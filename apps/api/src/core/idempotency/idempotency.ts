// Idempotency-Key (CLAUDE.md conventions; decision Q11). Put `idempotent()` on every posting action,
// after `authenticate` and the permission check:
//   router.post('/:id/post', requirePermission('...'), idempotent(), handler)
//
// 1. Claim (user, key) as IN_PROGRESS in its own transaction before the action runs.
// 2. Same key again: same method + path + body → replay the stored response (header Idempotent-Replayed: true);
//    different request → 409 DUPLICATE_REQUEST; still running → 409 DUPLICATE_REQUEST.
// 3. When the response is sent: 2xx/4xx are stored (COMPLETED); 5xx releases the claim so a retry can run.
// Fail-safe: if the process dies between the business commit and storing the response, the claim stays
// IN_PROGRESS and retries get 409 until it expires (24 h) — the action is never run twice.
import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { and, eq, lt, sql } from 'drizzle-orm';
import { db, withTransaction } from '../../db/client';
import { idempotencyKeys } from '../../db/schema/core';
import { AppError } from '../errors';
import { logger } from '../logger';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const KEY_RE = /^[A-Za-z0-9_.:-]{8,200}$/;

/** JSON with object keys sorted, so the same body always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Hash of the request body. Passwords in e-signature bodies are excluded (never stored, even hashed). */
export function requestHash(body: unknown): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k]) => k !== 'password')
          .map(([k, val]) => [k, strip(val)]),
      );
    }
    return v;
  };
  return createHash('sha256').update(canonical(strip(body))).digest('hex');
}

function endpointOf(req: Request): string {
  return `${req.method} ${req.originalUrl.split('?')[0] ?? ''}`;
}

type Claim = { kind: 'claimed'; id: string } | { kind: 'replay'; status: number; body: unknown };

async function claim(userId: string, companyId: string, key: string, endpoint: string, hash: string): Promise<Claim> {
  return withTransaction({ userId, companyId, reason: 'idempotency claim' }, async (tx) => {
    // An expired key may be reused: remove it first.
    await tx
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key), lt(idempotencyKeys.expiresAt, sql`now()`)));
    const inserted = await tx
      .insert(idempotencyKeys)
      .values({ userId, key, endpoint, requestHash: hash, status: 'IN_PROGRESS' })
      .onConflictDoNothing({ target: [idempotencyKeys.userId, idempotencyKeys.key] })
      .returning({ id: idempotencyKeys.id });
    if (inserted[0]) return { kind: 'claimed', id: inserted[0].id };

    const [existing] = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
    if (!existing) throw new AppError('DUPLICATE_REQUEST', 'This Idempotency-Key is being used by another request');
    if (existing.endpoint !== endpoint || existing.requestHash !== hash) {
      throw new AppError('DUPLICATE_REQUEST', 'This Idempotency-Key was already used for a different request', {
        endpoint: existing.endpoint,
      });
    }
    if (existing.status !== 'COMPLETED' || existing.responseStatus === null) {
      throw new AppError('DUPLICATE_REQUEST', 'A request with this Idempotency-Key is still being processed');
    }
    return { kind: 'replay', status: existing.responseStatus, body: existing.responseBody };
  });
}

async function complete(userId: string, companyId: string, id: string, status: number, body: unknown): Promise<void> {
  await withTransaction({ userId, companyId, reason: 'idempotency complete' }, async (tx) => {
    if (status >= 500) {
      await tx.delete(idempotencyKeys).where(eq(idempotencyKeys.id, id));
      return;
    }
    await tx
      .update(idempotencyKeys)
      .set({ status: 'COMPLETED', responseStatus: status, responseBody: body ?? null, completedAt: new Date() })
      .where(eq(idempotencyKeys.id, id));
  });
}

/**
 * @param required true for posting actions (header mandatory); false to honour the header only when sent.
 */
export function idempotent({ required = true }: { required?: boolean } = {}): RequestHandler {
  return (req, res, next) => {
    const auth = req.auth;
    if (!auth) {
      next(new AppError('UNAUTHENTICATED', 'Not signed in'));
      return;
    }
    const key = req.get(IDEMPOTENCY_HEADER);
    if (!key) {
      if (required) next(new AppError('VALIDATION_FAILED', 'This action needs an Idempotency-Key header'));
      else next();
      return;
    }
    if (!KEY_RE.test(key)) {
      next(new AppError('VALIDATION_FAILED', 'Idempotency-Key must be 8–200 characters: letters, digits, _ . : -'));
      return;
    }

    claim(auth.userId, auth.companyId, key, endpointOf(req), requestHash(req.body))
      .then((result) => {
        if (result.kind === 'replay') {
          res.setHeader('Idempotent-Replayed', 'true');
          res.status(result.status).json(result.body);
          return;
        }
        captureResponse(res, (status, body) => complete(auth.userId, auth.companyId, result.id, status, body));
        next();
      })
      .catch(next);
  };
}

/** Store the response before it goes out, so an immediate retry already sees COMPLETED. */
function captureResponse(res: Response, store: (status: number, body: unknown) => Promise<void>): void {
  const originalJson = res.json.bind(res);
  const originalEnd = res.end.bind(res);
  let stored = false;
  const persist = (body: unknown): Promise<void> => {
    if (stored) return Promise.resolve();
    stored = true;
    return store(res.statusCode, body).catch((err: unknown) => {
      // The action already ran; the claim stays IN_PROGRESS (fail-safe: no second run).
      logger.error({ err }, 'Could not store idempotent response');
    });
  };
  res.json = ((body: unknown) => {
    void persist(body).then(() => originalJson(body));
    return res;
  }) as Response['json'];
  res.end = ((...args: Parameters<Response['end']>) => {
    if (stored) return originalEnd(...args);
    void persist(null).then(() => originalEnd(...args));
    return res;
  }) as Response['end'];
}

/** Housekeeping (nightly job later): remove expired keys. Returns how many were removed. */
export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const rows = await db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, sql`now()`)).returning({ id: idempotencyKeys.id });
  return rows.length;
}
