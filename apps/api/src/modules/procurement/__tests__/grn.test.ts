// M3 task 3 + owner answers 2026-11-25 (0028: rates, qc_required, shelf life, cancel, reversal). GRN from PO → lots in QUARANTINE, receipt movement + GRN_RECEIPT journal, QC sample request, PO
// received; labels. Happy paths and every refusal, through the real HTTP endpoints, plus the 0027 database guards.
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { databaseUrl } from '../../../config/env';
import { runSeed } from '../../../db/seed/run';
import { createTestUser, TEST_PASSWORD } from '../../../test/factories';
import { systemContext, withTransaction } from '../../../db/client';
import { permissionKeysForUser } from '../../../core/auth/auth.repo';
import type { Actor } from '../../../core/transition/transition';
import { reserve, transfer } from '../../../engines/inventory';

const app = createApp();
const client = new pg.Client({ connectionString: databaseUrl });
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};
const ids: Record<string, string> = {};

const PO_DATE = '2026-11-20';
const GRN_DATE = '2026-11-24';
let keyNo = 0;

function call(who: string, method: 'get' | 'post' | 'patch', url: string, body?: object) {
  const r = request(app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`);
  return body ? r.send(body) : r;
}
const post = (who: string, grnId: string) =>
  call(who, 'post', `/purch/grns/${grnId}/post`).set('Idempotency-Key', `grn-test-${++keyNo}`);
const sign = (meaning: 'APPROVED' | 'REJECTED') => ({ signature: { password: TEST_PASSWORD, meaning, reason: 'Checked the order' } });

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
const count = async (sql: string, params: unknown[] = []) => Number((await client.query<{ n: string }>(sql, params)).rows[0]!.n);

async function vendor(code: string, opts: { foreign?: boolean; currency?: string } = {}): Promise<string> {
  const id = await inTx(users.buyer!, async () => {
    const v = await one(
      `INSERT INTO master.vendors (code, name, ntn, is_foreign, country, currency, status) VALUES ($1, $1, $2, $3, $4, $5, 'DRAFT') RETURNING id`,
      [code, opts.foreign ? null : '1234567', opts.foreign ?? false, opts.foreign ? 'CN' : 'PK', opts.currency ?? 'PKR'],
    );
    await history('master.vendors', v, null, 'DRAFT', users.buyer!);
    return v;
  });
  await inTx(users.pm!, async () => {
    await history('master.vendors', id, 'DRAFT', 'ACTIVE', users.pm!);
    await client.query(`UPDATE master.vendors SET status = 'ACTIVE' WHERE id = $1`, [id]);
  });
  return id;
}

async function item(code: string, type: string): Promise<string> {
  const id = await inTx(users.wm!, async () => {
    const i = await one(
      `INSERT INTO master.items (code, name, type, category_id, base_uom_id, status) VALUES ($1, $1, $2, $3, $4, 'DRAFT') RETURNING id`,
      [code, type, ids.category, ids.uom],
    );
    await history('master.items', i, null, 'DRAFT', users.wm!);
    return i;
  });
  const activator = ['SPARE', 'CONSUMABLE'].includes(type) ? users.pm! : users.qa!;
  await inTx(activator, async () => {
    await history('master.items', id, 'DRAFT', 'ACTIVE', activator);
    await client.query(`UPDATE master.items SET status = 'ACTIVE' WHERE id = $1`, [id]);
  });
  return id;
}

async function approvedSource(vendorId: string, itemId: string, manufacturer = 'Maker Ltd'): Promise<string> {
  const id = await inTx(users.buyer!, async () => {
    const s = await one(
      `INSERT INTO master.approved_sources (vendor_id, item_id, manufacturer, manufacturing_site, status) VALUES ($1, $2, $3, 'Site A', 'PENDING') RETURNING id`,
      [vendorId, itemId, manufacturer],
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

/** An APPROVED PO: created and submitted by `creator`, approved by the Purchase Manager (PKR ≤ 500k band). */
async function approvedPo(
  lines: { itemId: string; qty: string; unitPrice: string }[],
  opts: { vendorId?: string; currency?: string; creator?: string; approver?: string } = {},
): Promise<{ id: string; docNo: string; lineIds: string[] }> {
  const creator = opts.creator ?? 'buyer';
  const imp = opts.currency && opts.currency !== 'PKR';
  const res = await call(creator, 'post', '/purch/pos', {
    poDate: PO_DATE,
    vendorId: opts.vendorId ?? ids.vendor,
    poType: imp ? 'IMPORT' : 'LOCAL',
    currency: opts.currency ?? 'PKR',
    ...(imp ? { incoterm: 'CIF' } : {}),
    lines,
  });
  expect(res.status).toBe(201);
  expect((await call(creator, 'post', `/purch/pos/${res.body.id}/submit`)).status).toBe(200);
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM core.approvals WHERE doc_table = 'purch.purchase_orders' AND doc_id = $1 ORDER BY id DESC LIMIT 1`,
    [res.body.id],
  );
  expect((await call(opts.approver ?? 'pm', 'post', `/core/approvals/${rows[0]!.id}/approve`, sign('APPROVED'))).status).toBe(200);
  return { id: res.body.id, docNo: res.body.docNo, lineIds: res.body.lines.map((l: { id: string }) => l.id) };
}

const grnBody = (poId: string, lines: object[], extra: object = {}) => ({ poId, grnDate: GRN_DATE, locationId: ids.loc, lines, ...extra });
const rmLine = (poLineId: string, qty: string, extra: object = {}) => ({ poLineId, qty, approvedSourceId: ids.rmSource, ...extra });
const apiDates = { mfrBatchNo: 'MB-77', mfgDate: '2026-06-01', expiryDate: '2028-05-31', retestDate: '2027-05-31' };

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  for (const [name, roles] of [
    ['buyer', ['PURCHASE_OFFICER']],
    ['pm', ['PURCHASE_MANAGER']],
    ['fm', ['FINANCE_MANAGER']],
    ['store', ['STOREKEEPER']],
    ['buyerstore', ['PURCHASE_OFFICER', 'STOREKEEPER']],
    ['pmstore', ['PURCHASE_MANAGER', 'STOREKEEPER']],
    ['wm', ['WAREHOUSE_MANAGER']],
    ['qa', ['QA_MANAGER']],
  ] as const) {
    users[name] = await createTestUser({ username: `grn_${name}`, roleCodes: [...roles] });
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: `grn_${name}`, password: TEST_PASSWORD });
    tokens[name] = res.body.accessToken as string;
  }
  await inTx('1', async () => {
    ids.uom = await one(`INSERT INTO master.uoms (code, name) VALUES ('KG', 'Kilogram') RETURNING id`);
    ids.category = await one(`INSERT INTO master.item_categories (code, name) VALUES ('RM', 'Raw material') RETURNING id`);
    const wh = await one(`INSERT INTO master.warehouses (code, name) VALUES ('MAIN', 'Main store') RETURNING id`);
    ids.loc = await one(`INSERT INTO master.locations (warehouse_id, code, name) VALUES ($1, 'QUAR', 'Quarantine bay') RETURNING id`, [wh]);
  });
  await inTx(users.fm!, async () => {
    const p = await one(
      `INSERT INTO core.fiscal_periods (fiscal_year, period_no, name, start_date, end_date, status) VALUES ('2026-27', 5, 'Nov-2026', '2026-11-01', '2026-11-30', 'OPEN') RETURNING id`,
    );
    await history('core.fiscal_periods', p, null, 'OPEN', users.fm!);
  });
  ids.vendor = await vendor('V-LOCAL');
  ids.usdVendor = await vendor('V-CN', { foreign: true, currency: 'USD' });
  ids.api = await item('API-1', 'API');
  ids.rm = await item('RM-1', 'RM');
  ids.spare = await item('SP-1', 'SPARE');
  ids.rmSource = await approvedSource(ids.vendor, ids.rm);
  ids.apiSource = await approvedSource(ids.vendor, ids.api);
  ids.usdApiSource = await approvedSource(ids.usdVendor, ids.api, 'Hebei Pharma');
  expect((await call('fm', 'post', '/fin/exchange-rates', { currency: 'USD', rateDate: PO_DATE, rate: '280.0000', source: 'SBP' })).status).toBe(200);
});

afterAll(async () => {
  await client.end();
});

describe('GRN: scan the PO', () => {
  it('finds the PO by its number and shows what each line may still receive (2% tolerance) and the APPROVED sources', async () => {
    const po = await approvedPo([
      { itemId: ids.rm!, qty: '100', unitPrice: '50' },
      { itemId: ids.spare!, qty: '3', unitPrice: '1200' },
    ]);
    const res = await call('store', 'get', `/purch/grns/po-receipt?docNo=${encodeURIComponent(po.docNo.toLowerCase())}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ poId: po.id, poStatus: 'APPROVED', overReceiptPct: 2, currency: 'PKR' });
    expect(res.body.lines[0]).toMatchObject({ openQty: '100.0000', maxQty: '102.0000', needsSource: true, needsDates: false });
    expect(res.body.lines[0].sources).toEqual([{ id: ids.rmSource, manufacturer: 'Maker Ltd', manufacturingSite: 'Site A' }]);
    expect(res.body.lines[1]).toMatchObject({ needsSource: false, sources: [] });
    expect((await call('store', 'get', '/purch/grns/po-receipt?docNo=PO-NOPE')).status).toBe(404);
  });
});

describe('GRN posting (happy path, local PO)', () => {
  it('posts lots in QUARANTINE (APPROVED for an item without QC), receipt movements, a balanced GRN_RECEIPT journal, sample requests; the PO is partly then fully received', async () => {
    const po = await approvedPo([
      { itemId: ids.rm!, qty: '100', unitPrice: '50.125' },
      { itemId: ids.spare!, qty: '3', unitPrice: '1200' },
    ]);
    const draft = await call('store', 'post', '/purch/grns', grnBody(po.id, [
      rmLine(po.lineIds[0]!, '60', { containers: 3, mfrBatchNo: 'RMB-1', expiryDate: '2028-01-31', manufacturer: 'ignored for GMP' }),
      { poLineId: po.lineIds[1], qty: '3', manufacturer: 'Spares Co' },
    ], { deliveryNoteNo: 'DN-881' }));
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({ status: 'DRAFT', poDocNo: po.docNo, currency: 'PKR', exchangeRate: null });
    expect(draft.body.docNo).toMatch(/^GRN-2627-\d{5}$/);
    expect(draft.body.lines[0]).toMatchObject({ manufacturer: 'Maker Ltd', manufacturingSite: 'Site A', unitPrice: '50.125000', lotId: null });

    const noKey = await call('store', 'post', `/purch/grns/${draft.body.id}/post`);
    expect([noKey.status, noKey.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);

    const res = await post('store', draft.body.id);
    expect(res.status).toBe(200);
    const g = res.body;
    expect(g).toMatchObject({ status: 'POSTED', exchangeRate: '1.000000', exchangeRateDate: GRN_DATE, postedBy: users.store });
    expect(g.lines[0]).toMatchObject({ unitCost: '50.125000', valuePkr: '3007.50', lotStatus: 'QUARANTINE', sampleRequest: { status: 'OPEN' } });
    expect(g.lines[0].lotNo).toMatch(/^ML26-\d{5}$/);
    // Owner 2026-11-25 (answer 4): a spare needs no QC — its lot starts APPROVED with no sample request.
    expect(g.lines[1]).toMatchObject({ unitCost: '1200.000000', valuePkr: '3600.00', lotStatus: 'APPROVED', sampleRequest: null });
    expect(g.totalPkr).toBe('6607.50');
    expect(g.journalDocNo).toMatch(/^SJ-/);

    // Lot: GRN source, manufacturer data, cost; its first status through core/transition under purch.grn.post.
    const { rows: lots } = await client.query(
      `SELECT l.lot_no, l.status, l.source, l.unit_cost, l.mfr_batch_no, l.manufacturer, l.expiry_date::text AS expiry
         FROM inv.lots l WHERE l.id = $1`,
      [g.lines[0].lotId],
    );
    expect(lots[0]).toMatchObject({ status: 'QUARANTINE', source: 'GRN', unit_cost: '50.125000', mfr_batch_no: 'RMB-1', manufacturer: 'Maker Ltd', expiry: '2028-01-31' });
    expect(await count(`SELECT count(*) AS n FROM core.status_history WHERE entity_table = 'inv.lots' AND entity_id = $1 AND to_status = 'QUARANTINE' AND actor_id = $2`, [g.lines[0].lotId, users.store])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM core.status_history WHERE entity_table = 'qc.sample_requests' AND entity_id = $1 AND to_status = 'OPEN'`, [g.lines[0].sampleRequest.id])).toBe(1);

    // Ledger and GL: Dr Inventory / Cr GRNI (vendor on the GRNI line), equal to the movement values.
    const { rows: mv } = await client.query(
      `SELECT movement_type, qty, value, to_location_id FROM inv.stock_movements WHERE ref_doc_type = 'GRN' AND ref_doc_id = $1 ORDER BY id`,
      [g.id],
    );
    expect(mv).toEqual([
      { movement_type: 'RECEIPT', qty: '60.0000', value: '3007.50', to_location_id: ids.loc },
      { movement_type: 'RECEIPT', qty: '3.0000', value: '3600.00', to_location_id: ids.loc },
    ]);
    const { rows: jl } = await client.query(
      `SELECT a.code, sum(jl.debit)::text AS dr, sum(jl.credit)::text AS cr, max(jl.vendor_id) AS vendor
         FROM fin.journal_lines jl JOIN fin.journal_entries je ON je.id = jl.entry_id JOIN fin.accounts a ON a.id = jl.account_id
        WHERE je.source_type = 'GRN' AND je.source_id = $1 AND je.status = 'POSTED' GROUP BY a.code ORDER BY a.code`,
      [g.id],
    );
    expect(jl).toEqual([
      { code: '1310', dr: '6607.50', cr: '0.00', vendor: null },
      { code: '2120', dr: '0.00', cr: '6607.50', vendor: ids.vendor },
    ]);

    // PO: received quantities and PARTIALLY_RECEIVED (moved by the receiver under purch.grn.post).
    const poNow = (await call('buyer', 'get', `/purch/pos/${po.id}`)).body;
    expect(poNow.status).toBe('PARTIALLY_RECEIVED');
    expect(poNow.lines.map((l: { receivedQty: string }) => l.receivedQty)).toEqual(['60.0000', '3.0000']);

    // The rest, within tolerance (40 + 2 = 102 of 100): RECEIVED.
    const rest = await call('store', 'post', '/purch/grns', grnBody(po.id, [rmLine(po.lineIds[0]!, '42', { mfrBatchNo: 'RMB-2' })]));
    expect(rest.status).toBe(201);
    expect((await post('store', rest.body.id)).status).toBe(200);
    expect((await call('buyer', 'get', `/purch/pos/${po.id}`)).body.status).toBe('RECEIVED');
    const { rows: ph } = await client.query(
      `SELECT from_status, to_status FROM core.status_history WHERE entity_table = 'purch.purchase_orders' AND entity_id = $1 ORDER BY id`,
      [po.id],
    );
    expect(ph.slice(-2)).toEqual([
      { from_status: 'APPROVED', to_status: 'PARTIALLY_RECEIVED' },
      { from_status: 'PARTIALLY_RECEIVED', to_status: 'RECEIVED' },
    ]);

    // A received PO takes no more GRNs; a posted GRN never changes.
    const more = await call('store', 'post', '/purch/grns', grnBody(po.id, [{ poLineId: po.lineIds[1], qty: '1' }]));
    expect([more.status, more.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);
    const edit = await call('store', 'patch', `/purch/grns/${g.id}`, { grnDate: GRN_DATE, locationId: ids.loc, lines: [{ poLineId: po.lineIds[1], qty: '1' }] });
    expect([edit.status, edit.body.error.code]).toEqual([409, 'RECORD_LOCKED']);
    const again = await post('store', g.id);
    expect([again.status, again.body.error.code]).toEqual([409, 'RECORD_LOCKED']);

    const list = await call('buyer', 'get', `/purch/grns?poId=${po.id}`);
    expect(list.body.total).toBe(2);
  });
});

describe('GRN at the GRN-date exchange rate (owner 2026-11-25)', () => {
  it('refuses RATE_MISSING without a rate within 3 days of the GRN date, then values the lot at PO price × GRN rate', async () => {
    const po = await approvedPo([{ itemId: ids.api!, qty: '10', unitPrice: '12.3456' }], { vendorId: ids.usdVendor, currency: 'USD' });
    const draft = await call('store', 'post', '/purch/grns', grnBody(po.id, [{ poLineId: po.lineIds[0], qty: '10', approvedSourceId: ids.usdApiSource, ...apiDates }]));
    expect(draft.status).toBe(201);
    const lotsBefore = await count(`SELECT count(*) AS n FROM inv.lots`);
    const missing = await post('store', draft.body.id); // latest USD rate is of 20-11, 4 days before 24-11
    expect([missing.status, missing.body.error.code]).toEqual([422, 'RATE_MISSING']);
    expect(await count(`SELECT count(*) AS n FROM inv.lots`)).toBe(lotsBefore);

    expect((await call('fm', 'post', '/fin/exchange-rates', { currency: 'USD', rateDate: '2026-11-23', rate: '282.5000', source: 'SBP' })).status).toBe(200);
    const res = await post('store', draft.body.id);
    expect(res.status).toBe(200);
    // 12.3456 × 282.5 = 3487.632 per kg; 10 kg = 34876.32 PKR. The PO (indicative) was at 280.
    expect(res.body).toMatchObject({ exchangeRate: '282.500000', exchangeRateDate: '2026-11-23', totalPkr: '34876.32' });
    expect(res.body.lines[0]).toMatchObject({ unitPrice: '12.345600', unitCost: '3487.632000', manufacturer: 'Hebei Pharma' });
  });
});

describe('GRN refusals', () => {
  it('OVER_RECEIPT above ordered + 2% (across lines of the same PO line); exactly at the limit is accepted', async () => {
    const po = await approvedPo([{ itemId: ids.rm!, qty: '50', unitPrice: '10' }]);
    const over = await call('store', 'post', '/purch/grns', grnBody(po.id, [rmLine(po.lineIds[0]!, '30'), rmLine(po.lineIds[0]!, '21.0001')]));
    expect([over.status, over.body.error.code]).toEqual([422, 'OVER_RECEIPT']);
    expect(over.body.error.details).toMatchObject({ maxQty: '51.0000', tolerancePct: 2 });
    const ok = await call('store', 'post', '/purch/grns', grnBody(po.id, [rmLine(po.lineIds[0]!, '30'), rmLine(po.lineIds[0]!, '21')]));
    expect(ok.status).toBe(201);
    // Two drafts together would exceed it: the second is refused at posting (received counts only posted GRNs).
    const first = await call('store', 'post', '/purch/grns', grnBody(po.id, [rmLine(po.lineIds[0]!, '49')]));
    const second = await call('store', 'post', '/purch/grns', grnBody(po.id, [rmLine(po.lineIds[0]!, '3')]));
    expect([first.status, second.status]).toEqual([201, 201]);
    expect((await post('store', first.body.id)).status).toBe(200); // 49 of 50: PARTIALLY_RECEIVED
    const late = await post('store', second.body.id); // 49 + 3 = 52 > 51
    expect([late.status, late.body.error.code]).toEqual([422, 'OVER_RECEIPT']);
    // The first draft (51 in all) is now too much as well: refused when saved again.
    const resave = await call('store', 'patch', `/purch/grns/${ok.body.id}`, { grnDate: GRN_DATE, locationId: ids.loc, lines: [rmLine(po.lineIds[0]!, '30'), rmLine(po.lineIds[0]!, '21')] });
    expect(resave.body.error.code).toBe('OVER_RECEIPT');
  });

  it('an API needs manufacturer batch, mfg, expiry and retest dates; expired or future-mfg material is refused', async () => {
    const po = await approvedPo([{ itemId: ids.api!, qty: '5', unitPrice: '100' }]);
    const base = { poLineId: po.lineIds[0], qty: '5', approvedSourceId: ids.apiSource };
    const noDates = await call('store', 'post', '/purch/grns', grnBody(po.id, [base]));
    expect([noDates.status, noDates.body.error.code, noDates.body.error.details.field]).toEqual([400, 'VALIDATION_FAILED', 'mfrBatchNo']);
    const expired = await call('store', 'post', '/purch/grns', grnBody(po.id, [{ ...base, ...apiDates, expiryDate: GRN_DATE }]));
    expect(expired.body.error.details.field).toBe('expiryDate');
    const futureMfg = await call('store', 'post', '/purch/grns', grnBody(po.id, [{ ...base, ...apiDates, mfgDate: '2026-11-25' }]));
    expect(futureMfg.body.error.details.field).toBe('mfgDate');
    const future = await call('store', 'post', '/purch/grns', grnBody(po.id, [{ ...base, ...apiDates }], { grnDate: '2099-01-01' }));
    expect(future.body.error.details.field).toBe('grnDate');
  });

  it('AVL at receipt: a GMP line needs an APPROVED source of this vendor; a source blocked after the draft stops the posting', async () => {
    const po = await approvedPo([{ itemId: ids.rm!, qty: '20', unitPrice: '10' }]);
    const none = await call('store', 'post', '/purch/grns', grnBody(po.id, [{ poLineId: po.lineIds[0], qty: '20' }]));
    expect([none.status, none.body.error.code]).toEqual([422, 'AVL_NOT_APPROVED']);
    const otherVendors = await call('store', 'post', '/purch/grns', grnBody(po.id, [{ poLineId: po.lineIds[0], qty: '20', approvedSourceId: ids.usdApiSource }]));
    expect(otherVendors.body.error.code).toBe('AVL_NOT_APPROVED');
    const spareSource = await call('store', 'post', '/purch/grns', grnBody(po.id, [{ poLineId: po.lineIds[0], qty: '20', approvedSourceId: ids.rmSource }]));
    expect(spareSource.status).toBe(201);

    // QA blocks the source while the draft waits: posting is refused, nothing is written.
    const blocked = await approvedSource(ids.vendor!, ids.rm!, 'Second Maker');
    const draft = await call('store', 'post', '/purch/grns', grnBody(po.id, [{ poLineId: po.lineIds[0], qty: '5', approvedSourceId: blocked }]));
    expect(draft.status).toBe(201);
    await inTx(users.qa!, async () => {
      await history('master.approved_sources', blocked, 'APPROVED', 'BLOCKED', users.qa!);
      await client.query(`UPDATE master.approved_sources SET status = 'BLOCKED' WHERE id = $1`, [blocked]);
    });
    const lotsBefore = await count(`SELECT count(*) AS n FROM inv.lots`);
    const res = await post('store', draft.body.id);
    expect([res.status, res.body.error.code]).toEqual([422, 'AVL_NOT_APPROVED']);
    expect(await count(`SELECT count(*) AS n FROM inv.lots`)).toBe(lotsBefore);
    expect((await call('store', 'get', `/purch/grns/${draft.body.id}`)).body.status).toBe('DRAFT');
  });

  it('segregation (rule 9): the PO creator and the PO approver cannot receive its goods (403)', async () => {
    const byCreator = await approvedPo([{ itemId: ids.spare!, qty: '1', unitPrice: '10' }], { creator: 'buyerstore' });
    const d1 = await call('buyerstore', 'post', '/purch/grns', grnBody(byCreator.id, [{ poLineId: byCreator.lineIds[0], qty: '1' }]));
    expect(d1.status).toBe(201); // drafting is allowed; receiving (posting) is not
    const r1 = await post('buyerstore', d1.body.id);
    expect([r1.status, r1.body.error.code, r1.body.error.details.rule]).toEqual([403, 'SEGREGATION_OF_DUTIES', 'PO creator ≠ GRN receiver']);

    const byApprover = await approvedPo([{ itemId: ids.spare!, qty: '1', unitPrice: '10' }], { approver: 'pmstore' });
    const d2 = await call('pmstore', 'post', '/purch/grns', grnBody(byApprover.id, [{ poLineId: byApprover.lineIds[0], qty: '1' }]));
    const r2 = await post('pmstore', d2.body.id);
    expect([r2.status, r2.body.error.code, r2.body.error.details.rule]).toEqual([403, 'SEGREGATION_OF_DUTIES', 'PO approver ≠ GRN receiver']);
    expect((await post('store', d2.body.id)).status).toBe(200); // another storekeeper receives it
  });

  it('permissions: only purch.grn.post creates and posts; a PO not yet approved receives nothing', async () => {
    const po = await approvedPo([{ itemId: ids.spare!, qty: '1', unitPrice: '10' }]);
    const body = grnBody(po.id, [{ poLineId: po.lineIds[0], qty: '1' }]);
    expect((await call('buyer', 'post', '/purch/grns', body)).status).toBe(403);
    const draft = await call('store', 'post', '/purch/grns', body);
    expect((await post('buyer', draft.body.id)).status).toBe(403);
    expect((await call('qa', 'get', '/purch/grns')).status).toBe(403); // no purch.view

    const pending = await call('buyer', 'post', '/purch/pos', { poDate: PO_DATE, vendorId: ids.vendor, poType: 'LOCAL', currency: 'PKR', lines: [{ itemId: ids.spare, qty: '1', unitPrice: '1' }] });
    const res = await call('store', 'post', '/purch/grns', grnBody(pending.body.id, [{ poLineId: pending.body.lines[0].id, qty: '1' }]));
    expect([res.status, res.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);
  });
});

describe('GRN labels (pdfmake + bwip-js)', () => {
  it('prints one label per container of a posted GRN; refuses a draft and users without inv.label.print', async () => {
    const po = await approvedPo([{ itemId: ids.rm!, qty: '10', unitPrice: '10' }]);
    const draft = await call('store', 'post', '/purch/grns', grnBody(po.id, [rmLine(po.lineIds[0]!, '10', { containers: 4 })]));
    const early = await call('store', 'get', `/purch/grns/${draft.body.id}/labels.pdf`);
    expect([early.status, early.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);
    expect((await post('store', draft.body.id)).status).toBe(200);
    const pdf = await call('store', 'get', `/purch/grns/${draft.body.id}/labels.pdf`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    const text = (pdf.body as Buffer).toString('latin1');
    expect(text.startsWith('%PDF')).toBe(true);
    expect(text.match(/\/Type \/Page\b/g)).toHaveLength(4);
    expect((await call('buyer', 'get', `/purch/grns/${draft.body.id}/labels.pdf`)).status).toBe(403);
  });
});

describe('GRN database guards (0027)', () => {
  it('a posted GRN and its lines never change; received quantities must equal posted GRN lines; PO status must match', async () => {
    const po = await approvedPo([{ itemId: ids.spare!, qty: '5', unitPrice: '10' }]);
    const draft = await call('store', 'post', '/purch/grns', grnBody(po.id, [{ poLineId: po.lineIds[0], qty: '2' }]));
    expect((await post('store', draft.body.id)).status).toBe(200);
    await expect(raw(`UPDATE purch.grns SET notes = 'x' WHERE id = $1`, [draft.body.id])).rejects.toThrow(/RECORD_LOCKED/);
    await expect(raw(`UPDATE purch.grn_lines SET qty = 1 WHERE grn_id = $1`, [draft.body.id])).rejects.toThrow(/RECORD_LOCKED/);
    await expect(raw(`DELETE FROM purch.grns WHERE id = $1`, [draft.body.id])).rejects.toThrow();
    // received_qty not backed by posted GRN lines
    await expect(raw(`UPDATE purch.po_lines SET received_qty = 3 WHERE id = $1`, [po.lineIds[0]])).rejects.toThrow(/posted GRN lines hold/);
    // above the tolerance
    await expect(raw(`UPDATE purch.po_lines SET received_qty = 5.2 WHERE id = $1`, [po.lineIds[0]])).rejects.toThrow(/OVER_RECEIPT/);
    // PO marked RECEIVED while only partly received
    await expect(
      inTx(users.store!, async () => {
        await history('purch.purchase_orders', po.id, 'PARTIALLY_RECEIVED', 'RECEIVED', users.store!);
        await client.query(`UPDATE purch.purchase_orders SET status = 'RECEIVED' WHERE id = $1`, [po.id]);
      }),
    ).rejects.toThrow(/not fully received/);
  });

  it('refuses posting a GRN whose lines have no lot, movement or sample request', async () => {
    const po = await approvedPo([{ itemId: ids.spare!, qty: '5', unitPrice: '10' }]);
    const draft = await call('store', 'post', '/purch/grns', grnBody(po.id, [{ poLineId: po.lineIds[0], qty: '1' }]));
    await expect(
      inTx(users.store!, async () => {
        await history('purch.grns', draft.body.id, 'DRAFT', 'POSTED', users.store!);
        await client.query(
          `UPDATE purch.grns SET status = 'POSTED', exchange_rate = 1, exchange_rate_date = grn_date, posted_by = $2, posted_at = now() WHERE id = $1`,
          [draft.body.id, users.store],
        );
      }),
    ).rejects.toThrow(/unit cost must be|no matching GRN lot/);
  });
});

// ---------------------------------------------------------------- owner answers 2026-11-25 (0028)

const reverse = (who: string, grnId: string, body: object = sign('APPROVED')) =>
  call(who, 'post', `/purch/grns/${grnId}/reverse`, body).set('Idempotency-Key', `grn-rev-${++keyNo}`);
const setShelfPct = (pct: number) =>
  raw(`INSERT INTO core.settings (key, value) VALUES ('purch.grn.min_shelf_life_pct', $1::jsonb)
       ON CONFLICT (company_id, key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(pct)]);
const countersignBy = (who: string) => ({ countersign: { username: `grn_${who}`, password: TEST_PASSWORD, meaning: 'APPROVED', reason: 'QC need reviewed' } });

async function actorOf(who: string): Promise<Actor> {
  const keys = await withTransaction(systemContext('test'), (tx) => permissionKeysForUser(tx, users[who]!));
  return { userId: users[who]!, companyId: '1', permissions: new Set(keys) };
}

/** A posted GRN receiving the given PO lines in full; returns the GRN dto. */
async function postedGrn(po: { id: string; lineIds: string[] }, lines: object[]) {
  const draft = await call('store', 'post', '/purch/grns', grnBody(po.id, lines));
  expect(draft.status).toBe(201);
  const res = await post('store', draft.body.id);
  expect(res.status).toBe(200);
  return res.body;
}

describe('exchange rates NUMERIC(18,6) (owner 2026-11-25, answer 1)', () => {
  it('stores 6 decimals in the rate table, the PO and the approval record; the GRN converts at the full rate', async () => {
    expect((await call('fm', 'post', '/fin/exchange-rates', { currency: 'USD', rateDate: GRN_DATE, rate: '281.123456', source: 'SBP' })).status).toBe(200);
    const po = await approvedPo([{ itemId: ids.api!, qty: '2', unitPrice: '100' }], { vendorId: ids.usdVendor, currency: 'USD' });
    const { rows } = await client.query(
      `SELECT p.exchange_rate AS po, a.exchange_rate AS approval FROM purch.purchase_orders p
         JOIN core.approvals a ON a.doc_table = 'purch.purchase_orders' AND a.doc_id = p.id::text WHERE p.id = $1`,
      [po.id],
    );
    expect(rows[0]).toEqual({ po: '280.000000', approval: '280.000000' });
    const g = await postedGrn(po, [{ poLineId: po.lineIds[0], qty: '2', approvedSourceId: ids.usdApiSource, ...apiDates }]);
    expect(g).toMatchObject({ exchangeRate: '281.123456' });
    expect(g.lines[0]).toMatchObject({ unitCost: '28112.345600', valuePkr: '56224.69' });
  });
});

describe('item qc_required (owner 2026-11-25, answer 4)', () => {
  it('defaults by type: true for RM, PM, API, EXCIPIENT; false for the others', async () => {
    const mk = (code: string, type: string) =>
      call('wm', 'post', '/master/items', { code, name: code, type, categoryId: ids.category, baseUomId: ids.uom });
    expect((await mk('QCD-RM', 'RM')).body.qcRequired).toBe(true);
    expect((await mk('QCD-EXC', 'EXCIPIENT')).body.qcRequired).toBe(true);
    expect((await mk('QCD-SP', 'SPARE')).body.qcRequired).toBe(false);
    expect((await mk('QCD-CON', 'CONSUMABLE')).body.qcRequired).toBe(false);
    expect((await mk('QCD-RM2', 'RM')).body.qcRequired).toBe(true);
  });

  it('after DRAFT, changing it needs a QA countersign by another person, for any item type (service and database)', async () => {
    const rm = await item('RM-QCF', 'RM');
    const url = `/master/items/${rm}`;
    const none = await call('wm', 'patch', url, { qcRequired: false });
    expect([none.status, none.body.error.code]).toEqual([403, 'COUNTERSIGN_REQUIRED']);
    const notQa = await call('wm', 'patch', url, { qcRequired: false, ...countersignBy('pm') });
    expect([notQa.status, notQa.body.error.code]).toEqual([403, 'FORBIDDEN']);
    const ok = await call('wm', 'patch', url, { qcRequired: false, ...countersignBy('qa') });
    expect([ok.status, ok.body.qcRequired]).toEqual([200, false]);
    // A spare (non-GMP) too.
    const sp = await item('SP-QCF', 'SPARE');
    expect((await call('wm', 'patch', `/master/items/${sp}`, { qcRequired: true })).body.error.code).toBe('COUNTERSIGN_REQUIRED');
    // Database backstop: no APPROVED e-signature by a master.item.approve holder in the transaction.
    await expect(raw(`UPDATE master.items SET qc_required = true WHERE id = $1`, [rm], users.wm)).rejects.toThrow(/COUNTERSIGN_REQUIRED/);
  });

  it('a GRN lot of an item without QC starts APPROVED with no sample request; with QC: QUARANTINE + request', async () => {
    const rm = await item('RM-NOQC', 'RM');
    const src = await approvedSource(ids.vendor!, rm);
    expect((await call('wm', 'patch', `/master/items/${rm}`, { qcRequired: false, ...countersignBy('qa') })).status).toBe(200);
    const po = await approvedPo([
      { itemId: rm, qty: '4', unitPrice: '10' },
      { itemId: ids.rm!, qty: '4', unitPrice: '10' },
    ]);
    const g = await postedGrn(po, [
      { poLineId: po.lineIds[0], qty: '4', approvedSourceId: src },
      rmLine(po.lineIds[1]!, '4'),
    ]);
    expect(g.lines[0]).toMatchObject({ lotStatus: 'APPROVED', sampleRequest: null });
    expect(g.lines[1]).toMatchObject({ lotStatus: 'QUARANTINE', sampleRequest: { status: 'OPEN' } });
    expect(await count(`SELECT count(*) AS n FROM core.status_history WHERE entity_table = 'inv.lots' AND entity_id = $1 AND from_status IS NULL AND to_status = 'APPROVED' AND actor_id = $2`, [g.lines[0].lotId, users.store])).toBe(1);
    // The database refuses an APPROVED lot for an item that needs QC.
    await expect(
      inTx(users.store!, async () => {
        const lot = await one(`INSERT INTO inv.lots (item_id, lot_no, status, unit_cost, source) VALUES ($1, 'X-QC-1', 'APPROVED', 1, 'GRN') RETURNING id`, [ids.rm]);
        await history('inv.lots', lot, null, 'APPROVED', users.store!);
      }),
    ).rejects.toThrow(/created in QUARANTINE/);
  });
});

describe('GRN remaining shelf life (owner 2026-11-25, answer 3)', () => {
  it('is off by default; at 50% refuses short-dated material on save and at posting; uses the item shelf life without a mfg date', async () => {
    const po = await approvedPo([{ itemId: ids.rm!, qty: '50', unitPrice: '1' }]);
    const short = { mfgDate: '2026-01-01', expiryDate: '2027-01-01' }; // 38 of 365 days left on 24-11-2026
    const long = { mfgDate: '2026-11-01', expiryDate: '2028-11-24' };
    const draft = await call('store', 'post', '/purch/grns', grnBody(po.id, [rmLine(po.lineIds[0]!, '5', short)]));
    expect(draft.status).toBe(201); // setting 0 = off
    try {
      await setShelfPct(50);
      const refused = await call('store', 'post', '/purch/grns', grnBody(po.id, [rmLine(po.lineIds[0]!, '5', short)]));
      expect([refused.status, refused.body.error.code]).toEqual([422, 'SHELF_LIFE_TOO_SHORT']);
      expect(refused.body.error.details).toMatchObject({ daysLeft: 38, totalDays: 365, minPct: 50 });
      // The draft saved while the setting was off is refused at posting.
      expect((await post('store', draft.body.id)).body.error.code).toBe('SHELF_LIFE_TOO_SHORT');
      expect((await call('store', 'post', '/purch/grns', grnBody(po.id, [rmLine(po.lineIds[0]!, '5', long)]))).status).toBe(201);
      // No mfg date: the item's shelf life is the total; without one, the mfg date is asked for.
      const noMfg = await call('store', 'post', '/purch/grns', grnBody(po.id, [rmLine(po.lineIds[0]!, '5', { expiryDate: '2027-06-01' })]));
      expect([noMfg.status, noMfg.body.error.details.field]).toEqual([400, 'mfgDate']);
      await raw(`UPDATE master.items SET shelf_life_days = 365 WHERE id = $1`, [ids.spare], users.pm);
      const spPo = await approvedPo([{ itemId: ids.spare!, qty: '5', unitPrice: '1' }]);
      const spShort = await call('store', 'post', '/purch/grns', grnBody(spPo.id, [{ poLineId: spPo.lineIds[0], qty: '1', expiryDate: '2027-01-24' }]));
      expect([spShort.status, spShort.body.error.details]).toEqual([422, expect.objectContaining({ daysLeft: 61, totalDays: 365 })]);
      expect((await call('store', 'post', '/purch/grns', grnBody(spPo.id, [{ poLineId: spPo.lineIds[0], qty: '1', expiryDate: '2027-11-24' }]))).status).toBe(201);
      // Database backstop on the line.
      await expect(raw(`UPDATE purch.grn_lines SET mfg_date = '2026-01-01', expiry_date = '2027-01-01' WHERE grn_id = $1`, [draft.body.id], users.store)).rejects.toThrow(/SHELF_LIFE_TOO_SHORT/);
    } finally {
      await setShelfPct(0);
      await raw(`UPDATE master.items SET shelf_life_days = NULL WHERE id = $1`, [ids.spare], users.pm);
    }
  });
});

describe('GRN cancel (owner 2026-11-25, answer 5)', () => {
  it('cancels a DRAFT with a reason (purch.grn.post); refuses without a reason, without the key, and once posted', async () => {
    const po = await approvedPo([{ itemId: ids.spare!, qty: '5', unitPrice: '10' }]);
    const draft = await call('store', 'post', '/purch/grns', grnBody(po.id, [{ poLineId: po.lineIds[0], qty: '2' }]));
    const url = `/purch/grns/${draft.body.id}/cancel`;
    expect((await call('store', 'post', url, {})).status).toBe(400);
    expect((await call('buyer', 'post', url, { reason: 'Wrong PO scanned' })).status).toBe(403);
    const ok = await call('store', 'post', url, { reason: 'Wrong PO scanned' });
    expect([ok.status, ok.body.status, ok.body.totalPkr]).toEqual([200, 'CANCELLED', null]);
    expect(await count(`SELECT count(*) AS n FROM core.status_history WHERE entity_table = 'purch.grns' AND entity_id = $1 AND to_status = 'CANCELLED' AND reason = 'Wrong PO scanned'`, [draft.body.id])).toBe(1);
    expect((await post('store', draft.body.id)).body.error.code).toBe('RECORD_LOCKED');
    expect((await call('store', 'post', url, { reason: 'again' })).status).toBe(409);
    const g = await postedGrn(po, [{ poLineId: po.lineIds[0], qty: '1' }]);
    const posted = await call('store', 'post', `/purch/grns/${g.id}/cancel`, { reason: 'Too late' });
    expect([posted.status, posted.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);
  });
});

describe('GRN reversal (owner 2026-11-25, answer 5)', () => {
  it('reverses an untouched GRN in one transaction: stock, journal, sample requests, PO quantities and status', async () => {
    const po = await approvedPo([
      { itemId: ids.rm!, qty: '10', unitPrice: '12.5' },
      { itemId: ids.spare!, qty: '2', unitPrice: '100' },
    ]);
    const g = await postedGrn(po, [rmLine(po.lineIds[0]!, '10'), { poLineId: po.lineIds[1], qty: '2' }]);
    expect((await call('store', 'get', `/purch/pos/${po.id}`)).body.status).toBe('RECEIVED');

    const res = await reverse('wm', g.id, { signature: { password: TEST_PASSWORD, meaning: 'APPROVED', reason: 'Delivered to the wrong site' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'REVERSED', journalDocNo: g.journalDocNo, totalPkr: '325.00' });
    expect(res.body.reversalJournalDocNo).toMatch(/^SJ-/);
    expect(res.body.lines.map((l: { lotStatus: string; sampleRequest: unknown }) => [l.lotStatus, l.sampleRequest])).toEqual([
      ['QUARANTINE', expect.objectContaining({ status: 'CANCELLED' })],
      ['APPROVED', null],
    ]);
    // Stock and GL back to zero for this GRN; the lots are kept.
    const { rows: led } = await client.query(
      `SELECT sum(qty)::text AS qty, sum(value)::text AS value FROM inv.stock_movements WHERE ref_doc_type = 'GRN' AND ref_doc_id = $1`, [g.id]);
    expect(led[0]).toEqual({ qty: '0.0000', value: '0.00' });
    const { rows: gl } = await client.query(
      `SELECT sum(l.debit)::text AS dr, sum(l.credit)::text AS cr, array_agg(DISTINCT e.status ORDER BY e.status) AS st
         FROM fin.journal_entries e JOIN fin.journal_lines l ON l.entry_id = e.id WHERE e.source_type = 'GRN' AND e.source_id = $1`, [g.id]);
    expect(gl[0]).toEqual({ dr: '650.00', cr: '650.00', st: ['POSTED', 'REVERSED'] });
    expect(await count(`SELECT count(*) AS n FROM inv.lots WHERE id = ANY($1::bigint[])`, [g.lines.map((l: { lotId: string }) => l.lotId)])).toBe(2);
    // E-signature on the move; PO back to APPROVED with nothing received.
    expect(await count(`SELECT count(*) AS n FROM core.status_history WHERE entity_table = 'purch.grns' AND entity_id = $1 AND to_status = 'REVERSED' AND esign_id IS NOT NULL AND actor_id = $2`, [g.id, users.wm])).toBe(1);
    const after = (await call('store', 'get', `/purch/pos/${po.id}`)).body;
    expect(after.status).toBe('APPROVED');
    expect(after.lines.map((l: { receivedQty: string }) => l.receivedQty)).toEqual(['0.0000', '0.0000']);
    // The goods can be received again.
    await postedGrn(po, [rmLine(po.lineIds[0]!, '10')]);
    expect((await call('store', 'get', `/purch/pos/${po.id}`)).body.status).toBe('PARTIALLY_RECEIVED');
  });

  it('puts a RECEIVED PO back to PARTIALLY_RECEIVED when an earlier GRN stays', async () => {
    const po = await approvedPo([{ itemId: ids.spare!, qty: '10', unitPrice: '1' }]);
    await postedGrn(po, [{ poLineId: po.lineIds[0], qty: '6' }]);
    const g2 = await postedGrn(po, [{ poLineId: po.lineIds[0], qty: '4' }]);
    expect((await reverse('wm', g2.id)).status).toBe(200);
    const after = (await call('store', 'get', `/purch/pos/${po.id}`)).body;
    expect([after.status, after.lines[0].receivedQty]).toEqual(['PARTIALLY_RECEIVED', '6.0000']);
  });

  it('refuses: without purch.grn.reverse, without Idempotency-Key, a bad signature, a DRAFT, a second reversal', async () => {
    const po = await approvedPo([{ itemId: ids.spare!, qty: '5', unitPrice: '1' }]);
    const g = await postedGrn(po, [{ poLineId: po.lineIds[0], qty: '3' }]);
    expect((await reverse('store', g.id)).status).toBe(403);
    expect((await call('wm', 'post', `/purch/grns/${g.id}/reverse`, sign('APPROVED'))).status).toBe(400);
    expect((await reverse('wm', g.id, { signature: { password: 'wrong-password', meaning: 'APPROVED', reason: 'Wrong' } })).body.error.code).toBe('ESIGN_FAILED');
    expect((await reverse('wm', g.id, sign('REJECTED'))).status).toBe(400);
    expect((await reverse('wm', g.id, { signature: { password: TEST_PASSWORD, meaning: 'APPROVED' } })).status).toBe(400); // no reason
    const draft = await call('store', 'post', '/purch/grns', grnBody(po.id, [{ poLineId: po.lineIds[0], qty: '1' }]));
    expect([(await reverse('wm', draft.body.id)).status]).toEqual([409]);
    expect((await reverse('wm', g.id)).status).toBe(200);
    const again = await reverse('wm', g.id);
    expect([again.status, again.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);
  });

  it('refuses with GRN_LOTS_IN_USE once a lot has moved or been reserved (the route is QC rejection + return to vendor)', async () => {
    const loc2 = await inTx('1', () =>
      one(`INSERT INTO master.locations (warehouse_id, code, name) SELECT warehouse_id, 'REV2', 'Second bay' FROM master.locations WHERE id = $1 RETURNING id`, [ids.loc]),
    );
    const wm = await actorOf('wm');
    // Moved: a transfer out of the receiving location.
    const po = await approvedPo([{ itemId: ids.rm!, qty: '5', unitPrice: '2' }]);
    const g = await postedGrn(po, [rmLine(po.lineIds[0]!, '5')]);
    await withTransaction({ userId: wm.userId, companyId: '1' }, (tx) =>
      transfer(tx, wm, { lotId: g.lines[0].lotId, fromLocationId: ids.loc!, toLocationId: loc2, qty: '1', date: GRN_DATE, refDocType: 'TRANSFER', refDocId: '901' }),
    );
    const moved = await reverse('wm', g.id);
    expect([moved.status, moved.body.error.code]).toEqual([422, 'GRN_LOTS_IN_USE']);
    expect(moved.body.error.details.lots[0]).toMatchObject({ lotNo: g.lines[0].lotNo, touches: ['2 other movement(s)'] });
    // Reserved: an APPROVED lot of an item without QC.
    const spPo = await approvedPo([{ itemId: ids.spare!, qty: '5', unitPrice: '2' }]);
    const sg = await postedGrn(spPo, [{ poLineId: spPo.lineIds[0], qty: '5' }]);
    await withTransaction({ userId: wm.userId, companyId: '1' }, (tx) =>
      reserve(tx, wm, { lotId: sg.lines[0].lotId, qty: '1', refDocType: 'PROD_ORDER', refDocId: '902' }),
    );
    const reserved = await reverse('wm', sg.id);
    expect([reserved.status, reserved.body.error.code]).toEqual([422, 'GRN_LOTS_IN_USE']);
    // Nothing changed.
    expect((await call('store', 'get', `/purch/grns/${g.id}`)).body.status).toBe('POSTED');
  });

  it('database guards: REVERSED needs mirrored receipts and cancelled requests; a request is cancelled only with its GRN reversed', async () => {
    const po = await approvedPo([{ itemId: ids.rm!, qty: '2', unitPrice: '2' }]);
    const g = await postedGrn(po, [rmLine(po.lineIds[0]!, '2')]);
    await expect(
      inTx(users.wm!, async () => {
        await history('purch.grns', g.id, 'POSTED', 'REVERSED', users.wm!);
        await client.query(`UPDATE purch.grns SET status = 'REVERSED' WHERE id = $1`, [g.id]);
      }),
    ).rejects.toThrow(/receipt is not reversed/);
    const sr = g.lines[0].sampleRequest.id as string;
    await expect(
      inTx(users.wm!, async () => {
        await history('qc.sample_requests', sr, 'OPEN', 'CANCELLED', users.wm!);
        await client.query(`UPDATE qc.sample_requests SET status = 'CANCELLED' WHERE id = $1`, [sr]);
      }),
    ).rejects.toThrow(/cancelled only by reversing its GRN/);
    await expect(raw(`UPDATE purch.grns SET status = 'CANCELLED' WHERE id = $1`, [g.id], users.wm)).rejects.toThrow(/INVALID_TRANSITION/);
  });
});
