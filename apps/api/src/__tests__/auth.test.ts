// Auth rules: docs/architecture.md §7.1; decisions Q2–Q7. Happy path and every refusal.
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { databaseUrl, env } from '../config/env';
import { errorHandler } from '../core/errors';
import { authenticate, requireCurrentPassword } from '../core/auth/middleware';
import { unlockUser, type AuthContext } from '../core/auth/auth.service';
import { REFRESH_COOKIE } from '../core/auth/auth.routes';
import { runSeed } from '../db/seed/run';
import { createTestUser, setUserFields, TEST_PASSWORD } from '../test/factories';

const app = createApp();
const client = new pg.Client({ connectionString: databaseUrl });
const meta = { ip: '127.0.0.1', userAgent: 'vitest' };

async function login(username: string, password = TEST_PASSWORD) {
  return request(app).post('/api/v1/core/auth/login').send({ username, password });
}

function refreshCookieOf(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown;
  const list = Array.isArray(raw) ? (raw as string[]) : [];
  const cookie = list.find((c) => c.startsWith(`${REFRESH_COOKIE}=`));
  if (!cookie) throw new Error('no refresh cookie');
  return cookie.split(';')[0]!;
}

async function events(username: string): Promise<string[]> {
  const { rows } = await client.query<{ event: string }>(
    `SELECT event FROM core.auth_events WHERE lower(username) = lower($1) ORDER BY id`,
    [username],
  );
  return rows.map((r) => r.event);
}

async function userRow(id: string) {
  const { rows } = await client.query(
    `SELECT failed_attempts, locked_at, must_change_password FROM core.users WHERE id = $1`,
    [id],
  );
  return rows[0] as { failed_attempts: number; locked_at: Date | null; must_change_password: boolean };
}

async function sessionRow(id: string) {
  const { rows } = await client.query(`SELECT revoked_at, revoke_reason, expires_at FROM core.sessions WHERE id = $1`, [id]);
  return rows[0] as { revoked_at: Date | null; revoke_reason: string | null; expires_at: Date };
}

function sessionIdOf(accessToken: string): string {
  const payload = jwt.decode(accessToken) as { sid: string };
  return payload.sid;
}

/** A tiny app with one protected route, to test the "change password first" gate. */
const gated = express();
gated.get('/protected', authenticate, requireCurrentPassword, (_req, res) => {
  res.json({ ok: true });
});
gated.use(errorHandler);

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
});

afterAll(async () => {
  await client.end();
});

describe('login', () => {
  it('signs in with username and password, sets an httpOnly refresh cookie and logs LOGIN_OK', async () => {
    await createTestUser({ username: 'QC101', roleCodes: ['QC_MANAGER'] });
    const res = await login('QC101');
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ username: 'QC101', mustChangePassword: false, passwordExpired: false });
    expect(res.body.user.permissions).toContain('qc.lot.change_status');
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith(REFRESH_COOKIE));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\/core\/auth/);
    expect(JSON.stringify(res.body)).not.toMatch(/argon2/);
    expect(await events('QC101')).toEqual(['LOGIN_OK']);
  });

  it('matches the username case-insensitively', async () => {
    await createTestUser({ username: 'Emp200' });
    expect((await login('EMP200')).status).toBe(200);
  });

  it('refuses a wrong password, counts it and logs LOGIN_FAIL', async () => {
    const id = await createTestUser({ username: 'emp201' });
    const res = await login('emp201', 'Wrong-Password-1');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await userRow(id)).failed_attempts).toBe(1);
    expect(await events('emp201')).toEqual(['LOGIN_FAIL']);
  });

  it('gives an unknown username the same answer and logs it without a user id', async () => {
    const res = await login('nobody-here', 'Whatever-123');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Username or password is incorrect' });
    const { rows } = await client.query(`SELECT user_id FROM core.auth_events WHERE username = 'nobody-here'`);
    expect(rows).toEqual([{ user_id: null }]);
  });

  it('never lets the SYSTEM user sign in', async () => {
    const res = await login('SYSTEM', 'Anything-123');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('refuses a deactivated account even with the right password', async () => {
    const id = await createTestUser({ username: 'emp202' });
    await setUserFields(id, { isActive: false });
    const res = await login('emp202');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
  });

  it('validates the request body', async () => {
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('lockout (5 failures, until an admin unlocks — Q5)', () => {
  it('locks on the 5th failure, revokes open sessions and logs LOCKOUT', async () => {
    const id = await createTestUser({ username: 'emp300' });
    const ok = await login('emp300');
    const sessionId = sessionIdOf(ok.body.accessToken as string);

    for (let i = 1; i <= 4; i += 1) {
      const res = await login('emp300', 'Wrong-Password-1');
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    }
    const fifth = await login('emp300', 'Wrong-Password-1');
    expect(fifth.status).toBe(401);
    expect(fifth.body.error.code).toBe('ACCOUNT_LOCKED');

    const user = await userRow(id);
    expect(user.failed_attempts).toBe(5);
    expect(user.locked_at).not.toBeNull();
    expect((await sessionRow(sessionId)).revoke_reason).toBe('LOCKOUT');
    expect(await events('emp300')).toEqual(['LOGIN_OK', 'LOGIN_FAIL', 'LOGIN_FAIL', 'LOGIN_FAIL', 'LOGIN_FAIL', 'LOGIN_FAIL', 'LOCKOUT']);

    // The old access token is dead, and even the right password is refused while locked.
    const me = await request(app).get('/api/v1/core/auth/me').set('Authorization', `Bearer ${ok.body.accessToken}`);
    expect(me.status).toBe(401);
    expect((await login('emp300')).body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('resets the failure count on a successful login', async () => {
    const id = await createTestUser({ username: 'emp301' });
    for (let i = 0; i < 4; i += 1) await login('emp301', 'Wrong-Password-1');
    expect((await login('emp301')).status).toBe(200);
    expect((await userRow(id)).failed_attempts).toBe(0);
  });

  it('stays locked until an admin unlocks; the unlock is logged with the admin as actor', async () => {
    const adminId = await createTestUser({ username: 'admin301', roleCodes: ['SYSTEM_ADMIN'] });
    const id = await createTestUser({ username: 'emp302' });
    for (let i = 0; i < 5; i += 1) await login('emp302', 'Wrong-Password-1');
    expect((await login('emp302')).body.error.code).toBe('ACCOUNT_LOCKED');

    const actor: AuthContext = {
      userId: adminId,
      companyId: '1',
      sessionId: '0',
      username: 'admin301',
      mustChangePassword: false,
      passwordExpired: false,
      permissions: new Set(['core.user.manage']),
    };
    await unlockUser(actor, id, meta);
    expect(await userRow(id)).toMatchObject({ failed_attempts: 0, locked_at: null });
    const { rows } = await client.query(
      `SELECT actor_id FROM core.auth_events WHERE user_id = $1 AND event = 'UNLOCK'`,
      [id],
    );
    expect(rows).toEqual([{ actor_id: adminId }]);
    expect((await login('emp302')).status).toBe(200);

    await expect(unlockUser(actor, id, meta)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
});

describe('access token and session check', () => {
  it('returns the current user for a valid token and refuses missing, forged or expired tokens', async () => {
    await createTestUser({ username: 'emp400' });
    const ok = await login('emp400');
    const me = await request(app).get('/api/v1/core/auth/me').set('Authorization', `Bearer ${ok.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('emp400');

    expect((await request(app).get('/api/v1/core/auth/me')).status).toBe(401);
    const forged = jwt.sign({ sid: '1', cid: '1' }, 'not-the-secret-not-the-secret-not-the', { subject: '2' });
    expect((await request(app).get('/api/v1/core/auth/me').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
    const expired = jwt.sign({ sid: sessionIdOf(ok.body.accessToken as string), cid: '1' }, env.JWT_ACCESS_SECRET, {
      subject: me.body.id as string,
      expiresIn: -10,
    });
    const res = await request(app).get('/api/v1/core/auth/me').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('refresh (12 h fixed, rotate on every use, reuse revokes the session — Q4)', () => {
  it('rotates the refresh token without extending the session', async () => {
    await createTestUser({ username: 'emp500' });
    const first = await login('emp500');
    const sessionId = sessionIdOf(first.body.accessToken as string);
    const expiresBefore = (await sessionRow(sessionId)).expires_at;

    const second = await request(app).post('/api/v1/core/auth/refresh').set('Cookie', refreshCookieOf(first));
    expect(second.status).toBe(200);
    expect(refreshCookieOf(second)).not.toBe(refreshCookieOf(first));
    expect(sessionIdOf(second.body.accessToken as string)).toBe(sessionId);
    expect((await sessionRow(sessionId)).expires_at).toEqual(expiresBefore);
    const hours = (expiresBefore.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThanOrEqual(12);
  });

  it('revokes the whole session when an old refresh token is reused', async () => {
    await createTestUser({ username: 'emp501' });
    const first = await login('emp501');
    const sessionId = sessionIdOf(first.body.accessToken as string);
    const second = await request(app).post('/api/v1/core/auth/refresh').set('Cookie', refreshCookieOf(first));

    const replay = await request(app).post('/api/v1/core/auth/refresh').set('Cookie', refreshCookieOf(first));
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('SESSION_REVOKED');
    expect((await sessionRow(sessionId)).revoke_reason).toBe('TOKEN_REUSE');
    expect(await events('emp501')).toEqual(['LOGIN_OK', 'TOKEN_REUSE']);

    // The legitimate newest token and the current access token are dead too.
    const after = await request(app).post('/api/v1/core/auth/refresh').set('Cookie', refreshCookieOf(second));
    expect(after.body.error.code).toBe('SESSION_REVOKED');
    const me = await request(app).get('/api/v1/core/auth/me').set('Authorization', `Bearer ${second.body.accessToken}`);
    expect(me.status).toBe(401);
  });

  it('refuses a refresh without a cookie, with a garbage cookie, or after the session expired', async () => {
    expect((await request(app).post('/api/v1/core/auth/refresh')).status).toBe(401);
    expect((await request(app).post('/api/v1/core/auth/refresh').set('Cookie', `${REFRESH_COOKIE}=garbage`)).status).toBe(401);

    await createTestUser({ username: 'emp502' });
    const res = await login('emp502');
    const sessionId = sessionIdOf(res.body.accessToken as string);
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id','1',true), set_config('app.company_id','1',true)`);
    await client.query(`UPDATE core.sessions SET expires_at = issued_at + interval '1 millisecond' WHERE id = $1`, [sessionId]);
    await client.query('COMMIT');
    const expired = await request(app).post('/api/v1/core/auth/refresh').set('Cookie', refreshCookieOf(res));
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('SESSION_REVOKED');
  });
});

describe('logout', () => {
  it('revokes the session, clears the cookie and logs LOGOUT', async () => {
    await createTestUser({ username: 'emp600' });
    const res = await login('emp600');
    const sessionId = sessionIdOf(res.body.accessToken as string);
    const out = await request(app).post('/api/v1/core/auth/logout').set('Cookie', refreshCookieOf(res));
    expect(out.status).toBe(204);
    expect((await sessionRow(sessionId)).revoke_reason).toBe('LOGOUT');
    expect(await events('emp600')).toEqual(['LOGIN_OK', 'LOGOUT']);
    expect((await request(app).post('/api/v1/core/auth/refresh').set('Cookie', refreshCookieOf(res))).status).toBe(401);
    expect(
      (await request(app).get('/api/v1/core/auth/me').set('Authorization', `Bearer ${res.body.accessToken}`)).status,
    ).toBe(401);
    // Logging out twice is harmless.
    expect((await request(app).post('/api/v1/core/auth/logout').set('Cookie', refreshCookieOf(res))).status).toBe(204);
  });
});

describe('forced and expired passwords (90 days, first login — Q6, Q7)', () => {
  it('lets a user who must change the password reach only me and change-password', async () => {
    await createTestUser({ username: 'emp700', mustChangePassword: true });
    const res = await login('emp700');
    expect(res.body.user.mustChangePassword).toBe(true);
    const token = res.body.accessToken as string;
    const blocked = await request(gated).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await request(app).get('/api/v1/core/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);

    const change = await request(app)
      .post('/api/v1/core/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'Brand-New-Pass-1' });
    expect(change.status).toBe(204);
    const allowed = await request(gated).get('/protected').set('Authorization', `Bearer ${token}`);
    expect(allowed.status).toBe(200);
  });

  it('treats a password older than 90 days as expired', async () => {
    await createTestUser({ username: 'emp701', passwordChangedAt: new Date(Date.now() - 91 * 24 * 3_600_000) });
    const res = await login('emp701');
    expect(res.body.user.passwordExpired).toBe(true);
    const blocked = await request(gated).get('/protected').set('Authorization', `Bearer ${res.body.accessToken}`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_EXPIRED');
  });

  it('does not treat an 89-day-old password as expired', async () => {
    await createTestUser({ username: 'emp702', passwordChangedAt: new Date(Date.now() - 89 * 24 * 3_600_000) });
    const res = await login('emp702');
    expect(res.body.user.passwordExpired).toBe(false);
    expect((await request(gated).get('/protected').set('Authorization', `Bearer ${res.body.accessToken}`)).status).toBe(200);
  });
});

describe('change password (policy, last-5 reuse — Q6)', () => {
  async function change(token: string, currentPassword: string, newPassword: string) {
    return request(app)
      .post('/api/v1/core/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword, newPassword });
  }

  it('refuses a wrong current password and counts it toward lockout', async () => {
    const id = await createTestUser({ username: 'emp800' });
    const token = (await login('emp800')).body.accessToken as string;
    const res = await change(token, 'Wrong-Password-1', 'Another-Pass-123');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    expect((await userRow(id)).failed_attempts).toBe(1);
  });

  it('refuses passwords that break the policy, listing the broken rules', async () => {
    await createTestUser({ username: 'emp801' });
    const token = (await login('emp801')).body.accessToken as string;
    const short = await change(token, TEST_PASSWORD, 'Ab1');
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe('PASSWORD_POLICY');
    expect(short.body.error.details.rules).toContain('At least 10 characters');
    const withName = await change(token, TEST_PASSWORD, 'Emp801-Password');
    expect(withName.body.error.details.rules).toContain('Must not contain the username');
  });

  it('refuses any of the last 5 passwords and accepts the 6th-oldest', async () => {
    await createTestUser({ username: 'emp802' });
    const token = (await login('emp802')).body.accessToken as string;
    expect((await change(token, TEST_PASSWORD, TEST_PASSWORD)).body.error.code).toBe('PASSWORD_REUSED');

    const sequence = ['Second-Pass-0001', 'Third-Pass-00002', 'Fourth-Pass-0003', 'Fifth-Pass-00004', 'Sixth-Pass-00005'];
    let current = TEST_PASSWORD;
    for (const next of sequence) {
      expect((await change(token, current, next)).status).toBe(204);
      current = next;
    }
    // Last 5 = the five above; the original is now the 6th-oldest.
    expect((await change(token, current, 'Second-Pass-0001')).body.error.code).toBe('PASSWORD_REUSED');
    expect((await change(token, current, TEST_PASSWORD)).status).toBe(204);
  });

  it('on success: clears the forced change, logs PASSWORD_CHANGE, ends other sessions, keeps this one', async () => {
    const id = await createTestUser({ username: 'emp803', mustChangePassword: true });
    const other = await login('emp803');
    const mine = await login('emp803');
    const res = await change(mine.body.accessToken as string, TEST_PASSWORD, 'Changed-Pass-2026');
    expect(res.status).toBe(204);
    expect((await userRow(id)).must_change_password).toBe(false);
    expect((await sessionRow(sessionIdOf(other.body.accessToken as string))).revoke_reason).toBe('PASSWORD_CHANGE');
    expect((await sessionRow(sessionIdOf(mine.body.accessToken as string))).revoked_at).toBeNull();
    expect(await events('emp803')).toEqual(['LOGIN_OK', 'LOGIN_OK', 'PASSWORD_CHANGE']);
    expect((await login('emp803')).status).toBe(401);
    expect((await login('emp803', 'Changed-Pass-2026')).status).toBe(200);
  });
});

describe('secrets stay out of the audit log', () => {
  it('has no password hash and no session token hash anywhere in audit_log', async () => {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.audit_log
        WHERE coalesce(old_data::text,'') ~ '(\\$argon2|current_token_hash)'
           OR coalesce(new_data::text,'') ~ '(\\$argon2|current_token_hash)'`,
    );
    expect(rows[0]).toEqual({ n: 0 });
  });
});
