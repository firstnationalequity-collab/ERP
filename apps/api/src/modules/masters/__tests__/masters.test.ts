// Masters API (M2 task 3): happy paths and every refusal, through HTTP with the seeded roles.
// Rules: decisions M2 Q1, Q4, Q5, Q6 and 18-11-2026 (editing active parties); architecture §3, §4, §7.2.
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { databaseUrl } from '../../../config/env';
import { runSeed } from '../../../db/seed/run';
import { systemContext, withTransaction } from '../../../db/client';
import { assertTaxRateConfirmed } from '../catalog.service';
import { PLACEHOLDER_TAX_CODES } from '../../../db/seed/finance';
import { createTestUser, TEST_PASSWORD } from '../../../test/factories';

const app = createApp();
const client = new pg.Client({ connectionString: databaseUrl });
const tokens: Record<string, string> = {};
const userIds: Record<string, string> = {};

type Body = Record<string, unknown>;
const call = (method: 'get' | 'post' | 'patch' | 'put', who: string, url: string, body?: unknown) => {
  const req = request(app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`);
  return body === undefined ? req : req.send(body as object);
};
const get = (who: string, url: string) => call('get', who, url);
const post = (who: string, url: string, body: unknown = {}) => call('post', who, url, body);
const patch = (who: string, url: string, body: unknown) => call('patch', who, url, body);
const put = (who: string, url: string, body: unknown) => call('put', who, url, body);

const countersign = (who: string, password = TEST_PASSWORD) => ({
  username: `m_${who}`,
  password,
  meaning: 'APPROVED' as const,
  reason: 'Checked against the source document',
});
const sig = (meaning: 'APPROVED' | 'REJECTED', reason = 'Reviewed the evidence') => ({ password: TEST_PASSWORD, meaning, reason });

const PDF = Buffer.from('%PDF-1.4\n% supplier questionnaire\n%%EOF\n');
const upload = (who: string, table: string, id: string | undefined) =>
  request(app)
    .post(`/api/v1/core/attachments/${table}/${id}`)
    .set('Authorization', `Bearer ${tokens[who]}`)
    .set('Content-Type', 'application/pdf')
    .set('X-File-Name', 'questionnaire.pdf')
    .send(PDF);

async function history(table: string, id: string | undefined): Promise<string[]> {
  if (!id) throw new Error(`history: no id for ${table} (an earlier step failed)`);
  const { rows } = await client.query<{ f: string | null; t: string; actor: string }>(
    `SELECT from_status AS f, to_status AS t, actor_id::text AS actor FROM core.status_history
      WHERE entity_table = $1 AND entity_id = $2 ORDER BY id`,
    [table, id],
  );
  return rows.map((r) => `${r.f ?? '-'}>${r.t}`);
}

function expectError(res: request.Response, status: number, code: string): void {
  expect({ status: res.status, code: (res.body as { error?: { code?: string } }).error?.code }).toEqual({ status, code });
}

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  const people: [string, string[]][] = [
    ['planner', ['PLANNER']],
    ['qao', ['QA_OFFICER']],
    ['prodm', ['PRODUCTION_MANAGER']],
    ['qam', ['QA_MANAGER']],
    ['po', ['PURCHASE_OFFICER']],
    ['po2', ['PURCHASE_OFFICER']],
    ['pm', ['PURCHASE_MANAGER']],
    ['se', ['SALES_EXECUTIVE']],
    ['se2', ['SALES_EXECUTIVE']],
    ['sm', ['SALES_MANAGER']],
    ['sesm', ['SALES_EXECUTIVE', 'SALES_MANAGER']],
    ['fm', ['FINANCE_MANAGER']],
    ['wm', ['WAREHOUSE_MANAGER']],
    ['ceo', ['CEO']],
    ['admin', ['SYSTEM_ADMIN']],
  ];
  for (const [name, roles] of people) {
    userIds[name] = await createTestUser({ username: `m_${name}`, roleCodes: roles });
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: `m_${name}`, password: TEST_PASSWORD });
    tokens[name] = res.body.accessToken as string;
  }
});

afterAll(async () => {
  await client.end();
});

// Shared fixtures built by the catalog tests and used later.
const ids: Record<string, string> = {};

describe('catalog masters: tax codes, UoM, categories, items, conversions', () => {
  it('lets the Finance Manager keep tax codes; others cannot write; decimals only as text', async () => {
    const gst = await post('fm', '/master/tax-codes', { code: 'gst18', name: 'Sales tax 18%', kind: 'SALES_TAX', rate: '18', isPlaceholder: true });
    expect(gst.status).toBe(201);
    expect(gst.body).toMatchObject({ code: 'GST18', rate: '18.0000', isPlaceholder: true, isActive: true });
    ids.gst = gst.body.id;
    ids.wht = (await post('fm', '/master/tax-codes', { code: 'WHT153', name: 'WHT 153', kind: 'WITHHOLDING', rate: '4.5' })).body.id;

    expectError(await post('planner', '/master/tax-codes', { code: 'X', name: 'X', kind: 'SALES_TAX', rate: '1' }), 403, 'FORBIDDEN');
    expectError(await post('fm', '/master/tax-codes', { code: 'X1', name: 'X', kind: 'SALES_TAX', rate: '100.5' }), 400, 'VALIDATION_FAILED');
    expectError(await post('fm', '/master/tax-codes', { code: 'X2', name: 'X', kind: 'SALES_TAX', rate: 17 }), 400, 'VALIDATION_FAILED');
    expectError(await post('fm', '/master/tax-codes', { code: 'X3', name: 'X', kind: 'SALES_TAX', rate: '1.23456' }), 400, 'VALIDATION_FAILED');
    expectError(await post('fm', '/master/tax-codes', { code: 'GST18', name: 'Again', kind: 'SALES_TAX', rate: '18' }), 409, 'ALREADY_EXISTS');

    const upd = await patch('fm', `/master/tax-codes/${ids.gst}`, { rate: '17', isPlaceholder: false });
    expect(upd.body).toMatchObject({ rate: '17.0000', isPlaceholder: false });
    // The two created here plus the seeded PLACEHOLDER tax codes (M2 task 4).
    expect((await get('ceo', '/master/tax-codes')).body.total).toBe(2 + PLACEHOLDER_TAX_CODES.length);
    expectError(await get('admin', '/master/tax-codes'), 403, 'FORBIDDEN');
  });

  it('WHT placeholder rates block posting until Finance confirms them; confirmed stays confirmed (owner 18-11-2026)', async () => {
    const { rows } = await client.query<{ id: string; name: string }>(`SELECT id::text, name FROM master.tax_codes WHERE code = 'WHT-153-1B'`);
    const wht = rows[0]!;
    expect(wht.name).toBe('WHT s.153(1)(b) - services - RATE NOT CONFIRMED');
    const check = () => withTransaction(systemContext(), (tx) => assertTaxRateConfirmed(tx, '1', wht.id));
    await expect(check()).rejects.toMatchObject({ code: 'TAX_RATE_NOT_CONFIRMED' });
    // A sales-tax placeholder is not blocked by this rule.
    const st = await client.query<{ id: string }>(`SELECT id::text FROM master.tax_codes WHERE code = 'ST-18'`);
    await withTransaction(systemContext(), (tx) => assertTaxRateConfirmed(tx, '1', st.rows[0]!.id));

    expectError(await patch('planner', `/master/tax-codes/${wht.id}`, { isPlaceholder: false }), 403, 'FORBIDDEN');
    const confirmed = await patch('fm', `/master/tax-codes/${wht.id}`, { rate: '10', isPlaceholder: false });
    expect(confirmed.body).toMatchObject({ name: 'WHT s.153(1)(b) - services', rate: '10.0000', isPlaceholder: false });
    await check();
    expectError(await patch('fm', `/master/tax-codes/${wht.id}`, { isPlaceholder: true }), 400, 'VALIDATION_FAILED');
  });

  it('lets the Warehouse Manager keep UoM and categories (Planner no longer can); codes are unique', async () => {
    const kg = await post('wm', '/master/uoms', { code: 'KG', name: 'Kilogram' });
    expect(kg.status).toBe(201);
    ids.kg = kg.body.id;
    ids.g = (await post('wm', '/master/uoms', { code: 'G', name: 'Gram' })).body.id;
    ids.tab = (await post('wm', '/master/uoms', { code: 'TAB', name: 'Tablet' })).body.id;
    expectError(await post('wm', '/master/uoms', { code: 'KG', name: 'Dup' }), 409, 'ALREADY_EXISTS');
    expectError(await post('planner', '/master/uoms', { code: 'L', name: 'Litre' }), 403, 'FORBIDDEN');

    ids.catRm = (await post('wm', '/master/item-categories', { code: 'RM', name: 'Raw materials' })).body.id;
    ids.catFg = (await post('wm', '/master/item-categories', { code: 'FG', name: 'Finished goods' })).body.id;
    ids.catOld = (await post('wm', '/master/item-categories', { code: 'OLD', name: 'Old' })).body.id;
    expect((await patch('wm', `/master/item-categories/${ids.catOld}`, { name: 'Retired' })).body.name).toBe('Retired');
  });

  it('deactivates with a reason (never deletes); refuses repeating the same move', async () => {
    expectError(await post('wm', `/master/item-categories/${ids.catOld}/deactivate`, {}), 400, 'VALIDATION_FAILED');
    expect((await post('wm', `/master/item-categories/${ids.catOld}/deactivate`, { reason: 'No longer used' })).status).toBe(204);
    expectError(await post('wm', `/master/item-categories/${ids.catOld}/deactivate`, { reason: 'Again' }), 409, 'INVALID_TRANSITION');
    const { rows } = await client.query(`SELECT reason FROM core.audit_log WHERE table_name = 'master.item_categories' AND record_id = $1 ORDER BY id DESC LIMIT 1`, [
      ids.catOld,
    ]);
    expect(rows[0].reason).toContain('No longer used');
    expect((await request(app).delete(`/api/v1/master/item-categories/${ids.catOld}`).set('Authorization', `Bearer ${tokens.wm}`)).status).toBe(404);
  });

  it('creates items with active references and a sales tax code; code, type and base unit are fixed', async () => {
    const item = (code: string, type: string, extra: Body = {}) =>
      post('wm', '/master/items', { code, name: `${code} name`, type, categoryId: type === 'FG' ? ids.catFg : ids.catRm, baseUomId: ids.kg, ...extra });
    const api = await item('API-PARA', 'API', { shelfLifeDays: 1095, retestDays: 365, storageZone: 'BELOW_25C' });
    expect(api.status).toBe(201);
    expect(api.body).toMatchObject({ code: 'API-PARA', type: 'API', storageZone: 'BELOW_25C', isControlled: false });
    ids.api = api.body.id;
    ids.exc = (await item('EXC-MCC', 'EXCIPIENT')).body.id;
    ids.exc2 = (await item('EXC-LAC', 'EXCIPIENT')).body.id;
    ids.rm = (await item('RM-STARCH', 'RM')).body.id;
    ids.fg = (await item('FG-PARA500', 'FG', { taxCodeId: ids.gst, baseUomId: ids.tab })).body.id;
    ids.fg2 = (await item('FG-PARA250', 'FG', { baseUomId: ids.tab })).body.id;
    ids.spare = (await item('SP-BELT', 'SPARE')).body.id;

    expectError(await item('X-1', 'RM', { taxCodeId: ids.wht }), 400, 'VALIDATION_FAILED');
    expectError(await item('X-2', 'RM', { categoryId: ids.catOld }), 400, 'VALIDATION_FAILED');
    expectError(await item('X-3', 'RM', { categoryId: '999999' }), 400, 'VALIDATION_FAILED');
    expectError(await item('X-4', 'RM', { shelfLifeDays: 100, retestDays: 200 }), 400, 'VALIDATION_FAILED');
    expectError(await patch('wm', `/master/items/${ids.api}`, { type: 'RM' }), 400, 'VALIDATION_FAILED');
    expectError(await patch('wm', `/master/items/${ids.api}`, { retestDays: 2000 }), 400, 'VALIDATION_FAILED');
    expect((await patch('wm', `/master/items/${ids.api}`, { isControlled: true })).body.isControlled).toBe(true);

    const fgOnly = await get('ceo', '/master/items?type=FG');
    expect(fgOnly.body.items.map((i: Body) => i.code)).toEqual(['FG-PARA250', 'FG-PARA500']);
    expect((await get('ceo', '/master/items?search=para')).body.total).toBe(3);
  });

  it('creates items as DRAFT; QA activates GMP items, another item keeper activates non-GMP items', async () => {
    expect((await get('wm', `/master/items/${ids.api}`)).body).toMatchObject({ status: 'DRAFT', isActive: false });
    expectError(await post('planner', `/master/items/${ids.api}/activate`), 403, 'FORBIDDEN');
    // GMP item: the creator cannot, and neither can another item keeper without master.item.approve.
    expectError(await post('wm', `/master/items/${ids.api}/activate`), 403, 'SEGREGATION_OF_DUTIES');
    expectError(await post('pm', `/master/items/${ids.api}/activate`), 403, 'FORBIDDEN');
    expect((await get('wm', `/master/items/${ids.api}`)).body.status).toBe('DRAFT');
    expect((await post('qam', `/master/items/${ids.api}/activate`)).body).toMatchObject({ status: 'ACTIVE', isActive: true });
    for (const k of ['exc', 'exc2', 'rm', 'fg', 'fg2']) {
      expect((await post('qam', `/master/items/${ids[k]}/activate`)).body.status).toBe('ACTIVE');
    }
    // Non-GMP item: not the creator, not QA (no master.item.manage); another item keeper does it.
    expectError(await post('wm', `/master/items/${ids.spare}/activate`), 403, 'SEGREGATION_OF_DUTIES');
    expectError(await post('qam', `/master/items/${ids.spare}/activate`), 403, 'FORBIDDEN');
    expect((await post('pm', `/master/items/${ids.spare}/activate`)).body.status).toBe('ACTIVE');
    expect(await history('master.items', ids.api)).toEqual(['->DRAFT', 'DRAFT>ACTIVE']);
    expect((await get('ceo', '/master/items?status=DRAFT')).body.total).toBe(0);
  });

  it('refuses a DRAFT item as a reference until it is activated', async () => {
    const draft = await post('wm', '/master/items', { code: 'FG-DRAFT', name: 'Draft FG', type: 'FG', categoryId: ids.catFg, baseUomId: ids.tab });
    expect(draft.body.status).toBe('DRAFT');
    expectError(await post('sm', '/master/products', { itemId: draft.body.id }), 400, 'VALIDATION_FAILED');
  });

  it('deactivates and reactivates with a reason: GMP by QA only; a non-GMP item not by the person who deactivated it', async () => {
    expectError(await post('wm', `/master/items/${ids.rm}/deactivate`, { reason: 'Discontinued' }), 403, 'FORBIDDEN');
    expectError(await post('qam', `/master/items/${ids.rm}/deactivate`, {}), 400, 'VALIDATION_FAILED');
    expect((await post('qam', `/master/items/${ids.rm}/deactivate`, { reason: 'Supplier change' })).body.status).toBe('INACTIVE');
    expectError(await post('pm', `/master/items/${ids.rm}/activate`, { reason: 'Back in use' }), 403, 'FORBIDDEN');
    expect((await post('qam', `/master/items/${ids.rm}/activate`, { reason: 'Back in use' })).body.status).toBe('ACTIVE');
    expectError(await post('qam', `/master/items/${ids.rm}/activate`, { reason: 'Again' }), 409, 'INVALID_TRANSITION');

    expect((await post('wm', `/master/items/${ids.spare}/deactivate`, { reason: 'Obsolete belt' })).body.status).toBe('INACTIVE');
    expectError(await post('wm', `/master/items/${ids.spare}/activate`, { reason: 'Changed my mind' }), 403, 'SEGREGATION_OF_DUTIES');
    expect((await post('pm', `/master/items/${ids.spare}/activate`, { reason: 'Still in use' })).body.status).toBe('ACTIVE');
    expect(await history('master.items', ids.spare)).toEqual(['->DRAFT', 'DRAFT>ACTIVE', 'ACTIVE>INACTIVE', 'INACTIVE>ACTIVE']);
  });

  it('needs a QA countersign to change GMP fields of a GMP item after DRAFT; other fields and non-GMP items stay free', async () => {
    const url = `/master/items/${ids.api}`;
    expect((await patch('wm', url, { name: 'Paracetamol API' })).body.name).toBe('Paracetamol API');
    for (const change of [{ shelfLifeDays: 730 }, { retestDays: 180 }, { storageZone: 'COLD_2_8C' }, { isControlled: false }]) {
      expectError(await patch('wm', url, change), 403, 'COUNTERSIGN_REQUIRED');
    }
    expectError(await patch('wm', url, { shelfLifeDays: 730, countersign: countersign('pm') }), 403, 'FORBIDDEN');
    expectError(await patch('wm', url, { shelfLifeDays: 730, countersign: countersign('wm') }), 403, 'SEGREGATION_OF_DUTIES');
    expect((await get('wm', url)).body.shelfLifeDays).toBe(1095);
    const ok = await patch('wm', url, { shelfLifeDays: 730, countersign: countersign('qam') });
    expect(ok.body).toMatchObject({ shelfLifeDays: 730, status: 'ACTIVE' });
    // Same value again is not a change: no countersign needed.
    expect((await patch('wm', url, { shelfLifeDays: 730 })).status).toBe(200);
    expect((await patch('wm', `/master/items/${ids.spare}`, { storageZone: 'COLD_2_8C' })).body.storageZone).toBe('COLD_2_8C');
  });

  it('adds unit conversions (never edited: deactivate and add a new one)', async () => {
    const conv = await post('wm', '/master/uom-conversions', { fromUomId: ids.kg, toUomId: ids.g, factor: '1000' });
    expect(conv.status).toBe(201);
    expect(conv.body).toMatchObject({ itemId: null, factor: '1000.000000' });
    expectError(await post('wm', '/master/uom-conversions', { fromUomId: ids.kg, toUomId: ids.kg, factor: '1' }), 400, 'VALIDATION_FAILED');
    expectError(await post('wm', '/master/uom-conversions', { fromUomId: ids.kg, toUomId: ids.g, factor: '0' }), 400, 'VALIDATION_FAILED');
    expectError(await post('wm', '/master/uom-conversions', { fromUomId: ids.kg, toUomId: ids.g, factor: '1000' }), 409, 'ALREADY_EXISTS');
    expect((await patch('wm', `/master/uom-conversions/${conv.body.id}`, { factor: '999' })).status).toBe(404);
    expect((await post('wm', `/master/uom-conversions/${conv.body.id}/deactivate`, { reason: 'Wrong factor' })).status).toBe(204);
    expect((await post('wm', '/master/uom-conversions', { fromUomId: ids.kg, toUomId: ids.g, factor: '1000' })).status).toBe(201);
  });
});

describe('warehouses and locations (master.location.manage)', () => {
  it('lets the Warehouse Manager keep them; a location needs an active warehouse', async () => {
    const wh = await post('wm', '/master/warehouses', { code: 'main', name: 'Main store' });
    expect(wh.status).toBe(201);
    ids.wh = wh.body.id;
    const loc = await post('wm', '/master/locations', { warehouseId: ids.wh, code: 'A-01', name: 'Rack A1', storageZone: 'COLD_2_8C' });
    expect(loc.body).toMatchObject({ code: 'A-01', storageZone: 'COLD_2_8C' });
    expectError(await post('wm', '/master/locations', { warehouseId: ids.wh, code: 'A-01', name: 'Dup' }), 409, 'ALREADY_EXISTS');
    expectError(await post('planner', '/master/warehouses', { code: 'X', name: 'X' }), 403, 'FORBIDDEN');

    const old = await post('wm', '/master/warehouses', { code: 'OLD', name: 'Old store' });
    await post('wm', `/master/warehouses/${old.body.id}/deactivate`, { reason: 'Closed' });
    expectError(await post('wm', '/master/locations', { warehouseId: old.body.id, code: 'B-01', name: 'B1' }), 400, 'VALIDATION_FAILED');
    expect((await get('wm', `/master/locations?warehouseId=${ids.wh}`)).body.total).toBe(1);
  });
});

describe('customers (DRAFT → ACTIVE by another person; sensitive edits countersigned)', () => {
  it('creates a DRAFT through core/transition and needs an NTN or CNIC', async () => {
    expectError(await post('se', '/master/customers', { code: 'C-1', name: 'No tax id' }), 400, 'VALIDATION_FAILED');
    expectError(await post('se', '/master/customers', { code: 'C-1', name: 'Bad NTN', ntn: '12AB' }), 400, 'VALIDATION_FAILED');
    const c = await post('se', '/master/customers', { code: 'cust-1', name: 'City Pharmacy', ntn: '1234567-8', creditLimit: '100000' });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ code: 'CUST-1', status: 'DRAFT', creditLimit: '100000.00' });
    ids.cust = c.body.id;
    expect(await history('master.customers', ids.cust)).toEqual(['->DRAFT']);
    expectError(await post('pm', '/master/customers', { code: 'C-2', name: 'X', ntn: '1234567' }), 403, 'FORBIDDEN');
  });

  it('refuses activation without the approve key and by the creator; the Sales Manager activates', async () => {
    expectError(await post('se', `/master/customers/${ids.cust}/activate`), 403, 'FORBIDDEN');
    const own = await post('sesm', '/master/customers', { code: 'CUST-2', name: 'Own draft', cnic: '35202-1234567-1' });
    expectError(await post('sesm', `/master/customers/${own.body.id}/activate`), 403, 'SEGREGATION_OF_DUTIES');
    // Editing someone else's draft also makes you unable to activate it.
    await patch('sesm', `/master/customers/${ids.cust}`, { name: 'City Pharmacy (Pvt) Ltd' });
    expectError(await post('sesm', `/master/customers/${ids.cust}/activate`), 403, 'SEGREGATION_OF_DUTIES');
    const ok = await post('sm', `/master/customers/${ids.cust}/activate`);
    expect(ok.body.status).toBe('ACTIVE');
    expect(await history('master.customers', ids.cust)).toEqual(['->DRAFT', 'DRAFT>ACTIVE']);
    expectError(await post('sm', `/master/customers/${ids.cust}/activate`), 409, 'INVALID_TRANSITION');
    expectError(await patch('se', `/master/customers/${ids.cust}`, { status: 'INACTIVE' }), 400, 'VALIDATION_FAILED');
  });

  it('edits non-sensitive fields of an active customer freely', async () => {
    const res = await patch('se', `/master/customers/${ids.cust}`, { paymentTermsDays: 30, creditLimit: '100000.00' });
    expect(res.status).toBe(200);
    expect(res.body.paymentTermsDays).toBe(30);
  });

  it('needs a countersign from an approve-key holder (not the editor) to change credit limit or tax ids', async () => {
    const url = `/master/customers/${ids.cust}`;
    expectError(await patch('se', url, { creditLimit: '500000' }), 403, 'COUNTERSIGN_REQUIRED');
    expectError(await patch('se', url, { creditLimit: '500000', countersign: countersign('se2') }), 403, 'FORBIDDEN');
    expectError(await patch('se', url, { creditLimit: '500000', countersign: countersign('sm', 'Wrong-Password-1') }), 403, 'ESIGN_FAILED');
    expectError(await patch('se', url, { creditLimit: '500000', countersign: countersign('se') }), 403, 'SEGREGATION_OF_DUTIES');
    expectError(await patch('se', url, { creditLimit: '500000', countersign: { ...countersign('sm'), meaning: 'REVIEWED' } }), 403, 'ESIGN_FAILED');
    expect((await get('se', url)).body.creditLimit).toBe('100000.00');

    const ok = await patch('se', url, { creditLimit: '500000', countersign: countersign('sm') });
    expect(ok.body.creditLimit).toBe('500000.00');
    const { rows } = await client.query(
      `SELECT user_id::text AS u, meaning FROM core.e_signatures WHERE record_table = 'master.customers' AND record_id = $1`,
      [ids.cust],
    );
    expect(rows).toEqual([{ u: userIds.sm, meaning: 'APPROVED' }]);
  });

  it('deactivates and reactivates with a reason', async () => {
    expectError(await post('sm', `/master/customers/${ids.cust}/deactivate`, {}), 400, 'VALIDATION_FAILED');
    expect((await post('sm', `/master/customers/${ids.cust}/deactivate`, { reason: 'Licence expired' })).body.status).toBe('INACTIVE');
    expectError(await post('sm', `/master/customers/${ids.cust}/activate`, {}), 400, 'VALIDATION_FAILED');
    expect((await post('sm', `/master/customers/${ids.cust}/activate`, { reason: 'Licence renewed' })).body.status).toBe('ACTIVE');
    expect((await get('ceo', '/master/customers?status=ACTIVE')).body.items.map((c: Body) => c.code)).toEqual(['CUST-1']);
  });

  it('keeps one default address per type', async () => {
    const a1 = await post('se', `/master/customers/${ids.cust}/addresses`, { type: 'BILLING', line1: 'Mall Road', city: 'Lahore', isDefault: true });
    expect(a1.status).toBe(201);
    const a2 = await post('se', `/master/customers/${ids.cust}/addresses`, { type: 'BILLING', line1: 'Gulberg', city: 'Lahore', isDefault: true });
    const list = (await get('se', `/master/customers/${ids.cust}/addresses`)).body as Body[];
    expect(list.map((a) => [a.id, a.isDefault])).toEqual([
      [a1.body.id, false],
      [a2.body.id, true],
    ]);
    expectError(await post('pm', `/master/customers/${ids.cust}/addresses`, { type: 'SHIPPING', line1: 'X', city: 'Y' }), 403, 'FORBIDDEN');
  });
});

describe('vendors', () => {
  it('needs NTN/CNIC for a local vendor and a non-PK country for a foreign one', async () => {
    expectError(await post('po', '/master/vendors', { code: 'V-1', name: 'Local' }), 400, 'VALIDATION_FAILED');
    expectError(await post('po', '/master/vendors', { code: 'V-1', name: 'Foreign', isForeign: true }), 400, 'VALIDATION_FAILED');
    const f = await post('po', '/master/vendors', { code: 'V-CN', name: 'Shandong API', isForeign: true, country: 'CN', currency: 'usd' });
    expect(f.body).toMatchObject({ status: 'DRAFT', currency: 'USD' });
    ids.vendorForeign = f.body.id;
  });

  it('is activated by the Purchase Manager; bank changes on an active vendor need the countersign', async () => {
    const v = await post('po', '/master/vendors', { code: 'V-LOCAL', name: 'Karachi Chemicals', ntn: '7654321', bankAccount: 'PK36SCBL0000001123456702' });
    ids.vendor = v.body.id;
    expectError(await post('po', `/master/vendors/${ids.vendor}/activate`), 403, 'FORBIDDEN');
    expect((await post('pm', `/master/vendors/${ids.vendor}/activate`)).body.status).toBe('ACTIVE');
    await post('pm', `/master/vendors/${ids.vendorForeign}/activate`);

    const url = `/master/vendors/${ids.vendor}`;
    expectError(await patch('po', url, { bankAccount: 'PK00FRAUD' }), 403, 'COUNTERSIGN_REQUIRED');
    expectError(await patch('po', url, { bankAccount: 'PK00FRAUD', countersign: countersign('po2') }), 403, 'FORBIDDEN');
    expectError(await patch('po', url, { ntn: null }), 400, 'VALIDATION_FAILED');
    expect((await patch('po', url, { name: 'Karachi Chemicals Ltd' })).status).toBe(200);
    const ok = await patch('po', url, { bankAccount: 'PK36SCBL0000001123456799', countersign: countersign('pm') });
    expect(ok.body.bankAccount).toBe('PK36SCBL0000001123456799');
  });
});

describe('approved sources (AVL)', () => {
  it('lets the Purchase Officer propose GMP materials only, from a usable vendor; starts the AVL approval', async () => {
    expectError(await post('po', '/master/approved-sources', { vendorId: ids.vendor, itemId: ids.spare, manufacturer: 'M', manufacturingSite: 'S' }), 400, 'VALIDATION_FAILED');
    expectError(await post('pm', '/master/approved-sources', { vendorId: ids.vendor, itemId: ids.api, manufacturer: 'M', manufacturingSite: 'S' }), 403, 'FORBIDDEN');
    const s = await post('po', '/master/approved-sources', {
      vendorId: ids.vendorForeign,
      itemId: ids.api,
      manufacturer: 'Shandong Pharma',
      manufacturingSite: 'Jinan plant 2',
    });
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ status: 'PENDING', vendorCode: 'V-CN', itemCode: 'API-PARA', attachments: [] });
    expect(s.body.approvalId).toMatch(/^\d+$/);
    ids.source = s.body.id;
    ids.sourceApproval = s.body.approvalId;
    expectError(
      await post('po', '/master/approved-sources', { vendorId: ids.vendorForeign, itemId: ids.api, manufacturer: 'SHANDONG PHARMA', manufacturingSite: 'jinan plant 2' }),
      409,
      'ALREADY_EXISTS',
    );
  });

  it('refuses the QA approval while no evidence is attached; lists the files on the approval for signing', async () => {
    const approve = () => post('qam', `/core/approvals/${ids.sourceApproval}/approve`, { signature: sig('APPROVED') });
    expectError(await approve(), 400, 'VALIDATION_FAILED');
    expect((await get('po', `/master/approved-sources/${ids.source}`)).body.status).toBe('PENDING');

    expectError(await upload('qam', 'master.approved_sources', ids.source), 403, 'FORBIDDEN');
    expect((await upload('po', 'master.approved_sources', ids.source)).status).toBe(201);
    const detail = await get('qam', `/core/approvals/${ids.sourceApproval}`);
    expect(detail.body.attachments.map((a: Body) => a.fileName)).toEqual(['questionnaire.pdf']);

    expect((await approve()).body.status).toBe('APPROVED');
    const s = await get('po', `/master/approved-sources/${ids.source}`);
    expect(s.body.status).toBe('APPROVED');
    expect(s.body.attachments).toHaveLength(1);
    expect(await history('master.approved_sources', ids.source)).toEqual(['->PENDING', 'PENDING>APPROVED']);
  });

  it('moves the source to REJECTED when QA rejects the approval', async () => {
    const s = await post('po', '/master/approved-sources', { vendorId: ids.vendor, itemId: ids.exc, manufacturer: 'Local Mfg', manufacturingSite: 'Site K' });
    const res = await post('qam', `/core/approvals/${s.body.approvalId}/reject`, { signature: sig('REJECTED', 'Audit report missing') });
    expect(res.body.status).toBe('REJECTED');
    expect((await get('po', `/master/approved-sources/${s.body.id}`)).body.status).toBe('REJECTED');
    // A rejected source may be proposed again as a new row.
    expect((await post('po', '/master/approved-sources', { vendorId: ids.vendor, itemId: ids.exc, manufacturer: 'Local Mfg', manufacturingSite: 'Site K' })).status).toBe(201);
  });

  it('lets only the QA Manager block an approved source, with an e-signature (REJECTED) and a reason', async () => {
    const url = `/master/approved-sources/${ids.source}/block`;
    expectError(await post('pm', url, { signature: sig('REJECTED', 'Bad audit') }), 403, 'FORBIDDEN');
    expectError(await post('qam', url, { signature: sig('APPROVED', 'Bad audit') }), 400, 'VALIDATION_FAILED');
    expectError(await post('qam', url, { signature: { ...sig('REJECTED', 'Bad audit'), password: 'Wrong-Password-1' } }), 403, 'ESIGN_FAILED');
    const ok = await post('qam', url, { signature: sig('REJECTED', 'Failed GMP audit 11-2026') });
    expect(ok.body.status).toBe('BLOCKED');
    expect(await history('master.approved_sources', ids.source)).toEqual(['->PENDING', 'PENDING>APPROVED', 'APPROVED>BLOCKED']);
    expectError(await post('qam', url, { signature: sig('REJECTED', 'Again') }), 409, 'INVALID_TRANSITION');
  });
});

describe('products (regulated fields need a QA countersign)', () => {
  it('creates a product on an FG item only', async () => {
    expectError(await post('sm', '/master/products', { itemId: ids.rm }), 400, 'VALIDATION_FAILED');
    expectError(await post('planner', '/master/products', { itemId: ids.fg }), 403, 'FORBIDDEN');
    const p = await post('sm', '/master/products', { itemId: ids.fg });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ itemCode: 'FG-PARA500', registrationNo: null });
    ids.product = p.body.id;
    expectError(await post('sm', '/master/products', { itemId: ids.fg }), 409, 'ALREADY_EXISTS');
  });

  it('needs a countersign by a qa.product.countersign holder to set registration, artwork or agreement', async () => {
    const url = `/master/products/${ids.product}`;
    expectError(await patch('sm', url, { registrationNo: '012345' }), 403, 'COUNTERSIGN_REQUIRED');
    expectError(await patch('sm', url, { registrationNo: '012345', countersign: countersign('pm') }), 403, 'FORBIDDEN');
    const ok = await patch('sm', url, { registrationNo: '012345', artworkVersion: 'A3', countersign: countersign('qam') });
    expect(ok.body).toMatchObject({ registrationNo: '012345', artworkVersion: 'A3' });
    // Sending the same value again is not a change.
    expect((await patch('sm', url, { registrationNo: '012345' })).status).toBe(200);
    expectError(await post('sm', '/master/products', { itemId: ids.fg2, registrationNo: '99' }), 403, 'COUNTERSIGN_REQUIRED');
    const p2 = await post('sm', '/master/products', { itemId: ids.fg2, registrationNo: '99', countersign: countersign('qam') });
    expect(p2.status).toBe(201);
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM core.e_signatures WHERE record_table = 'master.products'`);
    expect(rows[0].n).toBe(2);
  });
});

describe('deactivating a master still in use (owner 2026-11-19, 0021)', () => {
  it('refuses a UoM, category or tax code used by an ACTIVE item or by an item an active product sells; a DRAFT item does not block', async () => {
    const uom = (await post('wm', '/master/uoms', { code: 'BOXG', name: 'Box (guard test)' })).body.id as string;
    const cat = (await post('wm', '/master/item-categories', { code: 'FGG', name: 'FG (guard test)' })).body.id as string;
    const tax = (await post('fm', '/master/tax-codes', { code: 'GSTG', name: 'Sales tax (guard test)', kind: 'SALES_TAX', rate: '17' })).body.id as string;
    const refs: [string, string, string][] = [
      ['wm', 'uoms', uom],
      ['wm', 'item-categories', cat],
      ['fm', 'tax-codes', tax],
    ];
    const toggle = async (expectStatus: 204 | 409) => {
      for (const [who, path, id] of refs) {
        const res = await post(who, `/master/${path}/${id}/deactivate`, { reason: 'Guard test' });
        if (expectStatus === 409) {
          expectError(res, 409, 'IN_USE');
        } else {
          expect(res.status).toBe(204);
          expect((await post(who, `/master/${path}/${id}/activate`, { reason: 'Guard test' })).status).toBe(204);
        }
      }
    };
    const fg = await post('wm', '/master/items', { code: 'FG-GUARD', name: 'Guard FG', type: 'FG', categoryId: cat, baseUomId: uom, taxCodeId: tax });
    expect(fg.body.status).toBe('DRAFT');
    await toggle(204); // only a DRAFT item uses them
    // ... but the item becomes ACTIVE only while all three are active.
    for (const [who, path, id] of refs) {
      expect((await post(who, `/master/${path}/${id}/deactivate`, { reason: 'Guard test' })).status).toBe(204);
      expectError(await post('qam', `/master/items/${fg.body.id}/activate`), 400, 'VALIDATION_FAILED');
      expect((await post(who, `/master/${path}/${id}/activate`, { reason: 'Guard test' })).status).toBe(204);
    }
    expect((await post('qam', `/master/items/${fg.body.id}/activate`)).body.status).toBe('ACTIVE');
    await toggle(409); // an ACTIVE item uses them
    const product = await post('sm', '/master/products', { itemId: fg.body.id });
    expect(product.status).toBe(201);
    expect((await post('qam', `/master/items/${fg.body.id}/deactivate`, { reason: 'Guard test' })).body.status).toBe('INACTIVE');
    await toggle(409); // the item is INACTIVE but an active product still sells it
    expect((await post('sm', `/master/products/${product.body.id}/deactivate`, { reason: 'Guard test' })).status).toBe(204);
    await toggle(204); // nothing active uses them any more; reactivation is never refused
  });
});

describe('master formulas (versions, QA approval, one APPROVED per product)', () => {
  const lines = () => [
    { itemId: ids.api, qtyPerBatch: '50', uomId: ids.kg, isApi: true, assayBasis: 'DRIED' },
    { itemId: ids.exc, qtyPerBatch: '40.5', uomId: ids.kg, isFiller: true },
    { itemId: ids.exc2, qtyPerBatch: '9.5', uomId: ids.kg },
  ];

  it('lets the Production Manager draft version 1 (QA Officer cannot); a first version needs its batch size', async () => {
    expectError(await post('prodm', '/master/formulas', { productId: ids.product }), 400, 'VALIDATION_FAILED');
    expectError(await post('qao', '/master/formulas', { productId: ids.product, batchSize: '100', batchUomId: ids.kg }), 403, 'FORBIDDEN');
    expectError(await post('planner', '/master/formulas', { productId: ids.product, batchSize: '100', batchUomId: ids.kg }), 403, 'FORBIDDEN');
    const f = await post('prodm', '/master/formulas', { productId: ids.product, batchSize: '100', batchUomId: ids.kg });
    expect(f.status).toBe(201);
    expect(f.body).toMatchObject({ version: 1, status: 'DRAFT', batchSize: '100.0000', lines: [] });
    ids.f1 = f.body.id;
    expectError(await post('prodm', '/master/formulas', { productId: ids.product, batchSize: '100', batchUomId: ids.kg }), 409, 'ALREADY_EXISTS');
  });

  it('validates lines', async () => {
    const url = `/master/formulas/${ids.f1}/lines`;
    expectError(await put('prodm', url, { lines: [{ itemId: ids.api, qtyPerBatch: '1', uomId: ids.kg, isApi: true }] }), 400, 'VALIDATION_FAILED');
    expectError(await put('prodm', url, { lines: [{ itemId: ids.exc, qtyPerBatch: '1', uomId: ids.kg, isApi: true, assayBasis: 'AS_IS' }] }), 400, 'VALIDATION_FAILED');
    expectError(await put('prodm', url, { lines: [{ itemId: ids.fg, qtyPerBatch: '1', uomId: ids.kg }] }), 400, 'VALIDATION_FAILED');
    expectError(await put('prodm', url, { lines: [{ itemId: ids.exc, qtyPerBatch: '0', uomId: ids.kg }] }), 400, 'VALIDATION_FAILED');
    expectError(
      await put('prodm', url, { lines: [{ itemId: ids.exc, qtyPerBatch: '1', uomId: ids.kg, isFiller: true }, { itemId: ids.exc2, qtyPerBatch: '1', uomId: ids.kg, isFiller: true }] }),
      400,
      'VALIDATION_FAILED',
    );
  });

  it('refuses to submit an API formula without a filler line (DB completeness check)', async () => {
    await put('prodm', `/master/formulas/${ids.f1}/lines`, { lines: [lines()[0], lines()[2]] });
    expectError(await post('prodm', `/master/formulas/${ids.f1}/submit`), 400, 'VALIDATION_FAILED');
    expect((await get('prodm', `/master/formulas/${ids.f1}`)).body.status).toBe('DRAFT');
  });

  it('submits, locks the draft, and returns it to DRAFT when QA rejects', async () => {
    const set = await put('prodm', `/master/formulas/${ids.f1}/lines`, { lines: lines() });
    expect(set.body.lines.map((l: Body) => [l.lineNo, l.itemCode, l.isApi, l.isFiller])).toEqual([
      [1, 'API-PARA', true, false],
      [2, 'EXC-MCC', false, true],
      [3, 'EXC-LAC', false, false],
    ]);
    const sub = await post('prodm', `/master/formulas/${ids.f1}/submit`);
    expect(sub.body.status).toBe('PENDING_APPROVAL');
    expectError(await patch('prodm', `/master/formulas/${ids.f1}`, { notes: 'late change' }), 409, 'RECORD_LOCKED');
    expectError(await put('prodm', `/master/formulas/${ids.f1}/lines`, { lines: lines() }), 409, 'RECORD_LOCKED');

    const rej = await post('qam', `/core/approvals/${sub.body.approvalId}/reject`, { signature: sig('REJECTED', 'Check filler quantity') });
    expect(rej.body.status).toBe('REJECTED');
    expect((await get('prodm', `/master/formulas/${ids.f1}`)).body.status).toBe('DRAFT');
  });

  it('is approved by the QA Manager only (not the drafter)', async () => {
    const sub = await post('prodm', `/master/formulas/${ids.f1}/submit`);
    expectError(await post('prodm', `/core/approvals/${sub.body.approvalId}/approve`, { signature: sig('APPROVED') }), 403, 'SEGREGATION_OF_DUTIES');
    expectError(await post('sm', `/core/approvals/${sub.body.approvalId}/approve`, { signature: sig('APPROVED') }), 403, 'FORBIDDEN');
    expect((await post('qam', `/core/approvals/${sub.body.approvalId}/approve`, { signature: sig('APPROVED') })).body.status).toBe('APPROVED');
    expect((await get('prodm', `/master/formulas/${ids.f1}`)).body.status).toBe('APPROVED');
    expect(await history('master.master_formulas', ids.f1)).toEqual([
      '->DRAFT',
      'DRAFT>PENDING_APPROVAL',
      'PENDING_APPROVAL>DRAFT',
      'DRAFT>PENDING_APPROVAL',
      'PENDING_APPROVAL>APPROVED',
    ]);
  });

  it('copies the latest version into version 2; approving it makes version 1 OBSOLETE', async () => {
    const v2 = await post('prodm', '/master/formulas', { productId: ids.product, notes: 'Lactose reduced' });
    expect(v2.body).toMatchObject({ version: 2, status: 'DRAFT', batchSize: '100.0000', notes: 'Lactose reduced' });
    expect(v2.body.lines.map((l: Body) => [l.itemCode, l.qtyPerBatch, l.assayBasis])).toEqual([
      ['API-PARA', '50.0000', 'DRIED'],
      ['EXC-MCC', '40.5000', null],
      ['EXC-LAC', '9.5000', null],
    ]);
    const sub = await post('prodm', `/master/formulas/${v2.body.id}/submit`);
    await post('qam', `/core/approvals/${sub.body.approvalId}/approve`, { signature: sig('APPROVED') });
    expect((await get('prodm', `/master/formulas/${ids.f1}`)).body.status).toBe('OBSOLETE');
    expect((await get('prodm', `/master/formulas/${v2.body.id}`)).body.status).toBe('APPROVED');
    const approved = await get('ceo', `/master/formulas?productId=${ids.product}&status=APPROVED`);
    expect(approved.body.items.map((f: Body) => f.version)).toEqual([2]);
  });

  it('lists products and formulas by searching the FG item code or name (web pickers, task 9)', async () => {
    const products = await get('ceo', '/master/products?search=para500');
    expect(products.body.items.map((p: Body) => p.itemCode)).toEqual(['FG-PARA500']);
    expect(products.body.total).toBe(1);
    expect((await get('ceo', '/master/products?search=012345')).body.items.map((p: Body) => p.itemCode)).toEqual(['FG-PARA500']);
    expect((await get('ceo', '/master/products?search=no-such-product')).body.total).toBe(0);
    const formulas = await get('ceo', '/master/formulas?search=FG-PARA500');
    expect(formulas.body.items.map((f: Body) => f.version).sort()).toEqual([1, 2]);
    expect(formulas.body.total).toBe(2);
    expect((await get('ceo', '/master/formulas?search=no-such-product')).body.total).toBe(0);
  });
});

describe('price lists (master.price.manage)', () => {
  it('lets the Sales Manager keep price lists with money as exact decimals', async () => {
    expectError(await post('sm', '/master/price-lists', { code: 'PL', name: 'X', validFrom: '2026-07-01', validTo: '2026-06-30' }), 400, 'VALIDATION_FAILED');
    expectError(await post('se', '/master/price-lists', { code: 'PL', name: 'X', validFrom: '2026-07-01' }), 403, 'FORBIDDEN');
    const pl = await post('sm', '/master/price-lists', { code: 'TP-2627', name: 'Trade price FY26-27', validFrom: '2026-07-01' });
    expect(pl.body).toMatchObject({ currency: 'PKR', validTo: null, lines: [] });
    const line = await post('sm', `/master/price-lists/${pl.body.id}/lines`, { itemId: ids.fg, uomId: ids.tab, unitPrice: '12.50' });
    expect(line.body.unitPrice).toBe('12.500000'); // a unit price is a 6-decimal rate (owner 2026-11-25)
    expectError(await post('sm', `/master/price-lists/${pl.body.id}/lines`, { itemId: ids.fg, uomId: ids.tab, unitPrice: '13' }), 409, 'ALREADY_EXISTS');
    expectError(await post('sm', `/master/price-lists/${pl.body.id}/lines`, { itemId: ids.fg2, uomId: ids.tab, unitPrice: '1.0000005' }), 400, 'VALIDATION_FAILED');
    expect((await patch('sm', `/master/price-list-lines/${line.body.id}`, { unitPrice: '0.035' })).body.unitPrice).toBe('0.035000');
    expect((await get('ceo', `/master/price-lists/${pl.body.id}`)).body.lines).toHaveLength(1);
  });
});
