// M3 task 5b (0032; owner answers 2026-11-26): WHT base per code and filer / non-filer rates, the stale filer-status
// warning the approver acknowledges, the bank reference at posting, vendor invoice and payment reversal, and debit
// notes (price claim, short supply, return of a rejected lot) in the vendor ledger and AP ageing. Happy paths and
// each refusal, through the HTTP endpoints, and the 0032 database guards.
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const tax: Record<string, string> = {};

const PO_DATE = '2026-11-02';
const GRN_DATE = '2026-11-04';
const INV_DATE = '2026-11-06';
const PAY_DATE = '2026-11-10';
const DN_DATE = '2026-11-12';
const TODAY = companyToday();
let keyNo = 0;
let invNo = 0;

function call(who: string, method: 'get' | 'post' | 'patch', url: string, body?: object) {
  const r = request(app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`);
  return body ? r.send(body) : r;
}
const act = (who: string, url: string, body?: object) => call(who, 'post', url, body).set('Idempotency-Key', `ap5b-test-${++keyNo}`);
const sign = (meaning: 'APPROVED' | 'REJECTED' | 'REVERSED', reason = 'Checked against the documents') => ({ signature: { password: TEST_PASSWORD, meaning, reason } });
const witness = (username = 'ap5b_qa') => ({ username, password: TEST_PASSWORD, meaning: 'WITNESSED', reason: 'Saw the lot loaded for the vendor' });

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

interface VendorOpts {
  terms?: number;
  wht?: string;
  isFiler?: boolean | null;
  checkedOn?: string | null;
}
/** A local PKR vendor, set up in DRAFT (no countersign needed) and activated. */
async function vendor(code: string, o: VendorOpts = {}): Promise<string> {
  const id = await inTx(users.buyer!, async () => {
    const v = await one(
      `INSERT INTO master.vendors (code, name, ntn, is_foreign, country, currency, payment_terms_days, wht_tax_code_id, is_filer, filer_checked_on, status)
       VALUES ($1, $1, '1234567', false, 'PK', 'PKR', $2, $3, $4, $5, 'DRAFT') RETURNING id`,
      [code, o.terms ?? 30, o.wht ?? null, o.isFiler ?? null, o.isFiler === undefined || o.isFiler === null ? null : (o.checkedOn ?? TODAY)],
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

/** PO (approved) → GRN (posted) of a spare: lot APPROVED (no QC). */
async function received(qty: string, unitPrice: string, vendorId: string) {
  const po = await call('buyer', 'post', '/purch/pos', { poDate: PO_DATE, vendorId, poType: 'LOCAL', currency: 'PKR', lines: [{ itemId: ids.spare, qty, unitPrice }] });
  expect(po.status).toBe(201);
  await call('buyer', 'post', `/purch/pos/${po.body.id}/submit`);
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM core.approvals WHERE doc_table = 'purch.purchase_orders' AND doc_id = $1 ORDER BY id DESC LIMIT 1`, [po.body.id]);
  expect((await call('pm', 'post', `/core/approvals/${rows[0]!.id}/approve`, sign('APPROVED'))).status).toBe(200);
  const grn = await call('store', 'post', '/purch/grns', {
    poId: po.body.id,
    grnDate: GRN_DATE,
    locationId: ids.loc,
    lines: [{ poLineId: po.body.lines[0].id, qty, manufacturer: 'Spares Co' }],
  });
  const posted = await act('store', `/purch/grns/${grn.body.id}/post`);
  expect([posted.status, posted.body.error]).toEqual([200, undefined]);
  return { poId: po.body.id as string, grnId: grn.body.id as string, grnLineId: posted.body.lines[0].id as string, lotId: posted.body.lines[0].lotId as string };
}

/** A POSTED goods invoice (the Accountant enters and posts; outside tolerance the Finance Manager releases). */
async function invoice(poId: string, grnLineId: string, qty: string, unitPrice: string, o: { tax?: boolean; no?: string } = {}) {
  const body = {
    invoiceType: 'GOODS',
    poId,
    vendorInvoiceNo: o.no ?? `B-${++invNo}`,
    invoiceDate: INV_DATE,
    lines: [{ grnLineId, qty, unitPrice, ...(o.tax ? { taxCodeId: tax['ST-18'] } : {}) }],
  };
  const inv = await call('acct', 'post', '/purch/vendor-invoices', body);
  expect(inv.status).toBe(201);
  let res = await act('acct', `/purch/vendor-invoices/${inv.body.id}/post`);
  if (res.body.status === 'MATCH_EXCEPTION') res = await act('fm', `/purch/vendor-invoices/${inv.body.id}/release`, sign('APPROVED', 'Vendor bill agreed'));
  expect(res.body.status).toBe('POSTED');
  return res.body as { id: string; docNo: string; lines: { id: string }[]; totalAmount: string };
}

async function approvalOf(table: string, docId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM core.approvals WHERE doc_table = $1 AND doc_id = $2 ORDER BY id DESC LIMIT 1`, [table, docId]);
  return rows[0]!.id;
}
const approve = async (table: string, docId: string, who = 'fm', acknowledgements?: string[]) =>
  call(who, 'post', `/core/approvals/${await approvalOf(table, docId)}/approve`, { ...sign('APPROVED', 'Checked'), ...(acknowledgements ? { acknowledgements } : {}) });

/** Draft → submit → approve → post a PKR payment. */
async function pay(vendorId: string, invoiceId: string, amount: string, reference = `CHQ-${++keyNo}`) {
  const p = await call('ap', 'post', '/purch/vendor-payments', { vendorId, paymentDate: PAY_DATE, reference, allocations: [{ invoiceId, amount }] });
  expect(p.status).toBe(201);
  expect((await call('ap', 'post', `/purch/vendor-payments/${p.body.id}/submit`)).body.status).toBe('PENDING_APPROVAL');
  expect((await approve('purch.vendor_payments', p.body.id)).status).toBe(200);
  const posted = await act('ap', `/purch/vendor-payments/${p.body.id}/post`);
  expect([posted.status, posted.body.status]).toEqual([200, 'POSTED']);
  return posted.body as { id: string; docNo: string };
}

/** Draft → submit → approve a debit note; returns the APPROVED note. */
async function approvedNote(body: object) {
  const n = await call('acct', 'post', '/purch/debit-notes', body);
  expect([n.status, n.body.error]).toEqual([201, undefined]);
  expect((await call('acct', 'post', `/purch/debit-notes/${n.body.id}/submit`)).body.status).toBe('PENDING_APPROVAL');
  expect((await approve('purch.debit_notes', n.body.id)).status).toBe(200);
  return n.body as { id: string; docNo: string; totalAmount: string };
}

async function journalOf(sourceType: string, sourceId: string) {
  const { rows } = await client.query(
    `SELECT a.code, sum(jl.debit)::text AS dr, sum(jl.credit)::text AS cr
       FROM fin.journal_lines jl JOIN fin.journal_entries je ON je.id = jl.entry_id JOIN fin.accounts a ON a.id = jl.account_id
      WHERE je.source_type = $1 AND je.source_id = $2 AND je.status IN ('POSTED', 'REVERSED')
      GROUP BY a.code ORDER BY a.code`,
    [sourceType, sourceId],
  );
  return rows;
}

/** The fiscal period of a date in FY July–June, e.g. 2026-11-26 → 2026-27 period 5. */
function periodOf(date: string) {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const fyStart = m >= 7 ? y : y - 1;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const name = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return { fy: `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`, no: ((m + 5) % 12) + 1, name: `${name}-${y}`, start: `${date.slice(0, 7)}-01`, end };
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
    ['qa', ['QA_MANAGER']],
    ['acctfm', ['ACCOUNTANT', 'FINANCE_MANAGER']],
  ] as const) {
    users[name] = await createTestUser({ username: `ap5b_${name}`, roleCodes: [...roles] });
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: `ap5b_${name}`, password: TEST_PASSWORD });
    tokens[name] = res.body.accessToken as string;
  }
  await inTx('1', async () => {
    ids.uom = await one(`INSERT INTO master.uoms (code, name) VALUES ('NOS', 'Numbers') RETURNING id`);
    ids.category = await one(`INSERT INTO master.item_categories (code, name) VALUES ('SP', 'Spares') RETURNING id`);
    const wh = await one(`INSERT INTO master.warehouses (code, name) VALUES ('MAIN', 'Main store') RETURNING id`);
    ids.loc = await one(`INSERT INTO master.locations (warehouse_id, code, name) VALUES ($1, 'BAY', 'Receiving bay') RETURNING id`, [wh]);
  });
  // Periods for the documents (Nov-2026) and for today, when reversals are dated.
  const periods = new Map([[periodOf(INV_DATE).name, periodOf(INV_DATE)], [periodOf(TODAY).name, periodOf(TODAY)]]);
  await inTx(users.fm!, async () => {
    for (const p of periods.values()) {
      const id = await one(
        `INSERT INTO core.fiscal_periods (fiscal_year, period_no, name, start_date, end_date, status) VALUES ($1, $2, $3, $4, $5, 'OPEN') RETURNING id`,
        [p.fy, p.no, p.name, p.start, p.end],
      );
      await history('core.fiscal_periods', id, null, 'OPEN', users.fm!);
    }
  });
  await inTx(users.wm!, async () => {
    const i = await one(`INSERT INTO master.items (code, name, type, category_id, base_uom_id, status) VALUES ('SP-1', 'Spare', 'SPARE', $1, $2, 'DRAFT') RETURNING id`, [
      ids.category, ids.uom,
    ]);
    await history('master.items', i, null, 'DRAFT', users.wm!);
    ids.spare = i;
  });
  await inTx(users.pm!, async () => {
    await history('master.items', ids.spare!, 'DRAFT', 'ACTIVE', users.pm!);
    await client.query(`UPDATE master.items SET status = 'ACTIVE' WHERE id = $1`, [ids.spare]);
  });
  for (const t of (await client.query<{ id: string; code: string }>(`SELECT id, code FROM master.tax_codes`)).rows) tax[t.code] = t.id;
  ids.vendor = await vendor('V-PLAIN');
});

afterAll(async () => {
  await client.end();
});

// ---------------------------------------------------------------- owner answers 3 and 4: WHT base, filer rates

describe('WHT: base per code and filer / non-filer rates (owner 2026-11-26, answers 3 and 4)', () => {
  it('seeded codes have an unconfirmed base; posting waits until Finance confirms the rates and the base', async () => {
    const seeded = await call('fm', 'get', `/master/tax-codes/${tax['WHT-153-1A']}`);
    expect(seeded.body).toMatchObject({ whtBase: 'INCL_SALES_TAX', whtBaseConfirmed: false, isPlaceholder: true, nonFilerRate: null });
    // A new code: 4% filer, 8% non-filer, on the amount excluding sales tax.
    const code = await call('fm', 'post', '/master/tax-codes', {
      code: 'WHT-X', name: 'WHT test', kind: 'WITHHOLDING', rate: '4', nonFilerRate: '8', whtBase: 'EXCL_SALES_TAX', isPlaceholder: true,
    });
    expect(code.body).toMatchObject({ whtBase: 'EXCL_SALES_TAX', whtBaseConfirmed: false, nonFilerRate: '8.0000' });
    tax['WHT-X'] = code.body.id;
    expect((await call('acct', 'patch', `/master/tax-codes/${code.body.id}`, { whtBaseConfirmed: true })).status).toBe(403);

    const v = await vendor('V-FILER', { wht: tax['WHT-X'], isFiler: true });
    const { poId, grnLineId } = await received('10', '100', v);
    const inv = await invoice(poId, grnLineId, '10', '100', { tax: true }); // 1,000 + 180 = 1,180
    const draft = await call('ap', 'post', '/purch/vendor-payments', { vendorId: v, paymentDate: PAY_DATE, allocations: [{ invoiceId: inv.id, amount: '1180' }] });
    // Filer rate 4% on 1,000.00 (the PKR that is not sales tax) = 40.00.
    expect(draft.body).toMatchObject({ whtRate: '4.0000', whtBase: 'EXCL_SALES_TAX', whtBasePkr: '1000.00', whtAmount: '40.00', netPaid: '1140.00', whtRateUnconfirmed: true });
    const s1 = await call('ap', 'post', `/purch/vendor-payments/${draft.body.id}/submit`);
    expect([s1.status, s1.body.error.code]).toEqual([422, 'TAX_RATE_NOT_CONFIRMED']);
    expect((await call('fm', 'patch', `/master/tax-codes/${tax['WHT-X']}`, { isPlaceholder: false })).status).toBe(200);
    const s2 = await call('ap', 'post', `/purch/vendor-payments/${draft.body.id}/submit`);
    expect([s2.status, s2.body.error.code, s2.body.error.details.unconfirmed]).toEqual([422, 'TAX_RATE_NOT_CONFIRMED', 'BASE']);
    expect((await call('fm', 'patch', `/master/tax-codes/${tax['WHT-X']}`, { whtBaseConfirmed: true })).body.whtBaseConfirmed).toBe(true);
    const unconfirm = await call('fm', 'patch', `/master/tax-codes/${tax['WHT-X']}`, { whtBaseConfirmed: false });
    expect([unconfirm.status, unconfirm.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);

    // The DB recomputes the base: a draft carrying the gross as its base is refused at submit.
    await raw(`UPDATE purch.vendor_payments SET wht_base_pkr = 1180, wht_amount = 47.20, net_paid = 1132.80 WHERE id = $1`, [draft.body.id], users.ap!);
    await expect(
      inTx(users.ap!, async () => {
        await history('purch.vendor_payments', draft.body.id, 'DRAFT', 'PENDING_APPROVAL', users.ap!);
        await client.query(`UPDATE purch.vendor_payments SET status = 'PENDING_APPROVAL', submitted_by = $2, submitted_at = now() WHERE id = $1`, [draft.body.id, users.ap]);
      }),
    ).rejects.toThrow(/works WHT out on 1180.00/);

    // The service puts it right on submit (still a draft); approved and posted: Dr AP / Cr bank + WHT.
    expect((await call('ap', 'post', `/purch/vendor-payments/${draft.body.id}/submit`)).body).toMatchObject({ status: 'PENDING_APPROVAL', whtAmount: '40.00' });
    expect((await approve('purch.vendor_payments', draft.body.id)).status).toBe(200);
    expect((await act('ap', `/purch/vendor-payments/${draft.body.id}/post`, { reference: 'CHQ-1001' })).body.status).toBe('POSTED');
    expect(await journalOf('VENDOR_PAYMENT', draft.body.id)).toEqual([
      { code: '1120', dr: '0.00', cr: '1140.00' },
      { code: '2110', dr: '1180.00', cr: '0.00' },
      { code: '2220', dr: '0.00', cr: '40.00' },
    ]);
  });

  it('a non-filer (or a vendor never checked) pays the non-filer rate; without one Finance has given, it is refused', async () => {
    const nf = await vendor('V-NONFILER', { wht: tax['WHT-X'], isFiler: false });
    const a = await received('10', '100', nf);
    const invA = await invoice(a.poId, a.grnLineId, '10', '100', { tax: true });
    const draft = await call('ap', 'post', '/purch/vendor-payments', { vendorId: nf, paymentDate: PAY_DATE, allocations: [{ invoiceId: invA.id, amount: '1180' }] });
    expect(draft.body).toMatchObject({ whtRate: '8.0000', whtBasePkr: '1000.00', whtAmount: '80.00', payeeIsFiler: false });

    const never = await vendor('V-UNCHECKED', { wht: tax['WHT-X'], isFiler: null });
    const b = await received('1', '100', never);
    const invB = await invoice(b.poId, b.grnLineId, '1', '100');
    const d2 = await call('ap', 'post', '/purch/vendor-payments', { vendorId: never, paymentDate: PAY_DATE, allocations: [{ invoiceId: invB.id, amount: '100' }] });
    expect(d2.body).toMatchObject({ whtRate: '8.0000', whtAmount: '8.00', payeeIsFiler: null, filerCheckStale: true });

    // A code without a non-filer rate: its rates cannot be confirmed, and a non-filer is not paid.
    const noNf = await call('fm', 'post', '/master/tax-codes', { code: 'WHT-NONF', name: 'WHT no non-filer', kind: 'WITHHOLDING', rate: '5', isPlaceholder: true });
    expect((await call('fm', 'patch', `/master/tax-codes/${noNf.body.id}`, { isPlaceholder: false })).status).toBe(400);
    await expect(raw(`UPDATE master.tax_codes SET is_placeholder = false WHERE id = $1`, [noNf.body.id], users.fm!)).rejects.toThrow(/non-filer rate/);
    const nf2 = await vendor('V-NONFILER-2', { wht: noNf.body.id, isFiler: false });
    const c = await received('1', '100', nf2);
    const invC = await invoice(c.poId, c.grnLineId, '1', '100');
    const refused = await call('ap', 'post', '/purch/vendor-payments', { vendorId: nf2, paymentDate: PAY_DATE, allocations: [{ invoiceId: invC.id, amount: '100' }] });
    expect([refused.status, refused.body.error.code, refused.body.error.details.unconfirmed]).toEqual([422, 'TAX_RATE_NOT_CONFIRMED', 'NON_FILER_RATE']);

    // The DB refuses the filer rate on a non-filer's payment.
    await raw(`UPDATE purch.vendor_payments SET wht_rate = 4, wht_amount = 40, net_paid = 1140 WHERE id = $1`, [draft.body.id], users.ap!);
    await expect(
      inTx(users.ap!, async () => {
        await history('purch.vendor_payments', draft.body.id, 'DRAFT', 'PENDING_APPROVAL', users.ap!);
        await client.query(`UPDATE purch.vendor_payments SET status = 'PENDING_APPROVAL', submitted_by = $2, submitted_at = now() WHERE id = $1`, [draft.body.id, users.ap]);
      }),
    ).rejects.toThrow(/non-filer rate is 8/);
  });

  it('a filer status checked over purch.vendor.filer_check_max_days ago: the approver acknowledges the warning', async () => {
    const v = await vendor('V-STALE', { wht: tax['WHT-X'], isFiler: true, checkedOn: '2026-10-01' });
    const { poId, grnLineId } = await received('1', '100', v);
    const inv = await invoice(poId, grnLineId, '1', '100');
    const p = await call('ap', 'post', '/purch/vendor-payments', { vendorId: v, paymentDate: PAY_DATE, reference: 'TT-77', allocations: [{ invoiceId: inv.id, amount: '100' }] });
    expect(p.body).toMatchObject({ filerCheckStale: true, filerCheckMaxDays: 30, whtRate: '4.0000' });
    await call('ap', 'post', `/purch/vendor-payments/${p.body.id}/submit`);
    const noAck = await approve('purch.vendor_payments', p.body.id);
    expect([noAck.status, noAck.body.error.code, noAck.body.error.details.warning]).toEqual([422, 'ACKNOWLEDGEMENT_REQUIRED', 'FILER_CHECK_STALE']);
    expect((await call('ap', 'get', `/purch/vendor-payments/${p.body.id}`)).body.status).toBe('PENDING_APPROVAL');
    const ok = await approve('purch.vendor_payments', p.body.id, 'fm', ['FILER_CHECK_STALE']);
    expect(ok.status).toBe(200);
    const after = await call('ap', 'get', `/purch/vendor-payments/${p.body.id}`);
    expect(after.body).toMatchObject({ status: 'APPROVED', filerWarningAckByName: 'Test ap5b_fm' });
    // A wider setting makes the same check fresh: no warning.
    await raw(`INSERT INTO core.settings (key, value) VALUES ('purch.vendor.filer_check_max_days', '365') ON CONFLICT (company_id, key) DO UPDATE SET value = '365'`, [], users.fm!);
    expect((await call('ap', 'post', '/purch/vendor-payments', { vendorId: v, paymentDate: PAY_DATE, allocations: [{ invoiceId: inv.id, amount: '1' }] })).body.filerCheckStale).toBe(false);
    await raw(`UPDATE core.settings SET value = '30' WHERE key = 'purch.vendor.filer_check_max_days'`, [], users.fm!);
  });

  it('posting needs the bank reference or cheque number (owner answer 5); the DB refuses one without it', async () => {
    const { poId, grnLineId } = await received('1', '50', ids.vendor!);
    const inv = await invoice(poId, grnLineId, '1', '50');
    const p = await call('ap', 'post', '/purch/vendor-payments', { vendorId: ids.vendor, paymentDate: PAY_DATE, allocations: [{ invoiceId: inv.id, amount: '50' }] });
    await call('ap', 'post', `/purch/vendor-payments/${p.body.id}/submit`);
    await approve('purch.vendor_payments', p.body.id);
    const noRef = await act('ap', `/purch/vendor-payments/${p.body.id}/post`);
    expect([noRef.status, noRef.body.error.details.field]).toEqual([400, 'reference']);
    await expect(
      inTx(users.ap!, async () => {
        await history('purch.vendor_payments', p.body.id, 'APPROVED', 'POSTED', users.ap!);
        await client.query(
          `UPDATE purch.vendor_payments SET status = 'POSTED', carrying_pkr = 50, exchange_diff_pkr = 0, posting_date = payment_date, posted_by = $2, posted_at = now() WHERE id = $1`,
          [p.body.id, users.ap],
        );
      }),
    ).rejects.toThrow(/bank reference or cheque number/);
    const posted = await act('ap', `/purch/vendor-payments/${p.body.id}/post`, { reference: 'IBFT-55' });
    expect(posted.body).toMatchObject({ status: 'POSTED', reference: 'IBFT-55' });
  });
});

// ---------------------------------------------------------------- owner answer 7: reversals

describe('vendor invoice reversal (owner 2026-11-26): Finance Manager, e-signature, nothing paid against it', () => {
  it('refuses while a payment names it; reverses the journal, re-opens the GRN for billing and the PO', async () => {
    const v = await vendor('V-REV');
    const { poId, grnLineId } = await received('5', '100', v);
    const inv = await invoice(poId, grnLineId, '5', '100', { no: 'SAME-NO' });
    expect((await call('buyer', 'get', `/purch/pos/${poId}`)).body.status).toBe('CLOSED');

    const draftPay = await call('ap', 'post', '/purch/vendor-payments', { vendorId: v, paymentDate: PAY_DATE, allocations: [{ invoiceId: inv.id, amount: '500' }] });
    const inUse = await act('fm', `/purch/vendor-invoices/${inv.id}/reverse`, sign('REVERSED', 'Entered against the wrong PO'));
    expect([inUse.status, inUse.body.error.code]).toEqual([409, 'IN_USE']);
    await call('ap', 'post', `/purch/vendor-payments/${draftPay.body.id}/cancel`, { reason: 'Invoice to be re-entered' });

    expect((await act('acct', `/purch/vendor-invoices/${inv.id}/reverse`, sign('REVERSED'))).status).toBe(403);
    const meaning = await act('fm', `/purch/vendor-invoices/${inv.id}/reverse`, sign('APPROVED'));
    expect([meaning.status, meaning.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const bad = await act('fm', `/purch/vendor-invoices/${inv.id}/reverse`, { signature: { password: 'wrong', meaning: 'REVERSED', reason: 'Wrong PO' } });
    expect([bad.status, bad.body.error.code]).toEqual([403, 'ESIGN_FAILED']);

    const rev = await act('fm', `/purch/vendor-invoices/${inv.id}/reverse`, sign('REVERSED', 'Entered against the wrong PO'));
    expect(rev.body).toMatchObject({ status: 'REVERSED', reversalDate: TODAY, reversalReason: 'Entered against the wrong PO', reversedByName: 'Test ap5b_fm', openAmount: '0.00' });
    expect(rev.body.reversalJournalDocNo).toMatch(/^SJ-/);
    // The journal and its mirror: every account nets to zero.
    for (const l of await journalOf('VENDOR_INVOICE', inv.id)) expect(l.dr).toBe(l.cr);
    // The GRN line can be billed again; the PO is back to RECEIVED; the vendor's number may be entered again.
    expect((await call('buyer', 'get', `/purch/pos/${poId}`)).body.status).toBe('RECEIVED');
    const billable = await call('acct', 'get', `/purch/vendor-invoices/billable?poId=${poId}`);
    expect(billable.body.goods[0]).toMatchObject({ grnLineId, openQty: '5.0000', invoicedQty: '0.0000' });
    const again = await invoice(poId, grnLineId, '5', '100', { no: 'SAME-NO' });
    expect((await call('buyer', 'get', `/purch/pos/${poId}`)).body.status).toBe('CLOSED');

    const twice = await act('fm', `/purch/vendor-invoices/${inv.id}/reverse`, sign('REVERSED', 'Again'));
    expect([twice.status, twice.body.error.code]).toEqual([409, 'RECORD_LOCKED']);

    // The ledger shows the bill, the bill entered again (invoice date) and the reversal (dated today); the ageing as of
    // the invoice date still shows the reversed bill.
    const ledger = await call('acct', 'get', `/purch/vendors/${v}/ledger`);
    expect((ledger.body.lines as { sourceType: string; sourceDocNo: string; credit: string; debit: string }[]).map((l) => [l.sourceDocNo, l.credit, l.debit])).toEqual([
      [inv.docNo, '500.00', '0.00'],
      [again.docNo, '500.00', '0.00'],
      [inv.docNo, '0.00', '500.00'],
    ]);
    const then = await call('acct', 'get', `/purch/ap-ageing?asOf=${INV_DATE}&vendorId=${v}`);
    expect(then.body.vendors[0].invoices.map((i: { docNo: string }) => i.docNo)).toEqual([inv.docNo, again.docNo]);
    const now = await call('acct', 'get', `/purch/ap-ageing?vendorId=${v}`);
    expect(now.body.vendors[0].invoices.map((i: { docNo: string }) => i.docNo)).toEqual([again.docNo]);

    // The DB: no reversal without the e-signature and the mirrored journal; a reversed invoice never changes.
    await expect(
      inTx(users.fm!, async () => {
        await history('purch.vendor_invoices', again.id, 'POSTED', 'REVERSED', users.fm!);
        await client.query(
          `UPDATE purch.vendor_invoices SET status = 'REVERSED', reversed_by = $2, reversed_at = now(), reversal_date = $3, reversal_reason = 'raw' WHERE id = $1`,
          [again.id, users.fm, TODAY],
        );
      }),
    ).rejects.toThrow(/ESIGN_FAILED/);
    await expect(raw(`UPDATE purch.vendor_invoices SET notes = 'x' WHERE id = $1`, [inv.id], users.fm!)).rejects.toThrow(/RECORD_LOCKED/);
    await expect(raw(`UPDATE purch.vendor_invoices SET notes = 'x' WHERE id = $1`, [again.id], users.fm!)).rejects.toThrow(/changes only by its reversal/);
  });
});

describe('vendor payment reversal (owner 2026-11-26): bounced cheque, wrong payment', () => {
  it('a paid invoice is not reversed; the payment is (Finance Manager, e-signature) and the invoice is open again', async () => {
    const v = await vendor('V-BOUNCE');
    const { poId, grnLineId } = await received('2', '300', v);
    const inv = await invoice(poId, grnLineId, '2', '300');
    const p = await pay(v, inv.id, '600');
    const paid = await act('fm', `/purch/vendor-invoices/${inv.id}/reverse`, sign('REVERSED', 'Wrong vendor'));
    expect([paid.status, paid.body.error.code]).toEqual([409, 'IN_USE']);

    expect((await act('ap', `/purch/vendor-payments/${p.id}/reverse`, sign('REVERSED', 'Cheque bounced'))).status).toBe(403);
    const meaning = await act('fm', `/purch/vendor-payments/${p.id}/reverse`, sign('APPROVED', 'Cheque bounced'));
    expect(meaning.status).toBe(400);
    const rev = await act('fm', `/purch/vendor-payments/${p.id}/reverse`, sign('REVERSED', 'Cheque bounced'));
    expect(rev.body).toMatchObject({ status: 'REVERSED', reversalDate: TODAY, reversalReason: 'Cheque bounced' });
    for (const l of await journalOf('VENDOR_PAYMENT', p.id)) expect(l.dr).toBe(l.cr);
    expect((await call('acct', 'get', `/purch/vendor-invoices/${inv.id}`)).body).toMatchObject({ paidAmount: '0.00', openAmount: '600.00' });
    const twice = await act('fm', `/purch/vendor-payments/${p.id}/reverse`, sign('REVERSED', 'Again'));
    expect([twice.status, twice.body.error.code]).toEqual([409, 'RECORD_LOCKED']);
    // Ageing as of the payment date shows the invoice paid; today it is owed again.
    expect((await call('acct', 'get', `/purch/ap-ageing?asOf=${PAY_DATE}&vendorId=${v}`)).body.vendors).toEqual([]);
    expect((await call('acct', 'get', `/purch/ap-ageing?vendorId=${v}`)).body.totals.total).toBe('600.00');
    // Paid again, it is settled; or (here) the invoice itself can now be reversed.
    expect((await act('fm', `/purch/vendor-invoices/${inv.id}/reverse`, sign('REVERSED', 'Wrong vendor'))).body.status).toBe('REVERSED');

    // The DB: a posted payment is reversed only with the Finance Manager's e-signature and its journal.
    const r2 = await received('1', '10', ids.vendor!);
    const inv2 = await invoice(r2.poId, r2.grnLineId, '1', '10');
    const p2 = await pay(ids.vendor!, inv2.id, '10');
    await expect(
      inTx(users.fm!, async () => {
        await history('purch.vendor_payments', p2.id, 'POSTED', 'REVERSED', users.fm!);
        await client.query(
          `UPDATE purch.vendor_payments SET status = 'REVERSED', reversed_by = $2, reversed_at = now(), reversal_date = $3, reversal_reason = 'raw' WHERE id = $1`,
          [p2.id, users.fm, TODAY],
        );
      }),
    ).rejects.toThrow(/ESIGN_FAILED/);
  });
});

// ---------------------------------------------------------------- owner answer 7: debit notes

describe('debit note: price claim (owner 2026-11-26)', () => {
  it('approval matrix, creator ≠ approver; Dr AP / Cr price variance / Cr input tax; the open amount, ledger and ageing follow', async () => {
    const v = await vendor('V-CLAIM');
    const { poId, grnLineId } = await received('10', '100', v);
    // On a draft invoice: refused.
    const draftInv = await call('acct', 'post', '/purch/vendor-invoices', {
      invoiceType: 'GOODS', poId, vendorInvoiceNo: 'CL-DRAFT', invoiceDate: INV_DATE, lines: [{ grnLineId, qty: '1', unitPrice: '100' }],
    });
    const onDraft = await call('acct', 'post', '/purch/debit-notes', { invoiceId: draftInv.body.id, reason: 'PRICE_CLAIM', dnDate: DN_DATE, lines: [{ invoiceLineId: draftInv.body.lines[0].id, amount: '5' }] });
    expect([onDraft.status, onDraft.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);
    await call('acct', 'post', `/purch/vendor-invoices/${draftInv.body.id}/cancel`, { reason: 'Entered twice' });

    const inv = await invoice(poId, grnLineId, '10', '100', { tax: true }); // 1,180
    const lineId = inv.lines[0]!.id;
    const body = { invoiceId: inv.id, reason: 'PRICE_CLAIM', dnDate: DN_DATE, notes: 'Agreed 5 off per unit', lines: [{ invoiceLineId: lineId, amount: '50' }] };
    expect((await call('ap', 'post', '/purch/debit-notes', body)).status).toBe(403);
    const tooMuch = await call('acct', 'post', '/purch/debit-notes', { ...body, lines: [{ invoiceLineId: lineId, amount: '1000.01' }] });
    expect([tooMuch.status, tooMuch.body.error.code]).toEqual([422, 'AMOUNT_EXCEEDS_OPEN']);
    const qtyOnClaim = await call('acct', 'post', '/purch/debit-notes', { ...body, lines: [{ invoiceLineId: lineId, qty: '1' }] });
    expect(qtyOnClaim.status).toBe(400);
    const early = await call('acct', 'post', '/purch/debit-notes', { ...body, dnDate: '2026-11-01' });
    expect([early.status, early.body.error.details.field]).toEqual([400, 'dnDate']);

    // Creator ≠ approver, even for someone holding both roles.
    const own = await call('acctfm', 'post', '/purch/debit-notes', body);
    expect(own.body).toMatchObject({ docNo: expect.stringMatching(/^DN-2627-\d{5}$/), goodsAmount: '50.00', taxAmount: '9.00', totalAmount: '59.00', totalPkr: '59.00' });
    await call('acctfm', 'post', `/purch/debit-notes/${own.body.id}/submit`);
    const self = await approve('purch.debit_notes', own.body.id, 'acctfm');
    expect([self.status, self.body.error.code]).toEqual([403, 'SEGREGATION_OF_DUTIES']);
    await expect(
      inTx(users.fm!, async () => {
        await history('purch.debit_notes', own.body.id, 'PENDING_APPROVAL', 'APPROVED', users.fm!);
        await client.query(`UPDATE purch.debit_notes SET status = 'APPROVED' WHERE id = $1`, [own.body.id]);
      }),
    ).rejects.toThrow(/SEGREGATION_OF_DUTIES/);
    await call('acctfm', 'post', `/purch/debit-notes/${own.body.id}/cancel`, { reason: 'Entered by the wrong person' });

    const note = await approvedNote(body);
    expect((await act('wm', `/purch/debit-notes/${note.id}/post`)).status).toBe(403);
    const posted = await act('acct', `/purch/debit-notes/${note.id}/post`);
    expect([posted.status, posted.body.status]).toEqual([200, 'POSTED']);
    expect(posted.body.journalDocNo).toMatch(/^SJ-/);
    expect(await journalOf('DEBIT_NOTE', note.id)).toEqual([
      { code: '1230', dr: '0.00', cr: '9.00' },
      { code: '2110', dr: '59.00', cr: '0.00' },
      { code: '5200', dr: '0.00', cr: '50.00' },
    ]);
    // The invoice: 1,180 − 59 open; a payment never takes more; the invoice is no longer reversed.
    expect((await call('acct', 'get', `/purch/vendor-invoices/${inv.id}`)).body).toMatchObject({ debitedAmount: '59.00', openAmount: '1121.00', openPkr: '1121.00' });
    const over = await call('ap', 'post', '/purch/vendor-payments', { vendorId: v, paymentDate: PAY_DATE, allocations: [{ invoiceId: inv.id, amount: '1180' }] });
    expect([over.status, over.body.error.code]).toEqual([422, 'AMOUNT_EXCEEDS_OPEN']);
    const rev = await act('fm', `/purch/vendor-invoices/${inv.id}/reverse`, sign('REVERSED', 'Wrong entry'));
    expect([rev.status, rev.body.error.code]).toEqual([409, 'IN_USE']);
    // Ledger and ageing.
    const ledger = await call('acct', 'get', `/purch/vendors/${v}/ledger`);
    expect((ledger.body.lines as { sourceType: string; sourceDocNo: string; debit: string; balance: string }[]).map((l) => [l.sourceType, l.sourceDocNo, l.debit, l.balance])).toEqual([
      ['VENDOR_INVOICE', inv.docNo, '0.00', '1180.00'],
      ['DEBIT_NOTE', note.docNo, '59.00', '1121.00'],
    ]);
    expect((await call('acct', 'get', `/purch/ap-ageing?vendorId=${v}`)).body.totals.total).toBe('1121.00');
    expect((await call('acct', 'get', `/purch/ap-ageing?asOf=${INV_DATE}&vendorId=${v}`)).body.totals.total).toBe('1180.00');
    await pay(v, inv.id, '1121');
    expect((await call('acct', 'get', `/purch/ap-ageing?vendorId=${v}`)).body.vendors).toEqual([]);
    // A second claim beyond what is open: refused (service and DB); a posted note never changes.
    const more = await call('acct', 'post', '/purch/debit-notes', { ...body, lines: [{ invoiceLineId: lineId, amount: '1' }] });
    expect([more.status, more.body.error.code]).toEqual([422, 'AMOUNT_EXCEEDS_OPEN']);
    await expect(raw(`UPDATE purch.debit_notes SET notes = 'x' WHERE id = $1`, [note.id], users.acct!)).rejects.toThrow(/RECORD_LOCKED/);
  });
});

describe('debit note: short supply (owner 2026-11-26)', () => {
  it('only the quantity billed beyond what was received; Dr AP / Cr price variance', async () => {
    const v = await vendor('V-SHORT');
    const { poId, grnLineId } = await received('10', '100', v);
    const inv = await invoice(poId, grnLineId, '12', '100'); // billed 12, received 10: released by the Finance Manager
    const lineId = inv.lines[0]!.id;
    const body = { invoiceId: inv.id, reason: 'SHORT_SUPPLY', dnDate: DN_DATE, lines: [{ invoiceLineId: lineId, qty: '3' }] };
    const three = await call('acct', 'post', '/purch/debit-notes', body);
    expect([three.status, three.body.error.code]).toEqual([422, 'AMOUNT_EXCEEDS_OPEN']);
    const amountOnShort = await call('acct', 'post', '/purch/debit-notes', { ...body, lines: [{ invoiceLineId: lineId, amount: '200' }] });
    expect(amountOnShort.status).toBe(400);
    const note = await approvedNote({ ...body, lines: [{ invoiceLineId: lineId, qty: '2' }] });
    expect(note.totalAmount).toBe('200.00');
    // While it waits, a second claim for the same 2 is refused.
    const dup = await call('acct', 'post', '/purch/debit-notes', { ...body, lines: [{ invoiceLineId: lineId, qty: '1' }] });
    expect([dup.status, dup.body.error.code]).toEqual([422, 'AMOUNT_EXCEEDS_OPEN']);
    expect((await act('acct', `/purch/debit-notes/${note.id}/post`)).body.status).toBe('POSTED');
    expect(await journalOf('DEBIT_NOTE', note.id)).toEqual([
      { code: '2110', dr: '200.00', cr: '0.00' },
      { code: '5200', dr: '0.00', cr: '200.00' },
    ]);
  });
});

describe('debit note: return of a rejected lot (owner 2026-11-26; rule 1)', () => {
  it('only a REJECTED lot; posted by the Warehouse Manager with a QA witness; links the movement; the lot is RETURNED when empty', async () => {
    const v = await vendor('V-RETURN');
    const { poId, grnLineId, lotId } = await received('10', '100', v);
    const inv = await invoice(poId, grnLineId, '10', '101', { tax: true }); // 1,010 + 181.80; the lot is worth 1,000
    const lineId = inv.lines[0]!.id;
    const body = { invoiceId: inv.id, reason: 'RETURN_TO_VENDOR', dnDate: DN_DATE, lines: [{ invoiceLineId: lineId, qty: '4' }] };
    const notRejected = await call('acct', 'post', '/purch/debit-notes', body);
    expect([notRejected.status, notRejected.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);
    // QC rejects the lot (M4 builds the screen; here the status move as QC's would be).
    await inTx(users.qa!, async () => {
      await history('inv.lots', lotId, 'APPROVED', 'REJECTED', users.qa!);
      await client.query(`UPDATE inv.lots SET status = 'REJECTED' WHERE id = $1`, [lotId]);
    });
    const eleven = await call('acct', 'post', '/purch/debit-notes', { ...body, lines: [{ invoiceLineId: lineId, qty: '11' }] });
    expect([eleven.status, eleven.body.error.code]).toEqual([422, 'AMOUNT_EXCEEDS_OPEN']);
    const twoLines = await call('acct', 'post', '/purch/debit-notes', { ...body, lines: [{ invoiceLineId: lineId, qty: '1' }, { invoiceLineId: lineId, qty: '1' }] });
    expect(twoLines.status).toBe(400);

    const note = await approvedNote(body); // 4 × 101 = 404 + 72.72 tax
    expect(note.totalAmount).toBe('476.72');
    expect((await act('acct', `/purch/debit-notes/${note.id}/post`, { locationId: ids.loc })).status).toBe(403);
    const noWitness = await act('wm', `/purch/debit-notes/${note.id}/post`, { locationId: ids.loc });
    expect([noWitness.status, noWitness.body.error.code]).toEqual([403, 'WITNESS_REQUIRED']);
    const notQa = await act('wm', `/purch/debit-notes/${note.id}/post`, { locationId: ids.loc, witness: witness('ap5b_acct') });
    expect(notQa.status).toBe(403);
    const posted = await act('wm', `/purch/debit-notes/${note.id}/post`, { locationId: ids.loc, witness: witness() });
    expect([posted.status, posted.body.error]).toEqual([200, undefined]);
    expect(posted.body.lines[0]).toMatchObject({ qty: '4.0000', amountPkr: '404.00', taxPkr: '72.72', stockValuePkr: '400.00', priceVariancePkr: '4.00' });
    const movementId = posted.body.lines[0].movementId as string;
    const { rows: mv } = await client.query(`SELECT movement_type, qty::text, value::text, ref_doc_type, witness_esign_id IS NOT NULL AS witnessed FROM inv.stock_movements WHERE id = $1`, [movementId]);
    expect(mv[0]).toEqual({ movement_type: 'RETURN_TO_VENDOR', qty: '-4.0000', value: '-400.00', ref_doc_type: 'DEBIT_NOTE', witnessed: true });
    // LOT_RETURNED: Dr AP 476.72 / Cr inventory 400 / Cr price variance 4 / Cr input tax 72.72.
    expect(await journalOf('DEBIT_NOTE', note.id)).toEqual([
      { code: '1230', dr: '0.00', cr: '72.72' },
      { code: '1310', dr: '0.00', cr: '400.00' },
      { code: '2110', dr: '476.72', cr: '0.00' },
      { code: '5200', dr: '0.00', cr: '4.00' },
    ]);
    expect((await client.query(`SELECT status FROM inv.lots WHERE id = $1`, [lotId])).rows[0]!.status).toBe('REJECTED'); // 6 still held

    // The rest goes back: the lot is empty and RETURNED.
    const rest = await approvedNote({ ...body, lines: [{ invoiceLineId: lineId, qty: '6' }] });
    expect((await act('wm', `/purch/debit-notes/${rest.id}/post`, { locationId: ids.loc, witness: witness() })).body.status).toBe('POSTED');
    expect((await client.query(`SELECT status FROM inv.lots WHERE id = $1`, [lotId])).rows[0]!.status).toBe('RETURNED');
    expect((await call('acct', 'get', `/purch/vendor-invoices/${inv.id}`)).body).toMatchObject({ debitedAmount: '1191.80', openAmount: '0.00', openPkr: '0.00' });
    const ledger = await call('acct', 'get', `/purch/vendors/${v}/ledger`);
    expect(ledger.body.closing).toBe('0.00');
    expect((ledger.body.lines as { sourceType: string }[]).filter((l) => l.sourceType === 'DEBIT_NOTE').length).toBeGreaterThanOrEqual(2);
    // Nothing more can be returned.
    const again = await call('acct', 'post', '/purch/debit-notes', { ...body, lines: [{ invoiceLineId: lineId, qty: '1' }] });
    expect(again.status).toBeGreaterThanOrEqual(409);
  });
});

// ---------------------------------------------------------------- the remaining refusals (task 5b close)

describe('task 5b: the remaining refusals', () => {
  it('debit note: future date, a line of another invoice, a line twice, a reversed invoice', async () => {
    const v = await vendor('V-DN-REF');
    const a = await received('4', '100', v);
    const b = await received('4', '100', v);
    const invA = await invoice(a.poId, a.grnLineId, '4', '100');
    const invB = await invoice(b.poId, b.grnLineId, '4', '100');
    const body = { invoiceId: invA.id, reason: 'PRICE_CLAIM', dnDate: DN_DATE, lines: [{ invoiceLineId: invA.lines[0]!.id, amount: '10' }] };

    const tomorrow = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const future = await call('acct', 'post', '/purch/debit-notes', { ...body, dnDate: tomorrow });
    expect([future.status, future.body.error.details.field]).toEqual([400, 'dnDate']);
    const other = await call('acct', 'post', '/purch/debit-notes', { ...body, lines: [{ invoiceLineId: invB.lines[0]!.id, amount: '10' }] });
    expect([other.status, other.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const twice = await call('acct', 'post', '/purch/debit-notes', { ...body, lines: [{ invoiceLineId: invA.lines[0]!.id, amount: '5' }, { invoiceLineId: invA.lines[0]!.id, amount: '5' }] });
    expect([twice.status, twice.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);

    expect((await act('fm', `/purch/vendor-invoices/${invB.id}/reverse`, sign('REVERSED', 'Billed twice'))).body.status).toBe('REVERSED');
    const onReversed = await call('acct', 'post', '/purch/debit-notes', { ...body, invoiceId: invB.id, lines: [{ invoiceLineId: invB.lines[0]!.id, amount: '10' }] });
    expect([onReversed.status, onReversed.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);
  });

  it('debit note: no posting before approval; edits only in DRAFT; a rejection returns it to DRAFT; a cancelled note is locked', async () => {
    const v = await vendor('V-DN-FLOW');
    const { poId, grnLineId } = await received('4', '100', v);
    const inv = await invoice(poId, grnLineId, '4', '100');
    const lineId = inv.lines[0]!.id;
    const n = await call('acct', 'post', '/purch/debit-notes', { invoiceId: inv.id, reason: 'PRICE_CLAIM', dnDate: DN_DATE, lines: [{ invoiceLineId: lineId, amount: '20' }] });
    expect(n.status).toBe(201);
    const early = await act('acct', `/purch/debit-notes/${n.body.id}/post`);
    expect([early.status, early.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);

    await call('acct', 'post', `/purch/debit-notes/${n.body.id}/submit`);
    const editWaiting = await call('acct', 'patch', `/purch/debit-notes/${n.body.id}`, { dnDate: DN_DATE, lines: [{ invoiceLineId: lineId, amount: '15' }] });
    expect([editWaiting.status, editWaiting.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);
    const rejected = await call('fm', 'post', `/core/approvals/${await approvalOf('purch.debit_notes', n.body.id)}/reject`, sign('REJECTED', 'Vendor agreed 15 only'));
    expect(rejected.status).toBe(200);
    expect((await call('acct', 'get', `/purch/debit-notes/${n.body.id}`)).body.status).toBe('DRAFT');
    const edited = await call('acct', 'patch', `/purch/debit-notes/${n.body.id}`, { dnDate: DN_DATE, lines: [{ invoiceLineId: lineId, amount: '15' }] });
    expect([edited.status, edited.body.totalAmount]).toEqual([200, '15.00']);

    await call('acct', 'post', `/purch/debit-notes/${n.body.id}/submit`);
    expect((await approve('purch.debit_notes', n.body.id)).status).toBe(200);
    // A price claim moves no stock: a location or witness is refused.
    const stock = await act('acct', `/purch/debit-notes/${n.body.id}/post`, { locationId: ids.loc });
    expect([stock.status, stock.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect((await call('acct', 'post', `/purch/debit-notes/${n.body.id}/cancel`, { reason: 'Vendor withdrew the credit' })).body.status).toBe('CANCELLED');
    const afterCancel = await act('acct', `/purch/debit-notes/${n.body.id}/post`);
    expect([afterCancel.status, afterCancel.body.error.code]).toEqual([409, 'RECORD_LOCKED']);
    // Nothing was taken off the invoice.
    expect((await call('acct', 'get', `/purch/vendor-invoices/${inv.id}`)).body).toMatchObject({ debitedAmount: '0.00', openAmount: '400.00' });
  });

  it('return note: the location the lot leaves is required', async () => {
    const v = await vendor('V-DN-LOC');
    const { poId, grnLineId, lotId } = await received('3', '100', v);
    const inv = await invoice(poId, grnLineId, '3', '100');
    await inTx(users.qa!, async () => {
      await history('inv.lots', lotId, 'APPROVED', 'REJECTED', users.qa!);
      await client.query(`UPDATE inv.lots SET status = 'REJECTED' WHERE id = $1`, [lotId]);
    });
    const note = await approvedNote({ invoiceId: inv.id, reason: 'RETURN_TO_VENDOR', dnDate: DN_DATE, lines: [{ invoiceLineId: inv.lines[0]!.id, qty: '3' }] });
    const noLoc = await act('wm', `/purch/debit-notes/${note.id}/post`, { witness: witness() });
    expect([noLoc.status, noLoc.body.error.details.field]).toEqual([400, 'locationId']);
    expect((await call('acct', 'get', `/purch/debit-notes/${note.id}`)).body.status).toBe('APPROVED');
  });

  it('payments and invoices: a different reference at posting, reversing what is not posted, a wrong password', async () => {
    const v = await vendor('V-PAY-REF');
    const { poId, grnLineId } = await received('3', '100', v);
    // Bill 2 of the 3 received; the third is entered below and left in DRAFT.
    const inv = await invoice(poId, grnLineId, '2', '100');
    const p = await call('ap', 'post', '/purch/vendor-payments', { vendorId: v, paymentDate: PAY_DATE, reference: 'CHQ-500', allocations: [{ invoiceId: inv.id, amount: '200' }] });
    const draftRev = await act('fm', `/purch/vendor-payments/${p.body.id}/reverse`, sign('REVERSED', 'Not posted yet'));
    expect([draftRev.status, draftRev.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);
    await call('ap', 'post', `/purch/vendor-payments/${p.body.id}/submit`);
    await approve('purch.vendor_payments', p.body.id);
    const otherRef = await act('ap', `/purch/vendor-payments/${p.body.id}/post`, { reference: 'CHQ-501' });
    expect([otherRef.status, otherRef.body.error.details.field]).toEqual([400, 'reference']);
    expect((await act('ap', `/purch/vendor-payments/${p.body.id}/post`)).body).toMatchObject({ status: 'POSTED', reference: 'CHQ-500' });
    const badPw = await act('fm', `/purch/vendor-payments/${p.body.id}/reverse`, { signature: { password: 'wrong', meaning: 'REVERSED', reason: 'Cheque bounced' } });
    expect([badPw.status, badPw.body.error.code]).toEqual([403, 'ESIGN_FAILED']);
    expect((await call('ap', 'get', `/purch/vendor-payments/${p.body.id}`)).body.status).toBe('POSTED');

    const draftInv = await call('acct', 'post', '/purch/vendor-invoices', {
      invoiceType: 'GOODS', poId, vendorInvoiceNo: 'REF-DRAFT', invoiceDate: INV_DATE, lines: [{ grnLineId, qty: '1', unitPrice: '100' }],
    });
    const invRev = await act('fm', `/purch/vendor-invoices/${draftInv.body.id}/reverse`, sign('REVERSED', 'Not posted yet'));
    expect(draftInv.status).toBe(201);
    expect([invRev.status, invRev.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);
  });
});
