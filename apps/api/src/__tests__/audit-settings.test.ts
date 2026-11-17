// Audit trail viewer (rule 6, §7.1) and company settings.
import pg from 'pg';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { databaseUrl } from '../config/env';
import { withTransaction } from '../db/client';
import { runSeed } from '../db/seed/run';
import { authenticateToken, txContext } from '../core/auth/auth.service';
import { recordSignature, verifySignature } from '../core/esign/esign.service';
import { fieldChanges } from '../core/audit/audit.service';
import { getSetting, registerSetting } from '../core/settings/app-settings.service';
import { createTestUser, TEST_PASSWORD } from '../test/factories';

const app = createApp();
const client = new pg.Client({ connectionString: databaseUrl });
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

const get = (who: string, url: string) => request(app).get(`/api/v1/core${url}`).set('Authorization', `Bearer ${tokens[who]}`);

registerSetting({
  key: 'test.tolerance_pct',
  description: 'Test tolerance in percent',
  schema: z.number().min(0).max(10),
  defaultValue: 2,
});

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  for (const [name, role] of [
    ['admin', 'SYSTEM_ADMIN'],
    ['ceo', 'CEO'],
    ['qam', 'QA_MANAGER'],
    ['planner', 'PLANNER'],
    ['fm', 'FINANCE_MANAGER'],
  ] as const) {
    ids[name] = await createTestUser({ username: `u_${name}`, roleCodes: [role] });
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: `u_${name}`, password: TEST_PASSWORD });
    tokens[name] = res.body.accessToken as string;
  }
});

afterAll(async () => {
  await client.end();
});

describe('audit trail viewer', () => {
  it('shows any change with who, when, why and the exact field changes (M1 "Done when")', async () => {
    const target = await createTestUser({ username: 'u_target', fullName: 'Before Name' });
    const edit = await request(app)
      .patch(`/api/v1/core/users/${target}`)
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ fullName: 'After Name' });
    expect(edit.status).toBe(200);

    const res = await get('admin', `/audit-log?table=core.users&recordId=${target}&action=UPDATE`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      table: 'core.users',
      recordId: target,
      action: 'UPDATE',
      changedBy: { id: ids.admin, username: 'u_admin' },
      reason: 'update user details',
      changes: [{ field: 'full_name', old: 'Before Name', new: 'After Name' }],
    });
  });

  it('filters by user and lists the audited tables', async () => {
    const byAdmin = await get('admin', `/audit-log?userId=${ids.admin}&pageSize=200`);
    expect(byAdmin.body.items.length).toBeGreaterThan(0);
    expect(byAdmin.body.items.every((e: { changedBy: { id: string } }) => e.changedBy.id === ids.admin)).toBe(true);
    const tables = await get('admin', '/audit-log/tables');
    expect(tables.body).toEqual(expect.arrayContaining(['core.users', 'core.roles', 'core.role_permissions']));
  });

  it('reads date filters as whole days in Asia/Karachi', async () => {
    // 30-06-2026 19:30 UTC = 01-07-2026 00:30 PKT; 30-06-2026 18:30 UTC = 30-06-2026 23:30 PKT.
    await client.query(
      `INSERT INTO core.audit_log (table_name, record_id, action, new_data, changed_at)
       VALUES ('test.boundary', '1', 'INSERT', '{}', '2026-06-30T19:30:00Z'),
              ('test.boundary', '2', 'INSERT', '{}', '2026-06-30T18:30:00Z')`,
    );
    const july = await get('admin', '/audit-log?table=test.boundary&from=2026-07-01&to=2026-07-01');
    expect(july.body.items.map((e: { recordId: string }) => e.recordId)).toEqual(['1']);
    const june = await get('admin', '/audit-log?table=test.boundary&from=2026-06-30&to=2026-06-30');
    expect(june.body.items.map((e: { recordId: string }) => e.recordId)).toEqual(['2']);
  });

  it('refuses bad filters', async () => {
    expect((await get('admin', '/audit-log?recordId=5')).status).toBe(400);
    expect((await get('admin', '/audit-log?from=2026-07-02&to=2026-07-01')).status).toBe(400);
    expect((await get('admin', '/audit-log?table=DROP TABLE')).status).toBe(400);
  });

  it('is readable by holders of core.audit.view only (CEO, QA Manager, admin)', async () => {
    expect((await get('ceo', '/audit-log')).status).toBe(200);
    expect((await get('qam', '/audit-log')).status).toBe(200);
    expect((await get('planner', '/audit-log')).status).toBe(403);
  });

  it('never shows a password hash', async () => {
    const res = await get('admin', '/audit-log?pageSize=200');
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|password_hash/);
  });

  it('ignores updated_at/updated_by when listing field changes', () => {
    expect(
      fieldChanges(
        { status: 'OPEN', updated_at: 'a', updated_by: '1', name: 'Jul' },
        { status: 'CLOSED', updated_at: 'b', updated_by: '2', name: 'Jul' },
      ),
    ).toEqual([{ field: 'status', old: 'OPEN', new: 'CLOSED' }]);
  });
});

describe('record history: status changes and e-signatures', () => {
  it('shows who moved a record, when, why, and the signature', async () => {
    await request(app).post('/api/v1/core/fiscal-years').set('Authorization', `Bearer ${tokens.fm}`).send({ startYear: 2026 });
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM core.fiscal_periods WHERE name = 'Jul-2026'`);
    const periodId = rows[0]!.id;
    await request(app)
      .post(`/api/v1/core/fiscal-periods/${periodId}/close`)
      .set('Authorization', `Bearer ${tokens.fm}`)
      .send({ reason: 'July closed' });

    const history = await get('qam', `/status-history?table=core.fiscal_periods&recordId=${periodId}`);
    expect(history.body).toMatchObject([
      { fromStatus: null, toStatus: 'OPEN', actor: { id: ids.fm } },
      { fromStatus: 'OPEN', toStatus: 'CLOSED', reason: 'July closed', signature: null },
    ]);

    const fm = await authenticateToken(tokens.fm!);
    const proof = await verifySignature(fm, { password: TEST_PASSWORD, meaning: 'REVIEWED', reason: 'Reviewed close' }, { ip: null, userAgent: null });
    await withTransaction(txContext(fm), (tx) => recordSignature(tx, proof, { table: 'core.fiscal_periods', id: periodId }));
    const sigs = await get('qam', `/e-signatures?table=core.fiscal_periods&recordId=${periodId}`);
    expect(sigs.body).toMatchObject([{ signerUsername: 'u_fm', meaning: 'REVIEWED', reason: 'Reviewed close' }]);
  });
});

describe('auth events viewer', () => {
  it('lists login failures for a user', async () => {
    await request(app).post('/api/v1/core/auth/login').send({ username: 'u_planner', password: 'Wrong-Pass-123' });
    const res = await get('admin', `/auth-events?userId=${ids.planner}&event=LOGIN_FAIL`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ event: 'LOGIN_FAIL', username: 'u_planner', details: { reason: 'wrong_password' } });
    expect((await get('planner', '/auth-events')).status).toBe(403);
  });
});

describe('settings', () => {
  const put = (who: string, key: string, body: object) =>
    request(app).put(`/api/v1/core/settings/${key}`).set('Authorization', `Bearer ${tokens[who]}`).send(body);

  it('lists declared settings with their defaults', async () => {
    const res = await get('admin', '/settings');
    expect(res.body).toContainEqual({
      key: 'test.tolerance_pct',
      description: 'Test tolerance in percent',
      value: 2,
      defaultValue: 2,
      isDefault: true,
    });
  });

  it('changes a setting with a reason (audited) and services read the new value', async () => {
    const res = await put('admin', 'test.tolerance_pct', { value: 5, reason: 'Supplier agreement' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ value: 5, isDefault: false });
    const admin = await authenticateToken(tokens.admin!);
    expect(await withTransaction(txContext(admin), (tx) => getSetting<number>(tx, admin.companyId, 'test.tolerance_pct'))).toBe(5);
    const audit = await client.query(`SELECT reason FROM core.audit_log WHERE table_name = 'core.settings' ORDER BY id DESC LIMIT 1`);
    expect(audit.rows[0]).toEqual({ reason: 'Supplier agreement' });
  });

  it('refuses invalid values, unknown keys, missing reasons and non-admins', async () => {
    expect((await put('admin', 'test.tolerance_pct', { value: 50, reason: 'Too much' })).status).toBe(400);
    expect((await put('admin', 'test.tolerance_pct', { value: 'x', reason: 'Wrong type' })).status).toBe(400);
    expect((await put('admin', 'test.unknown_key', { value: 1, reason: 'Unknown' })).status).toBe(404);
    expect((await put('admin', 'test.tolerance_pct', { value: 3 })).status).toBe(400);
    expect((await put('ceo', 'test.tolerance_pct', { value: 3, reason: 'CEO' })).status).toBe(403);
  });

  it('never deletes a setting row', async () => {
    await expect(client.query(`DELETE FROM core.settings`)).rejects.toThrow(/APPEND_ONLY/);
  });
});
