// M4 task 4 (0039): re-tests as new rows (the original never edited) and certificates of analysis (one per QC approval
// of a material lot, e-signed, PDF stored with its SHA-256 and re-checked on download). Happy paths and every refusal
// through the HTTP endpoints, plus the database guards.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../../app';
import { databaseUrl, env } from '../../../config/env';
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
const take = (who: string, id: string, body: object) =>
  request(app).post(`/api/v1/qc/samples/${id}/take`).set('Authorization', `Bearer ${tokens[who]}`).set('Idempotency-Key', `qc-rt-${Date.now()}-${++idem}`).send(body);
const sig = (meaning: string, reason = 'Results meet the specification', password = TEST_PASSWORD) => ({ signature: { password, meaning, reason } });
const approve = (who: string, lotId: string) => call(who, 'post', `/qc/lots/${lotId}/approve`, sig('APPROVED'));
const retest = (who: string, requestId: string, resultId: string, body: object) => call(who, 'post', `/qc/samples/${requestId}/results/${resultId}/retest`, body);
const issue = (who: string, lotId: string, meaning = 'APPROVED', password = TEST_PASSWORD) =>
  call(who, 'post', '/qc/coas', { lotId, ...sig(meaning, 'CoA for the customer file', password) });

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

/** A lot (GRN, or FG output) with 100 at loc1, sampled by the analyst (lot UNDER_TEST). */
async function sampledLot(o: { itemId: string; fg?: boolean }): Promise<Made> {
  const who = o.fg ? 'sup' : 'store';
  const source: SampleRequestSource = o.fg ? 'PRODUCTION_OUTPUT' : 'GRN';
  const made = await withTransaction({ userId: actors[who]!.userId, companyId: '1' }, async (tx) => {
    const a = actors[who]!;
    const lot = await createLot(tx, a, {
      source, itemId: o.itemId, lotNo: `RT-${++seq}`, unitCost: o.fg ? fgUnitCost('500.00', '100') : '10.00', expiryDate: '2099-12-31',
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

async function enter(m: Made, assay: string, complies = true) {
  const res = await call('analyst', 'post', `/qc/samples/${m.requestId}/results`, {
    results: [{ specTestId: m.tests['Assay (HPLC)'], numericValue: assay }, { specTestId: m.tests['Identification (IR)'], textValue: 'IR matches', complies }],
  });
  expect([res.status, res.body.error]).toEqual([200, undefined]);
  return res.body.results as { id: string; specTestId: string }[];
}
async function review(m: Made) {
  const res = await call('qcm', 'post', `/qc/samples/${m.requestId}/review`, sig('REVIEWED', 'Raw data checked'));
  expect([res.status, res.body.error]).toEqual([200, undefined]);
}
const assayResult = (rows: { id: string; specTestId: string }[], m: Made) => rows.find((r) => r.specTestId === m.tests['Assay (HPLC)'])!.id;

/** A material lot approved by the QC Manager. */
async function approvedLot(): Promise<Made> {
  const m = await sampledLot({ itemId: ids.api! });
  await enter(m, '99.8');
  await review(m);
  const res = await approve('qcm', m.lotId);
  expect([res.status, res.body.error]).toEqual([200, undefined]);
  return m;
}

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  for (const [name, roles] of [
    ['analyst', ['QC_ANALYST']],
    ['analyst2', ['QC_ANALYST']],
    ['qcm', ['QC_MANAGER']],
    ['store', ['STOREKEEPER']],
    ['sup', ['PRODUCTION_SUPERVISOR']],
    ['wm', ['WAREHOUSE_MANAGER']],
    ['qa', ['QA_MANAGER']],
    ['fm', ['FINANCE_MANAGER']],
    ['ceo', ['CEO']],
  ] as const) {
    users[name] = await createTestUser({ username: `rt_${name}`, roleCodes: [...roles] });
    const keys = await withTransaction(systemContext('test'), (tx) => permissionKeysForUser(tx, users[name]!));
    actors[name] = { userId: users[name]!, companyId: '1', permissions: new Set(keys) };
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: `rt_${name}`, password: TEST_PASSWORD });
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
  ids.api = await item('API-PCM', 'API');
  ids.fg = await item('FG-TAB', 'FG');
  await approveSpec(ids.api);
  await approveSpec(ids.fg);
});

afterAll(async () => {
  await client.end();
});

describe('re-test as a new row (0039)', () => {
  it('a failed assay is re-tested once its OOS investigation invalidated it: the original stays as it was, the re-test is the latest result, reviewed, and the lot is approved on it', async () => {
    const m = await sampledLot({ itemId: ids.api! });
    const firsts = await enter(m, '96.5');
    await review(m);
    const failedId = assayResult(firsts, m);
    const before = (await client.query(`SELECT numeric_value::text, passed, updated_at FROM qc.results WHERE id = $1`, [failedId])).rows[0];
    expect((await approve('qcm', m.lotId)).body.error.code).toBe('OOS_OPEN');
    // Owner 2026-11-27 (0040): the review opened an OOS investigation; it is closed INVALIDATED before the re-test.
    const oosId = await one(`SELECT id FROM qc.oos_investigations WHERE result_id = $1`, [failedId]);
    const closed = await call('qcm', 'post', `/qc/oos/${oosId}/close`, {
      outcome: 'INVALIDATED', causeCategory: 'SAMPLE_PREP', causeDescription: 'Dilution error in the first preparation, confirmed from the raw data',
      ...sig('APPROVED', 'Assignable cause found'),
    });
    expect([closed.status, closed.body.error]).toEqual([200, undefined]);
    expect((await approve('qcm', m.lotId)).body.error.code).toBe('QC_RETEST_REQUIRED');

    const res = await retest('analyst2', m.requestId, failedId, { numericValue: '99.5', reason: 'Lab investigation: dilution error in the first preparation' });
    expect([res.status, res.body.error]).toEqual([200, undefined]);
    const rows = res.body.results as { id: string; numericValue: string; passed: boolean; retestOf: string | null; retestReason: string | null; superseded: boolean }[];
    expect(rows.filter((r) => r.numericValue !== null).map((r) => [r.numericValue, r.passed, r.retestOf, r.superseded])).toEqual([
      ['96.500000', false, null, true],
      ['99.500000', true, failedId, false],
    ]);
    expect(res.body).toMatchObject({ failedCount: 0, unreviewedCount: 1, resultCount: 3 });
    // The original row is untouched.
    expect((await client.query(`SELECT numeric_value::text, passed, updated_at FROM qc.results WHERE id = $1`, [failedId])).rows[0]).toEqual(before);

    // The re-test is reviewed before the lot is decided; then the approval writes the re-test's assay.
    expect((await approve('qcm', m.lotId)).body.error.code).toBe('QC_RESULTS_NOT_REVIEWED');
    await review(m);
    const ok = await approve('qcm', m.lotId);
    expect([ok.status, ok.body.error, ok.body.assayPct]).toEqual([200, undefined, '99.5000']);
  });

  it('refuses a re-test of a result already re-tested, without a reason, of a result on another sample, by the QC Manager, and after the decision', async () => {
    const m = await sampledLot({ itemId: ids.api! });
    // Passing results: re-tested without an OOS investigation (0040 gates only failures).
    const firsts = await enter(m, '98.5');
    const first = assayResult(firsts, m);
    const r1 = await retest('analyst', m.requestId, first, { numericValue: '98.6', reason: 'Repeat injection after system suitability' });
    expect(r1.status).toBe(200);
    const r1Id = (r1.body.results as { id: string; retestOf: string | null }[]).find((r) => r.retestOf === first)!.id;
    const again = await retest('analyst', m.requestId, first, { numericValue: '99', reason: 'Trying the old row again' });
    expect([again.status, again.body.error.code, again.body.error.details.latestResultId]).toEqual([409, 'INVALID_TRANSITION', r1Id]);
    expect((await retest('analyst', m.requestId, r1Id, { numericValue: '99' })).status).toBe(400);
    expect((await retest('analyst', m.requestId, r1Id, { numericValue: '99', reason: 'short' })).status).toBe(400);
    expect((await retest('analyst', m.requestId, r1Id, { textValue: 'x', complies: true, reason: 'Wrong value type given here' })).body.error.code).toBe('VALIDATION_FAILED');
    const textId = firsts.find((r) => r.specTestId === m.tests['Identification (IR)'])!.id;
    expect((await retest('analyst', m.requestId, textId, { textValue: 'IR matches', reason: 'Repeat on a fresh pellet' })).body.error.code).toBe('VALIDATION_FAILED');
    const other = await sampledLot({ itemId: ids.api! });
    expect((await retest('analyst', other.requestId, r1Id, { numericValue: '99', reason: 'Wrong sample on purpose' })).status).toBe(404);
    for (const who of ['qcm', 'qa', 'ceo']) {
      expect([who, (await retest(who, m.requestId, r1Id, { numericValue: '99', reason: 'Not my job to re-test' })).status]).toEqual([who, 403]);
    }

    // Two re-tests chained: the newest row is the latest result.
    const r2 = await retest('analyst', m.requestId, r1Id, { numericValue: '99.1', reason: 'Second repeat, new standard prepared' });
    expect(r2.body).toMatchObject({ failedCount: 0 });
    await review(m);
    expect((await approve('qcm', m.lotId)).body.assayPct).toBe('99.1000');
    const r2Id = (r2.body.results as { id: string; retestOf: string | null }[]).find((r) => r.retestOf === r1Id)!.id;
    const late = await retest('analyst', m.requestId, r2Id, { numericValue: '100', reason: 'After the decision, refused' });
    expect([late.status, late.body.error.code]).toEqual([409, 'INVALID_TRANSITION']);
  });

  it('a failed re-test of a passing result on an FG lot puts the lot on HOLD', async () => {
    const m = await sampledLot({ itemId: ids.fg!, fg: true });
    const firsts = await enter(m, '100');
    expect(await lotStatus(m.lotId)).toBe('UNDER_TEST');
    const res = await retest('analyst', m.requestId, assayResult(firsts, m), { numericValue: '95', reason: 'Repeat for the stability-indicating method' });
    expect([res.status, res.body.lotStatus, res.body.failedCount]).toEqual([200, 'HOLD', 1]);
  });

  it('database guards: results never change; one original per test; each result re-tested once, by the same test of the same sample', async () => {
    const m = await sampledLot({ itemId: ids.api! });
    const firsts = await enter(m, '99');
    const a = assayResult(firsts, m);
    const ident = firsts.find((r) => r.specTestId === m.tests['Identification (IR)'])!.id;
    await expect(inTx(users.analyst!, () => client.query(`UPDATE qc.results SET numeric_value = 100 WHERE id = $1`, [a]))).rejects.toThrow(/APPEND_ONLY/);
    const insert = (testId: string, retestOf: string | null, reason: string | null, value = 99.3) =>
      inTx(users.analyst!, () => client.query(
        `INSERT INTO qc.results (sample_request_id, spec_test_id, result_type, numeric_value, passed, retest_of, retest_reason) VALUES ($1, $2, 'NUMERIC', $3, true, $4, $5)`,
        [m.requestId, testId, value, retestOf, reason],
      ));
    await expect(insert(m.tests['Assay (HPLC)']!, null, null)).rejects.toThrow(/results_one_original_per_test_uq/);
    await expect(insert(m.tests['Assay (HPLC)']!, a, null)).rejects.toThrow(/results_retest_has_reason/);
    await expect(insert(m.tests['Assay (HPLC)']!, ident, 'Pointing at another test')).rejects.toThrow(/same sample and test/);
    await insert(m.tests['Assay (HPLC)']!, a, 'First repeat by raw SQL');
    await expect(insert(m.tests['Assay (HPLC)']!, a, 'Second repeat of the same row')).rejects.toThrow(/results_one_retest_each_uq/);
  });
});

describe('certificate of analysis (0039)', () => {
  it('issues one e-signed certificate per QC approval; the PDF is stored with its SHA-256 and served only while it matches', async () => {
    const m = await approvedLot();
    const cands = await call('qcm', 'get', '/qc/coas/candidates');
    expect(cands.body.find((c: { lotId: string }) => c.lotId === m.lotId)).toMatchObject({ itemCode: 'API-PCM' });

    const res = await issue('qcm', m.lotId);
    expect([res.status, res.body.error]).toEqual([201, undefined]);
    expect(res.body.docNo).toMatch(/^COA-\d{4}-\d{5}$/);
    expect(res.body).toMatchObject({ lotId: m.lotId, sampleRequestId: m.requestId, issuedBy: users.qcm, fileName: `${res.body.docNo}.pdf` });
    expect(res.body.attachmentId).not.toBeNull();

    const pdf = await call('analyst', 'get', `/qc/coas/${res.body.id}/pdf`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const bytes = pdf.body as Buffer;
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(res.body.sha256);

    const { rows: s } = await client.query(
      `SELECT s.meaning, s.record_table, s.record_id, s.user_id FROM qc.coas c JOIN core.e_signatures s ON s.id = c.esign_id WHERE c.id = $1`, [res.body.id],
    );
    const disp = await one(`SELECT id FROM qc.dispositions WHERE lot_id = $1`, [m.lotId]);
    expect(s).toEqual([{ meaning: 'APPROVED', record_table: 'qc.dispositions', record_id: disp, user_id: users.qcm }]);
    expect((await call('qcm', 'get', '/qc/coas/candidates')).body.map((c: { lotId: string }) => c.lotId)).not.toContain(m.lotId);
    expect((await call('qcm', 'get', `/qc/coas?search=${res.body.docNo}`)).body.items.map((c: { id: string }) => c.id)).toEqual([res.body.id]);

    const dup = await issue('qcm', m.lotId);
    expect([dup.status, dup.body.error.code]).toEqual([409, 'ALREADY_EXISTS']);

    // A changed file on disk is never served.
    const { rows } = await client.query<{ storage_key: string }>(`SELECT storage_key FROM core.attachments WHERE id = $1`, [res.body.attachmentId]);
    await writeFile(path.resolve(env.STORAGE_DIR, rows[0]!.storage_key), Buffer.from('%PDF-1.4 altered'));
    const bad = await call('qcm', 'get', `/qc/coas/${res.body.id}/pdf`);
    expect([bad.status, bad.body.error.code]).toEqual([500, 'FILE_INTEGRITY_FAILED']);
  });

  it('refuses without the key, with the wrong meaning or password, and for a lot not APPROVED or a finished-goods lot', async () => {
    const m = await approvedLot();
    for (const who of ['analyst', 'qa', 'ceo']) {
      expect([who, (await issue(who, m.lotId)).status]).toEqual([who, 403]);
    }
    expect((await issue('qcm', m.lotId, 'REVIEWED')).body.error.code).toBe('VALIDATION_FAILED');
    expect((await issue('qcm', m.lotId, 'APPROVED', 'wrong-password')).body.error.code).toBe('ESIGN_FAILED');

    const testing = await sampledLot({ itemId: ids.api! });
    expect((await issue('qcm', testing.lotId)).body.error.code).toBe('LOT_NOT_APPROVED');
    const fg = await sampledLot({ itemId: ids.fg!, fg: true });
    expect((await issue('qcm', fg.lotId)).body.error.code).toBe('FG_LOT_QA_DECIDES');
    expect((await call('qcm', 'get', '/qc/coas/candidates')).body.map((c: { lotId: string }) => c.lotId)).not.toContain(fg.lotId);
    expect((await call('qcm', 'get', '/qc/coas/999999')).status).toBe(404);
  });

  it('database guards: a certificate is never changed, needs its PDF in the same transaction, and takes no other file', async () => {
    const m = await approvedLot();
    const res = await issue('qcm', m.lotId);
    expect(res.status).toBe(201);
    await expect(inTx('1', () => client.query(`UPDATE qc.coas SET file_name = 'x.pdf' WHERE id = $1`, [res.body.id]))).rejects.toThrow(/APPEND_ONLY/);
    await expect(inTx('1', () => client.query(`DELETE FROM qc.coas WHERE id = $1`, [res.body.id]))).rejects.toThrow();
    const up = await request(app)
      .post(`/api/v1/core/attachments/qc.coas/${res.body.id}`)
      .set('Authorization', `Bearer ${tokens.qcm}`)
      .set('Content-Type', 'application/pdf')
      .set('X-File-Name', 'extra.pdf')
      .send(Buffer.from('%PDF-1.4\n%%EOF\n'));
    expect([up.status, up.body.error.code]).toEqual([409, 'RECORD_LOCKED']);

    // A certificate row without its file (signature valid) is refused at commit.
    const m2 = await approvedLot();
    const disp = await one(`SELECT id FROM qc.dispositions WHERE lot_id = $1`, [m2.lotId]);
    await expect(inTx(users.qcm!, async () => {
      const esign = await one(
        `INSERT INTO core.e_signatures (user_id, signer_username, signer_name, meaning, reason, record_table, record_id)
         VALUES ($1, 'rt_qcm', 'QC Manager', 'APPROVED', 'No file', 'qc.dispositions', $2) RETURNING id`, [users.qcm, disp],
      );
      await client.query(
        `INSERT INTO qc.coas (doc_no, lot_id, disposition_id, sample_request_id, file_name, sha256, esign_id) VALUES ('COA-X-1', $1, $2, $3, 'x.pdf', $4, $5)`,
        [m2.lotId, disp, m2.requestId, 'a'.repeat(64), esign],
      );
    })).rejects.toThrow(/FILE_INTEGRITY_FAILED/);
    // An analyst (no qc.coa.issue) cannot write one at all.
    await expect(inTx(users.analyst!, () => client.query(
      `INSERT INTO qc.coas (doc_no, lot_id, disposition_id, sample_request_id, file_name, sha256, esign_id) VALUES ('COA-X-2', $1, $2, $3, 'x.pdf', $4, 1)`,
      [m2.lotId, disp, m2.requestId, 'a'.repeat(64)],
    ))).rejects.toThrow(/FORBIDDEN/);
  });
});
