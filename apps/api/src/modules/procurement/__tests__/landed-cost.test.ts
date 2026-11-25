// M3 task 4: landed cost (owner Q21 2026-11-19, Q2/Q3 2026-11-25; architecture §6 "Landed cost"; 0029).
// Charge types; known charges entered on a DRAFT GRN roll into the lot cost when the GRN posts; later bills as
// value-only adjustments on the share still held, the consumed share to price variance; posting on the charge date
// in an open period. Happy paths and every refusal through the HTTP endpoints, plus the 0029 database guards.
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { createApp } from '../../../app';
import { databaseUrl } from '../../../config/env';
import { runSeed } from '../../../db/seed/run';
import { createTestUser, TEST_PASSWORD } from '../../../test/factories';
import { systemContext, withTransaction } from '../../../db/client';
import { permissionKeysForUser } from '../../../core/auth/auth.repo';
import type { Actor } from '../../../core/transition/transition';
import { postMovement, postValueAdjustment } from '../../../engines/inventory';
import { postStockJournal } from '../../../engines/posting';
import { allocateCharge, splitByWeights } from '../landed-costs.service';

const app = createApp();
const client = new pg.Client({ connectionString: databaseUrl });
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};
const ids: Record<string, string> = {};
const types: Record<string, string> = {};

const PO_DATE = '2026-11-20';
const GRN_DATE = '2026-11-24';
const BILL_DATE = '2026-11-25';
let keyNo = 0;

function call(who: string, method: 'get' | 'post' | 'patch', url: string, body?: object) {
  const r = request(app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`);
  return body ? r.send(body) : r;
}
const act = (who: string, url: string, body?: object) => call(who, 'post', url, body).set('Idempotency-Key', `lc-test-${++keyNo}`);
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

async function approvedSource(vendorId: string, itemId: string, manufacturer: string): Promise<string> {
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

async function approvedPo(
  lines: { itemId: string; qty: string; unitPrice: string }[],
  opts: { vendorId?: string; currency?: string; poDate?: string } = {},
): Promise<{ id: string; docNo: string; lineIds: string[] }> {
  const imp = opts.currency && opts.currency !== 'PKR';
  const res = await call('buyer', 'post', '/purch/pos', {
    poDate: opts.poDate ?? PO_DATE,
    vendorId: opts.vendorId ?? ids.vendor,
    poType: imp ? 'IMPORT' : 'LOCAL',
    currency: opts.currency ?? 'PKR',
    ...(imp ? { incoterm: 'CIF' } : {}),
    lines,
  });
  expect(res.status).toBe(201);
  expect((await call('buyer', 'post', `/purch/pos/${res.body.id}/submit`)).status).toBe(200);
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM core.approvals WHERE doc_table = 'purch.purchase_orders' AND doc_id = $1 ORDER BY id DESC LIMIT 1`,
    [res.body.id],
  );
  expect((await call('pm', 'post', `/core/approvals/${rows[0]!.id}/approve`, sign('APPROVED'))).status).toBe(200);
  return { id: res.body.id, docNo: res.body.docNo, lineIds: res.body.lines.map((l: { id: string }) => l.id) };
}

/** A DRAFT GRN (Storekeeper). */
async function draftGrn(poId: string, lines: object[], grnDate = GRN_DATE) {
  const res = await call('store', 'post', '/purch/grns', { poId, grnDate, locationId: ids.loc, lines });
  expect(res.status).toBe(201);
  return res.body as { id: string; docNo: string; lines: { id: string; poLineId: string }[] };
}
async function postGrn(grnId: string) {
  const res = await act('store', `/purch/grns/${grnId}/post`);
  expect([res.status, res.body.error]).toEqual([200, undefined]);
  return res.body as { id: string; docNo: string; landedCosts: { status: string }[]; lines: { id: string; lotId: string; lotNo: string }[] };
}

/** A spare (no QC: lot APPROVED), PKR, received in full and posted. */
async function postedSpareGrn(qty: string, unitPrice: string, dates: { poDate?: string; grnDate?: string } = {}) {
  const po = await approvedPo([{ itemId: ids.spare!, qty, unitPrice }], { poDate: dates.poDate });
  const grn = await draftGrn(po.id, [{ poLineId: po.lineIds[0], qty, manufacturer: 'Spares Co' }], dates.grnDate);
  return { po, grn: await postGrn(grn.id) };
}

const charge = (grnId: string, code: string, amount: string, extra: object = {}) => ({
  grnId,
  chargeTypeId: types[code],
  chargeDate: GRN_DATE,
  amount,
  ...extra,
});

async function actorOf(who: string): Promise<Actor> {
  const keys = await withTransaction(systemContext('test'), (tx) => permissionKeysForUser(tx, users[who]!));
  return { userId: users[who]!, companyId: '1', permissions: new Set(keys) };
}

/** Consumes stock from a lot: ADJUSTMENT_OUT + its STOCK_ADJUSTMENT journal (Finance Manager), one transaction. */
async function consume(lotId: string, qty: string, date = GRN_DATE): Promise<void> {
  const fm = await actorOf('fm');
  await withTransaction({ userId: fm.userId, companyId: '1' }, async (tx) => {
    const m = await postMovement(tx, fm, { type: 'ADJUSTMENT_OUT', lotId, locationId: ids.loc!, qty, date, refDocType: 'ADJUSTMENT', refDocId: String(++keyNo) });
    await postStockJournal(tx, fm, { movements: [m], narration: 'test consumption' });
  });
}

const lotOf = async (lotId: string) =>
  (await client.query<{ unit_cost: string; qty: string; value: string }>(
    `SELECT l.unit_cost, coalesce(sum(m.qty), 0)::text AS qty, coalesce(sum(m.value), 0)::text AS value
       FROM inv.lots l LEFT JOIN inv.stock_movements m ON m.lot_id = l.id WHERE l.id = $1 GROUP BY l.unit_cost`,
    [lotId],
  )).rows[0]!;

/** Journal lines of a landed cost, per account code. */
async function journalOf(chargeId: string) {
  const { rows } = await client.query(
    `SELECT je.event, je.entry_date::text AS date, a.code, sum(jl.debit)::text AS dr, sum(jl.credit)::text AS cr, max(jl.vendor_id) AS vendor
       FROM fin.journal_lines jl JOIN fin.journal_entries je ON je.id = jl.entry_id JOIN fin.accounts a ON a.id = jl.account_id
      WHERE je.source_type = 'LANDED_COST' AND je.source_id = $1 AND je.status = 'POSTED'
      GROUP BY je.event, je.entry_date, a.code ORDER BY a.code`,
    [chargeId],
  );
  return rows;
}

/** Owner 2026-11-18: the inventory GL balance equals the sum of the ledger movement values. */
async function glEqualsLedger(): Promise<void> {
  const { rows: gl } = await client.query<{ v: string }>(
    `SELECT COALESCE(sum(l.debit - l.credit), 0)::text AS v FROM fin.journal_lines l JOIN fin.journal_entries e ON e.id = l.entry_id
      WHERE e.status IN ('POSTED', 'REVERSED') AND l.account_id IN (SELECT account_id FROM fin.posting_rules WHERE account_role = 'INVENTORY')`,
  );
  const { rows: led } = await client.query<{ v: string }>(
    `SELECT COALESCE(sum(m.value), 0)::text AS v FROM inv.stock_movements m JOIN inv.lots l ON l.id = m.lot_id WHERE l.owner_type = 'OWN'`,
  );
  expect(new Decimal(gl[0]!.v).toFixed(2)).toBe(new Decimal(led[0]!.v).toFixed(2));
}

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  for (const [name, roles] of [
    ['buyer', ['PURCHASE_OFFICER']],
    ['pm', ['PURCHASE_MANAGER']],
    ['fm', ['FINANCE_MANAGER']],
    ['store', ['STOREKEEPER']],
    ['wm', ['WAREHOUSE_MANAGER']],
    ['qa', ['QA_MANAGER']],
  ] as const) {
    users[name] = await createTestUser({ username: `lc_${name}`, roleCodes: [...roles] });
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: `lc_${name}`, password: TEST_PASSWORD });
    tokens[name] = res.body.accessToken as string;
  }
  await inTx('1', async () => {
    ids.uom = await one(`INSERT INTO master.uoms (code, name) VALUES ('KG', 'Kilogram') RETURNING id`);
    ids.category = await one(`INSERT INTO master.item_categories (code, name) VALUES ('RM', 'Raw material') RETURNING id`);
    const wh = await one(`INSERT INTO master.warehouses (code, name) VALUES ('MAIN', 'Main store') RETURNING id`);
    ids.loc = await one(`INSERT INTO master.locations (warehouse_id, code, name) VALUES ($1, 'QUAR', 'Quarantine bay') RETURNING id`, [wh]);
  });
  await inTx(users.fm!, async () => {
    for (const [no, name, start, end] of [
      [4, 'Oct-2026', '2026-10-01', '2026-10-31'],
      [5, 'Nov-2026', '2026-11-01', '2026-11-30'],
    ] as const) {
      const p = await one(
        `INSERT INTO core.fiscal_periods (fiscal_year, period_no, name, start_date, end_date, status) VALUES ('2026-27', $1, $2, $3, $4, 'OPEN') RETURNING id`,
        [no, name, start, end],
      );
      await history('core.fiscal_periods', p, null, 'OPEN', users.fm!);
      ids[name] = p;
    }
  });
  ids.vendor = await vendor('V-LOCAL');
  ids.usdVendor = await vendor('V-CN', { foreign: true, currency: 'USD' });
  ids.customs = await vendor('CUSTOMS');
  ids.api1 = await item('API-1', 'API');
  ids.api2 = await item('API-2', 'API');
  ids.spare = await item('SP-1', 'SPARE');
  ids.src1 = await approvedSource(ids.usdVendor, ids.api1, 'Hebei Pharma');
  ids.src2 = await approvedSource(ids.usdVendor, ids.api2, 'Hebei Pharma');
  expect((await call('fm', 'post', '/fin/exchange-rates', { currency: 'USD', rateDate: PO_DATE, rate: '279.500000', source: 'SBP' })).status).toBe(200);
  expect((await call('fm', 'post', '/fin/exchange-rates', { currency: 'USD', rateDate: GRN_DATE, rate: '280.000000', source: 'SBP' })).status).toBe(200);
  for (const t of (await call('buyer', 'get', '/purch/landed-cost-types')).body as { id: string; code: string }[]) types[t.code] = t.id;
});

afterAll(async () => {
  await client.end();
});

describe('allocation arithmetic (owner Q21)', () => {
  it('splits to the paisa by largest remainder: totals always add up exactly', () => {
    expect(splitByWeights(new Decimal('100.00'), [1, 1, 1].map((n) => new Decimal(n))).map((d) => d.toFixed(2))).toEqual(['33.34', '33.33', '33.33']);
    expect(splitByWeights(new Decimal('0.01'), [1, 1].map((n) => new Decimal(n))).map((d) => d.toFixed(2))).toEqual(['0.01', '0.00']);
    const lines = [
      { id: 'a', poLineId: 'p1', qty: '6', unitPrice: '10' },
      { id: 'b', poLineId: 'p1', qty: '4', unitPrice: '10' },
      { id: 'c', poLineId: 'p2', qty: '5', unitPrice: '20' },
    ];
    const weight = allocateCharge('1000.01', 'WEIGHT', lines, [
      { poLineId: 'p1', weightKg: '30', gdAmount: null },
      { poLineId: 'p2', weightKg: '10', gdAmount: null },
    ]);
    expect([...weight.values()].map((d) => d.toFixed(2))).toEqual(['450.01', '300.00', '250.00']);
    expect(() => allocateCharge('10.00', 'GD_AMOUNTS', lines, [{ poLineId: 'p1', gdAmount: '9.00', weightKg: null }])).toThrow(/add up to 9.00/);
  });
});

describe('charge types (owner Q21; Finance keeps them)', () => {
  it('seeds the owner\'s eight types; Finance adds and edits; others are refused; bad combinations refused', async () => {
    const list = (await call('buyer', 'get', '/purch/landed-cost-types')).body as { code: string; capitalise: boolean; taxRole: string | null }[];
    expect(list.map((t) => t.code)).toEqual(['ACD', 'CD', 'CLEARING', 'FREIGHT', 'IMPORT_IT', 'IMPORT_ST', 'INSURANCE', 'RD']);
    expect(list.filter((t) => !t.capitalise).map((t) => [t.code, t.taxRole])).toEqual([
      ['IMPORT_IT', 'ADVANCE_TAX'],
      ['IMPORT_ST', 'INPUT_TAX'],
    ]);
    const body = { code: 'DEMURRAGE', name: 'Port demurrage', capitalise: true, defaultBasis: 'WEIGHT' };
    expect((await call('buyer', 'post', '/purch/landed-cost-types', body)).status).toBe(403);
    const made = await call('fm', 'post', '/purch/landed-cost-types', body);
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ code: 'DEMURRAGE', capitalise: true, taxRole: null, isDuty: false, defaultBasis: 'WEIGHT', isActive: true });
    expect((await call('fm', 'post', '/purch/landed-cost-types', body)).body.error.code).toBe('ALREADY_EXISTS');
    const bad = async (b: object) => (await call('fm', 'post', '/purch/landed-cost-types', b)).status;
    expect(await bad({ code: 'X1', name: 'x', capitalise: true, taxRole: 'INPUT_TAX', defaultBasis: 'VALUE' })).toBe(400);
    expect(await bad({ code: 'X2', name: 'x', capitalise: false })).toBe(400);
    expect(await bad({ code: 'X3', name: 'x', capitalise: true, isDuty: true, defaultBasis: 'WEIGHT' })).toBe(400);
    expect(await bad({ code: 'X4', name: 'x', capitalise: true, defaultBasis: 'GD_AMOUNTS' })).toBe(400);
    const edit = await call('fm', 'patch', `/purch/landed-cost-types/${made.body.id}`, { defaultBasis: 'VALUE' });
    expect(edit.body.defaultBasis).toBe('VALUE');
    expect((await call('fm', 'patch', `/purch/landed-cost-types/${types.CD}`, { defaultBasis: 'WEIGHT' })).status).toBe(400);
    const off = await call('fm', 'post', `/purch/landed-cost-types/${made.body.id}/deactivate`, { reason: 'Not used here' });
    expect(off.body.isActive).toBe(false);
    types.DEMURRAGE = made.body.id;
  });
});

describe('known charges entered with the GRN (owner Q2): the lot is received at full cost', () => {
  it('rolls duties (GD amounts), freight (weight) and insurance (value) into the lots and posts import taxes, all with the GRN', async () => {
    const po = await approvedPo(
      [
        { itemId: ids.api1!, qty: '10', unitPrice: '10' },
        { itemId: ids.api2!, qty: '5', unitPrice: '20' },
      ],
      { vendorId: ids.usdVendor, currency: 'USD' },
    );
    const dates = { mfrBatchNo: 'MB-1', mfgDate: '2026-06-01', expiryDate: '2028-05-31', retestDate: '2027-05-31' };
    const grn = await draftGrn(po.id, [
      { poLineId: po.lineIds[0], qty: '6', approvedSourceId: ids.src1, ...dates },
      { poLineId: po.lineIds[0], qty: '4', approvedSourceId: ids.src1, ...dates, mfrBatchNo: 'MB-2' },
      { poLineId: po.lineIds[1], qty: '5', approvedSourceId: ids.src2, ...dates },
    ]);

    // The Storekeeper does not enter charges (purch.landed_cost.manage: Purchase Officer).
    expect((await call('store', 'post', '/purch/landed-costs', charge(grn.id, 'CD', '10000'))).status).toBe(403);
    const gd = [
      { poLineId: po.lineIds[0], gdAmount: '7000' },
      { poLineId: po.lineIds[1], gdAmount: '3000' },
    ];
    const cd = await call('buyer', 'post', '/purch/landed-costs', charge(grn.id, 'CD', '10000', { basis: 'GD_AMOUNTS', inputs: gd, vendorId: ids.customs, reference: 'GD-KAPE-1234' }));
    expect(cd.status).toBe(201);
    expect(cd.body).toMatchObject({ status: 'DRAFT', withGrn: true, basis: 'GD_AMOUNTS', capitalise: true });
    expect(cd.body.docNo).toMatch(/^LC-2627-\d{5}$/);
    const fr = await call('buyer', 'post', '/purch/landed-costs', charge(grn.id, 'FREIGHT', '1000.01', {
      basis: 'WEIGHT',
      inputs: [
        { poLineId: po.lineIds[0], weightKg: '30' },
        { poLineId: po.lineIds[1], weightKg: '10' },
      ],
    }));
    expect(fr.status).toBe(201);
    const ins = await call('buyer', 'post', '/purch/landed-costs', charge(grn.id, 'INSURANCE', '560'));
    expect(ins.body.basis).toBe('VALUE'); // the type's default
    const st = await call('buyer', 'post', '/purch/landed-costs', charge(grn.id, 'IMPORT_ST', '9000', { vendorId: ids.customs }));
    const it = await call('buyer', 'post', '/purch/landed-costs', charge(grn.id, 'IMPORT_IT', '3000', { vendorId: ids.customs }));
    expect([st.status, it.status]).toEqual([201, 201]);
    // A charge entered with the GRN is posted by the GRN, not on its own.
    const early = await act('buyer', `/purch/landed-costs/${cd.body.id}/post`);
    expect([early.status, early.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);

    const posted = await postGrn(grn.id);
    expect(posted.landedCosts.map((c) => c.status)).toEqual(['POSTED', 'POSTED', 'POSTED', 'POSTED', 'POSTED']);
    // 6 × 2800 = 16800 + 4200 + 450.01 + 168 ; 4 × 2800 = 11200 + 2800 + 300 + 112 ; 5 × 5600 = 28000 + 3000 + 250 + 280
    const [l1, l2, l3] = await Promise.all(posted.lines.map((l) => lotOf(l.lotId)));
    expect(l1).toEqual({ unit_cost: '3603.001667', qty: '6.0000', value: '21618.01' });
    expect(l2).toEqual({ unit_cost: '3603.000000', qty: '4.0000', value: '14412.00' });
    expect(l3).toEqual({ unit_cost: '6306.000000', qty: '5.0000', value: '31530.00' });

    const cdNow = (await call('buyer', 'get', `/purch/landed-costs/${cd.body.id}`)).body;
    expect(cdNow).toMatchObject({ status: 'POSTED', postingDate: GRN_DATE });
    expect(cdNow.allocations.map((a: { amount: string; heldAmount: string; varianceAmount: string }) => [a.amount, a.heldAmount, a.varianceAmount])).toEqual([
      ['4200.00', '4200.00', '0.00'],
      ['2800.00', '2800.00', '0.00'],
      ['3000.00', '3000.00', '0.00'],
    ]);
    // Journals on the GRN date (Storekeeper under purch.grn.post): capitalised Dr Inventory / Cr clearing, taxes Dr tax / Cr clearing.
    expect(await journalOf(cd.body.id)).toEqual([
      { event: 'LANDED_COST', date: GRN_DATE, code: '1310', dr: '10000.00', cr: '0.00', vendor: null },
      { event: 'LANDED_COST', date: GRN_DATE, code: '2130', dr: '0.00', cr: '10000.00', vendor: ids.customs },
    ]);
    expect(await journalOf(st.body.id)).toEqual([
      { event: 'IMPORT_TAX', date: GRN_DATE, code: '1230', dr: '9000.00', cr: '0.00', vendor: null },
      { event: 'IMPORT_TAX', date: GRN_DATE, code: '2130', dr: '0.00', cr: '9000.00', vendor: ids.customs },
    ]);
    expect(await journalOf(it.body.id)).toEqual([
      { event: 'IMPORT_TAX', date: GRN_DATE, code: '1240', dr: '3000.00', cr: '0.00', vendor: null },
      { event: 'IMPORT_TAX', date: GRN_DATE, code: '2130', dr: '0.00', cr: '3000.00', vendor: ids.customs },
    ]);
    const { rows: va } = await client.query(
      `SELECT count(*)::int AS n, sum(value)::text AS v FROM inv.stock_movements WHERE movement_type = 'VALUE_ADJUSTMENT' AND reason_code = 'LANDED_COST'
          AND lot_id = ANY($1::bigint[])`,
      [posted.lines.map((l) => l.lotId)],
    );
    expect(va[0]).toEqual({ n: 9, v: '11560.01' });
    const { rows: who } = await client.query(
      `SELECT DISTINCT actor_id FROM core.status_history WHERE entity_table = 'purch.landed_costs' AND to_status = 'POSTED' AND entity_id = ANY($1::text[])`,
      [[cd.body.id, st.body.id]],
    );
    expect(who).toEqual([{ actor_id: users.store }]);
    // A posted charge never changes; the GRN with posted charges is not reversed.
    const edit = await call('buyer', 'patch', `/purch/landed-costs/${cd.body.id}`, { chargeTypeId: types.CD, chargeDate: GRN_DATE, amount: '1' });
    expect([edit.status, edit.body.error.code]).toEqual([409, 'RECORD_LOCKED']);
    const rev = await act('wm', `/purch/grns/${grn.id}/reverse`, sign('APPROVED', 'Wrong delivery'));
    expect([rev.status, rev.body.error.code]).toEqual([422, 'GRN_HAS_LANDED_COST']);
    await glEqualsLedger();
  });
});

describe('later bills (owner Q21): held share into the lot, consumed share to price variance', () => {
  it('a partly consumed lot: 60% held goes into the lot, 40% to price variance, on the charge date', async () => {
    const { grn } = await postedSpareGrn('10', '100');
    await consume(grn.lines[0]!.lotId, '4');
    const bill = await call('buyer', 'post', '/purch/landed-costs', charge(grn.id, 'FREIGHT', '1000', { chargeDate: BILL_DATE, vendorId: ids.vendor }));
    expect(bill.status).toBe(201);
    expect(bill.body.withGrn).toBe(false);
    const noKey = await call('buyer', 'post', `/purch/landed-costs/${bill.body.id}/post`);
    expect(noKey.status).toBe(400);
    expect((await act('store', `/purch/landed-costs/${bill.body.id}/post`)).status).toBe(403);
    const res = await act('buyer', `/purch/landed-costs/${bill.body.id}/post`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'POSTED', postingDate: BILL_DATE });
    expect(res.body.allocations).toEqual([
      expect.objectContaining({ amount: '1000.00', heldQty: '6.0000', heldAmount: '600.00', varianceAmount: '400.00' }),
    ]);
    expect(await lotOf(grn.lines[0]!.lotId)).toEqual({ unit_cost: '200.000000', qty: '6.0000', value: '1200.00' });
    expect(await journalOf(bill.body.id)).toEqual([
      { event: 'LANDED_COST', date: BILL_DATE, code: '1310', dr: '600.00', cr: '0.00', vendor: null },
      { event: 'LANDED_COST', date: BILL_DATE, code: '2130', dr: '0.00', cr: '1000.00', vendor: ids.vendor },
      { event: 'LANDED_COST', date: BILL_DATE, code: '5200', dr: '400.00', cr: '0.00', vendor: null },
    ]);
    await glEqualsLedger();
  });

  it('a fully consumed lot: the whole charge goes to price variance and the lot gets no row', async () => {
    const { grn } = await postedSpareGrn('5', '100');
    await consume(grn.lines[0]!.lotId, '5');
    const bill = await call('buyer', 'post', '/purch/landed-costs', charge(grn.id, 'INSURANCE', '250', { chargeDate: BILL_DATE }));
    const res = await act('buyer', `/purch/landed-costs/${bill.body.id}/post`);
    expect(res.status).toBe(200);
    expect(res.body.allocations).toEqual([expect.objectContaining({ amount: '250.00', heldQty: '0.0000', heldAmount: '0.00', varianceAmount: '250.00' })]);
    expect(await lotOf(grn.lines[0]!.lotId)).toEqual({ unit_cost: '100.000000', qty: '0.0000', value: '0.00' });
    expect(await journalOf(bill.body.id)).toEqual([
      { event: 'LANDED_COST', date: BILL_DATE, code: '2130', dr: '0.00', cr: '250.00', vendor: null },
      { event: 'LANDED_COST', date: BILL_DATE, code: '5200', dr: '250.00', cr: '0.00', vendor: null },
    ]);
    await glEqualsLedger();
  });

  it('refuses: a bill dated before the GRN, GD amounts that do not add up, a basis the type does not take, an inactive type, a cancelled GRN', async () => {
    const { po, grn } = await postedSpareGrn('2', '100');
    const code = async (body: object) => {
      const r = await call('buyer', 'post', '/purch/landed-costs', body);
      return [r.status, r.body.error?.code];
    };
    expect(await code(charge(grn.id, 'FREIGHT', '10', { chargeDate: '2026-11-23' }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code(charge(grn.id, 'FREIGHT', '10', { chargeDate: '2026-11-26' }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code(charge(grn.id, 'CD', '10', { basis: 'GD_AMOUNTS', inputs: [{ poLineId: po.lineIds[0], gdAmount: '9' }] }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code(charge(grn.id, 'CD', '10', { basis: 'WEIGHT', inputs: [{ poLineId: po.lineIds[0], weightKg: '9' }] }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code(charge(grn.id, 'IMPORT_ST', '10', { basis: 'VALUE' }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code(charge(grn.id, 'FREIGHT', '10', { inputs: [{ poLineId: po.lineIds[0], weightKg: '9' }] }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code(charge(grn.id, 'DEMURRAGE', '10'))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code(charge(grn.id, 'FREIGHT', '0'))).toEqual([400, 'VALIDATION_FAILED']);

    // A cancelled GRN takes its DRAFT charges with it, and takes no new ones.
    const po2 = await approvedPo([{ itemId: ids.spare!, qty: '1', unitPrice: '50' }]);
    const g2 = await draftGrn(po2.id, [{ poLineId: po2.lineIds[0], qty: '1' }]);
    const c2 = await call('buyer', 'post', '/purch/landed-costs', charge(g2.id, 'FREIGHT', '5'));
    expect((await act('store', `/purch/grns/${g2.id}/cancel`, { reason: 'Keyed twice' })).status).toBe(200);
    expect((await call('buyer', 'get', `/purch/landed-costs/${c2.body.id}`)).body.status).toBe('CANCELLED');
    expect(await code(charge(g2.id, 'FREIGHT', '5'))).toEqual([409, 'INVALID_TRANSITION']);
  });

  it('a GRN without posted charges is still reversed, cancelling its DRAFT later bills; a DRAFT bill is cancelled with a reason', async () => {
    const { grn } = await postedSpareGrn('3', '100');
    const bill = await call('buyer', 'post', '/purch/landed-costs', charge(grn.id, 'CLEARING', '30', { chargeDate: BILL_DATE }));
    const rev = await act('wm', `/purch/grns/${grn.id}/reverse`, sign('APPROVED', 'Wrong vendor'));
    expect(rev.status).toBe(200);
    expect((await call('buyer', 'get', `/purch/landed-costs/${bill.body.id}`)).body.status).toBe('CANCELLED');

    const { grn: g2 } = await postedSpareGrn('3', '100');
    const b2 = await call('buyer', 'post', '/purch/landed-costs', charge(g2.id, 'CLEARING', '30', { chargeDate: BILL_DATE }));
    expect((await act('buyer', `/purch/landed-costs/${b2.body.id}/cancel`, {})).status).toBe(400);
    const cancelled = await act('buyer', `/purch/landed-costs/${b2.body.id}/cancel`, { reason: 'Billed twice' });
    expect(cancelled.body.status).toBe('CANCELLED');
    expect((await act('buyer', `/purch/landed-costs/${b2.body.id}/post`)).status).toBe(409);
  });
});

describe('posting date = charge date, in an open period (rule 11)', () => {
  it('posts a later bill in its own month; refuses one dated in a closed period', async () => {
    const { grn } = await postedSpareGrn('4', '100', { poDate: '2026-10-10', grnDate: '2026-10-15' });
    const close = await call('fm', 'post', `/core/fiscal-periods/${ids['Oct-2026']}/close`, { reason: 'October closed' });
    expect(close.status).toBe(200);
    const old = await call('buyer', 'post', '/purch/landed-costs', charge(grn.id, 'FREIGHT', '40', { chargeDate: '2026-10-20' }));
    expect(old.status).toBe(201);
    const refused = await act('buyer', `/purch/landed-costs/${old.body.id}/post`);
    expect([refused.status, refused.body.error.code]).toEqual([422, 'PERIOD_CLOSED']);
    expect((await call('buyer', 'get', `/purch/landed-costs/${old.body.id}`)).body.status).toBe('DRAFT');
    const nov = await call('buyer', 'post', '/purch/landed-costs', charge(grn.id, 'FREIGHT', '40', { chargeDate: '2026-11-02' }));
    const ok = await act('buyer', `/purch/landed-costs/${nov.body.id}/post`);
    expect(ok.status).toBe(200);
    expect((await journalOf(nov.body.id))[0]).toMatchObject({ date: '2026-11-02' });
    await glEqualsLedger();
  });
});

describe('database guards (0029)', () => {
  it('a posted charge and its allocations never change; a used type keeps its capitalise flag; a landed-cost adjustment needs a GRN lot', async () => {
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM purch.landed_costs WHERE status = 'POSTED' ORDER BY id LIMIT 1`);
    const id = rows[0]!.id;
    await expect(raw(`UPDATE purch.landed_costs SET notes = 'x' WHERE id = $1`, [id])).rejects.toThrow(/RECORD_LOCKED/);
    await expect(raw(`UPDATE purch.landed_cost_allocations SET amount = amount WHERE landed_cost_id = $1`, [id])).rejects.toThrow(/RECORD_LOCKED/);
    await expect(raw(`DELETE FROM purch.landed_costs WHERE id = $1`, [id])).rejects.toThrow(/IN_USE/);
    await expect(raw(`UPDATE purch.landed_cost_types SET capitalise = false, tax_role = 'INPUT_TAX', is_duty = false, default_basis = NULL WHERE id = $1`, [types.CD])).rejects.toThrow(
      /IN_USE/,
    );
    const { grn } = await postedSpareGrn('1', '10');
    const buyer = await actorOf('buyer');
    await expect(
      withTransaction({ userId: buyer.userId, companyId: '1' }, (tx) =>
        postValueAdjustment(tx, buyer, { lotId: grn.lines[0]!.lotId, value: '5.00', reason: 'LANDED_COST', date: BILL_DATE, refDocType: 'GRN', refDocId: grn.id }),
      ),
    ).rejects.toThrow(/landed-cost adjustment/);
    await expect(raw(`UPDATE purch.landed_costs SET status = 'POSTED', posting_date = '2026-11-25', posted_by = 1, posted_at = now() WHERE status = 'DRAFT'`)).rejects.toThrow();
  });
});
