// M3 task 2: exchange rates (owner Q4), purchase requisitions (owner Q6) and purchase orders with the approval
// matrix, the AVL block and PO segregation — the happy path and every refusal, through the real HTTP endpoints,
// plus the database guards of 0023.
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
const users: Record<string, string> = {};
const ids: Record<string, string> = {};

const PO_DATE = '2026-11-20';

function call(who: string, method: 'get' | 'post' | 'patch', url: string, body?: object) {
  const r = request(app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`);
  return body ? r.send(body) : r;
}
const sign = (meaning: 'APPROVED' | 'REJECTED', reason = 'Checked the order') => ({ signature: { password: TEST_PASSWORD, meaning, reason } });

async function inTx<T>(userId: string, work: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.user_id', $1, true), set_config('app.company_id', '1', true)`, [userId]);
    const out = await work();
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
const one = async (text: string, params: unknown[] = []) => (await client.query<{ id: string }>(text, params)).rows[0]!.id;
const history = (table: string, id: string, from: string | null, to: string, actor: string) =>
  client.query(`INSERT INTO core.status_history (entity_table, entity_id, from_status, to_status, actor_id) VALUES ($1, $2, $3, $4, $5)`, [
    table, id, from, to, actor,
  ]);
const raw = (statement: string, params: unknown[] = [], userId = '1') => inTx(userId, () => client.query(statement, params));

async function vendor(code: string, opts: { foreign?: boolean; currency?: string; active?: boolean } = {}): Promise<string> {
  const id = await inTx(users.buyer!, async () => {
    const v = await one(
      `INSERT INTO master.vendors (code, name, ntn, is_foreign, country, currency, status)
       VALUES ($1, $1, $2, $3, $4, $5, 'DRAFT') RETURNING id`,
      [code, opts.foreign ? null : '1234567', opts.foreign ?? false, opts.foreign ? 'CN' : 'PK', opts.currency ?? 'PKR'],
    );
    await history('master.vendors', v, null, 'DRAFT', users.buyer!);
    return v;
  });
  if (opts.active !== false) {
    await inTx(users.pm!, async () => {
      await history('master.vendors', id, 'DRAFT', 'ACTIVE', users.pm!);
      await client.query(`UPDATE master.vendors SET status = 'ACTIVE' WHERE id = $1`, [id]);
    });
  }
  return id;
}

async function item(code: string, type: string, active = true): Promise<string> {
  const id = await inTx(users.wm!, async () => {
    const i = await one(
      `INSERT INTO master.items (code, name, type, category_id, base_uom_id, status) VALUES ($1, $1, $2, $3, $4, 'DRAFT') RETURNING id`,
      [code, type, ids.category, ids.uom],
    );
    await history('master.items', i, null, 'DRAFT', users.wm!);
    return i;
  });
  if (active) {
    const activator = ['SPARE', 'CONSUMABLE'].includes(type) ? users.pm! : users.qa!; // non-GMP: master.item.manage
    await inTx(activator, async () => {
      await history('master.items', id, 'DRAFT', 'ACTIVE', activator);
      await client.query(`UPDATE master.items SET status = 'ACTIVE' WHERE id = $1`, [id]);
    });
  }
  return id;
}

async function approvedSource(vendorId: string, itemId: string): Promise<string> {
  const id = await inTx(users.buyer!, async () => {
    const s = await one(
      `INSERT INTO master.approved_sources (vendor_id, item_id, manufacturer, manufacturing_site, status)
       VALUES ($1, $2, 'Maker Ltd', 'Site A', 'PENDING') RETURNING id`,
      [vendorId, itemId],
    );
    await history('master.approved_sources', s, null, 'PENDING', users.buyer!);
    return s;
  });
  await inTx(users.qa!, async () => {
    await history('master.approved_sources', id, 'PENDING', 'APPROVED', users.qa!);
    await client.query(`UPDATE master.approved_sources SET status = 'APPROVED' WHERE id = $1`, [id]);
  });
  return id;
}

async function approvalOf(poId: string) {
  const { rows } = await client.query<{ id: string; status: string; measured_amount: string | null }>(
    `SELECT id, status, measured_amount FROM core.approvals WHERE doc_table = 'purch.purchase_orders' AND doc_id = $1 ORDER BY id DESC LIMIT 1`,
    [poId],
  );
  return rows[0]!;
}

const localPo = (vendorId: string, lines: { itemId: string; qty: string; unitPrice: string }[]) => ({
  poDate: PO_DATE,
  vendorId,
  poType: 'LOCAL',
  currency: 'PKR',
  lines,
});

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  for (const [name, roles] of [
    ['buyer', ['PURCHASE_OFFICER']],
    ['buyer2', ['PURCHASE_OFFICER']],
    ['buyerpm', ['PURCHASE_OFFICER', 'PURCHASE_MANAGER']],
    ['pm', ['PURCHASE_MANAGER']],
    ['fm', ['FINANCE_MANAGER']],
    ['store', ['STOREKEEPER']],
    ['wm', ['WAREHOUSE_MANAGER']],
    ['qa', ['QA_MANAGER']],
    ['ceo', ['CEO']],
  ] as const) {
    users[name] = await createTestUser({ username: `pr_${name}`, roleCodes: [...roles] });
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: `pr_${name}`, password: TEST_PASSWORD });
    tokens[name] = res.body.accessToken as string;
  }
  await inTx('1', async () => {
    ids.uom = await one(`INSERT INTO master.uoms (code, name) VALUES ('KG', 'Kilogram') RETURNING id`);
    ids.category = await one(`INSERT INTO master.item_categories (code, name) VALUES ('RM', 'Raw material') RETURNING id`);
  });
  ids.api = await item('API-1', 'API');
  ids.rm = await item('RM-1', 'RM');
  ids.spare = await item('SP-1', 'SPARE');
  ids.fg = await item('FG-1', 'FG');
  ids.draftItem = await item('RM-D', 'RM', false);
  ids.vendor = await vendor('V-LOCAL');
  ids.other = await vendor('V-OTHER');
  ids.foreign = await vendor('V-CHINA', { foreign: true, currency: 'USD' });
  ids.inactive = await vendor('V-DRAFT', { active: false });
  await approvedSource(ids.vendor, ids.api);
  await approvedSource(ids.vendor, ids.rm);
  ids.foreignSource = await approvedSource(ids.foreign, ids.api);
});

afterAll(async () => {
  await client.end();
});

// ------------------------------------------------------------------ exchange rates (owner Q4)

describe('daily exchange rates (fin.rate.manage, Finance Manager)', () => {
  it('lets the Finance Manager enter a rate, and Finance and Procurement read it', async () => {
    const res = await call('fm', 'post', '/fin/exchange-rates', { currency: 'usd', rateDate: PO_DATE, rate: '280.5000', source: 'SBP' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ currency: 'USD', rateDate: PO_DATE, rate: '280.5000', source: 'SBP' });
    expect((await call('buyer', 'get', '/fin/exchange-rates?currency=USD')).body).toHaveLength(1);
    expect((await call('ceo', 'get', '/fin/exchange-rates')).status).toBe(200);
  });

  it('refuses anyone else, PKR, a zero rate, and a correction without a reason', async () => {
    expect((await call('buyer', 'post', '/fin/exchange-rates', { currency: 'USD', rateDate: PO_DATE, rate: '1', source: 'SBP' })).status).toBe(403);
    expect((await call('fm', 'post', '/fin/exchange-rates', { currency: 'PKR', rateDate: PO_DATE, rate: '1', source: 'SBP' })).status).toBe(400);
    expect((await call('fm', 'post', '/fin/exchange-rates', { currency: 'EUR', rateDate: PO_DATE, rate: '0', source: 'SBP' })).status).toBe(400);
    const noReason = await call('fm', 'post', '/fin/exchange-rates', { currency: 'USD', rateDate: PO_DATE, rate: '281', source: 'SBP' });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.details).toMatchObject({ field: 'reason' });
  });

  it('corrects a rate with a reason, keeping the old value in the audit log; currency and date never change', async () => {
    const res = await call('fm', 'post', '/fin/exchange-rates', { currency: 'USD', rateDate: PO_DATE, rate: '280.2500', source: 'SBP', reason: 'Typo in the rate' });
    expect(res.body.rate).toBe('280.2500');
    const { rows } = await client.query(
      `SELECT old_data->>'rate' AS old, new_data->>'rate' AS new, reason FROM core.audit_log WHERE table_name = 'fin.exchange_rates' AND action = 'UPDATE'`,
    );
    expect(rows).toEqual([{ old: '280.5000', new: '280.2500', reason: 'Typo in the rate' }]);
    await expect(raw(`UPDATE fin.exchange_rates SET rate_date = '2026-11-21' WHERE currency = 'USD'`)).rejects.toThrow(/FORBIDDEN/);
    await expect(raw(`DELETE FROM fin.exchange_rates`)).rejects.toThrow();
  });
});

// ------------------------------------------------------------------ requisitions (owner Q6)

describe('purchase requisitions: DRAFT → SUBMITTED → CONVERTED, no approval', () => {
  it('creates, edits and submits a requisition; it is locked after submit', async () => {
    const res = await call('buyer', 'post', '/purch/prs', {
      prDate: PO_DATE,
      department: 'Production',
      lines: [{ itemId: ids.api, qty: '10' }],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ docNo: 'PR-2627-00001', status: 'DRAFT', createdByName: expect.any(String) });
    ids.pr = res.body.id;

    const edited = await call('buyer', 'patch', `/purch/prs/${ids.pr}`, {
      prDate: PO_DATE,
      requiredBy: '2026-12-15',
      department: 'Production',
      lines: [{ itemId: ids.api, qty: '10.5' }, { itemId: ids.rm, qty: '200' }, { itemId: ids.spare, qty: '2' }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.lines.map((l: { itemCode: string; qty: string }) => [l.itemCode, l.qty])).toEqual([
      ['API-1', '10.5000'],
      ['RM-1', '200.0000'],
      ['SP-1', '2.0000'],
    ]);

    expect((await call('buyer', 'post', `/purch/prs/${ids.pr}/submit`)).body.status).toBe('SUBMITTED');
    const locked = await call('buyer', 'patch', `/purch/prs/${ids.pr}`, { prDate: PO_DATE, lines: [{ itemId: ids.api, qty: '1' }] });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('RECORD_LOCKED');
    const again = await call('buyer', 'post', `/purch/prs/${ids.pr}/submit`);
    expect(again.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('refuses users without purch.pr.manage, FG / inactive items, future dates and empty requisitions', async () => {
    const base = { prDate: PO_DATE, lines: [{ itemId: ids.rm, qty: '1' }] };
    expect((await call('store', 'post', '/purch/prs', base)).status).toBe(403);
    expect((await call('ceo', 'post', '/purch/prs', base)).status).toBe(403);
    expect((await call('buyer', 'post', '/purch/prs', { ...base, lines: [{ itemId: ids.fg, qty: '1' }] })).status).toBe(400);
    expect((await call('buyer', 'post', '/purch/prs', { ...base, lines: [{ itemId: ids.draftItem, qty: '1' }] })).status).toBe(400);
    expect((await call('buyer', 'post', '/purch/prs', { ...base, prDate: '2099-01-01' })).status).toBe(400);
    expect((await call('buyer', 'post', '/purch/prs', { ...base, lines: [] })).status).toBe(400);
    expect((await call('buyer', 'post', '/purch/prs', { ...base, lines: [{ itemId: ids.rm, qty: '0' }] })).status).toBe(400);
  });

  it('cancels a requisition only with a reason', async () => {
    const pr = (await call('buyer', 'post', '/purch/prs', { prDate: PO_DATE, lines: [{ itemId: ids.rm, qty: '1' }] })).body;
    expect((await call('buyer', 'post', `/purch/prs/${pr.id}/cancel`, {})).status).toBe(400);
    expect((await call('buyer', 'post', `/purch/prs/${pr.id}/cancel`, { reason: 'Not needed' })).body.status).toBe('CANCELLED');
    expect((await call('buyer', 'post', `/purch/prs/${pr.id}/submit`)).status).toBe(409);
  });

  it('orders chosen lines on a DRAFT PO; CONVERTED once every line is ordered; a line is ordered once', async () => {
    const pr = (await call('buyer', 'get', `/purch/prs/${ids.pr}`)).body;
    const [apiLine, rmLine, spareLine] = pr.lines as { id: string }[];
    const header = { poDate: PO_DATE, vendorId: ids.vendor, poType: 'LOCAL', currency: 'PKR' };

    const first = await call('buyer', 'post', `/purch/prs/${ids.pr}/convert`, {
      ...header,
      lines: [{ prLineId: apiLine!.id, unitPrice: '1500' }, { prLineId: rmLine!.id, unitPrice: '25.50' }],
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ docNo: 'PO-2627-00001', status: 'DRAFT', totalAmount: '20850.00' });
    expect(first.body.lines[0]).toMatchObject({ prDocNo: 'PR-2627-00001', qty: '10.5000', lineAmount: '15750.00' });
    ids.poFromPr = first.body.id;
    expect((await call('buyer', 'get', `/purch/prs/${ids.pr}`)).body.status).toBe('SUBMITTED');

    const twice = await call('buyer', 'post', `/purch/prs/${ids.pr}/convert`, { ...header, lines: [{ prLineId: apiLine!.id, unitPrice: '1' }] });
    expect(twice.status).toBe(409);
    const cancel = await call('buyer', 'post', `/purch/prs/${ids.pr}/cancel`, { reason: 'Changed mind' });
    expect(cancel.status).toBe(409);

    const rest = await call('buyer', 'post', `/purch/prs/${ids.pr}/convert`, { ...header, vendorId: ids.other, lines: [{ prLineId: spareLine!.id, unitPrice: '900' }] });
    expect(rest.status).toBe(201);
    const after = (await call('buyer', 'get', `/purch/prs/${ids.pr}`)).body;
    expect(after.status).toBe('CONVERTED');
    expect(after.lines.map((l: { poDocNo: string }) => l.poDocNo)).toEqual(['PO-2627-00001', 'PO-2627-00001', 'PO-2627-00002']);
  });

  it('refuses converting a DRAFT requisition, a line of another requisition, and dropping a requisition line from the PO', async () => {
    const draft = (await call('buyer', 'post', '/purch/prs', { prDate: PO_DATE, lines: [{ itemId: ids.rm, qty: '1' }] })).body;
    const header = { poDate: PO_DATE, vendorId: ids.vendor, poType: 'LOCAL', currency: 'PKR' };
    expect((await call('buyer', 'post', `/purch/prs/${draft.id}/convert`, { ...header, lines: [{ prLineId: draft.lines[0].id, unitPrice: '1' }] })).status).toBe(409);
    await call('buyer', 'post', `/purch/prs/${draft.id}/submit`);
    const pr = (await call('buyer', 'get', `/purch/prs/${ids.pr}`)).body;
    expect((await call('buyer', 'post', `/purch/prs/${draft.id}/convert`, { ...header, lines: [{ prLineId: pr.lines[0].id, unitPrice: '1' }] })).status).toBe(400);
    expect((await call('pm', 'post', `/purch/prs/${draft.id}/convert`, { ...header, lines: [{ prLineId: draft.lines[0].id, unitPrice: '1' }] })).status).toBe(403);

    const po = (await call('buyer', 'get', `/purch/pos/${ids.poFromPr}`)).body;
    const dropped = await call('buyer', 'patch', `/purch/pos/${ids.poFromPr}`, {
      ...header,
      lines: [{ itemId: ids.api, qty: '10.5', unitPrice: '1500', prLineId: po.lines[0].prLineId }],
    });
    expect(dropped.status).toBe(400);
    const kept = await call('buyer', 'patch', `/purch/pos/${ids.poFromPr}`, {
      ...header,
      lines: po.lines.map((l: { itemId: string; prLineId: string }) => ({ itemId: l.itemId, qty: '12', unitPrice: '100', prLineId: l.prLineId })),
    });
    expect(kept.status).toBe(200);
    expect(kept.body.totalAmount).toBe('2400.00');
    // Database: a converted requisition's line cannot leave every PO.
    await expect(raw(`DELETE FROM purch.po_lines WHERE po_id = $1`, [ids.poFromPr])).rejects.toThrow(/must stay on a purchase order/);
  });
});

// ------------------------------------------------------------------ purchase orders

describe('purchase orders: AVL block and header rules', () => {
  it('refuses a GMP material from a vendor that is not an approved source (Done-when: non-AVL vendor PO refused)', async () => {
    const res = await call('buyer', 'post', '/purch/pos', localPo(ids.other!, [{ itemId: ids.api!, qty: '5', unitPrice: '1000' }]));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('AVL_NOT_APPROVED');
    expect(res.body.error.message).toContain('API-1 (API)');
  });

  it('lets a non-GMP item (SPARE) be bought from any active vendor', async () => {
    const res = await call('buyer', 'post', '/purch/pos', localPo(ids.other!, [{ itemId: ids.spare!, qty: '1', unitPrice: '5000' }]));
    expect(res.status).toBe(201);
  });

  it('refuses an inactive vendor, a foreign vendor on a local PO, a local PO in USD, an import PO without incoterm, FG items and future dates', async () => {
    const line = [{ itemId: ids.spare!, qty: '1', unitPrice: '1' }];
    const inactive = await call('buyer', 'post', '/purch/pos', localPo(ids.inactive!, line));
    expect(inactive.body.error.code).toBe('VENDOR_NOT_ACTIVE');
    expect((await call('buyer', 'post', '/purch/pos', localPo(ids.foreign!, line))).status).toBe(400);
    expect((await call('buyer', 'post', '/purch/pos', { ...localPo(ids.vendor!, line), currency: 'USD' })).status).toBe(400);
    expect((await call('buyer', 'post', '/purch/pos', { ...localPo(ids.foreign!, line), poType: 'IMPORT', currency: 'USD' })).status).toBe(400);
    expect((await call('buyer', 'post', '/purch/pos', localPo(ids.vendor!, [{ itemId: ids.fg!, qty: '1', unitPrice: '1' }]))).status).toBe(400);
    expect((await call('buyer', 'post', '/purch/pos', { ...localPo(ids.vendor!, line), poDate: '2099-01-01' })).status).toBe(400);
    expect((await call('pm', 'post', '/purch/pos', localPo(ids.vendor!, line))).status).toBe(403);
  });
});

describe('purchase orders: submit, approval matrix and segregation', () => {
  it('submits a local PO (rate 1), routes it to the Purchase Manager (≤ 500,000) and locks it', async () => {
    const po = (await call('buyer', 'post', '/purch/pos', localPo(ids.vendor!, [{ itemId: ids.api!, qty: '100', unitPrice: '2500' }]))).body;
    ids.localPo = po.id;
    const sub = await call('buyer', 'post', `/purch/pos/${po.id}/submit`);
    expect(sub.status).toBe(200);
    expect(sub.body).toMatchObject({ status: 'PENDING_APPROVAL', exchangeRate: '1.0000', totalPkr: '250000.00', submittedBy: users.buyer });
    const approval = await approvalOf(po.id);
    expect(approval).toMatchObject({ status: 'PENDING', measured_amount: '250000.00' });
    expect(sub.body.approvalId).toBe(approval.id);

    const locked = await call('buyer', 'patch', `/purch/pos/${po.id}`, localPo(ids.vendor!, [{ itemId: ids.api!, qty: '1', unitPrice: '1' }]));
    expect(locked.body.error.code).toBe('RECORD_LOCKED');
    await expect(raw(`UPDATE purch.purchase_orders SET notes = 'x' WHERE id = $1`, [po.id])).rejects.toThrow(/RECORD_LOCKED/);
    await expect(raw(`UPDATE purch.po_lines SET qty = 1, line_amount = 2500 WHERE po_id = $1`, [po.id])).rejects.toThrow(/RECORD_LOCKED/);

    expect((await call('fm', 'post', `/core/approvals/${approval.id}/approve`, sign('APPROVED'))).status).toBe(403); // not the FM's band
    const ok = await call('pm', 'post', `/core/approvals/${approval.id}/approve`, sign('APPROVED'));
    expect(ok.status).toBe(200);
    expect((await call('buyer', 'get', `/purch/pos/${po.id}`)).body.status).toBe('APPROVED');
    const { rows } = await client.query(
      `SELECT from_status, to_status, actor_id FROM core.status_history WHERE entity_table = 'purch.purchase_orders' AND entity_id = $1 ORDER BY id`,
      [po.id],
    );
    expect(rows).toEqual([
      { from_status: null, to_status: 'DRAFT', actor_id: users.buyer },
      { from_status: 'DRAFT', to_status: 'PENDING_APPROVAL', actor_id: users.buyer },
      { from_status: 'PENDING_APPROVAL', to_status: 'APPROVED', actor_id: users.pm },
    ]);
  });

  it('refuses the PO creator as approver, even when they also hold the approver role (rule 9)', async () => {
    const po = (await call('buyerpm', 'post', '/purch/pos', localPo(ids.vendor!, [{ itemId: ids.rm!, qty: '10', unitPrice: '100' }]))).body;
    await call('buyer2', 'post', `/purch/pos/${po.id}/submit`); // submitted by someone else
    const approval = await approvalOf(po.id);
    const res = await call('buyerpm', 'post', `/core/approvals/${approval.id}/approve`, sign('APPROVED'));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'SEGREGATION_OF_DUTIES', details: { rule: 'PO creator ≠ PO approver' } });
    expect((await approvalOf(po.id)).status).toBe('PENDING');
    expect((await call('pm', 'post', `/core/approvals/${approval.id}/approve`, sign('APPROVED'))).status).toBe(200);
  });

  it('needs Finance’s rate on the PO date for an import PO; above 5,000,000 PKR it goes to Purchase Manager then Finance Manager', async () => {
    const body = { poDate: '2026-11-19', vendorId: ids.foreign, poType: 'IMPORT', currency: 'USD', incoterm: 'CIF', lines: [{ itemId: ids.api, qty: '1000', unitPrice: '25.00' }] };
    const po = (await call('buyer', 'post', '/purch/pos', body)).body;
    expect(po.totalAmount).toBe('25000.00');
    const missing = await call('buyer', 'post', `/purch/pos/${po.id}/submit`);
    expect(missing.status).toBe(422);
    expect(missing.body.error).toMatchObject({ code: 'RATE_MISSING', details: { currency: 'USD', date: '2026-11-19' } });

    await call('fm', 'post', '/fin/exchange-rates', { currency: 'USD', rateDate: '2026-11-19', rate: '280.1234', source: 'SBP' });
    const sub = await call('buyer', 'post', `/purch/pos/${po.id}/submit`);
    expect(sub.body).toMatchObject({ exchangeRate: '280.1234', totalPkr: '7003085.00' });
    const approval = await approvalOf(po.id);
    expect(approval.measured_amount).toBe('7003085.00');
    const { rows: steps } = await client.query(
      `SELECT s.step_no, r.code, s.status FROM core.approval_steps s JOIN core.roles r ON r.id = s.role_id WHERE s.approval_id = $1 ORDER BY s.step_no`,
      [approval.id],
    );
    expect(steps).toEqual([
      { step_no: 1, code: 'PURCHASE_MANAGER', status: 'PENDING' },
      { step_no: 2, code: 'FINANCE_MANAGER', status: 'WAITING' },
    ]);
    expect((await call('fm', 'post', `/core/approvals/${approval.id}/approve`, sign('APPROVED'))).status).toBe(403);
    expect((await call('pm', 'post', `/core/approvals/${approval.id}/approve`, sign('APPROVED'))).status).toBe(200);
    expect((await call('buyer', 'get', `/purch/pos/${po.id}`)).body.status).toBe('PENDING_APPROVAL');
    expect((await call('fm', 'post', `/core/approvals/${approval.id}/approve`, sign('APPROVED'))).status).toBe(200);
    expect((await call('buyer', 'get', `/purch/pos/${po.id}`)).body.status).toBe('APPROVED');
  });

  it('a rejection returns the PO to DRAFT with the reason; it can be fixed and submitted again', async () => {
    const po = (await call('buyer', 'post', '/purch/pos', localPo(ids.vendor!, [{ itemId: ids.rm!, qty: '10', unitPrice: '50' }]))).body;
    await call('buyer', 'post', `/purch/pos/${po.id}/submit`);
    const approval = await approvalOf(po.id);
    expect((await call('pm', 'post', `/core/approvals/${approval.id}/reject`, sign('REJECTED', 'Price too high'))).status).toBe(200);
    const back = (await call('buyer', 'get', `/purch/pos/${po.id}`)).body;
    expect(back.status).toBe('DRAFT');
    const { rows } = await client.query(
      `SELECT reason FROM core.status_history WHERE entity_table = 'purch.purchase_orders' AND entity_id = $1 AND to_status = 'DRAFT' AND from_status IS NOT NULL`,
      [po.id],
    );
    expect(rows).toEqual([{ reason: 'Price too high' }]);
    expect((await call('buyer', 'patch', `/purch/pos/${po.id}`, localPo(ids.vendor!, [{ itemId: ids.rm!, qty: '10', unitPrice: '45' }]))).status).toBe(200);
    expect((await call('buyer', 'post', `/purch/pos/${po.id}/submit`)).body.status).toBe('PENDING_APPROVAL');
  });

  it('refuses the approval when the source was blocked while the PO waited (service and database)', async () => {
    const po = (await call('buyer', 'post', '/purch/pos', { poDate: PO_DATE, vendorId: ids.foreign, poType: 'IMPORT', currency: 'USD', incoterm: 'FOB', lines: [{ itemId: ids.api, qty: '1', unitPrice: '10' }] })).body;
    expect((await call('buyer', 'post', `/purch/pos/${po.id}/submit`)).status).toBe(200);
    await inTx(users.qa!, async () => {
      await history('master.approved_sources', ids.foreignSource!, 'APPROVED', 'BLOCKED', users.qa!);
      await client.query(`UPDATE master.approved_sources SET status = 'BLOCKED' WHERE id = $1`, [ids.foreignSource]);
    });
    const approval = await approvalOf(po.id);
    const res = await call('pm', 'post', `/core/approvals/${approval.id}/approve`, sign('APPROVED'));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('AVL_NOT_APPROVED');
    expect((await approvalOf(po.id)).status).toBe('PENDING');
    // The database refuses the same move on its own.
    await expect(
      inTx(users.pm!, async () => {
        await history('purch.purchase_orders', po.id, 'PENDING_APPROVAL', 'APPROVED', users.pm!);
        await client.query(`UPDATE purch.purchase_orders SET status = 'APPROVED' WHERE id = $1`, [po.id]);
      }),
    ).rejects.toThrow(/AVL_NOT_APPROVED/);
  });
});

describe('purchase orders: cancel', () => {
  it('cancels a pending PO with its approval, and an approved PO, only with a reason', async () => {
    const po = (await call('buyer', 'post', '/purch/pos', localPo(ids.vendor!, [{ itemId: ids.rm!, qty: '1', unitPrice: '10' }]))).body;
    await call('buyer', 'post', `/purch/pos/${po.id}/submit`);
    expect((await call('buyer', 'post', `/purch/pos/${po.id}/cancel`, {})).status).toBe(400);
    expect((await call('pm', 'post', `/purch/pos/${po.id}/cancel`, { reason: 'No longer needed' })).status).toBe(403);
    expect((await call('buyer', 'post', `/purch/pos/${po.id}/cancel`, { reason: 'No longer needed' })).body.status).toBe('CANCELLED');
    expect((await approvalOf(po.id)).status).toBe('CANCELLED');

    expect((await call('buyer', 'post', `/purch/pos/${ids.localPo}/cancel`, { reason: 'Supplier cannot deliver' })).body.status).toBe('CANCELLED');
    expect((await call('buyer', 'post', `/purch/pos/${ids.localPo}/cancel`, { reason: 'Again' })).status).toBe(409);
  });

  it('refuses cancelling a PO that has receipts (service and database)', async () => {
    const po = (await call('buyer', 'post', '/purch/pos', localPo(ids.vendor!, [{ itemId: ids.rm!, qty: '10', unitPrice: '10' }]))).body;
    await call('buyer', 'post', `/purch/pos/${po.id}/submit`);
    await call('pm', 'post', `/core/approvals/${(await approvalOf(po.id)).id}/approve`, sign('APPROVED'));
    await raw(`UPDATE purch.po_lines SET received_qty = 4 WHERE po_id = $1`, [po.id]); // as a GRN will (task 3)
    const res = await call('buyer', 'post', `/purch/pos/${po.id}/cancel`, { reason: 'Stop the rest' });
    expect(res.status).toBe(409);
    await expect(
      inTx(users.buyer!, async () => {
        await history('purch.purchase_orders', po.id, 'APPROVED', 'CANCELLED', users.buyer!);
        await client.query(`UPDATE purch.purchase_orders SET status = 'CANCELLED' WHERE id = $1`, [po.id]);
      }),
    ).rejects.toThrow(/has receipts/);
  });
});

describe('purchase orders: database guards (0023)', () => {
  it('refuses a wrong line amount, a local PO in USD, an import PO without incoterm, and a DRAFT with receipts', async () => {
    const sevenDecimals = await call('buyer', 'post', '/purch/pos', localPo(ids.vendor!, [{ itemId: ids.rm!, qty: '3', unitPrice: '0.0350001' }]));
    expect(sevenDecimals.status).toBe(400); // a unit price is a rate NUMERIC(18,6) (owner 2026-11-25)
    // A printed label at 0.035 PKR is ordered at its real price; the line amount rounds to 2 decimals, half-up.
    const labels = (await call('buyer', 'post', '/purch/pos', localPo(ids.vendor!, [
      { itemId: ids.rm!, qty: '10000', unitPrice: '0.035' },
      { itemId: ids.rm!, qty: '3', unitPrice: '0.035' },
    ]))).body;
    expect(labels.lines.map((l: { unitPrice: string; lineAmount: string }) => [l.unitPrice, l.lineAmount])).toEqual([
      ['0.035000', '350.00'],
      ['0.035000', '0.11'], // 0.105 half-up
    ]);
    expect(labels.totalAmount).toBe('350.11');
    await expect(raw(`UPDATE purch.po_lines SET line_amount = 0.10 WHERE po_id = $1 AND line_no = 2`, [labels.id])).rejects.toThrow(/check/i);
    const ok = (await call('buyer', 'post', '/purch/pos', localPo(ids.vendor!, [{ itemId: ids.rm!, qty: '3.3333', unitPrice: '0.35' }]))).body;
    expect(ok.lines[0].lineAmount).toBe('1.17'); // 1.166655 half-up
    await expect(raw(`UPDATE purch.po_lines SET line_amount = 1.16 WHERE po_id = $1`, [ok.id])).rejects.toThrow(/check/i);
    await expect(raw(`UPDATE purch.purchase_orders SET currency = 'USD' WHERE id = $1`, [ok.id])).rejects.toThrow(/check/i);
    await expect(raw(`UPDATE purch.purchase_orders SET po_type = 'IMPORT', currency = 'USD' WHERE id = $1`, [ok.id])).rejects.toThrow(/check/i);
    await expect(raw(`UPDATE purch.po_lines SET received_qty = 1 WHERE po_id = $1`, [ok.id])).rejects.toThrow(/no receipts/);
  });

  it('refuses a raw submit of a non-AVL line, a PO created straight as APPROVED, and deleting a PO', async () => {
    const po = (await call('buyer', 'post', '/purch/pos', localPo(ids.other!, [{ itemId: ids.spare!, qty: '1', unitPrice: '1' }]))).body;
    await raw(`INSERT INTO purch.po_lines (po_id, line_no, item_id, qty, unit_price, line_amount) VALUES ($1, 2, $2, 1, 1, 1)`, [po.id, ids.rm], users.buyer);
    await raw(`UPDATE purch.purchase_orders SET total_amount = 2 WHERE id = $1`, [po.id], users.buyer);
    await expect(
      inTx(users.buyer!, async () => {
        await history('purch.purchase_orders', po.id, 'DRAFT', 'PENDING_APPROVAL', users.buyer!);
        await client.query(
          `UPDATE purch.purchase_orders SET status = 'PENDING_APPROVAL', exchange_rate = 1, submitted_by = $2, submitted_at = now() WHERE id = $1`,
          [po.id, users.buyer],
        );
      }),
    ).rejects.toThrow(/AVL_NOT_APPROVED/);
    await expect(
      raw(`INSERT INTO purch.purchase_orders (doc_no, po_date, vendor_id, po_type, currency, status) VALUES ('X-1', $1, $2, 'LOCAL', 'PKR', 'APPROVED')`, [PO_DATE, ids.vendor]),
    ).rejects.toThrow(/starts as DRAFT/);
    await expect(raw(`DELETE FROM purch.purchase_orders WHERE id = $1`, [po.id])).rejects.toThrow();
  });
});
