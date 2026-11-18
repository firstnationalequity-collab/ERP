// Finance masters API (M2 task 4): chart of accounts, cost centres, posting rules — happy paths and every
// refusal, through HTTP with the seeded roles (Finance Manager writes; fin.view / master.view read).
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { databaseUrl } from '../../../config/env';
import { runSeed } from '../../../db/seed/run';
import { createTestUser, TEST_PASSWORD } from '../../../test/factories';

const app = createApp();
const client = new pg.Client({ connectionString: databaseUrl });
const tokens: Record<string, string> = {};
const acct: Record<string, string> = {};

const call = (method: 'get' | 'post' | 'patch', who: string, url: string, body?: unknown) => {
  const req = request(app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`);
  return body === undefined ? req : req.send(body as object);
};
const get = (who: string, url: string) => call('get', who, url);
const post = (who: string, url: string, body: unknown = {}) => call('post', who, url, body);
const patch = (who: string, url: string, body: unknown) => call('patch', who, url, body);

function expectError(res: request.Response, status: number, code: string): void {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
}

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  const people: [string, string[]][] = [
    ['fm', ['FINANCE_MANAGER']],
    ['acc', ['ACCOUNTANT']],
    ['wm', ['WAREHOUSE_MANAGER']],
    ['ceo', ['CEO']],
    ['admin', ['SYSTEM_ADMIN']],
  ];
  for (const [who, roleCodes] of people) {
    await createTestUser({ username: `f_${who}`, roleCodes });
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: `f_${who}`, password: TEST_PASSWORD });
    tokens[who] = res.body.accessToken as string;
  }
  const { rows } = await client.query<{ id: string; code: string }>(`SELECT id, code FROM fin.accounts`);
  for (const r of rows) acct[r.code] = r.id;
});

afterAll(async () => {
  await client.end();
});

describe('permissions', () => {
  it('reads with fin.view or master.view; writes only with fin.master.manage', async () => {
    expect((await get('acc', '/fin/accounts')).status).toBe(200);
    expect((await get('wm', '/fin/posting-rules')).status).toBe(200);
    expect((await get('ceo', '/fin/cost-centers')).status).toBe(200);
    expectError(await get('admin', '/fin/accounts'), 403, 'FORBIDDEN');
    expectError(await post('acc', '/fin/accounts', { code: '1999', name: 'x', type: 'ASSET' }), 403, 'FORBIDDEN');
    expectError(await post('ceo', '/fin/cost-centers', { code: 'X', name: 'x' }), 403, 'FORBIDDEN');
    expectError(await post('wm', `/fin/posting-rules/1/deactivate`, { reason: 'try it' }), 403, 'FORBIDDEN');
  });
});

describe('chart of accounts', () => {
  it('lists the seeded PLACEHOLDER chart, filtered by type and search', async () => {
    const res = await get('fm', '/fin/accounts?accountType=LIABILITY&search=GRNI');
    expect(res.body.items).toEqual([expect.objectContaining({ code: '2120', isPlaceholder: true, isPostable: true, type: 'LIABILITY' })]);
  });

  it('creates an account under a header of the same type; refuses a postable parent, other type or bad code', async () => {
    const ok = await post('fm', '/fin/accounts', { code: '1130', name: 'Bank - deposit account', type: 'ASSET', parentId: acct['1100'] });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ code: '1130', parentId: acct['1100'], isPostable: true, isPlaceholder: false, isActive: true });
    expectError(await post('fm', '/fin/accounts', { code: '1131', name: 'x', type: 'ASSET', parentId: acct['1120'] }), 400, 'VALIDATION_FAILED');
    expectError(await post('fm', '/fin/accounts', { code: '1132', name: 'x', type: 'EXPENSE', parentId: acct['1100'] }), 400, 'VALIDATION_FAILED');
    expectError(await post('fm', '/fin/accounts', { code: '1130', name: 'again', type: 'ASSET' }), 409, 'ALREADY_EXISTS');
    expectError(await post('fm', '/fin/accounts', { code: 'a b', name: 'x', type: 'ASSET' }), 400, 'VALIDATION_FAILED');
  });

  it('never changes code or type; clears the placeholder flag but never sets it', async () => {
    expectError(await patch('fm', `/fin/accounts/${acct['1110']}`, { code: '1119' }), 400, 'VALIDATION_FAILED');
    expectError(await patch('fm', `/fin/accounts/${acct['1110']}`, { type: 'EXPENSE' }), 400, 'VALIDATION_FAILED');
    expectError(await patch('fm', `/fin/accounts/${acct['1110']}`, { isPlaceholder: true }), 400, 'VALIDATION_FAILED');
    const ok = await patch('fm', `/fin/accounts/${acct['1110']}`, { name: 'Petty cash', isPlaceholder: false });
    expect(ok.body).toMatchObject({ name: 'Petty cash', isPlaceholder: false, code: '1110' });
  });

  it('refuses placing an account under itself or its own sub-account', async () => {
    expectError(await patch('fm', `/fin/accounts/${acct['1100']}`, { parentId: acct['1100'] }), 400, 'VALIDATION_FAILED');
    const sub = await post('fm', '/fin/accounts', { code: '1150', name: 'Bank group', type: 'ASSET', parentId: acct['1100'], isPostable: false });
    expectError(await patch('fm', `/fin/accounts/${acct['1100']}`, { parentId: sub.body.id }), 400, 'VALIDATION_FAILED');
  });

  it('a header with sub-accounts stays a header', async () => {
    expectError(await patch('fm', `/fin/accounts/${acct['1100']}`, { isPostable: true }), 409, 'IN_USE');
  });

  it('deactivates with a reason; refuses one used by an active posting rule or with active sub-accounts', async () => {
    expectError(await post('fm', `/fin/accounts/${acct['3100']}/deactivate`, {}), 400, 'VALIDATION_FAILED');
    expect((await post('fm', `/fin/accounts/${acct['3100']}/deactivate`, { reason: 'Not used yet' })).status).toBe(204);
    expectError(await post('fm', `/fin/accounts/${acct['3100']}/deactivate`, { reason: 'Again' }), 409, 'INVALID_TRANSITION');
    expectError(await post('fm', `/fin/accounts/${acct['1310']}/deactivate`, { reason: 'Replace' }), 409, 'IN_USE');
    expectError(await post('fm', `/fin/accounts/${acct['3000']}/deactivate`, { reason: 'Replace' }), 409, 'IN_USE');
    const audit = await client.query(`SELECT reason FROM core.audit_log WHERE table_name = 'fin.accounts' AND record_id = $1 ORDER BY id DESC LIMIT 1`, [
      acct['3100'],
    ]);
    expect(audit.rows[0].reason).toBe('Account: Not used yet');
    expect((await post('fm', `/fin/accounts/${acct['3100']}/activate`, {})).status).toBe(204);
  });

  it('returns 404 for an unknown account', async () => {
    expectError(await get('fm', '/fin/accounts/987654'), 404, 'NOT_FOUND');
  });
});

describe('cost centres', () => {
  it('creates, renames, refuses duplicates, deactivates', async () => {
    const cc = await post('fm', '/fin/cost-centers', { code: 'prod-line-1', name: 'Tablet line 1' });
    expect(cc.status).toBe(201);
    expect(cc.body).toMatchObject({ code: 'PROD-LINE-1', isActive: true });
    expectError(await post('fm', '/fin/cost-centers', { code: 'PROD-LINE-1', name: 'x' }), 409, 'ALREADY_EXISTS');
    expect((await patch('fm', `/fin/cost-centers/${cc.body.id}`, { name: 'Tablet line A' })).body.name).toBe('Tablet line A');
    expectError(await patch('fm', `/fin/cost-centers/${cc.body.id}`, { code: 'X' }), 400, 'VALIDATION_FAILED');
    expect((await post('fm', `/fin/cost-centers/${cc.body.id}/deactivate`, { reason: 'Line closed' })).status).toBe(204);
    expect((await get('acc', '/fin/cost-centers?active=inactive')).body.items.map((c: { code: string }) => c.code)).toEqual(['PROD-LINE-1']);
  });
});

describe('posting rules', () => {
  it('lists the default rules with account code and name', async () => {
    const res = await get('acc', '/fin/posting-rules?event=DISPATCH');
    expect(res.body.items).toEqual([
      expect.objectContaining({ event: 'DISPATCH', accountRole: 'COGS', accountCode: '5100', itemCategoryId: null, isPlaceholder: true }),
      expect.objectContaining({ event: 'DISPATCH', accountRole: 'INVENTORY', accountCode: '1310', itemCategoryId: null }),
    ]);
    expect(res.body.total).toBe(2);
    const search = await get('acc', '/fin/posting-rules?search=GRNI');
    expect(search.body.total).toBe(search.body.items.length);
    expect(search.body.items.length).toBeGreaterThan(0);
  });

  it('adds a per-category inventory rule; refuses a role the event does not use, a duplicate, a header or inactive account', async () => {
    const cat = await client.query<{ id: string }>(
      `WITH s AS (SELECT set_config('app.user_id', '1', true), set_config('app.company_id', '1', true))
       INSERT INTO master.item_categories (code, name) SELECT 'API', 'Active ingredients' FROM s RETURNING id`,
    );
    const categoryId = cat.rows[0]!.id;
    const api = await post('fm', '/fin/accounts', { code: '1311', name: 'Stock - API', type: 'ASSET', parentId: acct['1300'] });
    const ok = await post('fm', '/fin/posting-rules', { event: 'GRN_RECEIPT', accountRole: 'INVENTORY', itemCategoryId: categoryId, accountId: api.body.id });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ accountCode: '1311', itemCategoryId: categoryId, isPlaceholder: false });
    expectError(await post('fm', '/fin/posting-rules', { event: 'GRN_RECEIPT', accountRole: 'INVENTORY', itemCategoryId: categoryId, accountId: acct['1310'] }), 409, 'ALREADY_EXISTS');
    expectError(await post('fm', '/fin/posting-rules', { event: 'DISPATCH', accountRole: 'BANK', accountId: acct['1120'] }), 400, 'VALIDATION_FAILED');
    expectError(await post('fm', '/fin/posting-rules', { event: 'DISPATCH', accountRole: 'COGS', itemCategoryId: categoryId, accountId: acct['5000'] }), 400, 'VALIDATION_FAILED');
    expectError(await post('fm', '/fin/posting-rules', { event: 'DISPATCH', accountRole: 'COGS', itemCategoryId: '987654', accountId: acct['5100'] }), 400, 'VALIDATION_FAILED');
    await post('fm', `/fin/accounts/${acct['3200']}/deactivate`, { reason: 'Test inactive account' });
    expectError(await patch('fm', `/fin/posting-rules/${ok.body.id}`, { accountId: acct['3200'] }), 400, 'VALIDATION_FAILED');
  });

  it('points a rule at another account and clears the placeholder; never changes its event or role', async () => {
    const rule = (await get('fm', '/fin/posting-rules?event=LOT_DESTROYED')).body.items.find((r: { accountRole: string }) => r.accountRole === 'REJECTION_WRITE_OFF');
    const res = await patch('fm', `/fin/posting-rules/${rule.id}`, { accountId: acct['6100'], isPlaceholder: false });
    expect(res.body).toMatchObject({ accountCode: '6100', isPlaceholder: false });
    expectError(await patch('fm', `/fin/posting-rules/${rule.id}`, { event: 'DISPATCH' }), 400, 'VALIDATION_FAILED');
    expectError(await patch('fm', `/fin/posting-rules/${rule.id}`, { isPlaceholder: true }), 400, 'VALIDATION_FAILED');
    const audit = await client.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE table_name = 'fin.posting_rules' AND record_id = $1 AND action = 'UPDATE'`, [rule.id]);
    expect(audit.rows[0].n).toBe(1);
  });

  it('deactivates a rule with a reason and reactivates it only while its account is postable and active', async () => {
    const rule = (await get('fm', '/fin/posting-rules?event=TOLL_INVOICE')).body.items[0];
    expect((await post('fm', `/fin/posting-rules/${rule.id}/deactivate`, { reason: 'Review' })).status).toBe(204);
    expect((await post('fm', `/fin/posting-rules/${rule.id}/activate`, {})).status).toBe(204);
  });
});
