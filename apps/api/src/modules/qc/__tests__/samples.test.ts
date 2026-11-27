// M4 task 2 (0035, 0036): sample queue, sampling (SAMPLE_ISSUE reduces stock, owner 2026-11-27), results (pass
// computed, insert-only), review (reviewer ≠ analyst, e-signature) and FG fail → HOLD (owner 2026-11-18). Happy path
// and every refusal through the HTTP endpoints, plus the database guards.
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { databaseUrl } from '../../../config/env';
import { systemContext, withTransaction } from '../../../db/client';
import { runSeed } from '../../../db/seed/run';
import { companyToday } from '../../../core/dates';
import { permissionKeysForUser } from '../../../core/auth/auth.repo';
import type { Actor } from '../../../core/transition/transition';
import { createLot, fgUnitCost, postMovement } from '../../../engines/inventory';
import { createTestUser, TEST_PASSWORD } from '../../../test/factories';
import { requestSample, type SampleRequestSource } from '../sample-requests.service';

const app = createApp();
const client = new pg.Client({ connectionString: databaseUrl });
const tokens: Record<string, string> = {};
const users: Record<string, string> = {};
const actors: Record<string, Actor> = {};
const ids: Record<string, string> = {};
const TODAY = companyToday();
let seq = 0;
let idem = 0;

function call(who: string, method: 'get' | 'post' | 'put', url: string, body?: object) {
  const r = request(app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`);
  return body ? r.send(body) : r;
}
/** Sampling posts stock: Idempotency-Key required. */
const take = (who: string, id: string, body: object) =>
  request(app).post(`/api/v1/qc/samples/${id}/take`).set('Authorization', `Bearer ${tokens[who]}`).set('Idempotency-Key', `qc-sample-${Date.now()}-${++idem}`).send(body);
const sign = (meaning = 'REVIEWED', password = TEST_PASSWORD) => ({ signature: { password, meaning, reason: 'Raw data checked' } });

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
const lotStatus = async (lotId: string) => (await client.query<{ status: string }>(`SELECT status FROM inv.lots WHERE id = $1`, [lotId])).rows[0]!.status;
const balance = async (lotId: string) =>
  (await client.query<{ q: string }>(`SELECT COALESCE(sum(qty), 0)::numeric(18,4)::text AS q FROM inv.stock_balances WHERE lot_id = $1`, [lotId])).rows[0]!.q;

function periodOf(date: string) {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const fyStart = m >= 7 ? y : y - 1;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const name = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  return { fy: `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`, no: ((m + 5) % 12) + 1, name: `${name}-${y}`, start: `${date.slice(0, 7)}-01`, end };
}

async function item(code: string, type: string): Promise<string> {
  const id = await inTx(users.wm!, async () => {
    const i = await one(
      `INSERT INTO master.items (code, name, type, category_id, base_uom_id, status, qc_required) VALUES ($1, $1, $2, $3, $4, 'DRAFT', true) RETURNING id`,
      [code, type, ids.category, ids.uom],
    );
    await history('master.items', i, null, 'DRAFT', users.wm!);
    return i;
  });
  await inTx(users.qa!, async () => {
    await history('master.items', id, 'DRAFT', 'ACTIVE', users.qa!);
    await client.query(`UPDATE master.items SET status = 'ACTIVE' WHERE id = $1`, [id]);
  });
  return id;
}

const assay = { name: 'Assay (HPLC)', resultType: 'NUMERIC', minValue: '98.0', maxValue: '102.0', unit: '%', isAssay: true };
const water = { name: 'Water (KF)', resultType: 'NUMERIC', maxValue: '0.5', unit: '%', isWater: true };
const ident = { name: 'Identification (IR)', resultType: 'TEXT', textLimit: 'Complies with reference' };

/** The analyst drafts, the QC Manager approves (task 1). */
async function approveSpec(itemId: string, tests: object[] = [assay, water, ident]): Promise<string> {
  const created = await call('analyst', 'post', '/qc/specs', { itemId });
  await call('analyst', 'put', `/qc/specs/${created.body.id}/tests`, { tests });
  await call('analyst', 'post', `/qc/specs/${created.body.id}/submit`);
  const ok = await call('qcm', 'post', `/qc/specs/${created.body.id}/approve`, { signature: { password: TEST_PASSWORD, meaning: 'APPROVED', reason: 'Checked against BP' } });
  expect([created.status, ok.status, ok.body.error]).toEqual([201, 200, undefined]);
  return created.body.id as string;
}

/** A lot received (GRN) or produced (FG output) with `qty` at loc1, and its OPEN sample request. */
async function lotWithRequest(o: { itemId: string; qty: string; unitCost?: string; fg?: boolean; toll?: boolean }): Promise<{ lotId: string; requestId: string }> {
  const who = o.fg ? 'sup' : 'store';
  const source: SampleRequestSource = o.fg ? 'PRODUCTION_OUTPUT' : 'GRN';
  return withTransaction({ userId: actors[who]!.userId, companyId: '1' }, async (tx) => {
    const a = actors[who]!;
    const value = o.fg ? '500.00' : undefined;
    const lot = await createLot(tx, a, {
      source: o.fg ? 'PRODUCTION_OUTPUT' : 'GRN',
      itemId: o.itemId,
      lotNo: `S-${++seq}`,
      unitCost: o.fg ? fgUnitCost(value!, o.qty) : (o.unitCost ?? '10.00'),
      expiryDate: '2099-12-31',
      ...(o.toll ? { ownerCustomerId: ids.toll } : {}),
    });
    await postMovement(tx, a, {
      type: o.fg ? 'OUTPUT' : 'RECEIPT', lotId: lot.id, locationId: ids.loc1!, qty: o.qty, date: TODAY, refDocType: o.fg ? 'PROD_ORDER' : 'GRN', refDocId: String(seq),
      ...(value ? { value } : {}),
    });
    const req = await requestSample(tx, a, { lotId: lot.id, source, refDocId: String(seq) });
    return { lotId: lot.id, requestId: req.id };
  });
}

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  for (const [name, roles] of [
    ['analyst', ['QC_ANALYST']],
    ['analyst2', ['QC_ANALYST']],
    ['qcm', ['QC_MANAGER']],
    ['both', ['QC_ANALYST', 'QC_MANAGER']],
    ['store', ['STOREKEEPER']],
    ['sup', ['PRODUCTION_SUPERVISOR']],
    ['wm', ['WAREHOUSE_MANAGER']],
    ['qa', ['QA_MANAGER']],
    ['fm', ['FINANCE_MANAGER']],
  ] as const) {
    users[name] = await createTestUser({ username: `smp_${name}`, roleCodes: [...roles] });
    const keys = await withTransaction(systemContext('test'), (tx) => permissionKeysForUser(tx, users[name]!));
    actors[name] = { userId: users[name]!, companyId: '1', permissions: new Set(keys) };
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: `smp_${name}`, password: TEST_PASSWORD });
    tokens[name] = res.body.accessToken as string;
  }
  await inTx('1', async () => {
    ids.uom = await one(`INSERT INTO master.uoms (code, name) VALUES ('KG', 'Kilogram') RETURNING id`);
    ids.category = await one(`INSERT INTO master.item_categories (code, name) VALUES ('RM', 'Raw material') RETURNING id`);
    const wh = await one(`INSERT INTO master.warehouses (code, name) VALUES ('QS', 'Quarantine store') RETURNING id`);
    ids.loc1 = await one(`INSERT INTO master.locations (warehouse_id, code, name) VALUES ($1, 'Q1', 'Quarantine bay 1') RETURNING id`, [wh]);
    ids.toll = await one(`INSERT INTO master.customers (code, name, ntn, is_toll_customer, status) VALUES ('TOLL', 'Toll Co', '1234567', true, 'ACTIVE') RETURNING id`);
    await history('master.customers', ids.toll!, null, 'ACTIVE', '1');
  });
  const p = periodOf(TODAY);
  await inTx(users.fm!, async () => {
    const id = await one(
      `INSERT INTO core.fiscal_periods (fiscal_year, period_no, name, start_date, end_date, status) VALUES ($1, $2, $3, $4, $5, 'OPEN') RETURNING id`,
      [p.fy, p.no, p.name, p.start, p.end],
    );
    await history('core.fiscal_periods', id, null, 'OPEN', users.fm!);
  });
  ids.api = await item('API-PCM', 'API');
  ids.fg = await item('FG-TAB', 'FG');
  ids.nospec = await item('RM-NOSPEC', 'RM');
  ids.apiSpec = await approveSpec(ids.api);
  ids.fgSpec = await approveSpec(ids.fg);
});

afterAll(async () => {
  await client.end();
});

const testIds = async (requestId: string) => {
  const d = (await call('analyst', 'get', `/qc/samples/${requestId}`)).body as { tests: { id: string; name: string }[] };
  return Object.fromEntries(d.tests.map((t) => [t.name, t.id])) as Record<string, string>;
};

describe('sample queue → take sample → results → review (material lot)', () => {
  let lotId = '';
  let reqId = '';

  it('the queue lists the OPEN request; its detail shows the APPROVED spec tests and where the lot holds stock', async () => {
    ({ lotId, requestId: reqId } = await lotWithRequest({ itemId: ids.api!, qty: '100', unitCost: '12.345678' }));
    const list = await call('analyst', 'get', '/qc/samples?status=OPEN&search=pcm');
    expect(list.status).toBe(200);
    expect(list.body.items.map((s: { id: string }) => s.id)).toContain(reqId);
    const d = await call('analyst', 'get', `/qc/samples/${reqId}`);
    expect(d.body).toMatchObject({ status: 'OPEN', lotStatus: 'QUARANTINE', itemCode: 'API-PCM', specId: null, locations: [{ locationId: ids.loc1, locationCode: 'Q1', qty: '100.0000' }] });
    expect(d.body.tests.map((t: { name: string }) => t.name)).toEqual(['Assay (HPLC)', 'Water (KF)', 'Identification (IR)']);
  });

  it('taking the sample: lot UNDER_TEST, spec pinned, test + retention quantities leave stock with a QC_SAMPLE journal', async () => {
    const res = await take('analyst', reqId, { locationId: ids.loc1, testQty: '2.5', retentionQty: '1', notes: 'Thief sampler, 3 containers' });
    expect([res.status, res.body.error]).toEqual([200, undefined]);
    expect(res.body).toMatchObject({ status: 'SAMPLED', lotStatus: 'UNDER_TEST', specId: ids.apiSpec, specVersion: 1, sampledBy: users.analyst, testQty: '2.5000', retentionQty: '1.0000' });
    expect(await balance(lotId)).toBe('96.5000');
    const { rows: mv } = await client.query(`SELECT reason_code, qty::text, value::text FROM inv.stock_movements WHERE ref_doc_type = 'QC_SAMPLE' AND ref_doc_id = $1 ORDER BY id`, [reqId]);
    expect(mv).toEqual([{ reason_code: 'TEST', qty: '-2.5000', value: '-30.86' }, { reason_code: 'RETENTION', qty: '-1.0000', value: '-12.35' }]);
    const { rows: gl } = await client.query(
      `SELECT a.code, l.debit::text, l.credit::text FROM fin.journal_entries e JOIN fin.journal_lines l ON l.entry_id = e.id JOIN fin.accounts a ON a.id = l.account_id
        WHERE e.source_type = 'QC_SAMPLE' AND e.source_id = $1 AND e.event = 'QC_SAMPLE' AND e.status = 'POSTED' ORDER BY a.code`, [reqId],
    );
    expect(gl).toEqual([{ code: '1310', debit: '0.00', credit: '43.21' }, { code: '6400', debit: '43.21', credit: '0.00' }]);
    const { rows: h } = await client.query(`SELECT from_status, to_status, actor_id FROM core.status_history WHERE entity_table = 'inv.lots' AND entity_id = $1 ORDER BY id`, [lotId]);
    expect(h.map((x) => `${x.from_status ?? '-'}>${x.to_status}`)).toEqual(['->QUARANTINE', 'QUARANTINE>UNDER_TEST']);
    expect(h[1]!.actor_id).toBe(users.analyst);
  });

  it('results: numeric pass / fail computed from the limits, text by the analyst; a material lot stays UNDER_TEST on a failure', async () => {
    const t = await testIds(reqId);
    const res = await call('analyst', 'post', `/qc/samples/${reqId}/results`, {
      results: [
        { specTestId: t['Assay (HPLC)'], numericValue: '99.42' },
        { specTestId: t['Water (KF)'], numericValue: '0.51', remarks: 'Repeat planned' },
        { specTestId: t['Identification (IR)'], textValue: 'Spectrum concordant', complies: true },
      ],
    });
    expect([res.status, res.body.error]).toEqual([200, undefined]);
    expect(res.body.results.map((r: { numericValue: string | null; passed: boolean }) => [r.numericValue, r.passed])).toEqual([
      ['99.420000', true], ['0.510000', false], [null, true],
    ]);
    expect(res.body).toMatchObject({ resultCount: 3, failedCount: 1, unreviewedCount: 3, lotStatus: 'UNDER_TEST' });
    expect((await call('qcm', 'get', '/qc/samples?toReview=true')).body.items.map((s: { id: string }) => s.id)).toContain(reqId);
  });

  it('the QC Manager reviews with a REVIEWED e-signature; the sample leaves the review queue', async () => {
    const res = await call('qcm', 'post', `/qc/samples/${reqId}/review`, sign());
    expect([res.status, res.body.error]).toEqual([200, undefined]);
    expect(res.body.unreviewedCount).toBe(0);
    expect(res.body.results.every((r: { reviewedBy: string }) => r.reviewedBy === users.qcm)).toBe(true);
    const { rows } = await client.query(
      `SELECT DISTINCT e.meaning, e.record_table, e.record_id, e.user_id FROM qc.result_reviews v JOIN qc.results r ON r.id = v.result_id
         JOIN core.e_signatures e ON e.id = v.esign_id WHERE r.sample_request_id = $1`, [reqId],
    );
    expect(rows).toEqual([{ meaning: 'REVIEWED', record_table: 'qc.sample_requests', record_id: reqId, user_id: users.qcm }]);
    expect((await call('qcm', 'get', '/qc/samples?toReview=true')).body.items.map((s: { id: string }) => s.id)).not.toContain(reqId);
    expect((await call('qcm', 'post', `/qc/samples/${reqId}/review`, sign())).body.error.code).toBe('VALIDATION_FAILED'); // nothing left
  });
});

describe('FG lot: a failed result moves it UNDER_TEST → HOLD (owner 2026-11-18)', () => {
  it('a passing result keeps it UNDER_TEST; a failing one puts it on HOLD in the same transaction; the rest can still be entered', async () => {
    const { lotId, requestId } = await lotWithRequest({ itemId: ids.fg!, qty: '100', fg: true });
    expect((await take('analyst', requestId, { locationId: ids.loc1, testQty: '1', retentionQty: '2' })).status).toBe(200);
    const t = await testIds(requestId);
    const ok = await call('analyst', 'post', `/qc/samples/${requestId}/results`, { results: [{ specTestId: t['Identification (IR)'], textValue: 'Concordant', complies: true }] });
    expect(ok.body.lotStatus).toBe('UNDER_TEST');
    const bad = await call('analyst', 'post', `/qc/samples/${requestId}/results`, { results: [{ specTestId: t['Assay (HPLC)'], numericValue: '96.1' }] });
    expect([bad.status, bad.body.lotStatus, bad.body.failedCount]).toEqual([200, 'HOLD', 1]);
    const { rows } = await client.query(
      `SELECT from_status, to_status, actor_id, reason FROM core.status_history WHERE entity_table = 'inv.lots' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [lotId],
    );
    expect(rows[0]).toMatchObject({ from_status: 'UNDER_TEST', to_status: 'HOLD', actor_id: users.analyst });
    expect(rows[0]!.reason).toContain('Assay (HPLC)');
    const rest = await call('analyst', 'post', `/qc/samples/${requestId}/results`, { results: [{ specTestId: t['Water (KF)'], numericValue: '0.2' }] });
    expect([rest.status, rest.body.lotStatus, rest.body.resultCount]).toEqual([200, 'HOLD', 3]);
    expect(await lotStatus(lotId)).toBe('HOLD');
  });

  it('the database refuses a failed FG result whose lot is not put on HOLD (checked at commit)', async () => {
    const { requestId } = await lotWithRequest({ itemId: ids.fg!, qty: '10', fg: true });
    expect((await take('analyst', requestId, { locationId: ids.loc1, testQty: '1' })).status).toBe(200);
    const t = await testIds(requestId);
    await expect(
      inTx(users.analyst!, () =>
        client.query(`INSERT INTO qc.results (sample_request_id, spec_test_id, result_type, numeric_value, passed) VALUES ($1, $2, 'NUMERIC', 90, false)`, [
          requestId, t['Assay (HPLC)'],
        ]),
      ),
    ).rejects.toThrow(/on HOLD/);
  });
});

describe('toll lot sampling (rule 12)', () => {
  it('a customer-owned lot is sampled at zero value and posts no journal', async () => {
    const { lotId, requestId } = await lotWithRequest({ itemId: ids.api!, qty: '20', unitCost: '0', toll: true });
    expect((await take('analyst', requestId, { locationId: ids.loc1, testQty: '1' })).status).toBe(200);
    expect(await balance(lotId)).toBe('19.0000');
    const { rows } = await client.query(`SELECT value::text FROM inv.stock_movements WHERE ref_doc_type = 'QC_SAMPLE' AND ref_doc_id = $1`, [requestId]);
    expect(rows).toEqual([{ value: '0.00' }]);
    expect((await client.query(`SELECT 1 FROM fin.journal_entries WHERE source_type = 'QC_SAMPLE' AND source_id = $1`, [requestId])).rowCount).toBe(0);
  });
});

describe('sampling refusals', () => {
  it('no APPROVED spec → SPEC_NOT_APPROVED and nothing changes', async () => {
    const { lotId, requestId } = await lotWithRequest({ itemId: ids.nospec!, qty: '10' });
    const res = await take('analyst', requestId, { locationId: ids.loc1, testQty: '1' });
    expect([res.status, res.body.error.code]).toEqual([422, 'SPEC_NOT_APPROVED']);
    expect([await lotStatus(lotId), await balance(lotId)]).toEqual(['QUARANTINE', '10.0000']);
    expect((await call('analyst', 'get', `/qc/samples/${requestId}`)).body.status).toBe('OPEN');
  });

  it('permissions: storekeeper and QC Manager cannot take samples; a warehouse user cannot read the queue; no Idempotency-Key → 400', async () => {
    const { requestId } = await lotWithRequest({ itemId: ids.api!, qty: '10' });
    expect((await take('store', requestId, { locationId: ids.loc1, testQty: '1' })).status).toBe(403);
    expect((await take('qcm', requestId, { locationId: ids.loc1, testQty: '1' })).status).toBe(403);
    expect((await call('wm', 'get', '/qc/samples')).status).toBe(403);
    const noKey = await call('analyst', 'post', `/qc/samples/${requestId}/take`, { locationId: ids.loc1, testQty: '1' });
    expect(noKey.status).toBe(400);
  });

  it('more than the location holds → INSUFFICIENT_STOCK; a zero quantity → 400; a second sampling → 409', async () => {
    const { lotId, requestId } = await lotWithRequest({ itemId: ids.api!, qty: '5' });
    expect((await take('analyst', requestId, { locationId: ids.loc1, testQty: '4', retentionQty: '1.0001' })).body.error.code).toBe('INSUFFICIENT_STOCK');
    expect((await take('analyst', requestId, { locationId: ids.loc1, testQty: '0' })).status).toBe(400);
    expect([await lotStatus(lotId), await balance(lotId)]).toEqual(['QUARANTINE', '5.0000']);
    expect((await take('analyst', requestId, { locationId: ids.loc1, testQty: '1' })).status).toBe(200);
    const again = await take('analyst', requestId, { locationId: ids.loc1, testQty: '1' });
    expect([again.status, again.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);
  });
});

describe('result and review refusals', () => {
  let reqId = '';
  let t: Record<string, string> = {};

  beforeAll(async () => {
    const r = await lotWithRequest({ itemId: ids.api!, qty: '10' });
    reqId = r.requestId;
    const open = await call('analyst', 'post', `/qc/samples/${reqId}/results`, { results: [{ specTestId: '1', numericValue: '1' }] });
    expect([open.status, open.body.error.code]).toEqual([409, 'INVALID_TRANSITION']); // not sampled yet
    expect((await take('both', reqId, { locationId: ids.loc1, testQty: '1' })).status).toBe(200);
    t = await testIds(reqId);
  });

  it('validation: a test of another spec, numeric with a complies flag, text without one, the same test twice → 400', async () => {
    const fgTests = (await call('analyst', 'get', `/qc/specs/${ids.fgSpec}`)).body.tests as { id: string }[];
    for (const results of [
      [{ specTestId: fgTests[0]!.id, numericValue: '99' }],
      [{ specTestId: t['Assay (HPLC)'], numericValue: '99', complies: true }],
      [{ specTestId: t['Identification (IR)'], textValue: 'ok' }],
      [{ specTestId: t['Assay (HPLC)'], numericValue: '99' }, { specTestId: t['Assay (HPLC)'], numericValue: '100' }],
      [{ specTestId: t['Assay (HPLC)'], numericValue: '9.1234567' }],
    ]) {
      const res = await call('analyst', 'post', `/qc/samples/${reqId}/results`, { results });
      expect([res.status, res.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect((await call('qcm', 'post', `/qc/samples/${reqId}/results`, { results: [{ specTestId: t['Assay (HPLC)'], numericValue: '99' }] })).status).toBe(403);
  });

  it('a result is never changed: entering the same test again → 409 ALREADY_EXISTS', async () => {
    expect((await call('both', 'post', `/qc/samples/${reqId}/results`, { results: [{ specTestId: t['Assay (HPLC)'], numericValue: '100.1' }] })).status).toBe(200);
    const again = await call('analyst', 'post', `/qc/samples/${reqId}/results`, { results: [{ specTestId: t['Assay (HPLC)'], numericValue: '100.2' }] });
    expect([again.status, again.body.error.code]).toEqual([409, 'ALREADY_EXISTS']);
  });

  it('segregation: the analyst who entered a result cannot review it (403); wrong meaning or password refused; analysts cannot review', async () => {
    const own = await call('both', 'post', `/qc/samples/${reqId}/review`, sign());
    expect([own.status, own.body.error.code]).toEqual([403, 'SEGREGATION_OF_DUTIES']);
    expect((await call('analyst', 'post', `/qc/samples/${reqId}/review`, sign())).status).toBe(403);
    expect((await call('qcm', 'post', `/qc/samples/${reqId}/review`, sign('APPROVED'))).body.error.code).toBe('VALIDATION_FAILED');
    expect((await call('qcm', 'post', `/qc/samples/${reqId}/review`, sign('REVIEWED', 'wrong-password'))).body.error.code).toBe('ESIGN_FAILED');
    expect((await call('qcm', 'get', `/qc/samples/${reqId}`)).body.unreviewedCount).toBe(1);
    expect((await call('qcm', 'post', `/qc/samples/${reqId}/review`, sign())).status).toBe(200);
  });
});

describe('database guards (0036)', () => {
  let reqId = '';
  let lotId = '';
  let t: Record<string, string> = {};

  beforeAll(async () => {
    ({ requestId: reqId, lotId } = await lotWithRequest({ itemId: ids.api!, qty: '10' }));
    expect((await take('analyst', reqId, { locationId: ids.loc1, testQty: '1' })).status).toBe(200);
    t = await testIds(reqId);
    expect((await call('analyst', 'post', `/qc/samples/${reqId}/results`, { results: [{ specTestId: t['Water (KF)'], numericValue: '0.3' }] })).status).toBe(200);
  });
  const raw = (userId: string, sql: string, params: unknown[]) => inTx(userId, () => client.query(sql, params));

  it('results are insert-only; pass is computed; only a qc.result.enter holder enters them', async () => {
    await expect(raw(users.analyst!, `UPDATE qc.results SET numeric_value = 0.2 WHERE sample_request_id = $1`, [reqId])).rejects.toThrow(/APPEND_ONLY/);
    await expect(raw(users.analyst!, `DELETE FROM qc.results WHERE sample_request_id = $1`, [reqId])).rejects.toThrow();
    const insert = `INSERT INTO qc.results (sample_request_id, spec_test_id, result_type, numeric_value, passed) VALUES ($1, $2, 'NUMERIC', $3, $4)`;
    await expect(raw(users.analyst!, insert, [reqId, t['Assay (HPLC)'], '97', true])).rejects.toThrow(/computed from the limits/);
    await expect(raw(users.qcm!, insert, [reqId, t['Assay (HPLC)'], '99', true])).rejects.toThrow(/FORBIDDEN/);
  });

  it('a review by the analyst, or without a REVIEWED signature of the reviewer, is refused', async () => {
    const resultId = (await client.query<{ id: string }>(`SELECT id FROM qc.results WHERE sample_request_id = $1`, [reqId])).rows[0]!.id;
    const sigOf = (userId: string, username: string) =>
      one(
        `INSERT INTO core.e_signatures (user_id, signer_username, signer_name, meaning, reason, record_table, record_id) VALUES ($1, $2, 'X', 'REVIEWED', 'review', 'qc.sample_requests', $3) RETURNING id`,
        [userId, username, reqId],
      );
    await expect(
      inTx(users.both!, async () => {
        // 'both' did not enter this result but signs for someone else's record table: wrong signer
        await client.query(`INSERT INTO qc.result_reviews (result_id, esign_id) VALUES ($1, $2)`, [resultId, await sigOf(users.qcm!, 'smp_qcm')]);
      }),
    ).rejects.toThrow(/ESIGN_FAILED/);
    // A QC Manager who is also the analyst of a result: give 'both' a result on another sample and try to review it.
    const r2 = await lotWithRequest({ itemId: ids.api!, qty: '5' });
    expect((await take('both', r2.requestId, { locationId: ids.loc1, testQty: '1' })).status).toBe(200);
    const t2 = await testIds(r2.requestId);
    expect((await call('both', 'post', `/qc/samples/${r2.requestId}/results`, { results: [{ specTestId: t2['Water (KF)'], numericValue: '0.1' }] })).status).toBe(200);
    const own = (await client.query<{ id: string }>(`SELECT id FROM qc.results WHERE sample_request_id = $1`, [r2.requestId])).rows[0]!.id;
    await expect(
      inTx(users.both!, async () => {
        const sig = await one(
          `INSERT INTO core.e_signatures (user_id, signer_username, signer_name, meaning, reason, record_table, record_id) VALUES ($1, 'smp_both', 'X', 'REVIEWED', 'self', 'qc.sample_requests', $2) RETURNING id`,
          [users.both, r2.requestId],
        );
        await client.query(`INSERT INTO qc.result_reviews (result_id, esign_id) VALUES ($1, $2)`, [own, sig]);
      }),
    ).rejects.toThrow(/SEGREGATION_OF_DUTIES/);
  });

  it('a request is SAMPLED only with its SAMPLE_ISSUE movements; its sampling record never changes', async () => {
    const r = await lotWithRequest({ itemId: ids.api!, qty: '5' });
    await expect(
      inTx(users.analyst!, async () => {
        await history('inv.lots', r.lotId, 'QUARANTINE', 'UNDER_TEST', users.analyst!);
        await client.query(`UPDATE inv.lots SET status = 'UNDER_TEST' WHERE id = $1`, [r.lotId]);
        await history('qc.sample_requests', r.requestId, 'OPEN', 'SAMPLED', users.analyst!);
        await client.query(
          `UPDATE qc.sample_requests SET status = 'SAMPLED', spec_id = $2, sampled_by = $3, sampled_at = now(), sample_location_id = $4, test_qty = 1, retention_qty = 0 WHERE id = $1`,
          [r.requestId, ids.apiSpec, users.analyst, ids.loc1],
        );
      }),
    ).rejects.toThrow(/SAMPLE_ISSUE movements/);
    await expect(raw(users.analyst!, `UPDATE qc.sample_requests SET test_qty = 3 WHERE id = $1`, [reqId])).rejects.toThrow(/RECORD_LOCKED/);
    expect(await lotStatus(lotId)).toBe('UNDER_TEST');
  });
});
