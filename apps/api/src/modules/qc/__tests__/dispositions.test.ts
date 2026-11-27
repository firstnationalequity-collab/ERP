// M4 task 3 (0037, 0038): QC lot disposition. The QC Manager approves (all tests passed and reviewed; assay / water
// written onto the lot; sample request CLOSED) or rejects (a failed result; or, owner 2026-11-27, without one: before
// sampling, on HOLD or all passed, with a reason category and a description) with an e-signature on the lot. FG lots
// are QA's. Happy paths and every refusal through the HTTP endpoints, plus the database guards.
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { databaseUrl } from '../../../config/env';
import { systemContext, withTransaction } from '../../../db/client';
import { runSeed } from '../../../db/seed/run';
import { companyToday } from '../../../core/dates';
import { permissionKeysForUser } from '../../../core/auth/auth.repo';
import { defineTransitions, transition, type Actor } from '../../../core/transition/transition';
import { createLot, fgUnitCost, LOT_TABLE, postMovement } from '../../../engines/inventory';
import { LotStatus } from '@albert/shared';
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
const take = (who: string, id: string, body: object) =>
  request(app).post(`/api/v1/qc/samples/${id}/take`).set('Authorization', `Bearer ${tokens[who]}`).set('Idempotency-Key', `qc-disp-${Date.now()}-${++idem}`).send(body);
const sig = (meaning: string, reason = 'Results meet the specification', password = TEST_PASSWORD) => ({ signature: { password, meaning, reason } });
const approve = (who: string, lotId: string, extra: object = {}, meaning = 'APPROVED') => call(who, 'post', `/qc/lots/${lotId}/approve`, { ...sig(meaning), ...extra });
const reject = (who: string, lotId: string, meaning = 'REJECTED', extra: object = {}) =>
  call(who, 'post', `/qc/lots/${lotId}/reject`, { ...sig(meaning, 'Assay out of limits'), ...extra });
const damaged = { category: 'DAMAGED_CONTAINER', description: 'Two drums dented, inner liner torn' };

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
const lotRow = async (lotId: string) =>
  (await client.query<{ status: string; assay: string | null; water: string | null; retest: string | null }>(
    `SELECT status, assay_pct::text AS assay, water_pct::text AS water, to_char(retest_date, 'YYYY-MM-DD') AS retest FROM inv.lots WHERE id = $1`, [lotId],
  )).rows[0]!;
const requestStatus = async (id: string) => (await client.query<{ status: string }>(`SELECT status FROM qc.sample_requests WHERE id = $1`, [id])).rows[0]!.status;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

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

const assayTest = { name: 'Assay (HPLC)', resultType: 'NUMERIC', minValue: '98.0', maxValue: '102.0', unit: '%', isAssay: true };
const waterTest = { name: 'Water (KF)', resultType: 'NUMERIC', maxValue: '0.5', unit: '%', isWater: true };
const identTest = { name: 'Identification (IR)', resultType: 'TEXT', textLimit: 'Complies with reference' };

async function approveSpec(itemId: string): Promise<void> {
  const created = await call('analyst', 'post', '/qc/specs', { itemId });
  await call('analyst', 'put', `/qc/specs/${created.body.id}/tests`, { tests: [assayTest, waterTest, identTest] });
  await call('analyst', 'post', `/qc/specs/${created.body.id}/submit`);
  const ok = await call('qcm', 'post', `/qc/specs/${created.body.id}/approve`, sig('APPROVED', 'Checked against BP'));
  expect([created.status, ok.status, ok.body.error]).toEqual([201, 200, undefined]);
}

interface Made { lotId: string; requestId: string; tests: Record<string, string> }

/** A lot (GRN, or FG output) with 100 at loc1 and its OPEN sample request. */
async function lotWithRequest(o: { itemId: string; fg?: boolean; expiryDate?: string; retestDate?: string }): Promise<Omit<Made, 'tests'>> {
  const who = o.fg ? 'sup' : 'store';
  const source: SampleRequestSource = o.fg ? 'PRODUCTION_OUTPUT' : 'GRN';
  return withTransaction({ userId: actors[who]!.userId, companyId: '1' }, async (tx) => {
    const a = actors[who]!;
    const lot = await createLot(tx, a, {
      source,
      itemId: o.itemId,
      lotNo: `D-${++seq}`,
      unitCost: o.fg ? fgUnitCost('500.00', '100') : '10.00',
      expiryDate: o.expiryDate ?? '2099-12-31',
      ...(o.retestDate ? { retestDate: o.retestDate } : {}),
    });
    await postMovement(tx, a, {
      type: o.fg ? 'OUTPUT' : 'RECEIPT', lotId: lot.id, locationId: ids.loc1!, qty: '100', date: TODAY, refDocType: o.fg ? 'PROD_ORDER' : 'GRN', refDocId: String(seq),
      ...(o.fg ? { value: '500.00' } : {}),
    });
    const req = await requestSample(tx, a, { lotId: lot.id, source, refDocId: String(seq) });
    return { lotId: lot.id, requestId: req.id };
  });
}

/** Sampled by the analyst (lot UNDER_TEST); returns the spec test ids by name. */
async function sampledLot(o: Parameters<typeof lotWithRequest>[0]): Promise<Made> {
  const made = await lotWithRequest(o);
  const res = await take('analyst', made.requestId, { locationId: ids.loc1, testQty: '1' });
  expect([res.status, res.body.error]).toEqual([200, undefined]);
  const tests = Object.fromEntries((res.body.tests as { id: string; name: string }[]).map((t) => [t.name, t.id]));
  return { ...made, tests };
}

const results = (m: Made, v: { assay?: string; water?: string; complies?: boolean }) => ({
  results: [
    ...(v.assay !== undefined ? [{ specTestId: m.tests['Assay (HPLC)'], numericValue: v.assay }] : []),
    ...(v.water !== undefined ? [{ specTestId: m.tests['Water (KF)'], numericValue: v.water }] : []),
    ...(v.complies !== undefined ? [{ specTestId: m.tests['Identification (IR)'], textValue: 'IR matches', complies: v.complies }] : []),
  ],
});
async function enter(m: Made, v: Parameters<typeof results>[1], who = 'analyst') {
  const res = await call(who, 'post', `/qc/samples/${m.requestId}/results`, results(m, v));
  expect([res.status, res.body.error]).toEqual([200, undefined]);
}
async function review(m: Made, who = 'qcm') {
  const res = await call(who, 'post', `/qc/samples/${m.requestId}/review`, sig('REVIEWED', 'Raw data checked'));
  expect([res.status, res.body.error]).toEqual([200, undefined]);
}
/** Sampled, all three tests entered and reviewed. */
async function testedLot(v: { assay: string; water: string; complies: boolean }, o: Partial<Parameters<typeof lotWithRequest>[0]> = {}): Promise<Made> {
  const m = await sampledLot({ itemId: ids.api!, ...o });
  await enter(m, v);
  await review(m);
  return m;
}

/** Posts an ISSUE of 1 from the lot and rolls it back: resolves to the refusal code, or 'OK'. */
async function tryIssue(lotId: string): Promise<string> {
  try {
    await withTransaction({ userId: actors.store!.userId, companyId: '1' }, async (tx) => {
      await postMovement(tx, actors.store!, { type: 'ISSUE', lotId, locationId: ids.loc1!, qty: '1', date: TODAY, refDocType: 'PROD_ORDER', refDocId: '1' });
      throw new Error('ROLLBACK');
    });
  } catch (err) {
    const e = err as { code?: string; message: string };
    return e.message === 'ROLLBACK' ? 'OK' : (e.code ?? e.message);
  }
  return 'NOT_REACHED';
}

/** QA places a hold (APPROVED → HOLD, qa.lot.hold); the QA module itself is M7. */
const QaHold = defineTransitions<LotStatus>({
  entityTable: LOT_TABLE,
  statuses: LotStatus,
  moves: [{ from: 'APPROVED', to: 'HOLD', permission: 'qa.lot.hold', reasonRequired: true }],
});

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  for (const [name, roles] of [
    ['analyst', ['QC_ANALYST']],
    ['qcm', ['QC_MANAGER']],
    ['qcm2', ['QC_MANAGER']],
    ['both', ['QC_ANALYST', 'QC_MANAGER']],
    ['store', ['STOREKEEPER']],
    ['sup', ['PRODUCTION_SUPERVISOR']],
    ['wm', ['WAREHOUSE_MANAGER']],
    ['qa', ['QA_MANAGER']],
    ['fm', ['FINANCE_MANAGER']],
    ['ceo', ['CEO']],
  ] as const) {
    users[name] = await createTestUser({ username: `dsp_${name}`, roleCodes: [...roles] });
    const keys = await withTransaction(systemContext('test'), (tx) => permissionKeysForUser(tx, users[name]!));
    actors[name] = { userId: users[name]!, companyId: '1', permissions: new Set(keys) };
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: `dsp_${name}`, password: TEST_PASSWORD });
    tokens[name] = res.body.accessToken as string;
  }
  await inTx('1', async () => {
    ids.uom = await one(`INSERT INTO master.uoms (code, name) VALUES ('KG', 'Kilogram') RETURNING id`);
    ids.category = await one(`INSERT INTO master.item_categories (code, name) VALUES ('RM', 'Raw material') RETURNING id`);
    const wh = await one(`INSERT INTO master.warehouses (code, name) VALUES ('QS', 'Quarantine store') RETURNING id`);
    ids.loc1 = await one(`INSERT INTO master.locations (warehouse_id, code, name) VALUES ($1, 'Q1', 'Quarantine bay 1') RETURNING id`, [wh]);
  });
  const p = periodOf(TODAY);
  await inTx(users.fm!, async () => {
    const id = await one(
      `INSERT INTO core.fiscal_periods (fiscal_year, period_no, name, start_date, end_date, status) VALUES ($1, $2, $3, $4, $5, 'OPEN') RETURNING id`,
      [p.fy, p.no, p.name, p.start, p.end],
    );
    await history('core.fiscal_periods', id, null, 'OPEN', users.fm!);
  });
  ids.api = await item('API-IBU', 'API');
  ids.fg = await item('FG-CAP', 'FG');
  await approveSpec(ids.api);
  await approveSpec(ids.fg);
});

afterAll(async () => {
  await client.end();
});

describe('approval (UNDER_TEST → APPROVED)', () => {
  it('a quarantined lot is issuable only after QC approval; approval writes assay / water, closes the request, signs the lot', async () => {
    const m = await testedLot({ assay: '99.12345', water: '0.2', complies: true });
    expect(await tryIssue(m.lotId)).toBe('LOT_NOT_APPROVED');

    const queue = await call('qcm', 'get', '/qc/lots?status=UNDER_TEST&search=ibu');
    const row = queue.body.items.find((x: { lotId: string }) => x.lotId === m.lotId);
    expect(row).toMatchObject({ lotStatus: 'UNDER_TEST', sampleStatus: 'SAMPLED', missingCount: 0, unreviewedCount: 0, failedCount: 0, canApprove: true, canReject: true, rejectNeedsCategory: true });
    const detail = await call('qcm', 'get', `/qc/lots/${m.lotId}`);
    expect(detail.body).toMatchObject({ approvalAssayPct: '99.1235', approvalWaterPct: '0.2000' });
    expect(detail.body.tests.map((t: { name: string; limit: string; passed: boolean }) => [t.name, t.limit, t.passed])).toEqual([
      ['Assay (HPLC)', '98 – 102 %', true], ['Water (KF)', '≤ 0.5 %', true], ['Identification (IR)', 'Complies with reference', true],
    ]);

    const res = await approve('qcm', m.lotId);
    expect([res.status, res.body.error]).toEqual([200, undefined]);
    expect(res.body).toMatchObject({ lotStatus: 'APPROVED', assayPct: '99.1235', waterPct: '0.2000', sampleStatus: 'CLOSED', canApprove: false, canReject: false });
    expect(res.body.history).toMatchObject([{ fromStatus: 'UNDER_TEST', decision: 'APPROVED', assayPct: '99.1235', waterPct: '0.2000', reason: 'Results meet the specification', decidedBy: users.qcm }]);
    expect(await lotRow(m.lotId)).toMatchObject({ status: 'APPROVED', assay: '99.1235', water: '0.2000' });
    expect(await requestStatus(m.requestId)).toBe('CLOSED');
    const { rows: h } = await client.query(
      `SELECT h.from_status, h.to_status, h.actor_id, s.meaning, s.record_table, s.record_id FROM core.status_history h JOIN core.e_signatures s ON s.id = h.esign_id
        WHERE h.entity_table = 'inv.lots' AND h.entity_id = $1 AND h.to_status = 'APPROVED'`, [m.lotId],
    );
    expect(h).toEqual([{ from_status: 'UNDER_TEST', to_status: 'APPROVED', actor_id: users.qcm, meaning: 'APPROVED', record_table: 'inv.lots', record_id: m.lotId }]);
    expect(await tryIssue(m.lotId)).toBe('OK');
    // Decided once: no second decision, no more results.
    expect((await approve('qcm', m.lotId)).body.error.code).toBe('INVALID_TRANSITION');
    expect((await call('analyst', 'post', `/qc/samples/${m.requestId}/results`, results(m, { assay: '99' }))).body.error.code).toBe('INVALID_TRANSITION');
  });

  it('refuses until every test has a reviewed, passing latest result (QC_RESULTS_NOT_REVIEWED / _INCOMPLETE / QC_TEST_FAILED)', async () => {
    const m = await sampledLot({ itemId: ids.api! });
    await enter(m, { assay: '100', water: '0.1' });
    const notReviewed = await approve('qcm', m.lotId);
    expect([notReviewed.status, notReviewed.body.error.code]).toEqual([422, 'QC_RESULTS_NOT_REVIEWED']);
    await review(m);
    const incomplete = await approve('qcm', m.lotId);
    expect([incomplete.status, incomplete.body.error.code, incomplete.body.error.details.tests]).toEqual([422, 'QC_RESULTS_INCOMPLETE', ['Identification (IR)']]);
    const queue = (await call('qcm', 'get', `/qc/lots/${m.lotId}`)).body;
    expect(queue).toMatchObject({ canApprove: false, canReject: true, rejectNeedsCategory: true, missingCount: 1 });
    expect(queue.blockers.join(' ')).toContain('Identification (IR)');

    const f = await testedLot({ assay: '97.5', water: '0.1', complies: true });
    // Owner 2026-11-27 (0040): the reviewed failure opened an OOS investigation, which blocks the approval first.
    const failed = await approve('qcm', f.lotId);
    expect([failed.status, failed.body.error.code, failed.body.error.details.oos]).toEqual([422, 'OOS_OPEN', [expect.stringMatching(/^OOS-\d{4}-\d{5}$/)]]);
    expect((await lotRow(f.lotId)).status).toBe('UNDER_TEST');
  });

  it('refuses without the key (analyst, QA Manager, CEO), with the wrong meaning or password, and for the analyst of the results', async () => {
    const m = await testedLot({ assay: '100', water: '0.1', complies: true });
    for (const who of ['analyst', 'qa', 'ceo']) {
      const res = await approve(who, m.lotId);
      expect([who, res.status, res.body.error.code]).toEqual([who, 403, 'FORBIDDEN']);
    }
    const meaning = await approve('qcm', m.lotId, {}, 'REVIEWED');
    expect([meaning.status, meaning.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const pwd = await call('qcm', 'post', `/qc/lots/${m.lotId}/approve`, sig('APPROVED', 'Results meet the specification', 'wrong-password'));
    expect(pwd.body.error.code).toBe('ESIGN_FAILED');
    const noReason = await call('qcm', 'post', `/qc/lots/${m.lotId}/approve`, { signature: { password: TEST_PASSWORD, meaning: 'APPROVED', reason: '' } });
    expect(noReason.status).toBe(400);

    // A user holding both QC roles who entered the results does not decide the lot (rule 9).
    const own = await sampledLot({ itemId: ids.api! });
    await enter(own, { assay: '100', water: '0.1', complies: true }, 'both');
    await review(own, 'qcm');
    const sod = await approve('both', own.lotId);
    expect([sod.status, sod.body.error.code]).toEqual([403, 'SEGREGATION_OF_DUTIES']);
    expect((await approve('qcm2', own.lotId)).status).toBe(200);
    expect((await lotRow(m.lotId)).status).toBe('UNDER_TEST');
  });

  it('expiry and retest: an expired lot is not approved; a reached retest date needs the next one (after today, not after expiry)', async () => {
    const expired = await testedLot({ assay: '100', water: '0.1', complies: true }, { expiryDate: TODAY });
    expect((await approve('qcm', expired.lotId)).body.error.code).toBe('LOT_EXPIRED');

    const expiry = addDays(TODAY, 400);
    const due = await testedLot({ assay: '100', water: '0.1', complies: true }, { expiryDate: expiry, retestDate: TODAY });
    expect((await call('qcm', 'get', `/qc/lots/${due.lotId}`)).body).toMatchObject({ canApprove: true, retestDateRequired: true });
    const none = await approve('qcm', due.lotId);
    expect([none.status, none.body.error.code]).toEqual([422, 'LOT_RETEST_DUE']);
    expect((await approve('qcm', due.lotId, { retestDate: TODAY })).body.error.details.field).toBe('retestDate');
    expect((await approve('qcm', due.lotId, { retestDate: addDays(expiry, 1) })).body.error.details.field).toBe('retestDate');
    const next = addDays(TODAY, 180);
    const ok = await approve('qcm', due.lotId, { retestDate: next });
    expect([ok.status, ok.body.error]).toEqual([200, undefined]);
    expect(await lotRow(due.lotId)).toMatchObject({ status: 'APPROVED', retest: next });
    expect(ok.body.history[0].retestDate).toBe(next);
  });
});

describe('rejection (UNDER_TEST / material HOLD → REJECTED)', () => {
  it('rejects on a reviewed failed result; the lot then moves only by destroy / return; a passing lot is not rejected', async () => {
    const m = await testedLot({ assay: '96', water: '0.1', complies: true });
    expect((await call('qcm', 'get', `/qc/lots/${m.lotId}`)).body).toMatchObject({ canApprove: false, canReject: true, failedCount: 1 });
    const res = await reject('qcm', m.lotId);
    expect([res.status, res.body.error]).toEqual([200, undefined]);
    expect(res.body).toMatchObject({ lotStatus: 'REJECTED', sampleStatus: 'CLOSED', assayPct: null });
    expect(res.body.history).toMatchObject([{ fromStatus: 'UNDER_TEST', decision: 'REJECTED', reason: 'Assay out of limits', assayPct: null }]);
    expect(await tryIssue(m.lotId)).toBe('LOT_NOT_APPROVED');
    expect((await approve('qcm', m.lotId)).body.error.code).toBe('INVALID_TRANSITION');

    const pass = await testedLot({ assay: '100', water: '0.1', complies: true });
    const refused = await reject('qcm', pass.lotId);
    expect([refused.status, refused.body.error.code]).toEqual([422, 'QC_REJECT_CATEGORY_REQUIRED']);
    expect((await reject('qcm', pass.lotId, 'APPROVED')).body.error.code).toBe('VALIDATION_FAILED');
    expect((await reject('analyst', pass.lotId, 'REJECTED', damaged)).status).toBe(403);
  });

  it('a material lot QA put on HOLD: QC may reject it but not approve it (only QA lifts a hold)', async () => {
    const m = await testedLot({ assay: '100', water: '0.1', complies: true });
    expect((await approve('qcm', m.lotId)).status).toBe(200);
    await withTransaction({ userId: users.qa!, companyId: '1' }, (tx) => transition(tx, QaHold, { entityId: m.lotId, to: 'HOLD', actor: actors.qa!, reason: 'Customer complaint on a sister lot' }));
    const queue = await call('qcm', 'get', '/qc/lots?status=HOLD');
    expect(queue.body.items.find((x: { lotId: string }) => x.lotId === m.lotId)).toMatchObject({ lotStatus: 'HOLD', canApprove: false, canReject: true, rejectNeedsCategory: true });
    const app2 = await approve('qcm', m.lotId);
    expect([app2.status, app2.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);
    expect((await reject('qcm', m.lotId)).body.error.code).toBe('QC_REJECT_CATEGORY_REQUIRED');
    const res = await reject('qcm', m.lotId, 'REJECTED', { category: 'VENDOR_ISSUE', description: 'Vendor recalled this batch of the API' });
    expect([res.status, res.body.error]).toEqual([200, undefined]);
    expect(res.body.history.map((d: { fromStatus: string; decision: string; sampleRequestId: string | null }) => [d.fromStatus, d.decision, d.sampleRequestId])).toEqual([
      ['UNDER_TEST', 'APPROVED', m.requestId], ['HOLD', 'REJECTED', null],
    ]);
  });
});

describe('rejection without a failed test (owner 2026-11-27; 0038)', () => {
  it('a lot whose results all passed is rejected with a reason category and a description; the analyst still does not decide', async () => {
    const m = await testedLot({ assay: '100', water: '0.1', complies: true });
    expect((await call('qcm', 'get', `/qc/lots/${m.lotId}`)).body).toMatchObject({ canApprove: true, canReject: true, rejectNeedsCategory: true });
    const noDesc = await reject('qcm', m.lotId, 'REJECTED', { category: 'CONTAMINATION' });
    expect([noDesc.status, noDesc.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    const shortDesc = await reject('qcm', m.lotId, 'REJECTED', { category: 'CONTAMINATION', description: 'dirty' });
    expect(shortDesc.status).toBe(400);
    const badCat = await reject('qcm', m.lotId, 'REJECTED', { category: 'WEATHER', description: 'It rained on the drums' });
    expect(badCat.status).toBe(400);
    const res = await reject('qcm', m.lotId, 'REJECTED', { category: 'CONTAMINATION', description: 'Black specks seen in drum 3 at sampling' });
    expect([res.status, res.body.error]).toEqual([200, undefined]);
    expect(res.body).toMatchObject({ lotStatus: 'REJECTED', sampleStatus: 'CLOSED' });
    expect(res.body.history).toMatchObject([
      { fromStatus: 'UNDER_TEST', decision: 'REJECTED', rejectCategory: 'CONTAMINATION', rejectDescription: 'Black specks seen in drum 3 at sampling' },
    ]);
    expect(await tryIssue(m.lotId)).toBe('LOT_NOT_APPROVED');

    // Same segregation: the user who entered results does not reject; unreviewed results are reviewed first.
    const own = await sampledLot({ itemId: ids.api! });
    await enter(own, { assay: '100' }, 'both');
    expect((await reject('qcm', own.lotId, 'REJECTED', damaged)).body.error.code).toBe('QC_RESULTS_NOT_REVIEWED');
    await review(own, 'qcm');
    const sod = await reject('both', own.lotId, 'REJECTED', damaged);
    expect([sod.status, sod.body.error.code]).toEqual([403, 'SEGREGATION_OF_DUTIES']);
    expect((await reject('qcm2', own.lotId, 'REJECTED', damaged)).status).toBe(200);

    // A failed result supports the rejection: the category is optional.
    const f = await testedLot({ assay: '96', water: '0.1', complies: true });
    expect((await call('qcm', 'get', `/qc/lots/${f.lotId}`)).body.rejectNeedsCategory).toBe(false);
    const both = await reject('qcm', f.lotId, 'REJECTED', { category: 'COA_MISMATCH', description: 'Assay differs from the vendor CoA by 3 %' });
    expect([both.status, both.body.history[0].rejectCategory]).toEqual([200, 'COA_MISMATCH']);
  });

  it('a quarantined lot (not sampled) is rejected before sampling: its OPEN request is CANCELLED; nobody else may do it', async () => {
    const m = await lotWithRequest({ itemId: ids.api! });
    const queue = await call('qcm', 'get', '/qc/lots?status=QUARANTINE');
    expect(queue.body.items.find((x: { lotId: string }) => x.lotId === m.lotId)).toMatchObject({ lotStatus: 'QUARANTINE', sampleStatus: 'OPEN', canApprove: false, canReject: true, rejectNeedsCategory: true });
    expect((await approve('qcm', m.lotId)).body.error.code).toBe('INVALID_TRANSITION');
    expect((await reject('qcm', m.lotId)).body.error.code).toBe('QC_REJECT_CATEGORY_REQUIRED');
    for (const who of ['analyst', 'qa', 'wm', 'ceo']) {
      const res = await reject(who, m.lotId, 'REJECTED', damaged);
      expect([who, res.status, res.body.error.code]).toEqual([who, 403, 'FORBIDDEN']);
    }
    const res = await reject('qcm', m.lotId, 'REJECTED', { category: 'SEAL_BROKEN', description: 'Tamper seal broken on all containers' });
    expect([res.status, res.body.error]).toEqual([200, undefined]);
    expect(res.body).toMatchObject({ lotStatus: 'REJECTED', sampleStatus: 'CANCELLED' });
    expect(res.body.history).toMatchObject([{ fromStatus: 'QUARANTINE', decision: 'REJECTED', rejectCategory: 'SEAL_BROKEN', sampleRequestId: m.requestId }]);
    expect(await requestStatus(m.requestId)).toBe('CANCELLED');
    // The request cannot be sampled any more.
    expect((await take('analyst', m.requestId, { locationId: ids.loc1, testQty: '1' })).body.error.code).toBe('INVALID_TRANSITION');

    // FG lots in quarantine are QA's too.
    const fg = await lotWithRequest({ itemId: ids.fg!, fg: true });
    expect((await reject('qcm', fg.lotId, 'REJECTED', damaged)).body.error.code).toBe('FG_LOT_QA_DECIDES');
  });
});

describe('finished goods are QA\'s decision (build-plan M4)', () => {
  it('refuses FG_LOT_QA_DECIDES to approve a passing FG lot or reject one on HOLD after a failure; FG lots are not in the queue', async () => {
    const pass = await sampledLot({ itemId: ids.fg!, fg: true });
    await enter(pass, { assay: '100', water: '0.1', complies: true });
    await review(pass);
    const a = await approve('qcm', pass.lotId);
    expect([a.status, a.body.error.code]).toEqual([422, 'FG_LOT_QA_DECIDES']);

    const fail = await sampledLot({ itemId: ids.fg!, fg: true });
    await enter(fail, { assay: '90' });
    await review(fail);
    expect((await lotRow(fail.lotId)).status).toBe('HOLD');
    expect((await reject('qcm', fail.lotId, 'REJECTED', damaged)).body.error.code).toBe('FG_LOT_QA_DECIDES');
    const queue = await call('qcm', 'get', '/qc/lots?pageSize=200');
    expect(queue.body.items.map((x: { lotId: string }) => x.lotId)).not.toContain(pass.lotId);
    expect(queue.body.items.map((x: { lotId: string }) => x.lotId)).not.toContain(fail.lotId);
  });
});

describe('database guards (0037, 0038)', () => {
  it('no lot decision, assay, water or retest change without a disposition; dispositions are insert-only; a request closes only with one', async () => {
    const m = await testedLot({ assay: '100', water: '0.1', complies: true });
    // A raw approval with a status_history row but no disposition.
    await expect(inTx(users.qcm!, async () => {
      await history('inv.lots', m.lotId, 'UNDER_TEST', 'APPROVED', users.qcm!);
      await client.query(`UPDATE inv.lots SET status = 'APPROVED' WHERE id = $1`, [m.lotId]);
    })).rejects.toThrow(/only with a QC Manager disposition/);
    await expect(inTx(users.qcm!, () => client.query(`UPDATE inv.lots SET assay_pct = 99 WHERE id = $1`, [m.lotId]))).rejects.toThrow(/RECORD_LOCKED/);
    await expect(inTx(users.qcm!, () => client.query(`UPDATE inv.lots SET retest_date = '2098-01-01' WHERE id = $1`, [m.lotId]))).rejects.toThrow(/RECORD_LOCKED/);
    await expect(inTx(users.qcm!, async () => {
      await history('qc.sample_requests', m.requestId, 'SAMPLED', 'CLOSED', users.qcm!);
      await client.query(`UPDATE qc.sample_requests SET status = 'CLOSED' WHERE id = $1`, [m.requestId]);
    })).rejects.toThrow(/closed by the QC Manager's disposition/);
    // A disposition without the decider's own signature on the lot.
    await expect(inTx(users.qcm!, () => client.query(
      `INSERT INTO qc.dispositions (lot_id, sample_request_id, from_status, decision, assay_pct, water_pct, reason, esign_id)
       VALUES ($1, $2, 'UNDER_TEST', 'APPROVED', 100, 0.1, 'Looks fine', (SELECT max(id) FROM core.e_signatures))`, [m.lotId, m.requestId],
    ))).rejects.toThrow(/ESIGN_FAILED/);
    // An analyst (no qc.lot.change_status) cannot write one at all.
    await expect(inTx(users.analyst!, () => client.query(
      `INSERT INTO qc.dispositions (lot_id, sample_request_id, from_status, decision, reason, esign_id)
       VALUES ($1, $2, 'UNDER_TEST', 'REJECTED', 'Looks bad', (SELECT max(id) FROM core.e_signatures))`, [m.lotId, m.requestId],
    ))).rejects.toThrow(/FORBIDDEN/);

    // 0038: a rejection with no failed result needs the category (the signature here is valid, so only the category fails).
    await expect(inTx(users.qcm!, async () => {
      const esign = await one(
        `INSERT INTO core.e_signatures (user_id, signer_username, signer_name, meaning, reason, record_table, record_id)
         VALUES ($1, 'dsp_qcm', 'QC Manager', 'REJECTED', 'Bad drums', 'inv.lots', $2) RETURNING id`, [users.qcm, m.lotId],
      );
      await client.query(
        `INSERT INTO qc.dispositions (lot_id, sample_request_id, from_status, decision, reason, esign_id) VALUES ($1, $2, 'UNDER_TEST', 'REJECTED', 'Bad drums', $3)`,
        [m.lotId, m.requestId, esign],
      );
    })).rejects.toThrow(/QC_REJECT_CATEGORY_REQUIRED/);
    // A category on an approval is refused by the table.
    await expect(inTx('1', () => client.query(
      `INSERT INTO qc.dispositions (lot_id, sample_request_id, from_status, decision, reason, reject_category, esign_id)
       VALUES ($1, $2, 'UNDER_TEST', 'APPROVED', 'x x x', 'OTHER', 1)`, [m.lotId, m.requestId],
    ))).rejects.toThrow();
    // QUARANTINE → REJECTED and an OPEN request's cancellation need the disposition.
    const q = await lotWithRequest({ itemId: ids.api! });
    await expect(inTx(users.qcm!, async () => {
      await history('inv.lots', q.lotId, 'QUARANTINE', 'REJECTED', users.qcm!);
      await client.query(`UPDATE inv.lots SET status = 'REJECTED' WHERE id = $1`, [q.lotId]);
    })).rejects.toThrow(/only with a QC Manager disposition/);
    await expect(inTx(users.qcm!, async () => {
      await history('qc.sample_requests', q.requestId, 'OPEN', 'CANCELLED', users.qcm!);
      await client.query(`UPDATE qc.sample_requests SET status = 'CANCELLED' WHERE id = $1`, [q.requestId]);
    })).rejects.toThrow(/reversing its GRN or rejecting its lot/);

    expect((await approve('qcm', m.lotId)).status).toBe(200);
    await expect(inTx('1', () => client.query(`UPDATE qc.dispositions SET reason = 'changed' WHERE lot_id = $1`, [m.lotId]))).rejects.toThrow(/APPEND_ONLY/);
    await expect(inTx('1', () => client.query(`DELETE FROM qc.dispositions WHERE lot_id = $1`, [m.lotId]))).rejects.toThrow();
  });
});
