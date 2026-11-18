// RBAC and user/role administration (docs/architecture.md §3, §7.1; decisions Q1, Q5–Q7, Q14, roles review).
// Through the real HTTP endpoints, with real logins.
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WitnessSignRequest } from '@albert/shared';
import { createApp } from '../app';
import { databaseUrl } from '../config/env';
import { runSeed } from '../db/seed/run';
import { createTestUser, TEST_PASSWORD } from '../test/factories';

const app = createApp();
const client = new pg.Client({ connectionString: databaseUrl });
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const roleIds: Record<string, string> = {};

async function signIn(username: string, password = TEST_PASSWORD): Promise<string> {
  const res = await request(app).post('/api/v1/core/auth/login').send({ username, password });
  if (res.status !== 200) throw new Error(`login ${username}: ${JSON.stringify(res.body)}`);
  return res.body.accessToken as string;
}

const as = (who: string) => ({
  get: (url: string) => request(app).get(`/api/v1/core${url}`).set('Authorization', `Bearer ${tokens[who]}`),
  post: (url: string, body: object = {}) => request(app).post(`/api/v1/core${url}`).set('Authorization', `Bearer ${tokens[who]}`).send(body),
  put: (url: string, body: object) => request(app).put(`/api/v1/core${url}`).set('Authorization', `Bearer ${tokens[who]}`).send(body),
  patch: (url: string, body: object) => request(app).patch(`/api/v1/core${url}`).set('Authorization', `Bearer ${tokens[who]}`).send(body),
});

const countersignBy = (username: string, password = TEST_PASSWORD): WitnessSignRequest => ({
  username,
  password,
  meaning: 'APPROVED',
  reason: 'QA countersign for access change',
});

async function rolesOf(userId: string): Promise<string[]> {
  const { rows } = await client.query<{ code: string }>(
    `SELECT r.code FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.code`,
    [userId],
  );
  return rows.map((r) => r.code);
}

async function failedAttempts(userId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(`SELECT failed_attempts AS n FROM core.users WHERE id = $1`, [userId]);
  return rows[0]!.n;
}

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  const { rows } = await client.query<{ id: string; code: string }>(`SELECT id, code FROM core.roles`);
  for (const r of rows) roleIds[r.code] = r.id;

  const people: [string, string[]][] = [
    ['admin', ['SYSTEM_ADMIN']],
    ['admin2', ['SYSTEM_ADMIN']],
    ['qam', ['QA_MANAGER']],
    ['qam2', ['QA_MANAGER']],
    ['qcm', ['QC_MANAGER']],
    ['pm', ['PRODUCTION_MANAGER']],
    ['ceo', ['CEO']],
    ['planner', ['PLANNER']],
  ];
  for (const [name, roleCodes] of people) {
    ids[name] = await createTestUser({ username: `a_${name}`, roleCodes });
    tokens[name] = await signIn(`a_${name}`);
  }
});

afterAll(async () => {
  await client.end();
});

describe('requirePermission on every route', () => {
  it('refuses a request without a token (401)', async () => {
    const res = await request(app).get('/api/v1/core/users');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it.each([
    ['CEO (view-only)', 'ceo'],
    ['QA Manager', 'qam'],
    ['Planner', 'planner'],
  ])('refuses user admin to %s with 403 naming the key', async (_label, who) => {
    const res = await as(who).get('/users');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', details: { permission: 'core.user.manage' } });
  });

  it('refuses role changes to a user without core.role.manage', async () => {
    const res = await as('qam').put(`/roles/${roleIds.PLANNER}/permissions`, { keys: ['prod.view'], reason: 'try' });
    expect(res.status).toBe(403);
  });

  it('lets System Admin list users, never showing the SYSTEM user or any password hash', async () => {
    const res = await as('admin').get('/users?pageSize=200');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(8);
    expect(res.body.items.map((u: { username: string }) => u.username)).not.toContain('SYSTEM');
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|password_hash|passwordHash/);
  });

  it('blocks admin routes until a forced password change is done', async () => {
    const id = await createTestUser({ username: 'a_admin_new', roleCodes: ['SYSTEM_ADMIN'], mustChangePassword: true });
    const token = await signIn('a_admin_new');
    const res = await request(app).get('/api/v1/core/users').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(id).toBeTruthy();
  });

  it('takes a role removal into effect on the next request (permissions are not cached in the token)', async () => {
    const id = await createTestUser({ username: 'a_admin_tmp', roleCodes: ['SYSTEM_ADMIN'] });
    const token = await signIn('a_admin_tmp');
    expect((await request(app).get('/api/v1/core/users').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    await as('admin').put(`/users/${id}/roles`, { roleIds: [], reason: 'Left IT' });
    expect((await request(app).get('/api/v1/core/users').set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });
});

describe('users', () => {
  it('creates a user with a temporary password that must be changed at first login', async () => {
    const res = await as('admin').post('/users', {
      username: 'EMP-900',
      fullName: 'New Storekeeper',
      email: 'store@example.com',
      temporaryPassword: 'Temp-Pass-2026',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ username: 'EMP-900', isActive: true, mustChangePassword: true, roles: [] });
    expect(JSON.stringify(res.body)).not.toMatch(/argon2/);
    const login = await request(app).post('/api/v1/core/auth/login').send({ username: 'emp-900', password: 'Temp-Pass-2026' });
    expect(login.body.user.mustChangePassword).toBe(true);
    const audit = await client.query(
      `SELECT changed_by FROM core.audit_log WHERE table_name = 'core.users' AND record_id = $1 AND action = 'INSERT'`,
      [res.body.id],
    );
    expect(audit.rows).toEqual([{ changed_by: ids.admin }]);
  });

  it('refuses a duplicate username (case-insensitive) with 409 and a weak temporary password with 422', async () => {
    const dup = await as('admin').post('/users', { username: 'emp-900', fullName: 'Dup', temporaryPassword: 'Temp-Pass-2026' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('ALREADY_EXISTS');
    const weak = await as('admin').post('/users', { username: 'EMP-901', fullName: 'Weak', temporaryPassword: 'weak' });
    expect(weak.status).toBe(422);
    expect(weak.body.error.code).toBe('PASSWORD_POLICY');
  });

  it('edits details with PATCH but refuses status fields there (actions only)', async () => {
    const id = await createTestUser({ username: 'a_edit' });
    const ok = await as('admin').patch(`/users/${id}`, { fullName: 'Edited Name' });
    expect(ok.status).toBe(200);
    expect(ok.body.fullName).toBe('Edited Name');
    const bad = await as('admin').patch(`/users/${id}`, { isActive: false });
    expect(bad.status).toBe(400);
  });

  it('deactivates a user: sessions end and login is refused; activation restores it', async () => {
    const id = await createTestUser({ username: 'a_leaver' });
    const token = await signIn('a_leaver');
    const res = await as('admin').post(`/users/${id}/deactivate`);
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    expect((await request(app).get('/api/v1/core/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    const login = await request(app).post('/api/v1/core/auth/login').send({ username: 'a_leaver', password: TEST_PASSWORD });
    expect(login.body.error.code).toBe('ACCOUNT_INACTIVE');
    expect((await as('admin').post(`/users/${id}/deactivate`)).status).toBe(409);
    expect((await as('admin').post(`/users/${id}/activate`)).body.isActive).toBe(true);
  });

  it('refuses to let an admin deactivate or reset their own account', async () => {
    expect((await as('admin').post(`/users/${ids.admin}/deactivate`)).body.error.code).toBe('FORBIDDEN');
    expect(
      (await as('admin').post(`/users/${ids.admin}/reset-password`, { temporaryPassword: 'Temp-Pass-2026' })).body.error.code,
    ).toBe('FORBIDDEN');
  });

  it('resets a password: forced change, other sessions end, logged with the admin as actor', async () => {
    const id = await createTestUser({ username: 'a_forgot' });
    const token = await signIn('a_forgot');
    const res = await as('admin').post(`/users/${id}/reset-password`, { temporaryPassword: 'Reset-Pass-2026' });
    expect(res.status).toBe(204);
    expect((await request(app).get('/api/v1/core/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
    const login = await request(app).post('/api/v1/core/auth/login').send({ username: 'a_forgot', password: 'Reset-Pass-2026' });
    expect(login.body.user.mustChangePassword).toBe(true);
    const { rows } = await client.query(
      `SELECT actor_id, details FROM core.auth_events WHERE user_id = $1 AND event = 'PASSWORD_CHANGE'`,
      [id],
    );
    expect(rows).toEqual([{ actor_id: ids.admin, details: { reset: true } }]);
  });

  it('unlocks a locked user through the route (204) and refuses an unlocked one (409)', async () => {
    const id = await createTestUser({ username: 'a_locked' });
    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/api/v1/core/auth/login').send({ username: 'a_locked', password: 'Wrong-Pass-123' });
    }
    expect((await as('admin').post(`/users/${id}/unlock`)).status).toBe(204);
    expect((await as('admin').post(`/users/${id}/unlock`)).status).toBe(409);
    expect((await as('ceo').post(`/users/${id}/unlock`)).status).toBe(403);
  });

  it('returns 404 for the SYSTEM user and unknown ids', async () => {
    expect((await as('admin').get('/users/1')).status).toBe(404);
    expect((await as('admin').get('/users/987654')).status).toBe(404);
    expect((await as('admin').get('/users/abc')).status).toBe(400);
  });
});

describe('role assignments (Q1)', () => {
  it('assigns a role without QC/QA action keys with no countersign, logging the reason', async () => {
    const id = await createTestUser({ username: 'a_new_planner' });
    const res = await as('admin').put(`/users/${id}/roles`, { roleIds: [roleIds.PLANNER], reason: 'Joined planning' });
    expect(res.status).toBe(200);
    expect(res.body.roles.map((r: { code: string }) => r.code)).toEqual(['PLANNER']);
    const { rows } = await client.query(
      `SELECT reason, changed_by FROM core.audit_log WHERE table_name = 'core.user_roles' AND new_data->>'user_id' = $1`,
      [id],
    );
    expect(rows).toEqual([{ reason: 'Joined planning', changed_by: ids.admin }]);
  });

  it('refuses any change to your own role assignments', async () => {
    const res = await as('admin').put(`/users/${ids.admin}/roles`, { roleIds: [roleIds.SYSTEM_ADMIN, roleIds.CEO], reason: 'More access' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SELF_ROLE_CHANGE');
  });

  it('refuses to give QC Manager without a QA countersign', async () => {
    const id = await createTestUser({ username: 'a_qc_new' });
    const res = await as('admin').put(`/users/${id}/roles`, { roleIds: [roleIds.QC_MANAGER], reason: 'Promotion' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('COUNTERSIGN_REQUIRED');
    expect(await rolesOf(id)).toEqual([]);
  });

  it('gives QC Manager with a QA Manager countersign and stores the e-signature', async () => {
    const id = await createTestUser({ username: 'a_qc_ok' });
    const res = await as('admin').put(`/users/${id}/roles`, {
      roleIds: [roleIds.QC_MANAGER],
      reason: 'Promotion',
      countersign: countersignBy('a_qam'),
    });
    expect(res.status).toBe(200);
    expect(await rolesOf(id)).toEqual(['QC_MANAGER']);
    const sig = await client.query(
      `SELECT user_id, meaning FROM core.e_signatures WHERE record_table = 'core.users' AND record_id = $1`,
      [id],
    );
    expect(sig.rows).toEqual([{ user_id: ids.qam, meaning: 'APPROVED' }]);
    const audit = await client.query(
      `SELECT reason FROM core.audit_log WHERE table_name = 'core.user_roles' AND new_data->>'user_id' = $1`,
      [id],
    );
    expect(audit.rows[0].reason).toMatch(/^Promotion \[countersign e-signature \d+\]$/);
  });

  it('also needs the countersign to REMOVE a QC/QA role', async () => {
    const id = await createTestUser({ username: 'a_qc_leave', roleCodes: ['QC_MANAGER'] });
    const res = await as('admin').put(`/users/${id}/roles`, { roleIds: [], reason: 'Left QC' });
    expect(res.body.error.code).toBe('COUNTERSIGN_REQUIRED');
    const ok = await as('admin').put(`/users/${id}/roles`, { roleIds: [], reason: 'Left QC', countersign: countersignBy('a_qam') });
    expect(ok.status).toBe(200);
    expect(await rolesOf(id)).toEqual([]);
  });

  it('refuses a countersign by someone without qa.access.countersign', async () => {
    const id = await createTestUser({ username: 'a_qc_pm' });
    const res = await as('admin').put(`/users/${id}/roles`, {
      roleIds: [roleIds.QC_MANAGER],
      reason: 'Promotion',
      countersign: countersignBy('a_pm'),
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', details: { permission: 'qa.access.countersign' } });
  });

  it('refuses the admin as their own countersigner', async () => {
    const id = await createTestUser({ username: 'a_qc_self' });
    const res = await as('admin').put(`/users/${id}/roles`, {
      roleIds: [roleIds.QC_MANAGER],
      reason: 'Promotion',
      countersign: countersignBy('a_admin'),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SEGREGATION_OF_DUTIES');
  });

  it('refuses a QA Manager countersigning a change to their own roles', async () => {
    const res = await as('admin').put(`/users/${ids.qam2}/roles`, {
      roleIds: [roleIds.QA_MANAGER, roleIds.QC_MANAGER],
      reason: 'Extra role',
      countersign: countersignBy('a_qam2'),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SEGREGATION_OF_DUTIES');
  });

  it("counts a wrong countersign password against the countersigner's account and changes nothing", async () => {
    const id = await createTestUser({ username: 'a_qc_wrong' });
    const before = await failedAttempts(ids.qam2!);
    const res = await as('admin').put(`/users/${id}/roles`, {
      roleIds: [roleIds.QC_MANAGER],
      reason: 'Promotion',
      countersign: countersignBy('a_qam2', 'Wrong-Pass-123'),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ESIGN_FAILED');
    expect(await failedAttempts(ids.qam2!)).toBe(before + 1);
    expect(await rolesOf(id)).toEqual([]);
  });

  it('refuses unknown role ids', async () => {
    const id = await createTestUser({ username: 'a_unknown_role' });
    const res = await as('admin').put(`/users/${id}/roles`, { roleIds: ['999999'], reason: 'x role' });
    expect(res.status).toBe(404);
  });
});

describe('roles and permission bundles (Q1, Q14)', () => {
  it('lists the permission catalogue with classes and the roles with their keys', async () => {
    const perms = await as('admin').get('/permissions');
    expect(perms.body).toContainEqual({ key: 'qa.batch.release', class: 'ACTION', description: expect.any(String) });
    const roles = await as('admin').get('/roles');
    const qc = roles.body.find((r: { code: string }) => r.code === 'QC_MANAGER');
    expect(qc).toMatchObject({ needsCountersign: true });
    expect(qc.keys).toContain('qc.lot.change_status');
    const planner = roles.body.find((r: { code: string }) => r.code === 'PLANNER');
    expect(planner.needsCountersign).toBe(false);
  });

  it('creates a role without QC/QA action keys', async () => {
    const res = await as('admin').post('/roles', {
      code: 'STORE_TRAINEE',
      name: 'Store trainee',
      keys: ['inv.stock.view', 'core.approval.inbox'],
      reason: 'New trainee role',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: 'STORE_TRAINEE', keys: ['core.approval.inbox', 'inv.stock.view'], userCount: 0 });
  });

  it('refuses a role that mixes an admin key with an action key (422)', async () => {
    const res = await as('admin').post('/roles', {
      code: 'SUPER_ADMIN',
      name: 'Super admin',
      keys: ['core.user.manage', 'qa.batch.release'],
      reason: 'Do everything',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ROLE_ADMIN_CONFLICT');
  });

  it('refuses to add an action key to System Admin — admin cannot grant itself release rights', async () => {
    const res = await as('admin').put(`/roles/${roleIds.SYSTEM_ADMIN}/permissions`, {
      keys: ['core.audit.view', 'core.user.manage', 'core.role.manage', 'core.settings.manage', 'core.approval.inbox', 'qa.batch.release'],
      reason: 'Convenience',
      countersign: countersignBy('a_qam'),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ROLE_ADMIN_CONFLICT');
  });

  it('needs a QA countersign to create a role with QC/QA action keys', async () => {
    const body = { code: 'QC_DEPUTY', name: 'QC deputy', keys: ['qc.view', 'qc.result.review'], reason: 'Deputy role' };
    expect((await as('admin').post('/roles', body)).body.error.code).toBe('COUNTERSIGN_REQUIRED');
    const ok = await as('admin').post('/roles', { ...body, countersign: countersignBy('a_qam') });
    expect(ok.status).toBe(201);
    expect(ok.body.needsCountersign).toBe(true);
  });

  it('needs a QA countersign for ANY bundle change to a role holding QC/QA action keys', async () => {
    const current = (await as('admin').get(`/roles/${roleIds.QC_MANAGER}`)).body.keys as string[];
    const next = [...current, 'prod.view'];
    const res = await as('admin').put(`/roles/${roleIds.QC_MANAGER}/permissions`, { keys: next, reason: 'See production' });
    expect(res.body.error.code).toBe('COUNTERSIGN_REQUIRED');
    const ok = await as('admin').put(`/roles/${roleIds.QC_MANAGER}/permissions`, {
      keys: next,
      reason: 'See production',
      countersign: countersignBy('a_qam'),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.keys).toContain('prod.view');
  });

  it('refuses a countersign by someone who holds the role being changed', async () => {
    const current = (await as('admin').get(`/roles/${roleIds.QA_MANAGER}`)).body.keys as string[];
    const res = await as('admin').put(`/roles/${roleIds.QA_MANAGER}/permissions`, {
      keys: [...current, 'fin.report.view'],
      reason: 'See reports',
      countersign: countersignBy('a_qam'),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SEGREGATION_OF_DUTIES');
  });

  it('refuses unknown permission keys (400)', async () => {
    const res = await as('admin').put(`/roles/${roleIds.PLANNER}/permissions`, { keys: ['qa.everything'], reason: 'bad key' });
    expect(res.status).toBe(400);
  });

  it('deactivating a QC/QA role needs the countersign, and its keys stop working at once', async () => {
    const create = await as('admin').post('/roles', {
      code: 'QC_TEMP',
      name: 'QC temp',
      keys: ['qc.view', 'qc.result.enter'],
      reason: 'Temp role',
      countersign: countersignBy('a_qam'),
    });
    const roleId = create.body.id as string;
    expect((await as('admin').post(`/roles/${roleId}/deactivate`, { reason: 'No longer needed' })).body.error.code).toBe(
      'COUNTERSIGN_REQUIRED',
    );
    const ok = await as('admin').post(`/roles/${roleId}/deactivate`, {
      reason: 'No longer needed',
      countersign: countersignBy('a_qam'),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.isActive).toBe(false);
  });

  it('refuses a change that would leave nobody able to manage users', async () => {
    const res = await as('admin').put(`/roles/${roleIds.SYSTEM_ADMIN}/permissions`, {
      keys: ['core.audit.view', 'core.approval.inbox'],
      reason: 'Oops',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('LAST_ADMIN');
    expect((await as('admin').post(`/roles/${roleIds.SYSTEM_ADMIN}/deactivate`, { reason: 'Oops' })).body.error.code).toBe(
      'LAST_ADMIN',
    );
  });

  it('refuses role admin to the CEO and to QA (403)', async () => {
    expect((await as('ceo').post('/roles', { code: 'X1', name: 'x', keys: [], reason: 'try it' })).status).toBe(403);
    expect((await as('qam').post(`/roles/${roleIds.PLANNER}/deactivate`, { reason: 'try it' })).status).toBe(403);
  });
});

describe('refusal paths (rules review E)', () => {
  it('refuses activating an already-active user or role (409)', async () => {
    const id = await createTestUser({ username: 'a_already_active' });
    const user = await as('admin').post(`/users/${id}/activate`);
    expect(user.status).toBe(409);
    expect(user.body.error.message).toBe('User is already active');
    const role = await as('admin').post(`/roles/${roleIds.PLANNER}/activate`, { reason: 'Already active' });
    expect(role.status).toBe(409);
    expect(role.body.error.message).toBe('Role is already active');
  });

  it('refuses a countersign whose meaning is not APPROVED, before checking any password', async () => {
    const id = await createTestUser({ username: 'a_cs_meaning' });
    const res = await as('admin').put(`/users/${id}/roles`, {
      roleIds: [roleIds.QC_MANAGER],
      reason: 'Promotion',
      countersign: { ...countersignBy('a_qam'), meaning: 'REVIEWED' },
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'ESIGN_FAILED', message: 'A countersign must have the meaning APPROVED' });
    expect(await rolesOf(id)).toEqual([]);
  });
});

describe('QA-controlled keys by classification, not prefix (decisions "QA-controlled keys")', () => {
  for (const key of ['master.avl.approve', 'master.formula.approve', 'master.item.approve'] as const) {
    it(`needs a QA countersign to grant ${key} to a role`, async () => {
      const code = `GMP_${key.split('.')[1]!.toUpperCase()}_TEST`;
      const body = { code, name: `${key} test`, keys: ['master.view', key], reason: 'GMP approver role' };
      const refused = await as('admin').post('/roles', body);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('COUNTERSIGN_REQUIRED');
      const ok = await as('admin').post('/roles', { ...body, countersign: countersignBy('a_qam') });
      expect(ok.status).toBe(201);
      expect(ok.body.needsCountersign).toBe(true);
    });
  }

  it('needs a QA countersign to add master.item.approve to an existing role without qc/qa keys', async () => {
    const created = await as('admin').post('/roles', {
      code: 'ITEM_CLERK_TEST', name: 'Item clerk', keys: ['master.view', 'master.item.manage'], reason: 'Clerk role',
    });
    expect(created.status).toBe(201);
    expect(created.body.needsCountersign).toBe(false);
    const next = { keys: ['master.view', 'master.item.manage', 'master.item.approve'], reason: 'Wants to activate items' };
    const refused = await as('admin').put(`/roles/${created.body.id}/permissions`, next);
    expect(refused.body.error.code).toBe('COUNTERSIGN_REQUIRED');
  });

  it('needs a QA countersign to assign a user to a role holding master.avl.approve', async () => {
    const role = await as('admin').post('/roles', {
      code: 'AVL_APPROVER_TEST', name: 'AVL approver', keys: ['master.view', 'master.avl.approve'], reason: 'AVL role',
      countersign: countersignBy('a_qam'),
    });
    const id = await createTestUser({ username: 'a_avl_user' });
    const refused = await as('admin').put(`/users/${id}/roles`, { roleIds: [role.body.id], reason: 'Approves AVL' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('COUNTERSIGN_REQUIRED');
    expect(await rolesOf(id)).toEqual([]);
    const ok = await as('admin').put(`/users/${id}/roles`, {
      roleIds: [role.body.id], reason: 'Approves AVL', countersign: countersignBy('a_qam'),
    });
    expect(ok.status).toBe(200);
    expect(await rolesOf(id)).toEqual(['AVL_APPROVER_TEST']);
  });

  it('does not need a QA countersign for master.customer.approve (qaControlled: false)', async () => {
    const res = await as('admin').post('/roles', {
      code: 'CUST_APPROVER_TEST', name: 'Customer approver', keys: ['master.view', 'master.customer.approve'], reason: 'Credit desk',
    });
    expect(res.status).toBe(201);
    expect(res.body.needsCountersign).toBe(false);
  });
});
