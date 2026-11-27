// M4 task 4b (owner 2026-11-27; 0040): OOS investigations (opened by the review of a failed result; closed by the QC
// Manager with an e-signature as INVALIDATED or CONFIRMED; no re-test or approval while open), the CoA header from
// settings, and CoA correction as a new version. Happy paths and every refusal through the HTTP endpoints, plus the
// database guards.
import { inflateSync } from 'node:zlib';
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
import { LotStatus } from '@albert/shared';
import { createLot, fgUnitCost, postMovement } from '../../../engines/inventory';
import { createTestUser, TEST_PASSWORD } from '../../../test/factories';
import { requestSample, type SampleRequestSource } from '../sample-requests.service';

const app = createApp();
/** QA places a hold (APPROVED → HOLD, qa.lot.hold); the QA module itself is M7. */
const QaHold = defineTransitions<LotStatus>({
  entityTable: 'inv.lots',
  statuses: LotStatus,
  moves: [{ from: 'APPROVED', to: 'HOLD', permission: 'qa.lot.hold', reasonRequired: true }],
});
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
  request(app).post(`/api/v1/qc/samples/${id}/take`).set('Authorization', `Bearer ${tokens[who]}`).set('Idempotency-Key', `qc-oos-${Date.now()}-${++idem}`).send(body);
const sig = (meaning: string, reason = 'Investigation complete', password = TEST_PASSWORD) => ({ signature: { password, meaning, reason } });
const approve = (who: string, lotId: string) => call(who, 'post', `/qc/lots/${lotId}/approve`, sig('APPROVED', 'Results meet the specification'));
const reject = (who: string, lotId: string, extra: object = {}) => call(who, 'post', `/qc/lots/${lotId}/reject`, { ...sig('REJECTED', 'Lot fails the specification'), ...extra });
const retest = (who: string, requestId: string, resultId: string, value: string) =>
  call(who, 'post', `/qc/samples/${requestId}/results/${resultId}/retest`, { numericValue: value, reason: 'Re-test after the OOS investigation' });
const invalidate = { outcome: 'INVALIDATED', causeCategory: 'LAB_ERROR', causeDescription: 'Wrong standard weight used in the calculation of the first run' };
const close = (who: string, oosId: string, body: object = invalidate, meaning = 'APPROVED', password = TEST_PASSWORD) =>
  call(who, 'post', `/qc/oos/${oosId}/close`, { ...body, ...sig(meaning, 'Investigation complete', password) });

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
  client.query(`INSERT INTO core.status_history (entity_table, entity_id, from_status, to_status, actor_id) VALUES ($1, $2, $3, $4, $5)`, [table, id, from, to, actor]);
const lotStatus = async (lotId: string) => (await client.query<{ status: string }>(`SELECT status FROM inv.lots WHERE id = $1`, [lotId])).rows[0]!.status;
const esign = (userId: string, username: string, meaning: string, reason: string, table: string, recordId: string) =>
  one(
    `INSERT INTO core.e_signatures (user_id, signer_username, signer_name, meaning, reason, record_table, record_id) VALUES ($1, $2, 'Signer', $3, $4, $5, $6) RETURNING id`,
    [userId, username, meaning, reason, table, recordId],
  );

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

const assayTest = { name: 'Assay (HPLC)', method: 'BP 2024', resultType: 'NUMERIC', minValue: '98.0', maxValue: '102.0', unit: '%', isAssay: true };
const identTest = { name: 'Identification (IR)', resultType: 'TEXT', textLimit: 'Complies with reference' };

async function approveSpec(itemId: string): Promise<void> {
  const created = await call('analyst', 'post', '/qc/specs', { itemId });
  await call('analyst', 'put', `/qc/specs/${created.body.id}/tests`, { tests: [assayTest, identTest] });
  await call('analyst', 'post', `/qc/specs/${created.body.id}/submit`);
  const ok = await call('qcm', 'post', `/qc/specs/${created.body.id}/approve`, sig('APPROVED', 'Checked against BP'));
  expect([created.status, ok.status, ok.body.error]).toEqual([201, 200, undefined]);
}

interface Made { lotId: string; requestId: string; tests: Record<string, string> }

async function sampledLot(o: { fg?: boolean } = {}): Promise<Made> {
  const who = o.fg ? 'sup' : 'store';
  const source: SampleRequestSource = o.fg ? 'PRODUCTION_OUTPUT' : 'GRN';
  const made = await withTransaction({ userId: actors[who]!.userId, companyId: '1' }, async (tx) => {
    const a = actors[who]!;
    const lot = await createLot(tx, a, {
      source, itemId: o.fg ? ids.fg! : ids.api!, lotNo: `OOS-T-${++seq}`, unitCost: o.fg ? fgUnitCost('500.00', '100') : '10.00', expiryDate: '2099-12-31',
      ...(o.fg ? {} : { mfrBatchNo: `MB-${seq}`, manufacturer: 'Acme Fine Chemicals' }),
    });
    await postMovement(tx, a, {
      type: o.fg ? 'OUTPUT' : 'RECEIPT', lotId: lot.id, locationId: ids.loc1!, qty: '100', date: TODAY, refDocType: o.fg ? 'PROD_ORDER' : 'GRN', refDocId: String(seq),
      ...(o.fg ? { value: '500.00' } : {}),
    });
    const req = await requestSample(tx, a, { lotId: lot.id, source, refDocId: String(seq) });
    return { lotId: lot.id, requestId: req.id };
  });
  const res = await take('analyst', made.requestId, { locationId: ids.loc1, testQty: '1' });
  expect([res.status, res.body.error]).toEqual([200, undefined]);
  return { ...made, tests: Object.fromEntries((res.body.tests as { id: string; name: string }[]).map((t) => [t.name, t.id])) };
}

interface ResultRow { id: string; specTestId: string; passed: boolean; oos: { id: string; docNo: string; status: string; outcome: string | null } | null; invalidated: boolean; retestOos: { docNo: string } | null; canRetest: boolean; retestOf: string | null }

async function enter(m: Made, assay: string, who = 'analyst'): Promise<string> {
  const res = await call(who, 'post', `/qc/samples/${m.requestId}/results`, {
    results: [{ specTestId: m.tests['Assay (HPLC)'], numericValue: assay }, { specTestId: m.tests['Identification (IR)'], textValue: 'IR matches', complies: true }],
  });
  expect([res.status, res.body.error]).toEqual([200, undefined]);
  return (res.body.results as ResultRow[]).find((r) => r.specTestId === m.tests['Assay (HPLC)'])!.id;
}
async function review(m: Made, who = 'qcm') {
  const res = await call(who, 'post', `/qc/samples/${m.requestId}/review`, sig('REVIEWED', 'Raw data checked'));
  expect([res.status, res.body.error]).toEqual([200, undefined]);
  return res.body.results as ResultRow[];
}
const resultsOf = async (m: Made) => (await call('qcm', 'get', `/qc/samples/${m.requestId}`)).body.results as ResultRow[];

/** A material lot with a failed, reviewed assay: its OOS investigation is OPEN. */
async function failedLot(o: { fg?: boolean; analyst?: string } = {}): Promise<Made & { failedId: string; oosId: string }> {
  const m = await sampledLot(o);
  const failedId = await enter(m, '96.5', o.analyst);
  const rows = await review(m);
  const oos = rows.find((r) => r.id === failedId)!.oos!;
  return { ...m, failedId, oosId: oos.id };
}

/** Text of every page of a PDF (pdfkit, compressed content streams, standard fonts as hex strings). */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const parts: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = raw.indexOf('endstream', start);
    try {
      parts.push(inflateSync(pdf.subarray(start, end)).toString('latin1'));
    } catch {
      // not a Flate stream (fonts, images)
    }
  }
  return parts
    .join('\n')
    .split(/\]\s*TJ/)
    .map((chunk) => [...chunk.matchAll(/<([0-9a-fA-F]+)>/g)].map((h) => Buffer.from(h[1]!, 'hex').toString('latin1')).join(''))
    .join('') // pdfkit writes one TJ per word, the space inside the word's string
    .replace(/\s+/g, ' ');
}
async function pdfOf(who: string, coaId: string): Promise<{ status: number; bytes: Buffer }> {
  const res = await call(who, 'get', `/qc/coas/${coaId}/pdf`).buffer(true).parse((r, cb) => {
    const chunks: Buffer[] = [];
    r.on('data', (c: Buffer) => chunks.push(c));
    r.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  return { status: res.status, bytes: res.body as Buffer };
}

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  for (const [name, roles] of [
    ['analyst', ['QC_ANALYST']],
    ['analyst2', ['QC_ANALYST']],
    ['qcm', ['QC_MANAGER']],
    ['qcm2', ['QC_MANAGER']],
    ['both', ['QC_ANALYST', 'QC_MANAGER']],
    ['store', ['STOREKEEPER']],
    ['sup', ['PRODUCTION_SUPERVISOR']],
    ['wm', ['WAREHOUSE_MANAGER']],
    ['qa', ['QA_MANAGER']],
    ['fm', ['FINANCE_MANAGER']],
    ['ceo', ['CEO']],
    ['admin', ['SYSTEM_ADMIN']],
  ] as const) {
    users[name] = await createTestUser({ username: `oos_${name}`, roleCodes: [...roles] });
    const keys = await withTransaction(systemContext('test'), (tx) => permissionKeysForUser(tx, users[name]!));
    actors[name] = { userId: users[name]!, companyId: '1', permissions: new Set(keys) };
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: `oos_${name}`, password: TEST_PASSWORD });
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
  ids.api = await item('API-OOS', 'API');
  ids.fg = await item('FG-OOS', 'FG');
  await approveSpec(ids.api);
  await approveSpec(ids.fg);
});

afterAll(async () => {
  await client.end();
});

describe('OOS investigation opened by the review of a failed result (0040)', () => {
  it('opens one OPEN investigation per failed reviewed result, linked to result, sample, lot and test; passing results open none', async () => {
    const m = await sampledLot();
    const failedId = await enter(m, '96.5');
    // Before review: no investigation, and the failure cannot be re-tested yet.
    expect((await resultsOf(m)).find((r) => r.id === failedId)).toMatchObject({ oos: null, canRetest: false });
    const early = await retest('analyst', m.requestId, failedId, '99.5');
    expect([early.status, early.body.error.code]).toEqual([422, 'OOS_REQUIRED']);

    const rows = await review(m);
    expect(rows.filter((r) => r.oos !== null).map((r) => r.id)).toEqual([failedId]);
    const ref = rows.find((r) => r.id === failedId)!.oos!;
    expect(ref).toMatchObject({ status: 'OPEN', outcome: null });
    expect(ref.docNo).toMatch(/^OOS-\d{4}-\d{5}$/);

    const dto = (await call('analyst', 'get', `/qc/oos/${ref.id}`)).body;
    expect(dto).toMatchObject({
      resultId: failedId, sampleRequestId: m.requestId, lotId: m.lotId, specTestId: m.tests['Assay (HPLC)'], testName: 'Assay (HPLC)',
      resultValue: '96.500000', enteredBy: users.analyst, openedBy: users.qcm, status: 'OPEN', canClose: false, limit: '98 – 102 %',
    });
    expect((await call('qcm', 'get', `/qc/oos/${ref.id}`)).body.canClose).toBe(true);
    const { rows: h } = await client.query(`SELECT from_status, to_status, actor_id FROM core.status_history WHERE entity_table = 'qc.oos_investigations' AND entity_id = $1`, [ref.id]);
    expect(h).toEqual([{ from_status: null, to_status: 'OPEN', actor_id: users.qcm }]);

    const list = (await call('qcm', 'get', `/qc/oos?status=OPEN&search=${ref.docNo}`)).body;
    expect(list.items.map((o: { id: string }) => o.id)).toEqual([ref.id]);
    expect((await call('qcm', 'get', `/qc/oos?lotId=${m.lotId}`)).body.total).toBe(1);
    expect((await call('store', 'get', `/qc/oos`)).status).toBe(403);
  });

  it('while OPEN: no re-test of that result and no approval of the lot; rejection is allowed and the investigation can still be closed', async () => {
    const f = await failedLot();
    const r = await retest('analyst', f.requestId, f.failedId, '99.5');
    expect([r.status, r.body.error.code]).toEqual([422, 'OOS_OPEN']);
    const a = await approve('qcm', f.lotId);
    expect([a.status, a.body.error.code]).toEqual([422, 'OOS_OPEN']);
    const queue = (await call('qcm', 'get', `/qc/lots/${f.lotId}`)).body;
    expect(queue).toMatchObject({ canApprove: false, canReject: true, rejectNeedsCategory: false });
    const rej = await reject('qcm', f.lotId);
    expect([rej.status, rej.body.error, await lotStatus(f.lotId)]).toEqual([200, undefined, 'REJECTED']);
    const c = await close('qcm', f.oosId, { outcome: 'CONFIRMED', causeDescription: 'No laboratory error found; material is out of specification' });
    expect([c.status, c.body.status, c.body.outcome]).toEqual([200, 'CLOSED', 'CONFIRMED']);
  });
});

describe('closing an OOS investigation (0040)', () => {
  it('refuses without the key, by the analyst of the failed result, with a wrong signature, without the cause, and twice', async () => {
    const f = await failedLot({ analyst: 'both' });
    for (const who of ['analyst', 'qa', 'ceo', 'admin']) {
      expect([who, (await close(who, f.oosId)).status]).toEqual([who, 403]);
    }
    const own = await close('both', f.oosId);
    expect([own.status, own.body.error.code]).toEqual([403, 'SEGREGATION_OF_DUTIES']);
    expect((await call('both', 'get', `/qc/oos/${f.oosId}`)).body.canClose).toBe(false);
    expect((await close('qcm', f.oosId, invalidate, 'REVIEWED')).body.error.code).toBe('VALIDATION_FAILED');
    expect((await close('qcm', f.oosId, invalidate, 'APPROVED', 'wrong-password')).body.error.code).toBe('ESIGN_FAILED');
    expect((await close('qcm', f.oosId, { outcome: 'INVALIDATED' })).status).toBe(400);
    expect((await close('qcm', f.oosId, { outcome: 'INVALIDATED', causeCategory: 'LAB_ERROR' })).status).toBe(400);
    expect((await close('qcm', f.oosId, { outcome: 'INVALIDATED', causeCategory: 'GUESS', causeDescription: 'Not a known category at all' })).status).toBe(400);
    expect((await close('qcm', f.oosId, { outcome: 'CONFIRMED', causeCategory: 'LAB_ERROR' })).status).toBe(400);
    expect((await call('qcm', 'get', `/qc/oos/${f.oosId}`)).body.status).toBe('OPEN');

    const ok = await close('qcm2', f.oosId);
    expect([ok.status, ok.body.error]).toEqual([200, undefined]);
    expect(ok.body).toMatchObject({ status: 'CLOSED', outcome: 'INVALIDATED', causeCategory: 'LAB_ERROR', conclusion: 'Investigation complete', closedBy: users.qcm2, canClose: false });
    const { rows: s } = await client.query(
      `SELECT s.meaning, s.record_table, s.record_id, s.user_id FROM qc.oos_investigations o JOIN core.e_signatures s ON s.id = o.close_esign_id WHERE o.id = $1`, [f.oosId],
    );
    expect(s).toEqual([{ meaning: 'APPROVED', record_table: 'qc.oos_investigations', record_id: f.oosId, user_id: users.qcm2 }]);
    const again = await close('qcm', f.oosId, { outcome: 'CONFIRMED' });
    expect([again.status, again.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);
    expect((await call('qcm', 'get', '/qc/oos/999999')).status).toBe(404);
  });

  it('INVALIDATED: the original is marked invalidated (never changed), approval needs the re-test, the failure no longer supports a rejection; the re-test decides the lot and the CoA prints the OOS', async () => {
    const f = await failedLot();
    const before = (await client.query(`SELECT numeric_value::text, passed, updated_at FROM qc.results WHERE id = $1`, [f.failedId])).rows[0];
    expect((await close('qcm', f.oosId)).status).toBe(200);
    expect((await client.query(`SELECT numeric_value::text, passed, updated_at FROM qc.results WHERE id = $1`, [f.failedId])).rows[0]).toEqual(before);
    expect((await resultsOf(f)).find((r) => r.id === f.failedId)).toMatchObject({ invalidated: true, canRetest: true, oos: { status: 'CLOSED', outcome: 'INVALIDATED' } });

    const a = await approve('qcm', f.lotId);
    expect([a.status, a.body.error.code]).toEqual([422, 'QC_RETEST_REQUIRED']);
    expect((await reject('qcm', f.lotId)).body.error.code).toBe('QC_REJECT_CATEGORY_REQUIRED');

    const r = await retest('analyst2', f.requestId, f.failedId, '99.6');
    expect([r.status, r.body.error]).toEqual([200, undefined]);
    const rows = r.body.results as ResultRow[];
    const re = rows.find((x) => x.retestOf === f.failedId)!;
    expect(re).toMatchObject({ passed: true, retestOos: { docNo: expect.stringMatching(/^OOS-/) } });
    expect((await call('qcm', 'get', `/qc/oos/${f.oosId}`)).body.retestResultId).toBe(re.id);
    await review(f);
    const ok = await approve('qcm', f.lotId);
    expect([ok.status, ok.body.error, ok.body.assayPct]).toEqual([200, undefined, '99.6000']);

    const coa = await call('qcm', 'post', '/qc/coas', { lotId: f.lotId, ...sig('APPROVED', 'CoA for the customer file') });
    expect(coa.status).toBe(201);
    const oosNo = (await call('qcm', 'get', `/qc/oos/${f.oosId}`)).body.docNo as string;
    const text = pdfText((await pdfOf('qcm', coa.body.id)).bytes);
    expect(text).toContain(`${oosNo} INVALIDATED`);
    expect(text).toContain('LAB_ERROR');
  });

  it('CONFIRMED: the failure stands: no re-test, no approval; a material lot is rejected', async () => {
    const f = await failedLot();
    expect((await close('qcm', f.oosId, { outcome: 'CONFIRMED', causeDescription: 'Lab investigation found no assignable cause' })).status).toBe(200);
    expect((await resultsOf(f)).find((r) => r.id === f.failedId)).toMatchObject({ invalidated: false, canRetest: false });
    const r = await retest('analyst', f.requestId, f.failedId, '99.5');
    expect([r.status, r.body.error.code]).toEqual([422, 'OOS_NOT_INVALIDATED']);
    expect((await approve('qcm', f.lotId)).body.error.code).toBe('QC_TEST_FAILED');
    const rej = await reject('qcm', f.lotId);
    expect([rej.status, await lotStatus(f.lotId)]).toEqual([200, 'REJECTED']);
  });

  it('FG lots use the same flow: on HOLD from the failure; re-test only after INVALIDATED; the lot stays on HOLD for QA', async () => {
    const f = await failedLot({ fg: true });
    expect(await lotStatus(f.lotId)).toBe('HOLD');
    expect((await retest('analyst', f.requestId, f.failedId, '99.5')).body.error.code).toBe('OOS_OPEN');
    expect((await close('qcm', f.oosId)).status).toBe(200);
    const r = await retest('analyst', f.requestId, f.failedId, '99.5');
    expect([r.status, r.body.lotStatus]).toEqual([200, 'HOLD']);

    const g = await failedLot({ fg: true });
    expect((await close('qcm', g.oosId, { outcome: 'CONFIRMED' })).status).toBe(200);
    expect((await retest('analyst', g.requestId, g.failedId, '99.5')).body.error.code).toBe('OOS_NOT_INVALIDATED');
    expect(await lotStatus(g.lotId)).toBe('HOLD');
  });
});

describe('OOS database guards (0040)', () => {
  it('a reviewed failure without its investigation is refused at commit; an investigation needs a failed reviewed result; a closed one never changes', async () => {
    const m = await sampledLot();
    const failedId = await enter(m, '96.5');
    await expect(inTx(users.qcm!, async () => {
      const s = await esign(users.qcm!, 'oos_qcm', 'REVIEWED', 'Raw data checked', 'qc.sample_requests', m.requestId);
      await client.query(`INSERT INTO qc.result_reviews (result_id, esign_id) VALUES ($1, $2)`, [failedId, s]);
    })).rejects.toThrow(/OOS_REQUIRED/);
    // Not reviewed yet: no investigation.
    await expect(inTx(users.qcm!, () => client.query(
      `INSERT INTO qc.oos_investigations (doc_no, result_id, sample_request_id, lot_id, spec_test_id, status) VALUES ('OOS-X-1', $1, $2, $3, $4, 'OPEN')`,
      [failedId, m.requestId, m.lotId, m.tests['Assay (HPLC)']],
    ))).rejects.toThrow(/QC_RESULTS_NOT_REVIEWED/);
    const rows = await review(m);
    const passedId = rows.find((r) => r.passed)!.id;
    await expect(inTx(users.qcm!, () => client.query(
      `INSERT INTO qc.oos_investigations (doc_no, result_id, sample_request_id, lot_id, spec_test_id, status) VALUES ('OOS-X-2', $1, $2, $3, $4, 'OPEN')`,
      [passedId, m.requestId, m.lotId, m.tests['Identification (IR)']],
    ))).rejects.toThrow(/failed result/);
    const oosId = rows.find((r) => r.id === failedId)!.oos!.id;

    // A failed result with an OPEN investigation is not re-tested, even by raw SQL.
    await expect(inTx(users.analyst!, () => client.query(
      `INSERT INTO qc.results (sample_request_id, spec_test_id, result_type, numeric_value, passed, retest_of, retest_reason) VALUES ($1, $2, 'NUMERIC', 99.5, true, $3, 'Raw re-test while open')`,
      [m.requestId, m.tests['Assay (HPLC)'], failedId],
    ))).rejects.toThrow(/OOS_NOT_INVALIDATED/);

    // Closing without the signature, by the analyst, or by a raw status change without history.
    const closeSql = (esignId: string | null, by: string) =>
      client.query(
        `UPDATE qc.oos_investigations SET status = 'CLOSED', outcome = 'CONFIRMED', conclusion = 'Closed by SQL', close_esign_id = $2, closed_by = $3, closed_at = now() WHERE id = $1`,
        [oosId, esignId, by],
      );
    await expect(inTx(users.qcm!, async () => {
      await history('qc.oos_investigations', oosId, 'OPEN', 'CLOSED', users.qcm!);
      await closeSql(await esign(users.qcm!, 'oos_qcm', 'APPROVED', 'Other reason', 'qc.oos_investigations', oosId), users.qcm!);
    })).rejects.toThrow(/ESIGN_FAILED/);
    await expect(inTx(users.analyst!, async () => {
      await history('qc.oos_investigations', oosId, 'OPEN', 'CLOSED', users.analyst!);
      await closeSql(await esign(users.analyst!, 'oos_analyst', 'APPROVED', 'Closed by SQL', 'qc.oos_investigations', oosId), users.analyst!);
    })).rejects.toThrow(/FORBIDDEN/);
    await expect(inTx(users.qcm!, async () => {
      await closeSql(await esign(users.qcm!, 'oos_qcm', 'APPROVED', 'Closed by SQL', 'qc.oos_investigations', oosId), users.qcm!);
    })).rejects.toThrow(/INVALID_TRANSITION/);
    await expect(inTx(users.qcm!, () => client.query(
      `UPDATE qc.oos_investigations SET status = 'CLOSED', outcome = 'INVALIDATED', conclusion = 'x y z', close_esign_id = NULL, closed_by = $2, closed_at = now() WHERE id = $1`,
      [oosId, users.qcm],
    ))).rejects.toThrow(/ESIGN_FAILED/); // the guard runs before the row CHECKs

    expect((await close('qcm', oosId, invalidate)).status).toBe(200);
    await expect(inTx(users.qcm!, () => client.query(`UPDATE qc.oos_investigations SET cause_description = 'Changed afterwards by SQL' WHERE id = $1`, [oosId]))).rejects.toThrow(/RECORD_LOCKED/);
    await expect(inTx('1', () => client.query(`DELETE FROM qc.oos_investigations WHERE id = $1`, [oosId]))).rejects.toThrow();

    // The disposition guard refuses approval while the latest result is the invalidated one.
    await expect(inTx(users.qcm!, async () => {
      const s = await esign(users.qcm!, 'oos_qcm', 'APPROVED', 'Approve by SQL', 'inv.lots', m.lotId);
      await client.query(
        `INSERT INTO qc.dispositions (lot_id, sample_request_id, from_status, decision, assay_pct, reason, esign_id) VALUES ($1, $2, 'UNDER_TEST', 'APPROVED', 96.5, 'Approve by SQL', $3)`,
        [m.lotId, m.requestId, s],
      );
    })).rejects.toThrow(/QC_RETEST_REQUIRED/);
  });

  it('the disposition guard refuses approval while an investigation of the lot is open', async () => {
    const f = await failedLot();
    // A passing re-test cannot exist while open, so the guard first sees the failed latest result; the OOS check
    // stands on its own for an open investigation of an earlier sample (raw check of the rule's SQL).
    await expect(inTx(users.qcm!, async () => {
      const s = await esign(users.qcm!, 'oos_qcm', 'APPROVED', 'Approve by SQL', 'inv.lots', f.lotId);
      await client.query(
        `INSERT INTO qc.dispositions (lot_id, sample_request_id, from_status, decision, assay_pct, reason, esign_id) VALUES ($1, $2, 'UNDER_TEST', 'APPROVED', 96.5, 'Approve by SQL', $3)`,
        [f.lotId, f.requestId, s],
      );
    })).rejects.toThrow(/QC_TEST_FAILED|OOS_OPEN/);
  });
});

describe('certificate of analysis: header from settings and correction as a new version (0040)', () => {
  async function approvedLot(): Promise<Made> {
    const m = await sampledLot();
    await enter(m, '99.8');
    await review(m);
    expect((await approve('qcm', m.lotId)).status).toBe(200);
    return m;
  }
  const issue = (lotId: string) => call('qcm', 'post', '/qc/coas', { lotId, ...sig('APPROVED', 'CoA for the customer file') });
  const reissue = (who: string, id: string, meaning = 'APPROVED', password = TEST_PASSWORD) =>
    call(who, 'post', `/qc/coas/${id}/reissue`, sig(meaning, 'Manufacturer name misspelt on version 1', password));
  const setting = (key: string, value: unknown) => call('admin', 'put', `/core/settings/${key}`, { value, reason: 'CoA header test' });

  it('prints the company name, address and DRAP licence from settings, with the logo when one is set', async () => {
    expect((await setting('company.name', 'Albert Pharmaceuticals (Pvt) Ltd')).status).toBe(200);
    expect((await setting('company.address', 'Plot 1, Industrial Estate, Lahore')).status).toBe(200);
    expect((await setting('company.drap_licence_no', 'DML-000123')).status).toBe(200);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const up = await request(app).post('/api/v1/core/attachments/core.companies/1').set('Authorization', `Bearer ${tokens.admin}`)
      .set('Content-Type', 'image/png').set('X-File-Name', 'logo.png').send(png);
    expect([up.status, up.body.error]).toEqual([201, undefined]);
    expect((await setting('company.logo', up.body.id)).status).toBe(200);
    // QC users cannot upload the logo.
    const qcUp = await request(app).post('/api/v1/core/attachments/core.companies/1').set('Authorization', `Bearer ${tokens.qcm}`)
      .set('Content-Type', 'image/png').set('X-File-Name', 'logo.png').send(png);
    expect(qcUp.status).toBe(403);

    const m = await approvedLot();
    const coa = await issue(m.lotId);
    expect([coa.status, coa.body.error]).toEqual([201, undefined]);
    const pdf = (await pdfOf('qcm', coa.body.id)).bytes;
    const text = pdfText(pdf);
    for (const s of ['Albert Pharmaceuticals (Pvt) Ltd', 'Plot 1, Industrial Estate, Lahore', 'DML-000123']) expect(text).toContain(s);
    expect(pdf.toString('latin1')).toContain('/Subtype /Image');

    // A logo setting that names some other file is refused (nothing issued).
    const other = await approvedLot();
    const pdfAtt = (await client.query<{ id: string }>(`SELECT id FROM core.attachments WHERE record_table = 'qc.coas' LIMIT 1`)).rows[0]!.id;
    expect((await setting('company.logo', pdfAtt)).status).toBe(200);
    const bad = await issue(other.lotId);
    expect([bad.status, bad.body.error.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect((await setting('company.logo', '')).status).toBe(200);
    expect((await issue(other.lotId)).status).toBe(201);
  });

  it('re-issues a certificate as the next version with a reason and e-signature; the old version is SUPERSEDED and still downloadable', async () => {
    const m = await approvedLot();
    const v1 = (await issue(m.lotId)).body;
    expect(v1).toMatchObject({ version: 1, status: 'CURRENT', supersedesId: null, supersededById: null, reissueReason: null });

    const res = await reissue('qcm2', v1.id);
    expect([res.status, res.body.error]).toEqual([201, undefined]);
    const v2 = res.body;
    expect(v2).toMatchObject({ docNo: v1.docNo, version: 2, status: 'CURRENT', supersedesId: v1.id, reissueReason: 'Manufacturer name misspelt on version 1', issuedBy: users.qcm2, fileName: `${v1.docNo}-v2.pdf` });
    expect((await call('analyst', 'get', `/qc/coas/${v1.id}`)).body).toMatchObject({ status: 'SUPERSEDED', supersededById: v2.id });
    const { rows: s } = await client.query(
      `SELECT s.meaning, s.record_table, s.record_id, s.reason FROM qc.coas c JOIN core.e_signatures s ON s.id = c.esign_id WHERE c.id = $1`, [v2.id],
    );
    expect(s).toEqual([{ meaning: 'APPROVED', record_table: 'qc.coas', record_id: v1.id, reason: 'Manufacturer name misspelt on version 1' }]);

    const old = await pdfOf('analyst', v1.id);
    expect([old.status, old.bytes.subarray(0, 5).toString()]).toEqual([200, '%PDF-']);
    const text = pdfText((await pdfOf('analyst', v2.id)).bytes);
    expect(text).toContain('Version 2 supersedes version 1');
    expect(text).toContain('Manufacturer name misspelt on version 1');

    // Version 3 from version 2 is fine; version 1 is no longer current.
    const stale = await reissue('qcm', v1.id);
    expect([stale.status, stale.body.error.code, stale.body.error.details.currentId]).toEqual([409, 'INVALID_TRANSITION', v2.id]);
    expect((await reissue('qcm', v2.id)).body.version).toBe(3);
    expect((await call('qcm', 'get', `/qc/coas?search=${v1.docNo}`)).body.items.map((c: { version: number }) => c.version)).toEqual([3, 2, 1]);
  });

  it('refuses a re-issue without the key, with the wrong meaning or password, of an unknown certificate, and after the lot was decided again', async () => {
    const m = await approvedLot();
    const v1 = (await issue(m.lotId)).body;
    for (const who of ['analyst', 'qa', 'ceo']) expect([who, (await reissue(who, v1.id)).status]).toEqual([who, 403]);
    expect((await reissue('qcm', v1.id, 'REVIEWED')).body.error.code).toBe('VALIDATION_FAILED');
    expect((await reissue('qcm', v1.id, 'APPROVED', 'wrong-password')).body.error.code).toBe('ESIGN_FAILED');
    expect((await reissue('qcm', '999999')).status).toBe(404);
    expect((await call('qcm', 'post', `/qc/coas/${v1.id}/reissue`, { signature: { password: TEST_PASSWORD, meaning: 'APPROVED', reason: 'x' } })).status).toBe(400);

    // QA holds the lot and QC rejects it: a new disposition, so the old certificate is not re-issued.
    const hold = await withTransaction({ userId: users.qa!, companyId: '1' }, (tx) =>
      transition(tx, QaHold, { entityId: m.lotId, to: 'HOLD', actor: actors.qa!, reason: 'Customer complaint' }));
    expect(hold.to).toBe('HOLD');
    expect((await reject('qcm', m.lotId, { category: 'OTHER', description: 'Complaint investigation found the lot unfit' })).status).toBe(200);
    const late = await reissue('qcm', v1.id);
    expect([late.status, late.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);
  });

  it('database guards: a version is the next version of the current certificate, signed on it with the reason', async () => {
    const m = await approvedLot();
    const v1 = (await issue(m.lotId)).body;
    const disp = await one(`SELECT id FROM qc.dispositions WHERE lot_id = $1`, [m.lotId]);
    const insert = (version: number, supersedes: string, reason: string, esignId: string) =>
      client.query(
        `INSERT INTO qc.coas (doc_no, lot_id, disposition_id, sample_request_id, file_name, sha256, esign_id, version, supersedes_id, reissue_reason)
         VALUES ($1, $2, $3, $4, 'x.pdf', $5, $6, $7, $8, $9)`,
        [v1.docNo, m.lotId, disp, m.requestId, 'a'.repeat(64), esignId, version, supersedes, reason],
      );
    await expect(inTx(users.qcm!, async () => insert(3, v1.id, 'Skipping a version', await esign(users.qcm!, 'oos_qcm', 'APPROVED', 'Skipping a version', 'qc.coas', v1.id))))
      .rejects.toThrow(/next version/);
    await expect(inTx(users.qcm!, async () => insert(2, v1.id, 'Signed on the disposition', await esign(users.qcm!, 'oos_qcm', 'APPROVED', 'Signed on the disposition', 'qc.dispositions', disp))))
      .rejects.toThrow(/ESIGN_FAILED/);
    await expect(inTx(users.qcm!, async () => insert(2, v1.id, 'Reason differs', await esign(users.qcm!, 'oos_qcm', 'APPROVED', 'Another reason', 'qc.coas', v1.id))))
      .rejects.toThrow(/ESIGN_FAILED/);
    // A second first issue for the same approval is refused.
    await expect(inTx(users.qcm!, async () => client.query(
      `INSERT INTO qc.coas (doc_no, lot_id, disposition_id, sample_request_id, file_name, sha256, esign_id) VALUES ('COA-X-9', $1, $2, $3, 'x.pdf', $4, $5)`,
      [m.lotId, disp, m.requestId, 'a'.repeat(64), await esign(users.qcm!, 'oos_qcm', 'APPROVED', 'Again', 'qc.dispositions', disp)],
    ))).rejects.toThrow(/coas_one_first_issue_per_disposition_uq/);
    // Superseding a version twice is refused.
    expect((await reissue('qcm', v1.id)).status).toBe(201);
    await expect(inTx(users.qcm!, async () => insert(2, v1.id, 'Second branch', await esign(users.qcm!, 'oos_qcm', 'APPROVED', 'Second branch', 'qc.coas', v1.id))))
      .rejects.toThrow(/coas_supersedes_id_key|coas_doc_no_version_uq/);
  });
});
