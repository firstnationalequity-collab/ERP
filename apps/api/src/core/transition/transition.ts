// core/transition — the only way a status changes (rule 7; docs/architecture.md §4).
//
// Each entity defines an allowed-moves map. Every move carries its own permission key (or 'SYSTEM' for
// background jobs), and optionally: required e-signature meanings, a required reason, and a required
// witness (second person with their own key). transition():
//   1. locks the row (SELECT ... FOR UPDATE) and reads the current status;
//   2. refuses moves not in the map (409), actors without the key (403), missing/foreign signatures (403);
//   3. writes core.status_history, then updates the status.
// The database refuses any status change without that history row (core.require_transition).
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PermissionKey, SignatureMeaning } from '@albert/shared';
import { SYSTEM_USER_ID, type Tx } from '../../db/client';
import { statusHistory } from '../../db/schema/core';
import { AppError } from '../errors';
import { permissionKeysForUser } from '../auth/auth.repo';
import type { SignatureRecord } from '../esign/esign.service';

export const SYSTEM = 'SYSTEM' as const;

export interface Move<S extends string> {
  from: S | null; // null = initial status of a new record
  to: S;
  /** Key the actor must hold, or SYSTEM for moves only background jobs may make. */
  permission: PermissionKey | typeof SYSTEM;
  /** If set, the actor must e-sign with one of these meanings. */
  esign?: readonly SignatureMeaning[];
  /** If true, a reason of at least 3 characters is required (an e-signature's reason counts). */
  reasonRequired?: boolean;
  /** If set, a different person holding `permission` must e-sign with one of `meanings`. */
  witness?: { permission: PermissionKey; meanings: readonly SignatureMeaning[] };
}

export interface TransitionMap<S extends string> {
  /** "<schema>.<table>"; the table must have `id` and `status` columns and core.require_transition. */
  entityTable: string;
  statuses: readonly S[];
  moves: readonly Move<S>[];
}

/** Who acts. Users come from AuthContext; background jobs use systemActor(). */
export interface Actor {
  userId: string;
  companyId: string;
  permissions: ReadonlySet<PermissionKey>;
}

export function systemActor(companyId = '1'): Actor {
  return { userId: SYSTEM_USER_ID, companyId, permissions: new Set() };
}

/** Build a map, refusing duplicates and unknown statuses at startup rather than at run time. */
export function defineTransitions<S extends string>(map: TransitionMap<S>): TransitionMap<S> {
  if (!/^[a-z_]+\.[a-z_]+$/.test(map.entityTable)) throw new Error(`Bad entity table name: ${map.entityTable}`);
  const known = new Set<string>(map.statuses);
  const seen = new Set<string>();
  for (const m of map.moves) {
    if ((m.from !== null && !known.has(m.from)) || !known.has(m.to)) {
      throw new Error(`${map.entityTable}: move ${m.from ?? '(new)'} → ${m.to} uses an unknown status`);
    }
    if (m.from === m.to) throw new Error(`${map.entityTable}: move to the same status ${m.to}`);
    const key = `${m.from ?? ''}→${m.to}`;
    if (seen.has(key)) throw new Error(`${map.entityTable}: duplicate move ${key}`);
    seen.add(key);
  }
  return map;
}

export interface TransitionRequest<S extends string> {
  entityId: string;
  to: S;
  actor: Actor;
  /** The actor's e-signature for this record (from recordSignature), when the move needs one. */
  signature?: SignatureRecord;
  /** The second person's signature, when the move needs a witness. */
  witness?: SignatureRecord;
  reason?: string;
  /**
   * Columns set in the same UPDATE as the status, for a row CHECK that ties them to it
   * (e.g. a journal entry's reversal_id when it becomes REVERSED). Existing records only.
   */
  alsoSet?: Readonly<Record<string, string | null>>;
}

export interface TransitionResult<S extends string> {
  from: S | null;
  to: S;
  historyId: string;
}

function tableSql(entityTable: string) {
  const [schema, table] = entityTable.split('.') as [string, string];
  return sql`${sql.identifier(schema)}.${sql.identifier(table)}`;
}

async function authorize<S extends string>(
  tx: Tx,
  map: TransitionMap<S>,
  move: Move<S>,
  req: TransitionRequest<S>,
): Promise<string | undefined> {
  const isSystem = req.actor.userId === SYSTEM_USER_ID;
  const label = `${move.from ?? '(new)'} → ${move.to}`;

  // 1. Permission. No role overrides the map — not admin, not CEO (rule 1).
  if (move.permission === SYSTEM) {
    if (!isSystem) throw new AppError('FORBIDDEN', `${label} is made only by the system`, { move: label });
  } else if (isSystem || !req.actor.permissions.has(move.permission)) {
    throw new AppError('FORBIDDEN', `You do not have permission for ${label}`, { move: label, permission: move.permission });
  }

  // 2. The actor's own e-signature, for this very record.
  const sig = req.signature;
  if (move.esign) {
    if (!sig) throw new AppError('ESIGN_FAILED', `${label} requires your e-signature`, { meanings: move.esign });
    if (sig.userId !== req.actor.userId) throw new AppError('ESIGN_FAILED', 'The e-signature must be your own');
    if (!move.esign.includes(sig.meaning)) {
      throw new AppError('ESIGN_FAILED', `Meaning ${sig.meaning} is not valid for ${label}`, { meanings: move.esign });
    }
  }
  if (sig && (sig.recordTable !== map.entityTable || sig.recordId !== req.entityId)) {
    throw new AppError('ESIGN_FAILED', 'The e-signature belongs to a different record');
  }

  // 3. Witness: a different person who holds the witness key.
  if (move.witness) {
    const w = req.witness;
    if (!w) throw new AppError('ESIGN_FAILED', `${label} requires a witness signature`, { witness: move.witness.permission });
    if (w.userId === req.actor.userId) {
      throw new AppError('SEGREGATION_OF_DUTIES', 'The witness must be a different person');
    }
    if (w.recordTable !== map.entityTable || w.recordId !== req.entityId) {
      throw new AppError('ESIGN_FAILED', 'The witness signature belongs to a different record');
    }
    if (!move.witness.meanings.includes(w.meaning)) {
      throw new AppError('ESIGN_FAILED', `Witness meaning ${w.meaning} is not valid for ${label}`);
    }
    const witnessKeys = await permissionKeysForUser(tx, w.userId);
    if (!witnessKeys.includes(move.witness.permission)) {
      throw new AppError('FORBIDDEN', `The witness does not hold ${move.witness.permission}`);
    }
  }

  // 4. Reason.
  const reason = (req.reason ?? sig?.reason ?? '').trim();
  if (move.reasonRequired && reason.length < 3) {
    throw new AppError('VALIDATION_FAILED', `${label} requires a reason`);
  }
  return reason.length > 0 ? reason : undefined;
}

async function writeHistory<S extends string>(
  tx: Tx,
  map: TransitionMap<S>,
  from: S | null,
  req: TransitionRequest<S>,
  reason: string | undefined,
): Promise<string> {
  const [row] = await tx
    .insert(statusHistory)
    .values({
      entityTable: map.entityTable,
      entityId: req.entityId,
      fromStatus: from,
      toStatus: req.to,
      actorId: req.actor.userId,
      esignId: req.signature?.id ?? null,
      witnessEsignId: req.witness?.id ?? null,
      reason: reason ?? null,
    })
    .returning({ id: statusHistory.id });
  if (!row) throw new Error('status_history insert returned no row');
  return row.id;
}

/** Move an existing record to a new status. Must run inside the business transaction. */
export async function transition<S extends string>(
  tx: Tx,
  map: TransitionMap<S>,
  req: TransitionRequest<S>,
): Promise<TransitionResult<S>> {
  const locked = await tx.execute<{ status: string }>(
    sql`SELECT status FROM ${tableSql(map.entityTable)} WHERE id = ${req.entityId} FOR UPDATE`,
  );
  const current = locked.rows[0]?.status;
  if (current === undefined) throw new AppError('NOT_FOUND', `${map.entityTable} ${req.entityId} not found`);
  const from = current as S;

  const move = map.moves.find((m) => m.from === from && m.to === req.to);
  if (!move) {
    throw new AppError('INVALID_TRANSITION', `Cannot change status from ${from} to ${req.to}`, {
      from,
      to: req.to,
      allowed: map.moves.filter((m) => m.from === from).map((m) => m.to),
    });
  }
  const reason = await authorize(tx, map, move, req);
  const historyId = await writeHistory(tx, map, from, req, reason);
  const extra = Object.entries(req.alsoSet ?? {}).map(([column, value]) => {
    if (!/^[a-z_]+$/.test(column) || column === 'status') throw new Error(`transition: bad column ${column}`);
    return sql`, ${sql.identifier(column)} = ${value}`;
  });
  await tx.execute(sql`UPDATE ${tableSql(map.entityTable)} SET status = ${req.to}${sql.join(extra)} WHERE id = ${req.entityId}`);
  return { from, to: req.to, historyId };
}

/**
 * Record the initial status of a record just inserted in this transaction (move from null).
 * The database checks at commit that every new record has this history row.
 */
export async function recordInitialStatus<S extends string>(
  tx: Tx,
  map: TransitionMap<S>,
  req: TransitionRequest<S>,
): Promise<TransitionResult<S>> {
  const move = map.moves.find((m) => m.from === null && m.to === req.to);
  if (!move) throw new AppError('INVALID_TRANSITION', `A new ${map.entityTable} cannot start in ${req.to}`);
  const reason = await authorize(tx, map, move, req);
  const historyId = await writeHistory(tx, map, null, req, reason);
  return { from: null, to: req.to, historyId };
}

/** Who made the latest move of a record into `status` (e.g. who deactivated it), or undefined if never. */
export async function lastStatusActor(tx: Tx, entityTable: string, entityId: string, status: string): Promise<string | undefined> {
  const [row] = await tx
    .select({ actorId: statusHistory.actorId })
    .from(statusHistory)
    .where(and(eq(statusHistory.entityTable, entityTable), eq(statusHistory.entityId, entityId), eq(statusHistory.toStatus, status)))
    .orderBy(desc(statusHistory.id))
    .limit(1);
  return row?.actorId;
}
