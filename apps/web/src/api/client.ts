// Typed fetch wrapper for /api/v1.
// - The access token (15 min) lives in memory only; the refresh token is an httpOnly cookie the page never sees.
// - On 401 the client refreshes once (shared by concurrent calls) and retries; if that fails, it signs out.
// - Posting actions send an Idempotency-Key (one per user action, reused on retry of the same action).
import type { ApiError, ErrorCode, LoginResponse } from '@albert/shared';

export class ApiRequestError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  constructor(
    readonly status: number,
    body: ApiError['error'],
  ) {
    super(body.message);
    this.code = body.code;
    this.details = body.details;
  }
}

let accessToken: string | null = null;
let onSignedOut: (() => void) | null = null;
let refreshing: Promise<LoginResponse | null> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/** Called when the session can no longer be refreshed (expired, revoked, reused token). */
export function onSessionLost(handler: () => void): void {
  onSignedOut = handler;
}

async function parseError(res: Response): Promise<ApiRequestError> {
  const body = (await res.json().catch(() => null)) as ApiError | null;
  return new ApiRequestError(res.status, body?.error ?? { code: 'INTERNAL_ERROR', message: res.statusText || 'Request failed' });
}

/** Exchange the refresh cookie for a new access token. One request at a time. */
export function refreshSession(): Promise<LoginResponse | null> {
  refreshing ??= fetch('/api/v1/core/auth/refresh', { method: 'POST', credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) return null;
      const body = (await res.json()) as LoginResponse;
      accessToken = body.accessToken;
      return body;
    })
    .catch(() => null)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export interface ApiOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Raw body (file upload); sent as-is with the given headers. */
  rawBody?: BodyInit;
  idempotencyKey?: string;
}

async function send(path: string, opts: ApiOptions): Promise<Response> {
  const headers = new Headers(opts.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (opts.idempotencyKey) headers.set('Idempotency-Key', opts.idempotencyKey);
  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
  } else if (opts.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(opts.body);
  }
  const { body: _b, rawBody: _r, idempotencyKey: _k, headers: _h, ...rest } = opts;
  return fetch(`/api/v1${path}`, { ...rest, headers, body, credentials: 'include' });
}

/** JSON request. Returns undefined for 204. */
export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  let res = await send(path, opts);
  if (res.status === 401 && accessToken !== null) {
    const refreshed = await refreshSession();
    if (refreshed) {
      res = await send(path, opts);
    } else {
      accessToken = null;
      onSignedOut?.();
    }
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** File download as a Blob, with the same auth handling. */
export async function apiBlob(path: string): Promise<Blob> {
  let res = await send(path, {});
  if (res.status === 401 && accessToken !== null && (await refreshSession())) res = await send(path, {});
  if (!res.ok) throw await parseError(res);
  return res.blob();
}

/** A new key for one user action (e.g. one click of "Approve"). */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** Human message for an error, including password-policy rules when present. */
export function errorText(err: unknown): string {
  if (err instanceof ApiRequestError) {
    const rules = (err.details as { rules?: unknown } | undefined)?.rules;
    if (Array.isArray(rules) && rules.length > 0) return `${err.message}: ${rules.join('; ')}`;
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}
