// M3 close-out (task 6): the build-plan Done-when, end to end through the HTTP endpoints.
//   PO (import, USD) → approve → GRN of a GMP material (approved source; lot in QUARANTINE) with landed costs (duty and
//   freight capitalised; import sales tax and income tax to input / advance tax) → GOODS invoice at the invoice-date
//   rate (price and rate differences) → CHARGES invoices (customs, forwarder) → payments (foreign with an exchange
//   difference; customs; forwarder with WHT). Every journal line is checked against architecture §6: each event's
//   account roles, mapped to accounts by the posting rules, with the amounts, dates and vendor; after each step the
//   inventory GL equals the stock ledger (owner 2026-11-18). Then: a non-AVL vendor PO is refused, and the M3
//   segregation rules (PO creator ≠ approver ≠ GRN receiver; payment creator ≠ approver) are swept in one place.
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import type { AccountRole, PostingEvent } from '@albert/shared';
import { createApp } from '../../../app';
import { databaseUrl } from '../../../config/env';
import { runSeed } from '../../../db/seed/run';
import { companyToday } from '../../../core/dates';
import { createTestUser, TEST_PASSWORD } from '../../../test/factories';

const app = createApp();
const client = new pg.Client({ connectionString: databaseUrl });
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};
const ids: Record<string, string> = {};
const types: Record<string, string> = {};

const PO_DATE = '2026-11-02';
const GRN_DATE = '2026-11-04';
const INV_DATE = '2026-11-06';
const PAY_DATE = '2026-11-10';
const TODAY = companyToday();
let keyNo = 0;

function call(who: string, method: 'get' | 'post' | 'patch', url: string, body?: object) {
  const r = request(app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`);
  return body ? r.send(body) : r;
}
const act = (who: string, url: string, body?: object) => call(who, 'post', url, body).set('Idempotency-Key', `m3-e2e-${++keyNo}`);
const sign = (meaning: 'APPROVED' | 'REVERSED', reason = 'Checked against the documents') => ({ signature: { password: TEST_PASSWORD, meaning, reason } });

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

/** A vendor set up in DRAFT by the Purchase Officer and activated by the Purchase Manager. */
async function vendor(code: string, o: { usd?: boolean; wht?: string; isFiler?: boolean } = {}): Promise<string> {
  const id = await inTx(users.buyer!, async () => {
    const v = await one(
      `INSERT INTO master.vendors (code, name, ntn, is_foreign, country, currency, payment_terms_days, wht_tax_code_id, is_filer, filer_checked_on, status)
       VALUES ($1, $1, $2, $3, $4, $5, 30, $6, $7, $8, 'DRAFT') RETURNING id`,
      [code, o.usd ? null : '1234567', o.usd ?? false, o.usd ? 'CN' : 'PK', o.usd ? 'USD' : 'PKR', o.wht ?? null, o.isFiler ?? null, o.isFiler === undefined ? null : TODAY],
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

/** An item in DRAFT (Warehouse Manager), activated by QA (GMP material) or the Purchase Manager (spare). */
async function item(code: string, type: 'API' | 'SPARE'): Promise<string> {
  const id = await inTx(users.wm!, async () => {
    const i = await one(`INSERT INTO master.items (code, name, type, category_id, base_uom_id, status) VALUES ($1, $1, $2, $3, $4, 'DRAFT') RETURNING id`, [
      code, type, ids.category, ids.uom,
    ]);
    await history('master.items', i, null, 'DRAFT', users.wm!);
    return i;
  });
  const activator = type === 'SPARE' ? users.pm! : users.qa!;
  await inTx(activator, async () => {
    await history('master.items', id, 'DRAFT', 'ACTIVE', activator);
    await client.query(`UPDATE master.items SET status = 'ACTIVE' WHERE id = $1`, [id]);
  });
  return id;
}

/** Approved source (AVL): proposed by the Purchase Officer, approved by QA. */
async function approvedSource(vendorId: string, itemId: string): Promise<string> {
  const id = await inTx(users.buyer!, async () => {
    const s = await one(
      `INSERT INTO master.approved_sources (vendor_id, item_id, manufacturer, manufacturing_site, status) VALUES ($1, $2, 'Hebei Pharma', 'Site A', 'PENDING') RETURNING id`,
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

async function approvalOf(table: string, docId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM core.approvals WHERE doc_table = $1 AND doc_id = $2 ORDER BY id DESC LIMIT 1`, [table, docId]);
  return rows[0]!.id;
}
const approve = async (who: string, table: string, docId: string) => call(who, 'post', `/core/approvals/${await approvalOf(table, docId)}/approve`, sign('APPROVED'));

// ---------------------------------------------------------------- §6 checks

/** The account a posting rule gives an event's role (default rule: the test's categories have no rule of their own). */
async function accountOf(event: PostingEvent, role: AccountRole): Promise<string> {
  const { rows } = await client.query<{ code: string }>(
    `SELECT a.code FROM fin.posting_rules pr JOIN fin.accounts a ON a.id = pr.account_id
      WHERE pr.event = $1 AND pr.account_role = $2 AND pr.item_category_id IS NULL AND pr.is_active`,
    [event, role],
  );
  expect(rows, `posting rule ${event} / ${role}`).toHaveLength(1);
  return rows[0]!.code;
}

type Expected = [role: AccountRole, debit: string, credit: string, vendorId?: string];
/**
 * The journal(s) of one source document for one event: exactly the given role lines (architecture §6), each on the
 * account its posting rule names, on the document's date, balanced, with the vendor on the AP / clearing lines named.
 */
async function expectJournal(sourceType: string, sourceId: string, event: PostingEvent, date: string, expected: Expected[]) {
  const { rows } = await client.query<{ code: string; dr: string; cr: string; vendor: string | null; entry_date: string; status: string }>(
    `SELECT a.code, jl.debit::text AS dr, jl.credit::text AS cr, jl.vendor_id AS vendor, je.entry_date::text AS entry_date, je.status
       FROM fin.journal_lines jl JOIN fin.journal_entries je ON je.id = jl.entry_id JOIN fin.accounts a ON a.id = jl.account_id
      WHERE je.source_type = $1 AND je.source_id = $2 AND je.event = $3 AND je.reversal_of IS NULL
      ORDER BY a.code, jl.debit DESC`,
    [sourceType, sourceId, event],
  );
  const want = await Promise.all(
    expected.map(async ([role, dr, cr, vendorId]) => ({ code: await accountOf(event, role), dr, cr, vendor: vendorId ?? null, entry_date: date, status: 'POSTED' })),
  );
  want.sort((a, b) => a.code.localeCompare(b.code) || Number(b.dr) - Number(a.dr));
  expect(rows, `${event} journal of ${sourceType} ${sourceId}`).toEqual(want);
  const dr = rows.reduce((s, r) => s.plus(r.dr), new Decimal(0));
  const cr = rows.reduce((s, r) => s.plus(r.cr), new Decimal(0));
  expect(dr.toFixed(2)).toBe(cr.toFixed(2));
}

/** Owner 2026-11-18: the inventory GL balance equals the sum of the own-stock ledger values, after every posting. */
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

/** What the GL holds on an account for a set of source documents (credit − debit). */
async function netOn(event: PostingEvent | null, role: AccountRole, sources: [string, string][]): Promise<string> {
  const code = await accountOf(event ?? 'VENDOR_INVOICE', role);
  const { rows } = await client.query<{ v: string }>(
    `SELECT coalesce(sum(jl.credit - jl.debit), 0)::text AS v FROM fin.journal_lines jl JOIN fin.journal_entries je ON je.id = jl.entry_id
       JOIN fin.accounts a ON a.id = jl.account_id
      WHERE a.code = $1 AND je.status IN ('POSTED', 'REVERSED') AND (je.source_type || ':' || je.source_id) = ANY($2::text[])`,
    [code, sources.map(([t, i]) => `${t}:${i}`)],
  );
  return new Decimal(rows[0]!.v).toFixed(2);
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
    ['acct', ['ACCOUNTANT']],
    ['ap', ['AP_OFFICER']],
    // Segregation sweep: one person holding two roles of the chain.
    ['buyerpm', ['PURCHASE_OFFICER', 'PURCHASE_MANAGER']],
    ['buyerstore', ['PURCHASE_OFFICER', 'STOREKEEPER']],
    ['pmstore', ['PURCHASE_MANAGER', 'STOREKEEPER']],
    ['apfm', ['AP_OFFICER', 'FINANCE_MANAGER']],
  ] as const) {
    users[name] = await createTestUser({ username: `e2e_${name}`, roleCodes: [...roles] });
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: `e2e_${name}`, password: TEST_PASSWORD });
    tokens[name] = res.body.accessToken as string;
  }
  await inTx('1', async () => {
    ids.uom = await one(`INSERT INTO master.uoms (code, name) VALUES ('KG', 'Kilogram') RETURNING id`);
    ids.category = await one(`INSERT INTO master.item_categories (code, name) VALUES ('API', 'Active ingredients') RETURNING id`);
    const wh = await one(`INSERT INTO master.warehouses (code, name) VALUES ('MAIN', 'Main store') RETURNING id`);
    ids.loc = await one(`INSERT INTO master.locations (warehouse_id, code, name) VALUES ($1, 'QUAR', 'Quarantine bay') RETURNING id`, [wh]);
  });
  await inTx(users.fm!, async () => {
    const p = await one(
      `INSERT INTO core.fiscal_periods (fiscal_year, period_no, name, start_date, end_date, status) VALUES ('2026-27', 5, 'Nov-2026', '2026-11-01', '2026-11-30', 'OPEN') RETURNING id`,
    );
    await history('core.fiscal_periods', p, null, 'OPEN', users.fm!);
  });
  for (const [date, rate] of [
    [PO_DATE, '279.500000'],
    [GRN_DATE, '280.000000'],
    [INV_DATE, '282.000000'],
    [PAY_DATE, '285.000000'],
  ]) {
    expect((await call('fm', 'post', '/fin/exchange-rates', { currency: 'USD', rateDate: date, rate, source: 'SBP' })).status).toBe(200);
  }
  // Finance's WHT code for the forwarder: 4% filer / 8% non-filer, excluding sales tax, rates and base confirmed.
  const wht = await call('fm', 'post', '/master/tax-codes', {
    code: 'WHT-E2E', name: 'WHT services', kind: 'WITHHOLDING', rate: '4', nonFilerRate: '8', whtBase: 'EXCL_SALES_TAX', isPlaceholder: true,
  });
  expect(wht.status).toBe(201);
  expect((await call('fm', 'patch', `/master/tax-codes/${wht.body.id}`, { isPlaceholder: false })).status).toBe(200);
  expect((await call('fm', 'patch', `/master/tax-codes/${wht.body.id}`, { whtBaseConfirmed: true })).status).toBe(200);

  ids.supplier = await vendor('E2E-CN', { usd: true });
  ids.other = await vendor('E2E-OTHER', { usd: true });
  ids.customs = await vendor('E2E-CUSTOMS');
  ids.forwarder = await vendor('E2E-FWD', { wht: wht.body.id, isFiler: true });
  ids.local = await vendor('E2E-LOCAL');
  ids.api = await item('E2E-API', 'API');
  ids.spare = await item('E2E-SP', 'SPARE');
  ids.source = await approvedSource(ids.supplier, ids.api);
  for (const t of (await call('buyer', 'get', '/purch/landed-cost-types')).body as { id: string; code: string }[]) types[t.code] = t.id;
});

afterAll(async () => {
  await client.end();
});

describe('M3 Done-when: PO → GRN → landed cost → invoice → payment posts the GL exactly as architecture §6', () => {
  it('posts every journal of the chain on its document date, with the roles §6 gives each event, and the GL equals the ledger', async () => {
    // ---- PO: import, USD 1,000 (100 kg × 10.00), PKR 279,500.00 at the PO-date rate; Purchase Manager band.
    const po = await call('buyer', 'post', '/purch/pos', {
      poDate: PO_DATE, vendorId: ids.supplier, poType: 'IMPORT', currency: 'USD', incoterm: 'CIF', lines: [{ itemId: ids.api, qty: '100', unitPrice: '10' }],
    });
    expect([po.status, po.body.error]).toEqual([201, undefined]);
    expect((await call('buyer', 'post', `/purch/pos/${po.body.id}/submit`)).body.status).toBe('PENDING_APPROVAL');
    expect((await approve('pm', 'purch.purchase_orders', po.body.id)).status).toBe(200);
    expect((await call('buyer', 'get', `/purch/pos/${po.body.id}`)).body.status).toBe('APPROVED');
    const poLineId = po.body.lines[0].id as string;

    // ---- GRN with the charges known at receipt.
    const grn = await call('store', 'post', '/purch/grns', {
      poId: po.body.id,
      grnDate: GRN_DATE,
      locationId: ids.loc,
      lines: [{ poLineId, qty: '100', approvedSourceId: ids.source, mfrBatchNo: 'HB-2611', mfgDate: '2026-06-01', expiryDate: '2028-05-31', retestDate: '2027-05-31' }],
    });
    expect([grn.status, grn.body.error]).toEqual([201, undefined]);
    const charge = async (code: string, amount: string, vendorId: string, extra: object = {}) => {
      const res = await call('buyer', 'post', '/purch/landed-costs', { grnId: grn.body.id, chargeTypeId: types[code], chargeDate: GRN_DATE, amount, vendorId, ...extra });
      expect([res.status, res.body.error]).toEqual([201, undefined]);
      return res.body.id as string;
    };
    const cd = await charge('CD', '20000', ids.customs!, { basis: 'GD_AMOUNTS', inputs: [{ poLineId, gdAmount: '20000' }], reference: 'GD-E2E-1' });
    const st = await charge('IMPORT_ST', '51000', ids.customs!, { reference: 'GD-E2E-1' });
    const itx = await charge('IMPORT_IT', '5600', ids.customs!, { reference: 'GD-E2E-1' });
    const fr = await charge('FREIGHT', '14000', ids.forwarder!);
    const posted = await act('store', `/purch/grns/${grn.body.id}/post`);
    expect([posted.status, posted.body.error]).toEqual([200, undefined]);
    expect(posted.body.landedCosts.map((c: { status: string }) => c.status)).toEqual(['POSTED', 'POSTED', 'POSTED', 'POSTED']);
    expect((await call('buyer', 'get', `/purch/pos/${po.body.id}`)).body.status).toBe('RECEIVED');

    // The lot: QUARANTINE (QC required), at full cost: 100 × 10 × 280 + duty 20,000 + freight 14,000 = 314,000.00.
    const lotId = posted.body.lines[0].lotId as string;
    const { rows: lot } = await client.query(
      `SELECT l.status, l.unit_cost::text AS unit_cost, sum(m.qty)::text AS qty, sum(m.value)::text AS value
         FROM inv.lots l JOIN inv.stock_movements m ON m.lot_id = l.id WHERE l.id = $1 GROUP BY l.status, l.unit_cost`,
      [lotId],
    );
    expect(lot[0]).toEqual({ status: 'QUARANTINE', unit_cost: '3140.000000', qty: '100.0000', value: '314000.00' });
    const { rows: sample } = await client.query(`SELECT status FROM qc.sample_requests WHERE lot_id = $1`, [lotId]);
    expect(sample).toEqual([{ status: 'OPEN' }]);

    // §6 "GRN posted": Dr Inventory / Cr GRNI, at the GRN-date rate.
    await expectJournal('GRN', grn.body.id, 'GRN_RECEIPT', GRN_DATE, [
      ['INVENTORY', '280000.00', '0.00'],
      ['GRNI', '0.00', '280000.00', ids.supplier],
    ]);
    // §6 "Landed cost added": capitalised duty and freight, Dr Inventory / Cr landed-cost clearing (the vendor billing it).
    await expectJournal('LANDED_COST', cd, 'LANDED_COST', GRN_DATE, [
      ['INVENTORY', '20000.00', '0.00'],
      ['LANDED_COST_CLEARING', '0.00', '20000.00', ids.customs],
    ]);
    await expectJournal('LANDED_COST', fr, 'LANDED_COST', GRN_DATE, [
      ['INVENTORY', '14000.00', '0.00'],
      ['LANDED_COST_CLEARING', '0.00', '14000.00', ids.forwarder],
    ]);
    // §6 "Import taxes": Dr input sales tax / advance income tax / Cr landed-cost clearing.
    await expectJournal('LANDED_COST', st, 'IMPORT_TAX', GRN_DATE, [
      ['INPUT_TAX', '51000.00', '0.00'],
      ['LANDED_COST_CLEARING', '0.00', '51000.00', ids.customs],
    ]);
    await expectJournal('LANDED_COST', itx, 'IMPORT_TAX', GRN_DATE, [
      ['ADVANCE_TAX', '5600.00', '0.00'],
      ['LANDED_COST_CLEARING', '0.00', '5600.00', ids.customs],
    ]);
    await glEqualsLedger();

    // ---- GOODS invoice: 100 × 10.10 USD at the invoice-date rate 282 = 284,820.00 (within the 2% price tolerance).
    const billable = await call('acct', 'get', `/purch/vendor-invoices/billable?poId=${po.body.id}`);
    const grnLineId = billable.body.goods[0].grnLineId as string;
    const inv = await call('acct', 'post', '/purch/vendor-invoices', {
      invoiceType: 'GOODS', poId: po.body.id, vendorInvoiceNo: 'HB-INV-1', invoiceDate: INV_DATE, lines: [{ grnLineId, qty: '100', unitPrice: '10.10' }],
    });
    expect(inv.body).toMatchObject({ currency: 'USD', exchangeRate: '282.000000', totalAmount: '1010.00', totalPkr: '284820.00' });
    const invPosted = await act('acct', `/purch/vendor-invoices/${inv.body.id}/post`);
    expect(invPosted.body.status).toBe('POSTED');
    // IAS 21 split (owner Q4): GRNI off at its receipt value; (10.10 − 10.00) × 100 × 282 = 2,820 price variance;
    // 100 × 10 × (282 − 280) = 2,000 exchange loss.
    expect(invPosted.body.lines[0]).toMatchObject({ clearedPkr: '280000.00', priceVariancePkr: '2820.00', exchangeDiffPkr: '2000.00' });
    await expectJournal('VENDOR_INVOICE', inv.body.id, 'VENDOR_INVOICE', INV_DATE, [
      ['GRNI', '280000.00', '0.00'],
      ['PRICE_VARIANCE', '2820.00', '0.00'],
      ['EXCHANGE_DIFFERENCE', '2000.00', '0.00'],
      ['ACCOUNTS_PAYABLE', '0.00', '284820.00', ids.supplier],
    ]);
    expect((await call('buyer', 'get', `/purch/pos/${po.body.id}`)).body.status).toBe('CLOSED');

    // ---- CHARGES invoices (owner Q3): customs bills duty and import taxes; the forwarder bills freight.
    const charges = async (vendorId: string, no: string, lines: { landedCostId: string; amount: string }[]) => {
      const draft = await call('acct', 'post', '/purch/vendor-invoices', { invoiceType: 'CHARGES', vendorId, vendorInvoiceNo: no, invoiceDate: INV_DATE, lines });
      expect([draft.status, draft.body.error]).toEqual([201, undefined]);
      expect((await act('acct', `/purch/vendor-invoices/${draft.body.id}/post`)).body.status).toBe('POSTED');
      return draft.body.id as string;
    };
    const customsInv = await charges(ids.customs!, 'PSID-E2E', [
      { landedCostId: cd, amount: '20000' },
      { landedCostId: st, amount: '51000' },
      { landedCostId: itx, amount: '5600' },
    ]);
    const fwdInv = await charges(ids.forwarder!, 'FWD-E2E', [{ landedCostId: fr, amount: '14000' }]);
    await expectJournal('VENDOR_INVOICE', customsInv, 'VENDOR_INVOICE', INV_DATE, [
      ['LANDED_COST_CLEARING', '76600.00', '0.00', ids.customs],
      ['ACCOUNTS_PAYABLE', '0.00', '76600.00', ids.customs],
    ]);
    await expectJournal('VENDOR_INVOICE', fwdInv, 'VENDOR_INVOICE', INV_DATE, [
      ['LANDED_COST_CLEARING', '14000.00', '0.00', ids.forwarder],
      ['ACCOUNTS_PAYABLE', '0.00', '14000.00', ids.forwarder],
    ]);
    await glEqualsLedger();

    // ---- Payments: drafted by the AP Officer, approved by the Finance Manager (matrix VENDOR_PAYMENT), posted.
    const pay = async (vendorId: string, invoiceId: string, amount: string, extra: object) => {
      const draft = await call('ap', 'post', '/purch/vendor-payments', { vendorId, paymentDate: PAY_DATE, allocations: [{ invoiceId, amount }], ...extra });
      expect([draft.status, draft.body.error]).toEqual([201, undefined]);
      expect((await call('ap', 'post', `/purch/vendor-payments/${draft.body.id}/submit`)).body.status).toBe('PENDING_APPROVAL');
      expect((await approve('fm', 'purch.vendor_payments', draft.body.id)).status).toBe(200);
      const done = await act('ap', `/purch/vendor-payments/${draft.body.id}/post`);
      expect([done.status, done.body.error, done.body.status]).toEqual([200, undefined, 'POSTED']);
      return done.body as { id: string; carryingPkr: string; exchangeDiffPkr: string; whtAmount: string; netPaid: string };
    };
    // Foreign: 1,010 USD settled with PKR 287,850.00 (at 285); AP off at its carrying 284,820.00; 3,030.00 exchange loss.
    const p1 = await pay(ids.supplier!, inv.body.id, '1010', { pkrPaid: '287850', reference: 'TT-E2E-1' });
    expect(p1).toMatchObject({ carryingPkr: '284820.00', exchangeDiffPkr: '3030.00', whtAmount: '0.00' });
    await expectJournal('VENDOR_PAYMENT', p1.id, 'VENDOR_PAYMENT', PAY_DATE, [
      ['ACCOUNTS_PAYABLE', '284820.00', '0.00', ids.supplier],
      ['EXCHANGE_DIFFERENCE', '3030.00', '0.00'],
      ['BANK', '0.00', '287850.00'],
    ]);
    // Customs: no WHT section, no WHT.
    const p2 = await pay(ids.customs!, customsInv, '76600', { reference: 'PSID-PAY-E2E' });
    await expectJournal('VENDOR_PAYMENT', p2.id, 'VENDOR_PAYMENT', PAY_DATE, [
      ['ACCOUNTS_PAYABLE', '76600.00', '0.00', ids.customs],
      ['BANK', '0.00', '76600.00'],
    ]);
    // Forwarder: filer, 4% WHT on 14,000.00 = 560.00; bank 13,440.00 (§6 "Vendor payment": Cr bank net + WHT payable).
    const p3 = await pay(ids.forwarder!, fwdInv, '14000', { reference: 'CHQ-E2E-3' });
    expect(p3).toMatchObject({ whtAmount: '560.00', netPaid: '13440.00' });
    await expectJournal('VENDOR_PAYMENT', p3.id, 'VENDOR_PAYMENT', PAY_DATE, [
      ['ACCOUNTS_PAYABLE', '14000.00', '0.00', ids.forwarder],
      ['BANK', '0.00', '13440.00'],
      ['WHT_PAYABLE', '0.00', '560.00', ids.forwarder],
    ]);
    await glEqualsLedger();

    // ---- The chain closes: GRNI and landed-cost clearing net to zero; every vendor is settled; nothing is open.
    const docs: [string, string][] = [
      ['GRN', grn.body.id], ['LANDED_COST', cd], ['LANDED_COST', st], ['LANDED_COST', itx], ['LANDED_COST', fr],
      ['VENDOR_INVOICE', inv.body.id], ['VENDOR_INVOICE', customsInv], ['VENDOR_INVOICE', fwdInv],
      ['VENDOR_PAYMENT', p1.id], ['VENDOR_PAYMENT', p2.id], ['VENDOR_PAYMENT', p3.id],
    ];
    expect(await netOn('GRN_RECEIPT', 'GRNI', docs)).toBe('0.00');
    expect(await netOn('VENDOR_INVOICE', 'LANDED_COST_CLEARING', docs)).toBe('0.00');
    expect(await netOn('VENDOR_INVOICE', 'ACCOUNTS_PAYABLE', docs)).toBe('0.00');
    for (const v of [ids.supplier, ids.customs, ids.forwarder]) {
      expect((await call('acct', 'get', `/purch/vendors/${v}/ledger`)).body.closing).toBe('0.00');
      expect((await call('acct', 'get', `/purch/ap-ageing?vendorId=${v}`)).body.vendors).toEqual([]);
    }
    // Totals the owner can tie out: inventory 314,000; input tax 51,000; advance tax 5,600; WHT 560; exchange loss
    // 5,030; price variance 2,820; bank 377,890 paid out (287,850 + 76,600 + 13,440).
    expect(await netOn('GRN_RECEIPT', 'INVENTORY', docs)).toBe('-314000.00');
    expect(await netOn('IMPORT_TAX', 'INPUT_TAX', docs)).toBe('-51000.00');
    expect(await netOn('IMPORT_TAX', 'ADVANCE_TAX', docs)).toBe('-5600.00');
    expect(await netOn('VENDOR_PAYMENT', 'WHT_PAYABLE', docs)).toBe('560.00');
    expect(await netOn('VENDOR_PAYMENT', 'EXCHANGE_DIFFERENCE', docs)).toBe('-5030.00');
    expect(await netOn('VENDOR_INVOICE', 'PRICE_VARIANCE', docs)).toBe('-2820.00');
    expect(await netOn('VENDOR_PAYMENT', 'BANK', docs)).toBe('377890.00');
  });

  it('refuses a PO for a GMP material from a vendor that is not its approved source (AVL_NOT_APPROVED)', async () => {
    const res = await call('buyer', 'post', '/purch/pos', {
      poDate: PO_DATE, vendorId: ids.other, poType: 'IMPORT', currency: 'USD', incoterm: 'CIF', lines: [{ itemId: ids.api, qty: '1', unitPrice: '10' }],
    });
    expect([res.status, res.body.error.code]).toEqual([422, 'AVL_NOT_APPROVED']);
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM purch.purchase_orders WHERE vendor_id = $1`, [ids.other]);
    expect(rows[0]!.n).toBe(0);
  });
});

describe('M3 segregation of duties (rule 9; build-plan M3): PO creator ≠ approver ≠ GRN receiver; payment creator ≠ approver', () => {
  const localPo = (who: string) =>
    call(who, 'post', '/purch/pos', { poDate: PO_DATE, vendorId: ids.local, poType: 'LOCAL', currency: 'PKR', lines: [{ itemId: ids.spare, qty: '2', unitPrice: '500' }] });
  const grnOf = (who: string, po: { id: string; lines: { id: string }[] }) =>
    call(who, 'post', '/purch/grns', { poId: po.id, grnDate: GRN_DATE, locationId: ids.loc, lines: [{ poLineId: po.lines[0]!.id, qty: '2', manufacturer: 'Spares Co' }] });

  it('the PO creator does not approve it, even holding the approver role (submitted by them or by someone else)', async () => {
    const po = await localPo('buyerpm');
    expect((await call('buyerpm', 'post', `/purch/pos/${po.body.id}/submit`)).body.status).toBe('PENDING_APPROVAL');
    const own = await approve('buyerpm', 'purch.purchase_orders', po.body.id);
    expect([own.status, own.body.error.code, own.body.error.message]).toEqual([403, 'SEGREGATION_OF_DUTIES', 'You cannot approve or reject your own document']);
    expect((await call('buyer', 'get', `/purch/pos/${po.body.id}`)).body.status).toBe('PENDING_APPROVAL');

    const po2 = await localPo('buyerpm');
    expect((await call('buyer', 'post', `/purch/pos/${po2.body.id}/submit`)).body.status).toBe('PENDING_APPROVAL');
    const created = await approve('buyerpm', 'purch.purchase_orders', po2.body.id);
    expect([created.status, created.body.error.code, created.body.error.details.rule]).toEqual([403, 'SEGREGATION_OF_DUTIES', 'PO creator ≠ PO approver']);
    expect((await approve('pm', 'purch.purchase_orders', po2.body.id)).status).toBe(200);
  });

  it('neither the PO creator nor its approver receives the goods; another storekeeper does', async () => {
    const byCreator = await localPo('buyerstore');
    await call('buyerstore', 'post', `/purch/pos/${byCreator.body.id}/submit`);
    expect((await approve('pm', 'purch.purchase_orders', byCreator.body.id)).status).toBe(200);
    const g1 = await grnOf('buyerstore', byCreator.body);
    const r1 = await act('buyerstore', `/purch/grns/${g1.body.id}/post`);
    expect([r1.status, r1.body.error.code, r1.body.error.details.rule]).toEqual([403, 'SEGREGATION_OF_DUTIES', 'PO creator ≠ GRN receiver']);

    const byBuyer = await localPo('buyer');
    await call('buyer', 'post', `/purch/pos/${byBuyer.body.id}/submit`);
    expect((await approve('pmstore', 'purch.purchase_orders', byBuyer.body.id)).status).toBe(200);
    const g2 = await grnOf('pmstore', byBuyer.body);
    const r2 = await act('pmstore', `/purch/grns/${g2.body.id}/post`);
    expect([r2.status, r2.body.error.code, r2.body.error.details.rule]).toEqual([403, 'SEGREGATION_OF_DUTIES', 'PO approver ≠ GRN receiver']);
    expect((await act('store', `/purch/grns/${g2.body.id}/post`)).body.status).toBe('POSTED');
    expect((await act('store', `/purch/grns/${g1.body.id}/post`)).body.status).toBe('POSTED');
  });

  it('the payment creator (or submitter) does not approve it, even holding the Finance Manager role', async () => {
    const po = await localPo('buyer');
    await call('buyer', 'post', `/purch/pos/${po.body.id}/submit`);
    await approve('pm', 'purch.purchase_orders', po.body.id);
    const g = await grnOf('store', po.body);
    const grn = await act('store', `/purch/grns/${g.body.id}/post`);
    const inv = await call('acct', 'post', '/purch/vendor-invoices', {
      invoiceType: 'GOODS', poId: po.body.id, vendorInvoiceNo: 'SOD-1', invoiceDate: INV_DATE, lines: [{ grnLineId: grn.body.lines[0].id, qty: '2', unitPrice: '500' }],
    });
    expect((await act('acct', `/purch/vendor-invoices/${inv.body.id}/post`)).body.status).toBe('POSTED');
    const p = await call('apfm', 'post', '/purch/vendor-payments', { vendorId: ids.local, paymentDate: PAY_DATE, reference: 'CHQ-SOD', allocations: [{ invoiceId: inv.body.id, amount: '1000' }] });
    expect((await call('apfm', 'post', `/purch/vendor-payments/${p.body.id}/submit`)).body.status).toBe('PENDING_APPROVAL');
    const own = await approve('apfm', 'purch.vendor_payments', p.body.id);
    expect([own.status, own.body.error.code]).toEqual([403, 'SEGREGATION_OF_DUTIES']);
    expect((await approve('fm', 'purch.vendor_payments', p.body.id)).status).toBe(200);
    expect((await act('ap', `/purch/vendor-payments/${p.body.id}/post`)).body.status).toBe('POSTED');
  });
});
