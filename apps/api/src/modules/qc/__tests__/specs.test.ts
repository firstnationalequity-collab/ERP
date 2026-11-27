// M4 task 1 (0034): QC specifications, versioned, approved by the QC Manager with an e-signature. Happy path and every
// refusal through the HTTP endpoints, plus the database guards (rules hold even if a service forgets them).
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

function call(who: string, method: 'get' | 'post' | 'patch' | 'put', url: string, body?: object) {
  const r = request(app)[method](`/api/v1${url}`).set('Authorization', `Bearer ${tokens[who]}`);
  return body ? r.send(body) : r;
}
const sign = (meaning = 'APPROVED', password = TEST_PASSWORD) => ({ signature: { password, meaning, reason: 'Spec reviewed against BP' } });

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

const assay = { name: 'Assay (HPLC)', method: 'BP 2025', resultType: 'NUMERIC', minValue: '98.0', maxValue: '102.0', unit: '%', isAssay: true };
const water = { name: 'Water (KF)', resultType: 'NUMERIC', maxValue: '0.5', unit: '%', isWater: true };
const ident = { name: 'Identification (IR)', resultType: 'TEXT', textLimit: 'Complies with reference' };

/** A spec drafted with tests and submitted by the analyst. */
async function submitted(itemId: string, tests: object[] = [assay, water, ident]): Promise<string> {
  const created = await call('analyst', 'post', '/qc/specs', { itemId, reference: 'BP 2025' });
  expect(created.status).toBe(201);
  expect((await call('analyst', 'put', `/qc/specs/${created.body.id}/tests`, { tests })).status).toBe(200);
  expect((await call('analyst', 'post', `/qc/specs/${created.body.id}/submit`)).status).toBe(200);
  return created.body.id as string;
}

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  for (const [name, roles] of [
    ['analyst', ['QC_ANALYST']],
    ['qcm', ['QC_MANAGER']],
    ['qcm2', ['QC_MANAGER']],
    ['both', ['QC_ANALYST', 'QC_MANAGER']],
    ['wm', ['WAREHOUSE_MANAGER']],
    ['pm', ['PURCHASE_MANAGER']],
    ['qa', ['QA_MANAGER']],
  ] as const) {
    users[name] = await createTestUser({ username: `spec_${name}`, roleCodes: [...roles] });
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: `spec_${name}`, password: TEST_PASSWORD });
    tokens[name] = res.body.accessToken as string;
  }
  await inTx('1', async () => {
    ids.uom = await one(`INSERT INTO master.uoms (code, name) VALUES ('KG', 'Kilogram') RETURNING id`);
    ids.category = await one(`INSERT INTO master.item_categories (code, name) VALUES ('RM', 'Raw material') RETURNING id`);
  });
  ids.api = await item('API-PCM', 'API');
  ids.rm = await item('RM-LAC', 'RM');
  ids.fg = await item('FG-TAB', 'FG');
  ids.spare = await item('SP-BELT', 'SPARE');
});

afterAll(async () => {
  await client.end();
});

describe('QC specification: draft → submit → approve (happy path)', () => {
  it('the analyst drafts v1 with tests; the QC Manager approves it with an e-signature', async () => {
    const id = await submitted(ids.api!);
    const pending = await call('qcm', 'get', `/qc/specs/${id}`);
    expect(pending.body).toMatchObject({ version: 1, status: 'PENDING_APPROVAL', submittedBy: users.analyst, itemCode: 'API-PCM' });
    expect(pending.body.tests.map((t: { seq: number; name: string }) => [t.seq, t.name])).toEqual([
      [1, 'Assay (HPLC)'], [2, 'Water (KF)'], [3, 'Identification (IR)'],
    ]);
    expect(pending.body.tests[0]).toMatchObject({ minValue: '98.000000', maxValue: '102.000000', isAssay: true });

    const ok = await call('qcm', 'post', `/qc/specs/${id}/approve`, sign());
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'APPROVED', approvedBy: users.qcm });
    const { rows } = await client.query(
      `SELECT e.meaning, e.user_id FROM qc.specs s JOIN core.e_signatures e ON e.id = s.approval_esign_id WHERE s.id = $1`, [id],
    );
    expect(rows[0]).toMatchObject({ meaning: 'APPROVED', user_id: users.qcm });
    const moves = await client.query(`SELECT from_status, to_status FROM core.status_history WHERE entity_table = 'qc.specs' AND entity_id = $1 ORDER BY id`, [id]);
    expect(moves.rows.map((m) => `${m.from_status ?? '-'}>${m.to_status}`)).toEqual(['->DRAFT', 'DRAFT>PENDING_APPROVAL', 'PENDING_APPROVAL>APPROVED']);
  });

  it('v2 copies v1, and approving v2 makes v1 OBSOLETE', async () => {
    const v2 = await call('analyst', 'post', '/qc/specs', { itemId: ids.api });
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({ version: 2, status: 'DRAFT', reference: 'BP 2025' });
    expect(v2.body.tests).toHaveLength(3);
    expect((await call('analyst', 'put', `/qc/specs/${v2.body.id}/tests`, { tests: [{ ...assay, minValue: '98.5' }, water, ident] })).status).toBe(200);
    expect((await call('analyst', 'post', `/qc/specs/${v2.body.id}/submit`)).status).toBe(200);
    expect((await call('qcm2', 'post', `/qc/specs/${v2.body.id}/approve`, sign())).status).toBe(200);
    const list = await call('analyst', 'get', `/qc/specs?itemId=${ids.api}`);
    expect(list.body.items.map((s: { version: number; status: string }) => [s.version, s.status])).toEqual([[2, 'APPROVED'], [1, 'OBSOLETE']]);
    expect((await call('analyst', 'get', '/qc/specs?search=pcm&status=APPROVED')).body.total).toBe(1);
  });

  it('a rejection returns the spec to DRAFT with a reason, editable again', async () => {
    const id = await submitted(ids.rm!, [ident]);
    const back = await call('qcm', 'post', `/qc/specs/${id}/reject`, { reason: 'Add the loss on drying test' });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ status: 'DRAFT', submittedBy: null });
    expect((await call('analyst', 'patch', `/qc/specs/${id}`, { notes: 'LOD added' })).status).toBe(200);
    expect((await call('analyst', 'put', `/qc/specs/${id}/tests`, { tests: [ident, { name: 'LOD', resultType: 'NUMERIC', maxValue: '1.0', unit: '%' }] })).status).toBe(200);
    expect((await call('analyst', 'post', `/qc/specs/${id}/submit`)).status).toBe(200);
    expect((await call('qcm', 'post', `/qc/specs/${id}/approve`, sign())).status).toBe(200);
  });
});

describe('QC specification refusals', () => {
  it('permissions: the analyst cannot approve; the QC Manager cannot draft; a warehouse user cannot read', async () => {
    const id = await submitted(ids.fg!, [ident]);
    expect((await call('analyst', 'post', `/qc/specs/${id}/approve`, sign())).status).toBe(403);
    expect((await call('analyst', 'post', `/qc/specs/${id}/reject`, { reason: 'nope' })).status).toBe(403);
    expect((await call('qcm', 'post', '/qc/specs', { itemId: ids.rm })).status).toBe(403);
    expect((await call('wm', 'get', '/qc/specs')).status).toBe(403);
    // finish it so the FG item has an APPROVED v1
    expect((await call('qcm', 'post', `/qc/specs/${id}/approve`, sign())).status).toBe(200);
  });

  it('segregation: the drafter / submitter never approves or rejects their own spec (403 SEGREGATION_OF_DUTIES)', async () => {
    const created = await call('both', 'post', '/qc/specs', { itemId: ids.fg });
    expect(created.status).toBe(201);
    await call('both', 'put', `/qc/specs/${created.body.id}/tests`, { tests: [ident] });
    expect((await call('both', 'post', `/qc/specs/${created.body.id}/submit`)).status).toBe(200);
    const res = await call('both', 'post', `/qc/specs/${created.body.id}/approve`, sign());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SEGREGATION_OF_DUTIES');
    expect((await call('both', 'post', `/qc/specs/${created.body.id}/reject`, { reason: 'mine' })).body.error.code).toBe('SEGREGATION_OF_DUTIES');
    // another QC Manager may approve it
    expect((await call('qcm', 'post', `/qc/specs/${created.body.id}/approve`, sign())).status).toBe(200);
  });

  it('e-signature: wrong password, wrong meaning → refused, nothing changes', async () => {
    const created = await call('analyst', 'post', '/qc/specs', { itemId: ids.fg });
    await call('analyst', 'put', `/qc/specs/${created.body.id}/tests`, { tests: [ident] });
    await call('analyst', 'post', `/qc/specs/${created.body.id}/submit`);
    expect((await call('qcm', 'post', `/qc/specs/${created.body.id}/approve`, sign('APPROVED', 'wrong-password'))).body.error.code).toBe('ESIGN_FAILED');
    expect((await call('qcm', 'post', `/qc/specs/${created.body.id}/approve`, sign('REVIEWED'))).body.error.code).toBe('VALIDATION_FAILED');
    expect((await call('qcm', 'get', `/qc/specs/${created.body.id}`)).body.status).toBe('PENDING_APPROVAL');
    expect((await call('qcm', 'post', `/qc/specs/${created.body.id}/reject`, { reason: 'Later' })).status).toBe(200);
  });

  it('one open version per item; a non-QC item type is refused; only DRAFT is edited; submit needs a test', async () => {
    const open = await call('analyst', 'post', '/qc/specs', { itemId: ids.fg });
    expect(open.status).toBe(409);
    expect(open.body.error.code).toBe('ALREADY_EXISTS');
    const spare = await call('analyst', 'post', '/qc/specs', { itemId: ids.spare });
    expect(spare.status).toBe(400);
    expect(spare.body.error.code).toBe('VALIDATION_FAILED');

    const draft = (await call('analyst', 'get', `/qc/specs?itemId=${ids.fg}&status=DRAFT`)).body.items[0];
    await call('analyst', 'put', `/qc/specs/${draft.id}/tests`, { tests: [] });
    const empty = await call('analyst', 'post', `/qc/specs/${draft.id}/submit`);
    expect(empty.status).toBe(400);

    const approved = (await call('analyst', 'get', `/qc/specs?itemId=${ids.api}&status=APPROVED`)).body.items[0];
    expect((await call('analyst', 'patch', `/qc/specs/${approved.id}`, { notes: 'x' })).body.error.code).toBe('RECORD_LOCKED');
    expect((await call('analyst', 'put', `/qc/specs/${approved.id}/tests`, { tests: [ident] })).body.error.code).toBe('RECORD_LOCKED');
    expect((await call('qcm', 'post', `/qc/specs/${approved.id}/approve`, sign())).body.error.code).toBe('INVALID_TRANSITION');
    expect((await call('analyst', 'post', `/qc/specs/${approved.id}/submit`)).body.error.code).toBe('RECORD_LOCKED');
  });

  it('validation: min above max, text test without its limit, two assay tests → 400', async () => {
    const draft = (await call('analyst', 'get', `/qc/specs?itemId=${ids.fg}&status=DRAFT`)).body.items[0];
    for (const tests of [
      [{ ...assay, minValue: '103' }],
      [{ name: 'ID', resultType: 'TEXT' }],
      [assay, { ...assay, name: 'Assay 2' }],
    ]) {
      const res = await call('analyst', 'put', `/qc/specs/${draft.id}/tests`, { tests });
      expect(res.status).toBe(400);
    }
  });
});

describe('QC specification database guards', () => {
  const rawUpdate = (userId: string, sql: string, params: unknown[]) => inTx(userId, () => client.query(sql, params));

  it('tests of a non-DRAFT spec cannot change; identity never changes', async () => {
    const approved = (await call('analyst', 'get', `/qc/specs?itemId=${ids.api}&status=APPROVED`)).body.items[0];
    await expect(rawUpdate(users.analyst!, `UPDATE qc.spec_tests SET max_value = 105 WHERE spec_id = $1`, [approved.id])).rejects.toThrow(/RECORD_LOCKED/);
    await expect(rawUpdate(users.analyst!, `DELETE FROM qc.spec_tests WHERE spec_id = $1`, [approved.id])).rejects.toThrow(/RECORD_LOCKED/);
    await expect(rawUpdate(users.analyst!, `UPDATE qc.specs SET version = 9 WHERE id = $1`, [approved.id])).rejects.toThrow(/never change/);
    await expect(rawUpdate(users.analyst!, `UPDATE qc.specs SET notes = 'x' WHERE id = $1`, [approved.id])).rejects.toThrow(/RECORD_LOCKED/);
  });

  it('approval without the approver\'s own signature, or by the drafter, is refused by the DB', async () => {
    const draft = (await call('analyst', 'get', `/qc/specs?itemId=${ids.fg}&status=DRAFT`)).body.items[0];
    await call('analyst', 'put', `/qc/specs/${draft.id}/tests`, { tests: [ident] });
    await call('analyst', 'post', `/qc/specs/${draft.id}/submit`);
    // QC Manager tries to approve with someone else's signature id (the spec's earlier approvals)
    const otherSig = (await client.query<{ id: string }>(`SELECT approval_esign_id AS id FROM qc.specs WHERE approval_esign_id IS NOT NULL LIMIT 1`)).rows[0]!.id;
    await expect(
      inTx(users.qcm!, async () => {
        await history('qc.specs', draft.id, 'PENDING_APPROVAL', 'APPROVED', users.qcm!);
        await client.query(`UPDATE qc.specs SET status = 'APPROVED', approved_by = $2, approved_at = now(), approval_esign_id = $3 WHERE id = $1`, [
          draft.id, users.qcm, otherSig,
        ]);
      }),
    ).rejects.toThrow(/ESIGN_FAILED/);
    // the analyst (drafter) records a signature on it and approves: segregation
    await expect(
      inTx(users.analyst!, async () => {
        const sig = await one(
          `INSERT INTO core.e_signatures (user_id, signer_username, signer_name, meaning, reason, record_table, record_id) VALUES ($1, 'spec_analyst', 'A', 'APPROVED', 'self approval', 'qc.specs', $2) RETURNING id`,
          [users.analyst, draft.id],
        );
        await history('qc.specs', draft.id, 'PENDING_APPROVAL', 'APPROVED', users.analyst!);
        await client.query(`UPDATE qc.specs SET status = 'APPROVED', approved_by = $2, approved_at = now(), approval_esign_id = $3 WHERE id = $1`, [
          draft.id, users.analyst, sig,
        ]);
      }),
    ).rejects.toThrow(/SEGREGATION_OF_DUTIES|approved_by/);
  });

  it('an APPROVED version becomes OBSOLETE only when a later version is approved in the same transaction', async () => {
    const approved = (await call('analyst', 'get', `/qc/specs?itemId=${ids.rm}&status=APPROVED`)).body.items[0];
    await expect(
      inTx(users.qcm!, async () => {
        await history('qc.specs', approved.id, 'APPROVED', 'OBSOLETE', users.qcm!);
        await client.query(`UPDATE qc.specs SET status = 'OBSOLETE' WHERE id = $1`, [approved.id]);
      }),
    ).rejects.toThrow(/OBSOLETE only when a later version/);
  });

  it('a status change without core/transition is refused', async () => {
    const draft = (await call('analyst', 'get', `/qc/specs?itemId=${ids.fg}&status=PENDING_APPROVAL`)).body.items[0];
    await expect(rawUpdate(users.analyst!, `UPDATE qc.specs SET status = 'DRAFT', submitted_by = NULL WHERE id = $1`, [draft.id])).rejects.toThrow();
  });
});
