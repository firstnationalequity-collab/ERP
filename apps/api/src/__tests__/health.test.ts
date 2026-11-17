import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app';

describe('GET /api/v1/health', () => {
  it('returns ok', async () => {
    const res = await request(createApp()).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('returns the standard error shape for unknown routes', async () => {
    const res = await request(createApp()).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
