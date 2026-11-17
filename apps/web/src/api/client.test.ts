import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, api, errorText, onSessionLost, setAccessToken } from './client';

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('api client', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    setAccessToken('old-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the bearer token and the Idempotency-Key', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }));
    await api('/x', { method: 'POST', body: { a: 1 }, idempotencyKey: 'key-123456' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/x');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer old-token');
    expect(headers.get('Idempotency-Key')).toBe('key-123456');
    expect(init?.credentials).toBe('include');
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } }))
      .mockResolvedValueOnce(json(200, { accessToken: 'new-token', accessTokenExpiresAt: '', user: {} }))
      .mockResolvedValueOnce(json(200, { value: 42 }));
    expect(await api<{ value: number }>('/y')).toEqual({ value: 42 });
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/v1/core/auth/refresh');
    expect(new Headers(fetchMock.mock.calls[2]![1]?.headers).get('Authorization')).toBe('Bearer new-token');
  });

  it('signs out when the refresh fails', async () => {
    const lost = vi.fn();
    onSessionLost(lost);
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } }))
      .mockResolvedValueOnce(json(401, { error: { code: 'SESSION_REVOKED', message: 'revoked' } }));
    await expect(api('/z')).rejects.toBeInstanceOf(ApiRequestError);
    expect(lost).toHaveBeenCalledOnce();
  });

  it('returns undefined for 204 and shows password-policy rules in errors', async () => {
    fetchMock.mockResolvedValueOnce(json(204, null));
    expect(await api('/none', { method: 'POST' })).toBeUndefined();
    const err = new ApiRequestError(422, {
      code: 'PASSWORD_POLICY',
      message: 'Password does not meet the policy',
      details: { rules: ['At least one digit'] },
    });
    expect(errorText(err)).toBe('Password does not meet the policy: At least one digit');
  });
});
