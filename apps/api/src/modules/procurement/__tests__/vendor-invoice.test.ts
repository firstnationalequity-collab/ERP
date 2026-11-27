// M3 task 5 (0031): vendor invoices with 3-way match (MATCH_EXCEPTION, owner Q5), CHARGES invoices settling
// landed-cost clearing (Q3), IAS 21 rate differences (Q4), payments with WHT and the approval matrix, vendor ledger,
// AP ageing, PO → CLOSED; plus the owner's 2026-11-26 change: PKR-only charge types. Happy paths and refusals through
// the HTTP endpoints, and the 0031 database guards.
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { createApp } from '../../../app';
import { databaseUrl } from '../../../config/env';
import { runSeed } from '../../../db/seed/run';
import { createTestUser, TEST_PASSWORD } from '../../../test/factories';
import { companyToday } from '../../../core/dates';

const app = createApp();
const client = new pg.Client({ connectionString: databaseUrl });
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};
const ids: Record<string, string> = {};
const types: Record<string, string> = {};
const tax: Record<string, string> = {};

const PO_DATE = '2026-11-02';
const GRN_DATE = '2026-11-04';
const INV_DATE = '2026-11-06';
const PAY_DATE = '2026-11-10';
let keyNo = 0;
let invNo = 0;

function call(who: string, method: 'get' | 'post' | 'patch', url: string, body?: object) {
  const r = request(app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`);
  return body ? r.send(body) : r;
}
const act = (who: string, url: string, body?: object) => call(who, 'post', url, body).set('Idempotency-Key', `vi-test-${++keyNo}`);
const sign = (meaning: 'APPROVED' | 'REJECTED' | 'REVERSED', reason = 'Checked against the bill') => ({ signature: { password: TEST_PASSWORD, meaning, reason } });

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

async function vendor(code: string, opts: { foreign?: boolean; currency?: string; terms?: number } = {}): Promise<string> {
  const id = await inTx(users.buyer!, async () => {
    const v = await one(
      `INSERT INTO master.vendors (code, name, ntn, is_foreign, country, currency, payment_terms_days, status)
       VALUES ($1, $1, $2, $3, $4, $5, $6, 'DRAFT') RETURNING id`,
      [code, opts.foreign ? null : '1234567', opts.foreign ?? false, opts.foreign ? 'CN' : 'PK', opts.currency ?? 'PKR', opts.terms ?? 0],
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

async function spareItem(code: string): Promise<string> {
  const id = await inTx(users.wm!, async () => {
    const i = await one(
      `INSERT INTO master.items (code, name, type, category_id, base_uom_id, status) VALUES ($1, $1, 'SPARE', $2, $3, 'DRAFT') RETURNING id`,
      [code, ids.category, ids.uom],
    );
    await history('master.items', i, null, 'DRAFT', users.wm!);
    return i;
  });
  await inTx(users.pm!, async () => {
    await history('master.items', id, 'DRAFT', 'ACTIVE', users.pm!);
    await client.query(`UPDATE master.items SET status = 'ACTIVE' WHERE id = $1`, [id]);
  });
  return id;
}

/** PO (approved) → GRN (posted) of a spare: lot APPROVED, no QC. */
async function received(qty: string, unitPrice: string, opts: { vendorId?: string; currency?: string; charges?: object[] } = {}) {
  const imp = opts.currency && opts.currency !== 'PKR';
  const po = await call('buyer', 'post', '/purch/pos', {
    poDate: PO_DATE,
    vendorId: opts.vendorId ?? ids.vendor,
    poType: imp ? 'IMPORT' : 'LOCAL',
    currency: opts.currency ?? 'PKR',
    ...(imp ? { incoterm: 'CIF' } : {}),
    lines: [{ itemId: ids.spare, qty, unitPrice }],
  });
  expect(po.status).toBe(201);
  expect((await call('buyer', 'post', `/purch/pos/${po.body.id}/submit`)).status).toBe(200);
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM core.approvals WHERE doc_table = 'purch.purchase_orders' AND doc_id = $1 ORDER BY id DESC LIMIT 1`,
    [po.body.id],
  );
  expect((await call('pm', 'post', `/core/approvals/${rows[0]!.id}/approve`, sign('APPROVED'))).status).toBe(200);
  const grn = await call('store', 'post', '/purch/grns', {
    poId: po.body.id,
    grnDate: GRN_DATE,
    locationId: ids.loc,
    lines: [{ poLineId: po.body.lines[0].id, qty, manufacturer: 'Spares Co' }],
  });
  expect(grn.status).toBe(201);
  for (const c of opts.charges ?? []) expect((await call('buyer', 'post', '/purch/landed-costs', { grnId: grn.body.id, chargeDate: GRN_DATE, ...c })).status).toBe(201);
  const posted = await act('store', `/purch/grns/${grn.body.id}/post`);
  expect([posted.status, posted.body.error]).toEqual([200, undefined]);
  return {
    poId: po.body.id as string,
    grnId: grn.body.id as string,
    grnLineId: posted.body.lines[0].id as string,
    charges: (posted.body.landedCosts as { id: string; chargeTypeCode: string }[]) ?? [],
  };
}

const goods = (poId: string, lines: object[], extra: object = {}) => ({
  invoiceType: 'GOODS',
  poId,
  vendorInvoiceNo: `INV-${++invNo}`,
  invoiceDate: INV_DATE,
  lines,
  ...extra,
});

async function journalOf(sourceType: string, sourceId: string) {
  const { rows } = await client.query(
    `SELECT a.code, sum(jl.debit)::text AS dr, sum(jl.credit)::text AS cr, max(jl.vendor_id) AS vendor
       FROM fin.journal_lines jl JOIN fin.journal_entries je ON je.id = jl.entry_id JOIN fin.accounts a ON a.id = jl.account_id
      WHERE je.source_type = $1 AND je.source_id = $2 AND je.status = 'POSTED'
      GROUP BY a.code ORDER BY a.code`,
    [sourceType, sourceId],
  );
  return rows;
}
const accountBalance = async (code: string) =>
  new Decimal(
    (
      await client.query<{ v: string }>(
        `SELECT coalesce(sum(jl.credit - jl.debit), 0)::text AS v FROM fin.journal_lines jl JOIN fin.journal_entries je ON je.id = jl.entry_id
           JOIN fin.accounts a ON a.id = jl.account_id WHERE a.code = $1 AND je.status IN ('POSTED', 'REVERSED')`,
        [code],
      )
    ).rows[0]!.v,
  ).toFixed(2);

async function approvePayment(paymentId: string, who = 'fm') {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM core.approvals WHERE doc_table = 'purch.vendor_payments' AND doc_id = $1 ORDER BY id DESC LIMIT 1`,
    [paymentId],
  );
  return call(who, 'post', `/core/approvals/${rows[0]!.id}/approve`, sign('APPROVED', 'Payment checked'));
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
    ['acct', ['ACCOUNTANT']],
    ['ap', ['AP_OFFICER']],
    ['acctfm', ['ACCOUNTANT', 'FINANCE_MANAGER']],
    ['apfm', ['AP_OFFICER', 'FINANCE_MANAGER']],
  ] as const) {
    users[name] = await createTestUser({ username: `vi_${name}`, roleCodes: [...roles] });
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: `vi_${name}`, password: TEST_PASSWORD });
    tokens[name] = res.body.accessToken as string;
  }
  await inTx('1', async () => {
    ids.uom = await one(`INSERT INTO master.uoms (code, name) VALUES ('NOS', 'Numbers') RETURNING id`);
    ids.category = await one(`INSERT INTO master.item_categories (code, name) VALUES ('SP', 'Spares') RETURNING id`);
    const wh = await one(`INSERT INTO master.warehouses (code, name) VALUES ('MAIN', 'Main store') RETURNING id`);
    ids.loc = await one(`INSERT INTO master.locations (warehouse_id, code, name) VALUES ($1, 'BAY', 'Receiving bay') RETURNING id`, [wh]);
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
    }
  });
  ids.vendor = await vendor('V-LOCAL', { terms: 30 });
  ids.usdVendor = await vendor('V-CN', { foreign: true, currency: 'USD', terms: 60 });
  ids.customs = await vendor('PK-CUSTOMS');
  ids.forwarder = await vendor('FWD-1');
  ids.spare = await spareItem('SP-1');
  for (const [date, rate] of [
    [PO_DATE, '279.500000'],
    [GRN_DATE, '280.000000'],
    [INV_DATE, '282.000000'],
    [PAY_DATE, '285.000000'],
  ]) {
    expect((await call('fm', 'post', '/fin/exchange-rates', { currency: 'USD', rateDate: date, rate, source: 'SBP' })).status).toBe(200);
  }
  for (const t of (await call('buyer', 'get', '/purch/landed-cost-types')).body as { id: string; code: string }[]) types[t.code] = t.id;
  for (const t of (await client.query<{ id: string; code: string }>(`SELECT id, code FROM master.tax_codes`)).rows) tax[t.code] = t.id;
});

afterAll(async () => {
  await client.end();
});

describe('PKR-only charge types (owner 2026-11-26)', () => {
  it('CD, ACD, RD, IMPORT_ST, IMPORT_IT are PKR only; FREIGHT, INSURANCE, CLEARING may be foreign; service and DB refuse', async () => {
    const list = (await call('buyer', 'get', '/purch/landed-cost-types')).body as { code: string; pkrOnly: boolean }[];
    expect(list.filter((t) => t.pkrOnly).map((t) => t.code)).toEqual(['ACD', 'CD', 'IMPORT_IT', 'IMPORT_ST', 'RD']);
    expect(list.filter((t) => !t.pkrOnly).map((t) => t.code)).toEqual(['CLEARING', 'FREIGHT', 'INSURANCE']);

    const { grnId } = await received('10', '100');
    for (const code of ['CD', 'ACD', 'RD', 'IMPORT_ST', 'IMPORT_IT']) {
      const res = await call('buyer', 'post', '/purch/landed-costs', { grnId, chargeTypeId: types[code], chargeDate: GRN_DATE, amount: '10', currency: 'USD' });
      expect([code, res.status, res.body.error?.code]).toEqual([code, 422, 'CURRENCY_NOT_ALLOWED']);
    }
    const fr = await call('buyer', 'post', '/purch/landed-costs', { grnId, chargeTypeId: types.FREIGHT, chargeDate: GRN_DATE, amount: '10', currency: 'USD' });
    expect([fr.status, fr.body.currency]).toEqual([201, 'USD']);

    // GD amounts are in PKR: a duty Finance adds without the flag still takes GD amounts in PKR only.
    const xd = await call('fm', 'post', '/purch/landed-cost-types', { code: 'XD', name: 'Extra duty', capitalise: true, isDuty: true, defaultBasis: 'VALUE' });
    expect([xd.status, xd.body.pkrOnly]).toEqual([201, false]);
    const { rows } = await client.query<{ id: string }>(`SELECT po_line_id AS id FROM purch.grn_lines WHERE grn_id = $1`, [grnId]);
    const gdUsd = await call('buyer', 'post', '/purch/landed-costs', {
      grnId, chargeTypeId: xd.body.id, chargeDate: GRN_DATE, amount: '10', currency: 'USD', basis: 'GD_AMOUNTS', inputs: [{ poLineId: rows[0]!.id, gdAmount: '10' }],
    });
    expect([gdUsd.status, gdUsd.body.error?.code]).toEqual([422, 'CURRENCY_NOT_ALLOWED']);
    // Finance may flag a type PKR-only.
    expect((await call('fm', 'patch', `/purch/landed-cost-types/${xd.body.id}`, { pkrOnly: true })).body.pkrOnly).toBe(true);
    expect((await call('buyer', 'patch', `/purch/landed-cost-types/${xd.body.id}`, { pkrOnly: false })).status).toBe(403);

    // The database refuses a foreign charge of a PKR-only type.
    await expect(
      raw(
        `INSERT INTO purch.landed_costs (doc_no, grn_id, charge_type_id, charge_date, amount, currency, foreign_amount, exchange_rate, exchange_rate_date, basis, with_grn, status)
         VALUES ('LC-X', $1, $2, $3, 2800, 'USD', 10, 280, $3, 'VALUE', false, 'DRAFT')`,
        [grnId, types.CD, GRN_DATE],
      ),
    ).rejects.toThrow(/CURRENCY_NOT_ALLOWED/);
  });
});

describe('GOODS invoice within the match tolerances (architecture §6)', () => {
  it('posts on the invoice date: Dr GRNI + price variance + input tax / Cr AP; the PO closes once fully billed', async () => {
    const { poId, grnLineId } = await received('10', '100');
    const body = goods(poId, [{ grnLineId, qty: '10', unitPrice: '101', taxCodeId: tax['ST-18'] }]);
    expect((await call('store', 'post', '/purch/vendor-invoices', body)).status).toBe(403);
    const draft = await call('acct', 'post', '/purch/vendor-invoices', body);
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({
      status: 'DRAFT', docNo: expect.stringMatching(/^VI-2627-\d{5}$/), currency: 'PKR', goodsAmount: '1010.00', taxAmount: '181.80', totalAmount: '1191.80',
      totalPkr: '1191.80', dueDate: '2026-12-06',
    });
    // The same vendor bill twice is refused.
    expect((await call('acct', 'post', '/purch/vendor-invoices', { ...body, vendorInvoiceNo: ` ${body.vendorInvoiceNo.toLowerCase()} ` })).body.error.code).toBe('ALREADY_EXISTS');

    const posted = await act('acct', `/purch/vendor-invoices/${draft.body.id}/post`);
    expect([posted.status, posted.body.error]).toEqual([200, undefined]);
    expect(posted.body).toMatchObject({ status: 'POSTED', postingDate: INV_DATE, openAmount: '1191.80', openPkr: '1191.80' });
    expect(posted.body.lines[0]).toMatchObject({ inTolerance: true, priceDiffPct: '1.0000', clearedPkr: '1000.00', priceVariancePkr: '10.00', exchangeDiffPkr: '0.00' });
    expect(await journalOf('VENDOR_INVOICE', draft.body.id)).toEqual([
      { code: '1230', dr: '181.80', cr: '0.00', vendor: null },
      { code: '2110', dr: '0.00', cr: '1191.80', vendor: ids.vendor },
      { code: '2120', dr: '1000.00', cr: '0.00', vendor: null },
      { code: '5200', dr: '10.00', cr: '0.00', vendor: null },
    ]);
    expect((await call('buyer', 'get', `/purch/pos/${poId}`)).body.status).toBe('CLOSED');
    // Posted: never edited again; the database agrees.
    expect((await call('acct', 'patch', `/purch/vendor-invoices/${draft.body.id}`, { vendorInvoiceNo: 'X-1', invoiceDate: INV_DATE, lines: body.lines })).status).toBe(409);
    await expect(raw(`UPDATE purch.vendor_invoices SET notes = 'x' WHERE id = $1`, [draft.body.id])).rejects.toThrow(/RECORD_LOCKED/);
    await expect(raw(`UPDATE purch.vendor_invoice_lines SET qty = 1 WHERE invoice_id = $1`, [draft.body.id])).rejects.toThrow(/RECORD_LOCKED/);
    // A GRN on a vendor invoice is no longer reversed.
    ids.invoicedPkr = draft.body.id;
  });

  it('refuses: a WHT code as the bill tax, a future date, a GRN line of another PO, a GRN on an invoice reversed', async () => {
    const a = await received('5', '100');
    const b = await received('5', '100');
    const bad = async (body: object) => (await call('acct', 'post', '/purch/vendor-invoices', body)).status;
    expect(await bad(goods(a.poId, [{ grnLineId: a.grnLineId, qty: '5', unitPrice: '100', taxCodeId: tax['WHT-153-1A'] }]))).toBe(400);
    expect(await bad(goods(a.poId, [{ grnLineId: a.grnLineId, qty: '5', unitPrice: '100' }], { invoiceDate: '2099-01-01' }))).toBe(400);
    expect(await bad(goods(a.poId, [{ grnLineId: b.grnLineId, qty: '5', unitPrice: '100' }]))).toBe(400);
    const draft = await call('acct', 'post', '/purch/vendor-invoices', goods(a.poId, [{ grnLineId: a.grnLineId, qty: '5', unitPrice: '100' }]));
    expect(draft.status).toBe(201);
    const rev = await act('wm', `/purch/grns/${a.grnId}/reverse`, sign('REVERSED', 'Wrong delivery'));
    expect([rev.status, rev.body.error?.code]).toEqual([409, 'IN_USE']);
    await expect(raw(`UPDATE purch.grns SET status = 'REVERSED' WHERE id = $1`, [a.grnId])).rejects.toThrow(/IN_USE/);
  });
});

describe('3-way match outside tolerance → MATCH_EXCEPTION (owner Q5)', () => {
  it('holds the invoice; a Finance Manager releases it with an e-signature and reason, then it posts', async () => {
    const { poId, grnLineId } = await received('10', '100');
    const draft = await call('acct', 'post', '/purch/vendor-invoices', goods(poId, [{ grnLineId, qty: '10', unitPrice: '110' }]));
    const held = await act('acct', `/purch/vendor-invoices/${draft.body.id}/post`);
    expect(held.body).toMatchObject({ status: 'MATCH_EXCEPTION', journalDocNo: null });
    expect(held.body.lines[0]).toMatchObject({ inTolerance: false, priceDiffPct: '10.0000', poUnitPrice: '100.000000' });
    expect(await journalOf('VENDOR_INVOICE', draft.body.id)).toEqual([]);
    // Held: not edited, not posted by the Accountant; the Accountant has no release key.
    expect((await call('acct', 'patch', `/purch/vendor-invoices/${draft.body.id}`, { vendorInvoiceNo: 'X-2', invoiceDate: INV_DATE, lines: [{ grnLineId, qty: '10', unitPrice: '100' }] })).status).toBe(409);
    expect((await act('acct', `/purch/vendor-invoices/${draft.body.id}/post`)).status).toBe(409);
    expect((await act('acct', `/purch/vendor-invoices/${draft.body.id}/release`, sign('APPROVED'))).status).toBe(403);
    // A wrong password or meaning is refused.
    expect((await act('fm', `/purch/vendor-invoices/${draft.body.id}/release`, { signature: { password: 'wrong', meaning: 'APPROVED', reason: 'ok ok' } })).status).toBe(403);
    expect((await act('fm', `/purch/vendor-invoices/${draft.body.id}/release`, sign('REJECTED'))).status).toBe(400);

    const released = await act('fm', `/purch/vendor-invoices/${draft.body.id}/release`, sign('APPROVED', 'Price rise agreed with the vendor'));
    expect([released.status, released.body.error]).toEqual([200, undefined]);
    expect(released.body).toMatchObject({ status: 'POSTED', releaseReason: 'Price rise agreed with the vendor', releasedByName: expect.any(String) });
    expect(await journalOf('VENDOR_INVOICE', draft.body.id)).toEqual([
      { code: '2110', dr: '0.00', cr: '1100.00', vendor: ids.vendor },
      { code: '2120', dr: '1000.00', cr: '0.00', vendor: null },
      { code: '5200', dr: '100.00', cr: '0.00', vendor: null },
    ]);
    const { rows } = await client.query(`SELECT meaning, reason FROM core.e_signatures WHERE record_table = 'purch.vendor_invoices' AND record_id = $1`, [draft.body.id]);
    expect(rows).toEqual([{ meaning: 'APPROVED', reason: 'Price rise agreed with the vendor' }]);
  });

  it('creator ≠ releaser: one person holding both keys cannot release their own invoice (service and DB)', async () => {
    const { poId, grnLineId } = await received('10', '100');
    const draft = await call('acctfm', 'post', '/purch/vendor-invoices', goods(poId, [{ grnLineId, qty: '10', unitPrice: '120' }]));
    expect((await act('acctfm', `/purch/vendor-invoices/${draft.body.id}/post`)).body.status).toBe('MATCH_EXCEPTION');
    const own = await act('acctfm', `/purch/vendor-invoices/${draft.body.id}/release`, sign('APPROVED'));
    expect([own.status, own.body.error.code]).toEqual([403, 'SEGREGATION_OF_DUTIES']);
    // The database refuses a release without the Finance Manager's signature in the same transaction.
    await expect(
      raw(`UPDATE purch.vendor_invoices SET status = 'POSTED', posting_date = invoice_date, posted_by = $2, posted_at = now(), released_by = $2, released_at = now(), release_reason = 'sneaky' WHERE id = $1`,
        [draft.body.id, users.fm!], users.fm!),
    ).rejects.toThrow();
    // The Finance Manager returns it to DRAFT; the Accountant corrects the price and it posts.
    const back = await call('fm', 'post', `/purch/vendor-invoices/${draft.body.id}/return`, { reason: 'Bill the agreed price' });
    expect(back.body.status).toBe('DRAFT');
    expect((await call('acctfm', 'patch', `/purch/vendor-invoices/${draft.body.id}`, { vendorInvoiceNo: 'RE-1', invoiceDate: INV_DATE, lines: [{ grnLineId, qty: '10', unitPrice: '100' }] })).status).toBe(200);
    expect((await act('acctfm', `/purch/vendor-invoices/${draft.body.id}/post`)).body.status).toBe('POSTED');
  });

  it('quantity billed beyond the received quantity is an exception; the extra goes to price variance when released', async () => {
    const { poId, grnLineId } = await received('10', '100');
    const draft = await call('acct', 'post', '/purch/vendor-invoices', goods(poId, [{ grnLineId, qty: '12', unitPrice: '100' }]));
    const held = await act('acct', `/purch/vendor-invoices/${draft.body.id}/post`);
    expect(held.body.lines[0]).toMatchObject({ inTolerance: false, qtyOver: '2.0000', priceDiffPct: '0.0000' });
    // A DRAFT straight to POSTED outside tolerance is refused by the database too.
    await expect(raw(`UPDATE purch.vendor_invoices SET status = 'DRAFT' WHERE id = $1`, [draft.body.id])).rejects.toThrow();
    const released = await act('fm', `/purch/vendor-invoices/${draft.body.id}/release`, sign('APPROVED', 'Two extra delivered later'));
    expect(released.body.lines[0]).toMatchObject({ matchedQty: '10.0000', clearedPkr: '1000.00', priceVariancePkr: '200.00' });
  });
});

describe('foreign currency (IAS 21, owner Q4)', () => {
  it('invoice at the invoice-date rate: rate difference → exchange, price difference → variance; payment difference → exchange', async () => {
    const { poId, grnLineId } = await received('10', '10', { vendorId: ids.usdVendor, currency: 'USD' });
    // GRN at 280: GRNI 28,000.00. Invoice 10 × 10.10 USD at 282 = 28,482.00.
    const draft = await call('acct', 'post', '/purch/vendor-invoices', goods(poId, [{ grnLineId, qty: '10', unitPrice: '10.10' }]));
    expect(draft.body).toMatchObject({ currency: 'USD', exchangeRate: '282.000000', totalAmount: '101.00', totalPkr: '28482.00', dueDate: '2027-01-05' });
    const posted = await act('acct', `/purch/vendor-invoices/${draft.body.id}/post`);
    expect(posted.body.lines[0]).toMatchObject({ clearedPkr: '28000.00', exchangeDiffPkr: '200.00', priceVariancePkr: '282.00' });
    expect(await journalOf('VENDOR_INVOICE', draft.body.id)).toEqual([
      { code: '2110', dr: '0.00', cr: '28482.00', vendor: ids.usdVendor },
      { code: '2120', dr: '28000.00', cr: '0.00', vendor: null },
      { code: '5200', dr: '282.00', cr: '0.00', vendor: null },
      { code: '6300', dr: '200.00', cr: '0.00', vendor: null },
    ]);

    // Pay 50 USD now (PKR 14,250 at 285): AP 14,100.00 (its share), loss 150.00.
    const p1 = await call('ap', 'post', '/purch/vendor-payments', { vendorId: ids.usdVendor, paymentDate: PAY_DATE, allocations: [{ invoiceId: draft.body.id, amount: '50' }] });
    expect([p1.status, p1.body.error?.field ?? p1.body.error?.details?.field]).toEqual([400, 'pkrPaid']);
    const pay = await call('ap', 'post', '/purch/vendor-payments', {
      vendorId: ids.usdVendor, paymentDate: PAY_DATE, pkrPaid: '14250', reference: 'TT-1', allocations: [{ invoiceId: draft.body.id, amount: '50' }],
    });
    expect(pay.body).toMatchObject({ status: 'DRAFT', currency: 'USD', foreignAmount: '50.00', pkrPaid: '14250.00', whtAmount: '0.00', netPaid: '14250.00' });
    expect((await call('ap', 'post', `/purch/vendor-payments/${pay.body.id}/submit`)).body.status).toBe('PENDING_APPROVAL');
    const self = await approvePayment(pay.body.id, 'ap');
    expect(self.status).toBe(403);
    expect((await approvePayment(pay.body.id)).status).toBe(200);
    const done = await act('ap', `/purch/vendor-payments/${pay.body.id}/post`);
    expect(done.body).toMatchObject({ status: 'POSTED', carryingPkr: '14100.00', exchangeDiffPkr: '150.00' });
    expect(await journalOf('VENDOR_PAYMENT', pay.body.id)).toEqual([
      { code: '1120', dr: '0.00', cr: '14250.00', vendor: null },
      { code: '2110', dr: '14100.00', cr: '0.00', vendor: ids.usdVendor },
      { code: '6300', dr: '150.00', cr: '0.00', vendor: null },
    ]);
    // The rest (51 USD) at a better rate: a gain. The last payment takes the remaining PKR exactly.
    const pay2 = await call('ap', 'post', '/purch/vendor-payments', {
      vendorId: ids.usdVendor, paymentDate: PAY_DATE, pkrPaid: '14000', allocations: [{ invoiceId: draft.body.id, amount: '51' }],
    });
    await call('ap', 'post', `/purch/vendor-payments/${pay2.body.id}/submit`);
    await approvePayment(pay2.body.id);
    // Owner 2026-11-26: posting needs the bank reference; it may be given at posting.
    const noRef = await act('ap', `/purch/vendor-payments/${pay2.body.id}/post`);
    expect([noRef.status, noRef.body.error.details.field]).toEqual([400, 'reference']);
    const done2 = await act('ap', `/purch/vendor-payments/${pay2.body.id}/post`, { reference: 'TT-2' });
    expect(done2.body).toMatchObject({ carryingPkr: '14382.00', exchangeDiffPkr: '-382.00' });
    const inv = await call('acct', 'get', `/purch/vendor-invoices/${draft.body.id}`);
    expect(inv.body).toMatchObject({ paidAmount: '101.00', openAmount: '0.00', openPkr: '0.00' });
    // Paying more than is open is refused.
    const over = await call('ap', 'post', '/purch/vendor-payments', { vendorId: ids.usdVendor, paymentDate: PAY_DATE, pkrPaid: '10', allocations: [{ invoiceId: draft.body.id, amount: '1' }] });
    expect([over.status, over.body.error.code]).toEqual([422, 'AMOUNT_EXCEEDS_OPEN']);
  });
});

describe('CHARGES invoice settles landed-cost clearing (owner Q3)', () => {
  it('Pakistan Customs bills duty and import sales tax in PKR; the forwarder bills USD freight; clearing nets to zero', async () => {
    const clearingBefore = await accountBalance('2130');
    const { grnId, charges } = await received('10', '1000', {
      charges: [
        { chargeTypeId: types.CD, amount: '5000', vendorId: ids.customs, reference: 'GD-1' },
        { chargeTypeId: types.IMPORT_ST, amount: '3000', vendorId: ids.customs, reference: 'GD-1' },
        { chargeTypeId: types.FREIGHT, amount: '100', currency: 'USD', vendorId: ids.forwarder },
      ],
    });
    expect(charges).toHaveLength(3);
    const billable = await call('acct', 'get', `/purch/vendor-invoices/billable?vendorId=${ids.customs}`);
    const mine = (billable.body.charges as { landedCostId: string; chargeTypeCode: string; openAmount: string }[]).filter((c) => charges.some((x) => x.id === c.landedCostId));
    expect(mine.map((c) => [c.chargeTypeCode, c.openAmount])).toEqual([['CD', '5000.00'], ['IMPORT_ST', '3000.00']]);
    const cd = mine[0]!.landedCostId;
    const st = mine[1]!.landedCostId;
    const fr = charges.find((c) => !mine.some((m) => m.landedCostId === c.id))!.id;

    const base = { invoiceType: 'CHARGES', vendorId: ids.customs, invoiceDate: INV_DATE };
    const over = await call('acct', 'post', '/purch/vendor-invoices', { ...base, vendorInvoiceNo: 'PSID-0', lines: [{ landedCostId: cd, amount: '6000' }] });
    expect([over.status, over.body.error.code]).toEqual([422, 'AMOUNT_EXCEEDS_OPEN']);
    const wrongVendor = await call('acct', 'post', '/purch/vendor-invoices', { ...base, vendorId: ids.forwarder, vendorInvoiceNo: 'F-0', lines: [{ landedCostId: cd, amount: '10' }] });
    expect(wrongVendor.status).toBe(400);
    const mixed = await call('acct', 'post', '/purch/vendor-invoices', { ...base, vendorId: ids.forwarder, vendorInvoiceNo: 'F-00', lines: [{ landedCostId: fr, amount: '10' }, { landedCostId: st, amount: '1' }] });
    expect(mixed.status).toBe(400);

    const customs = await call('acct', 'post', '/purch/vendor-invoices', {
      ...base, vendorInvoiceNo: 'PSID-1', lines: [{ landedCostId: cd, amount: '5000' }, { landedCostId: st, amount: '3000' }],
    });
    expect(customs.body).toMatchObject({ invoiceType: 'CHARGES', currency: 'PKR', totalPkr: '8000.00' });
    expect((await act('acct', `/purch/vendor-invoices/${customs.body.id}/post`)).body.status).toBe('POSTED');
    expect(await journalOf('VENDOR_INVOICE', customs.body.id)).toEqual([
      { code: '2110', dr: '0.00', cr: '8000.00', vendor: ids.customs },
      { code: '2130', dr: '8000.00', cr: '0.00', vendor: ids.customs },
    ]);
    // USD freight: 100 USD booked at 280 (28,000.00); billed at 282 (28,200.00): 200.00 exchange loss.
    const fwd = await call('acct', 'post', '/purch/vendor-invoices', { ...base, vendorId: ids.forwarder, vendorInvoiceNo: 'F-1', lines: [{ landedCostId: fr, amount: '100' }] });
    expect(fwd.body).toMatchObject({ currency: 'USD', totalPkr: '28200.00' });
    expect((await act('acct', `/purch/vendor-invoices/${fwd.body.id}/post`)).body.lines[0]).toMatchObject({ clearedPkr: '28000.00', exchangeDiffPkr: '200.00' });
    expect(await accountBalance('2130')).toBe(clearingBefore);

    // Fully billed: a correction may not take the charge below what was invoiced; the GRN is not reversed.
    const corr = await call('buyer', 'post', `/purch/landed-costs/${cd}/correct`, { chargeDate: INV_DATE, amount: '-1', reason: 'Duty refund' });
    expect([corr.status, corr.body.error.code]).toEqual([422, 'CORRECTION_EXCEEDS_CHARGE']);
    expect((await act('wm', `/purch/grns/${grnId}/reverse`, sign('REVERSED', 'Wrong delivery'))).body.error.code).toBe('IN_USE');
  });
});

describe('payment with WHT (0013: blocked while the rate is a placeholder)', () => {
  it('the vendor WHT section and filer status: sensitive edit, placeholder refused, then Dr AP / Cr bank + WHT', async () => {
    // Setting the WHT section of an active vendor needs a countersign (sensitive since 0031).
    const noSign = await call('buyer', 'patch', `/master/vendors/${ids.vendor}`, { whtTaxCodeId: tax['WHT-153-1A'], isFiler: true, filerCheckedOn: INV_DATE });
    expect([noSign.status, noSign.body.error.code]).toEqual([403, 'COUNTERSIGN_REQUIRED']);
    expect((await call('buyer', 'patch', `/master/vendors/${ids.vendor}`, { whtTaxCodeId: tax['ST-18'] })).status).toBe(400);
    expect((await call('buyer', 'patch', `/master/vendors/${ids.vendor}`, { isFiler: true })).status).toBe(400);
    const set = await call('buyer', 'patch', `/master/vendors/${ids.vendor}`, {
      whtTaxCodeId: tax['WHT-153-1A'], isFiler: true, filerCheckedOn: companyToday(), // fresh: no stale-filer warning (0032)
      countersign: { username: 'vi_pm', password: TEST_PASSWORD, meaning: 'APPROVED', reason: 'ATL checked on FBR' },
    });
    expect([set.status, set.body.whtTaxCodeId, set.body.isFiler]).toEqual([200, tax['WHT-153-1A'], true]);
    await expect(raw(`UPDATE master.vendors SET wht_tax_code_id = $2 WHERE id = $1`, [ids.forwarder, tax['ST-18']])).rejects.toThrow(/withholding/);

    // The invoice posted earlier (1,191.80) is paid: WHT 4% (placeholder rate) = 47.67.
    const draft = await call('ap', 'post', '/purch/vendor-payments', { vendorId: ids.vendor, paymentDate: PAY_DATE, allocations: [{ invoiceId: ids.invoicedPkr, amount: '1191.80' }] });
    expect(draft.body).toMatchObject({ pkrPaid: '1191.80', whtRate: '4.0000', whtAmount: '47.67', netPaid: '1144.13', whtRateUnconfirmed: true, payeeIsFiler: true });
    const blocked = await call('ap', 'post', `/purch/vendor-payments/${draft.body.id}/submit`);
    expect([blocked.status, blocked.body.error.code]).toEqual([422, 'TAX_RATE_NOT_CONFIRMED']);
    // Finance confirms the rates (with the non-filer rate) and the base (owner 2026-11-26); submit, a rejection back
    // to DRAFT, then approval and posting.
    expect((await call('fm', 'patch', `/master/tax-codes/${tax['WHT-153-1A']}`, { nonFilerRate: '8', isPlaceholder: false })).status).toBe(200);
    const baseOpen = await call('ap', 'post', `/purch/vendor-payments/${draft.body.id}/submit`);
    expect([baseOpen.status, baseOpen.body.error.code, baseOpen.body.error.details.unconfirmed]).toEqual([422, 'TAX_RATE_NOT_CONFIRMED', 'BASE']);
    expect((await call('fm', 'patch', `/master/tax-codes/${tax['WHT-153-1A']}`, { whtBaseConfirmed: true })).status).toBe(200);
    expect((await call('ap', 'post', `/purch/vendor-payments/${draft.body.id}/submit`)).body.status).toBe('PENDING_APPROVAL');
    expect((await act('ap', `/purch/vendor-payments/${draft.body.id}/post`)).status).toBe(409);
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM core.approvals WHERE doc_table = 'purch.vendor_payments' AND doc_id = $1`, [draft.body.id]);
    expect((await call('fm', 'post', `/core/approvals/${rows[0]!.id}/reject`, sign('REJECTED', 'Attach the bank letter'))).status).toBe(200);
    expect((await call('ap', 'get', `/purch/vendor-payments/${draft.body.id}`)).body.status).toBe('DRAFT');
    await call('ap', 'post', `/purch/vendor-payments/${draft.body.id}/submit`);
    expect((await approvePayment(draft.body.id)).status).toBe(200);
    const posted = await act('ap', `/purch/vendor-payments/${draft.body.id}/post`, { reference: 'CHQ-000123' });
    expect([posted.status, posted.body.status]).toEqual([200, 'POSTED']);
    expect(await journalOf('VENDOR_PAYMENT', draft.body.id)).toEqual([
      { code: '1120', dr: '0.00', cr: '1144.13', vendor: null },
      { code: '2110', dr: '1191.80', cr: '0.00', vendor: ids.vendor },
      { code: '2220', dr: '0.00', cr: '47.67', vendor: ids.vendor },
    ]);
    // Posted: locked (service and DB).
    expect((await call('ap', 'post', `/purch/vendor-payments/${draft.body.id}/cancel`, { reason: 'too late now' })).status).toBe(409);
    await expect(raw(`UPDATE purch.payment_allocations SET foreign_amount = 1 WHERE payment_id = $1`, [draft.body.id])).rejects.toThrow(/RECORD_LOCKED/);
  });

  it('creator ≠ approver also for someone holding both roles; the DB refuses an approval written around the matrix', async () => {
    const { poId, grnLineId } = await received('1', '100');
    const inv = await call('acct', 'post', '/purch/vendor-invoices', goods(poId, [{ grnLineId, qty: '1', unitPrice: '100' }]));
    await act('acct', `/purch/vendor-invoices/${inv.body.id}/post`);
    const pay = await call('apfm', 'post', '/purch/vendor-payments', { vendorId: ids.vendor, paymentDate: PAY_DATE, allocations: [{ invoiceId: inv.body.id, amount: '100' }] });
    await call('apfm', 'post', `/purch/vendor-payments/${pay.body.id}/submit`);
    const own = await approvePayment(pay.body.id, 'apfm');
    expect([own.status, own.body.error.code]).toEqual([403, 'SEGREGATION_OF_DUTIES']);
    await expect(raw(`UPDATE purch.vendor_payments SET status = 'APPROVED' WHERE id = $1`, [pay.body.id], users.fm!)).rejects.toThrow(/SEGREGATION_OF_DUTIES/);
    const cancelled = await call('apfm', 'post', `/purch/vendor-payments/${pay.body.id}/cancel`, { reason: 'Paid by cheque instead' });
    expect(cancelled.body.status).toBe('CANCELLED');
  });
});

describe('vendor ledger and AP ageing (owner 2026-11-25: ageing on payment terms)', () => {
  it('the ledger is the GL payables of the vendor with a running balance; ageing buckets by days past due', async () => {
    const ledger = await call('acct', 'get', `/purch/vendors/${ids.usdVendor}/ledger`);
    expect(ledger.status).toBe(200);
    const lines = ledger.body.lines as { sourceType: string; credit: string; debit: string; balance: string; currency: string; foreignAmount: string }[];
    expect(lines.map((l) => [l.sourceType, l.credit, l.debit, l.balance])).toEqual([
      ['VENDOR_INVOICE', '28482.00', '0.00', '28482.00'],
      ['VENDOR_PAYMENT', '0.00', '14100.00', '14382.00'],
      ['VENDOR_PAYMENT', '0.00', '14382.00', '0.00'],
    ]);
    expect(lines[0]).toMatchObject({ currency: 'USD', foreignAmount: '101.00' });
    expect(ledger.body.closing).toBe('0.00');
    expect((await call('store', 'get', `/purch/vendors/${ids.vendor}/ledger`)).status).toBe(200); // purch.view

    // V-LOCAL: terms 30 days, invoices dated 06-11 → due 06-12.
    const notDue = await call('acct', 'get', `/purch/ap-ageing?asOf=2026-12-01&vendorId=${ids.vendor}`);
    const local = (notDue.body.vendors as { vendorCode: string; notDue: string; d31to60: string; total: string }[])[0]!;
    expect(local.vendorCode).toBe('V-LOCAL');
    expect(local.notDue).toBe(local.total);
    const late = await call('acct', 'get', `/purch/ap-ageing?asOf=2027-01-20&vendorId=${ids.vendor}`);
    const v = late.body.vendors[0];
    expect(v.d31to60).toBe(v.total);
    expect(v.invoices.every((i: { daysPastDue: number }) => i.daysPastDue === 45)).toBe(true);
    // Before the invoices were posted nothing is owed.
    expect((await call('acct', 'get', '/purch/ap-ageing?asOf=2026-11-01')).body.totals.total).toBe('0.00');
    // Paid invoices leave the ageing.
    expect((await call('acct', 'get', `/purch/ap-ageing?vendorId=${ids.usdVendor}`)).body.vendors).toEqual([]);
  });
});
