import type { ApiError } from '@albert/shared';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError['error'],
  ) {
    super(body.message);
  }
}

/** Typed fetch wrapper for /api/v1. Auth headers and token refresh are added in M1. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(res.status, body?.error ?? { code: 'INTERNAL_ERROR', message: res.statusText });
  }
  return (await res.json()) as T;
}
