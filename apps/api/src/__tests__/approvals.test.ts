// Approval engine: matrix bands, "then"/"and", routing to roles, segregation, e-signature, inbox, rules admin.
// docs/architecture.md §3; decisions Q12, Q13. The matrix used is the seeded placeholder from §3.
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ESignRequest } from '@albert/shared';
import { createApp } from '../app';
import { databaseUrl } from '../config/env';
import { withTransaction } from '../db/client';
import { runSeed } from '../db/seed/run';
import { authenticateToken, txContext, type AuthContext } from '../core/auth/auth.service';
import {
  cancelApproval,
  registerApprovalHandler,
  startApproval,
  type ApprovalValue,
} from '../core/approvals/approvals.service';
import { createTestUser, TEST_PASSWORD } from '../test/factories';

const app = createApp();
const client = new pg.Client({ connectionString: databaseUrl });
const tokens: Record<string, string> = {};
const auths: Record<string, AuthContext> = {};
const userIds: Record<string, string> = {};

// ---- a stand-in module handler: records what the engine told it, can be told to fail
const events: { kind: 'approved' | 'rejected'; docId: string; by: string; reason?: string }[] = [];
let failNextApproval = false;
// AVL uses the real masters handler (registered when the app loads); these tests only start AVL approvals.
for (const docType of ['PO', 'QUOTATION_DISCOUNT', 'STOCK_ADJUSTMENT', 'BATCH_CLOSE', 'TEST_DOC', 'MATRIX_DEMO']) {
  registerApprovalHandler(docType, {
    async onApproved(_tx, approval, actor) {
      if (failNextApproval) {
        failNextApproval = false;
        throw new Error('module failed to move the document');
      }
      events.push({ kind: 'approved', docId: approval.docId, by: actor.userId });
    },
    async onRejected(_tx, approval, actor, reason) {
      events.push({ kind: 'rejected', docId: approval.docId, by: actor.userId, reason });
    },
  });
}

let docCounter = 0;
async function start(docType: string, value: ApprovalValue, requester = 'buyer') {
  docCounter += 1;
  const docId = String(docCounter);
  const auth = auths[requester]!;
  const approval = await withTransaction(txContext(auth), (tx) =>
    startApproval(tx, auth, { docType, docTable: 'test.documents', docId, docNo: `${docType}-${docId}`, value }),
  );
  return { approvalId: approval.id, docId };
}

/** Finance Manager countersign for approval-matrix changes (rules review B). */
const fmCountersign = (username = 'r_fm', password = TEST_PASSWORD) => ({ username, password, meaning: 'APPROVED' as const, reason: 'Finance agrees' });

const sig = (meaning: 'APPROVED' | 'REJECTED', password = TEST_PASSWORD): ESignRequest => ({
  password,
  meaning,
  reason: meaning === 'APPROVED' ? 'Checked and approved' : 'Price too high',
});

const act = (who: string, approvalId: string, decision: 'approve' | 'reject', signature?: ESignRequest) =>
  request(app)
    .post(`/api/v1/core/approvals/${approvalId}/${decision}`)
    .set('Authorization', `Bearer ${tokens[who]}`)
    .send({ signature: signature ?? sig(decision === 'approve' ? 'APPROVED' : 'REJECTED') });

const inboxOf = async (who: string): Promise<string[]> => {
  const res = await request(app).get('/api/v1/core/approvals/inbox?pageSize=200').set('Authorization', `Bearer ${tokens[who]}`);
  return (res.body.items as { approvalId: string }[]).map((i) => i.approvalId);
};

async function stepsOf(approvalId: string) {
  const { rows } = await client.query<{ role: string; step_no: number; status: string }>(
    `SELECT r.code AS role, s.step_no, s.status FROM core.approval_steps s JOIN core.roles r ON r.id = s.role_id
      WHERE s.approval_id = $1 ORDER BY s.step_no, r.code`,
    [approvalId],
  );
  return rows.map((r) => `${r.step_no}:${r.role}:${r.status}`);
}

async function approvalStatus(approvalId: string): Promise<string> {
  const { rows } = await client.query<{ status: string }>(`SELECT status FROM core.approvals WHERE id = $1`, [approvalId]);
  return rows[0]!.status;
}

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  const people: [string, string[]][] = [
    ['buyer', ['PURCHASE_OFFICER']],
    ['pm', ['PURCHASE_MANAGER']],
    ['pm2', ['PURCHASE_MANAGER']],
    ['fm', ['FINANCE_MANAGER']],
    ['qam', ['QA_MANAGER']],
    ['sm', ['SALES_MANAGER']],
    ['fmqa', ['FINANCE_MANAGER', 'QA_MANAGER']],
    ['admin', ['SYSTEM_ADMIN']],
    ['ceo', ['CEO']],
  ];
  for (const [name, roles] of people) {
    userIds[name] = await createTestUser({ username: `r_${name}`, roleCodes: roles });
    const res = await request(app).post('/api/v1/core/auth/login').send({ username: `r_${name}`, password: TEST_PASSWORD });
    tokens[name] = res.body.accessToken as string;
    auths[name] = await authenticateToken(tokens[name]!);
  }
});

beforeEach(() => {
  events.length = 0;
});

afterAll(async () => {
  await client.end();
});

describe('band selection on the seeded PO matrix (PKR, placeholder limits)', () => {
  it.each([
    ['400000.00', ['1:PURCHASE_MANAGER:PENDING']],
    ['500000.00', ['1:PURCHASE_MANAGER:PENDING']],
    ['500000.01', ['1:FINANCE_MANAGER:PENDING']],
    ['5000000.00', ['1:FINANCE_MANAGER:PENDING']],
    ['5000000.01', ['1:PURCHASE_MANAGER:PENDING', '2:FINANCE_MANAGER:WAITING']],
  ])('PKR %s routes to %j', async (amount, expected) => {
    const { approvalId } = await start('PO', { measure: 'AMOUNT_PKR', amount });
    expect(await stepsOf(approvalId)).toEqual(expected);
  });

  it('converts an import PO at the document exchange rate: USD 2,000 × 280.5000 = PKR 561,000 → Finance Manager', async () => {
    const { approvalId } = await start('PO', { measure: 'AMOUNT_PKR', amount: '2000', currency: 'USD', exchangeRate: '280.5' });
    expect(await stepsOf(approvalId)).toEqual(['1:FINANCE_MANAGER:PENDING']);
    const { rows } = await client.query(
      `SELECT amount, currency, exchange_rate, measured_amount, measured_percent FROM core.approvals WHERE id = $1`,
      [approvalId],
    );
    expect(rows[0]).toEqual({ amount: '2000.00', currency: 'USD', exchange_rate: '280.5000', measured_amount: '561000.00', measured_percent: null });
  });

  it('uses exact decimals at the boundary: USD 1,782.53 × 280.5000 = 499,999.67 → Purchase Manager', async () => {
    const { approvalId } = await start('PO', { measure: 'AMOUNT_PKR', amount: '1782.53', currency: 'USD', exchangeRate: '280.5' });
    expect(await stepsOf(approvalId)).toEqual(['1:PURCHASE_MANAGER:PENDING']);
  });

  it('refuses a foreign amount without an exchange rate, a negative amount, and the wrong measure', async () => {
    await expect(start('PO', { measure: 'AMOUNT_PKR', amount: '100', currency: 'EUR' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(start('PO', { measure: 'AMOUNT_PKR', amount: '-5' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(start('PO', { measure: 'PERCENT', percent: '3' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a document type without rules instead of skipping approval', async () => {
    await expect(start('TEST_DOC', { measure: 'NONE' })).rejects.toMatchObject({ code: 'APPROVAL_RULE_MISSING', status: 422 });
  });

  it('routes quotation discounts by percent: 5% → Sales Manager; 5.5% → Sales Manager then Finance Manager', async () => {
    expect(await stepsOf((await start('QUOTATION_DISCOUNT', { measure: 'PERCENT', percent: '5' })).approvalId)).toEqual([
      '1:SALES_MANAGER:PENDING',
    ]);
    expect(await stepsOf((await start('QUOTATION_DISCOUNT', { measure: 'PERCENT', percent: '5.5' })).approvalId)).toEqual([
      '1:SALES_MANAGER:PENDING',
      '2:FINANCE_MANAGER:WAITING',
    ]);
  });
});

describe('"then": sequential steps (PO above 5,000,000)', () => {
  it('opens the Finance Manager step only after the Purchase Manager approves, then approves the document', async () => {
    const { approvalId, docId } = await start('PO', { measure: 'AMOUNT_PKR', amount: '7500000' });
    expect(await inboxOf('pm')).toContain(approvalId);
    expect(await inboxOf('fm')).not.toContain(approvalId);

    const early = await act('fm', approvalId, 'approve');
    expect(early.status).toBe(403);
    expect(early.body.error.message).toMatch(/not open yet/);

    expect((await act('pm', approvalId, 'approve')).status).toBe(200);
    expect(await stepsOf(approvalId)).toEqual(['1:PURCHASE_MANAGER:APPROVED', '2:FINANCE_MANAGER:PENDING']);
    expect(await inboxOf('fm')).toContain(approvalId);
    expect(events).toEqual([]);

    const done = await act('fm', approvalId, 'approve');
    expect(done.body.status).toBe('APPROVED');
    expect(events).toEqual([{ kind: 'approved', docId, by: userIds.fm }]);
  });
});

describe('"and": parallel steps (stock adjustment: Finance Manager AND QA Manager)', () => {
  it('needs both, in either order, from two different people', async () => {
    const a = await start('STOCK_ADJUSTMENT', { measure: 'AMOUNT_PKR', amount: '12000' });
    expect(await inboxOf('fm')).toContain(a.approvalId);
    expect(await inboxOf('qam')).toContain(a.approvalId);
    await act('qam', a.approvalId, 'approve');
    expect(await approvalStatus(a.approvalId)).toBe('PENDING');
    await act('fm', a.approvalId, 'approve');
    expect(await approvalStatus(a.approvalId)).toBe('APPROVED');

    const b = await start('STOCK_ADJUSTMENT', { measure: 'AMOUNT_PKR', amount: '12000' });
    await act('fm', b.approvalId, 'approve');
    await act('qam', b.approvalId, 'approve');
    expect(await approvalStatus(b.approvalId)).toBe('APPROVED');
  });

  it('does not let one person holding both roles approve both steps', async () => {
    const { approvalId } = await start('STOCK_ADJUSTMENT', { measure: 'AMOUNT_PKR', amount: '500' });
    expect((await act('fmqa', approvalId, 'approve')).status).toBe(200);
    expect(await inboxOf('fmqa')).not.toContain(approvalId);
    const second = await act('fmqa', approvalId, 'approve');
    expect(second.status).toBe(403);
    expect(second.body.error.code).toBe('SEGREGATION_OF_DUTIES');
    expect(await approvalStatus(approvalId)).toBe('PENDING');
  });
});

describe('routing and segregation of duties (Q13)', () => {
  it('lets anyone holding the role act, and only once', async () => {
    const { approvalId } = await start('PO', { measure: 'AMOUNT_PKR', amount: '1000' });
    expect(await inboxOf('pm')).toContain(approvalId);
    expect(await inboxOf('pm2')).toContain(approvalId);
    expect((await act('pm2', approvalId, 'approve')).status).toBe(200);
    expect(await inboxOf('pm')).not.toContain(approvalId);
    expect((await act('pm', approvalId, 'approve')).status).toBe(409);
  });

  it('never routes a document to its creator, even when the creator holds the approving role', async () => {
    const { approvalId } = await start('PO', { measure: 'AMOUNT_PKR', amount: '1000' }, 'pm');
    expect(await inboxOf('pm')).not.toContain(approvalId);
    const res = await act('pm', approvalId, 'approve');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SEGREGATION_OF_DUTIES');
    expect(await inboxOf('pm2')).toContain(approvalId);
  });

  it('enforces "requester cannot approve" in the database too', async () => {
    const { approvalId } = await start('PO', { measure: 'AMOUNT_PKR', amount: '1000' }, 'pm');
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id', $1, true), set_config('app.company_id','1',true)`, [userIds.pm]);
    await expect(
      client.query(
        `UPDATE core.approval_steps SET acted_by = $1, acted_at = now() WHERE approval_id = $2`,
        [userIds.pm, approvalId],
      ),
    ).rejects.toThrow(/SEGREGATION_OF_DUTIES/);
    await client.query('ROLLBACK');
  });

  it('refuses users without the step role: Finance Manager on a small PO, CEO, admin', async () => {
    const { approvalId } = await start('PO', { measure: 'AMOUNT_PKR', amount: '1000' });
    expect((await act('fm', approvalId, 'approve')).status).toBe(403);
    expect((await act('admin', approvalId, 'approve')).status).toBe(403);
    expect((await act('ceo', approvalId, 'approve')).status).toBe(403);
    expect(await approvalStatus(approvalId)).toBe('PENDING');
  });
});

describe('approvals are e-signatures (rule 8)', () => {
  it('refuses a wrong password (counted toward lockout) and the wrong meaning', async () => {
    const { approvalId } = await start('PO', { measure: 'AMOUNT_PKR', amount: '1000' });
    const before = (await client.query(`SELECT failed_attempts FROM core.users WHERE id = $1`, [userIds.pm2])).rows[0].failed_attempts;
    const wrong = await act('pm2', approvalId, 'approve', sig('APPROVED', 'Wrong-Pass-123'));
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('ESIGN_FAILED');
    const after = (await client.query(`SELECT failed_attempts FROM core.users WHERE id = $1`, [userIds.pm2])).rows[0].failed_attempts;
    expect(after).toBe(before + 1);

    const meaning = await act('pm2', approvalId, 'approve', sig('REJECTED'));
    expect(meaning.status).toBe(400);
    expect(await approvalStatus(approvalId)).toBe('PENDING');
    await act('pm2', approvalId, 'approve'); // reset the counter with a good signature
  });

  it('stores the signature against the step and writes status history', async () => {
    const { approvalId } = await start('PO', { measure: 'AMOUNT_PKR', amount: '1000' });
    await act('pm', approvalId, 'approve');
    const { rows } = await client.query(
      `SELECT e.meaning, e.user_id, s.acted_by FROM core.approval_steps s JOIN core.e_signatures e ON e.id = s.esign_id
        WHERE s.approval_id = $1`,
      [approvalId],
    );
    expect(rows).toEqual([{ meaning: 'APPROVED', user_id: userIds.pm, acted_by: userIds.pm }]);
    const history = await client.query(
      `SELECT from_status, to_status FROM core.status_history WHERE entity_table = 'core.approvals' AND entity_id = $1 ORDER BY id`,
      [approvalId],
    );
    expect(history.rows).toEqual([
      { from_status: null, to_status: 'PENDING' },
      { from_status: 'PENDING', to_status: 'APPROVED' },
    ]);
  });
});

describe('rejection, cancellation and the module handler', () => {
  it('rejects: the step is REJECTED, later steps SKIPPED, the module told with the reason; no further action', async () => {
    const { approvalId, docId } = await start('PO', { measure: 'AMOUNT_PKR', amount: '9000000' });
    const res = await act('pm', approvalId, 'reject');
    expect(res.body.status).toBe('REJECTED');
    expect(await stepsOf(approvalId)).toEqual(['1:PURCHASE_MANAGER:REJECTED', '2:FINANCE_MANAGER:SKIPPED']);
    expect(events).toEqual([{ kind: 'rejected', docId, by: userIds.pm, reason: 'Price too high' }]);
    expect((await act('fm', approvalId, 'approve')).status).toBe(409);
  });

  it('rolls everything back when the module fails to move the document', async () => {
    const { approvalId } = await start('PO', { measure: 'AMOUNT_PKR', amount: '1000' });
    failNextApproval = true;
    const res = await act('pm', approvalId, 'approve');
    expect(res.status).toBe(500);
    expect(await approvalStatus(approvalId)).toBe('PENDING');
    expect(await stepsOf(approvalId)).toEqual(['1:PURCHASE_MANAGER:PENDING']);
    expect((await act('pm', approvalId, 'approve')).body.status).toBe('APPROVED');
  });

  it('cancels the open approval of a document; it leaves every inbox', async () => {
    const { approvalId, docId } = await start('PO', { measure: 'AMOUNT_PKR', amount: '1000' });
    const auth = auths.buyer!;
    expect(await withTransaction(txContext(auth), (tx) => cancelApproval(tx, auth, 'test.documents', docId, 'PO cancelled'))).toBe(true);
    expect(await approvalStatus(approvalId)).toBe('CANCELLED');
    expect(await stepsOf(approvalId)).toEqual(['1:PURCHASE_MANAGER:SKIPPED']);
    expect(await inboxOf('pm')).not.toContain(approvalId);
  });

  it('allows only one open approval per document', async () => {
    const { docId } = await start('PO', { measure: 'AMOUNT_PKR', amount: '1000' });
    const auth = auths.buyer!;
    await expect(
      withTransaction(txContext(auth), (tx) =>
        startApproval(tx, auth, { docType: 'PO', docTable: 'test.documents', docId, value: { measure: 'AMOUNT_PKR', amount: '1000' } }),
      ),
    ).rejects.toThrow(/approvals_open_doc_uq|ALREADY_EXISTS|duplicate key/);
  });

  it('refuses raw status changes and deletion in the database', async () => {
    const { approvalId } = await start('PO', { measure: 'AMOUNT_PKR', amount: '1000' });
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id','1',true), set_config('app.company_id','1',true)`);
    await client.query(`UPDATE core.approvals SET status = 'APPROVED' WHERE id = $1`, [approvalId]);
    await expect(client.query('COMMIT')).rejects.toThrow(/INVALID_TRANSITION/);
    await expect(client.query(`DELETE FROM core.approvals WHERE id = $1`, [approvalId])).rejects.toThrow(/APPEND_ONLY/);
  });
});

describe('inbox', () => {
  it('shows a count badge and the items the user may act on', async () => {
    const before = await request(app).get('/api/v1/core/approvals/inbox/count').set('Authorization', `Bearer ${tokens.sm}`);
    await start('QUOTATION_DISCOUNT', { measure: 'PERCENT', percent: '2' });
    const after = await request(app).get('/api/v1/core/approvals/inbox/count').set('Authorization', `Bearer ${tokens.sm}`);
    expect(after.body.count).toBe(before.body.count + 1);
    const list = await request(app).get('/api/v1/core/approvals/inbox').set('Authorization', `Bearer ${tokens.sm}`);
    expect(list.body.items[0]).toMatchObject({ docType: 'QUOTATION_DISCOUNT', roleCode: 'SALES_MANAGER', measure: 'PERCENT' });
  });

  it('hides approval details from people with no part in them', async () => {
    const { approvalId } = await start('PO', { measure: 'AMOUNT_PKR', amount: '1000' });
    expect((await request(app).get(`/api/v1/core/approvals/${approvalId}`).set('Authorization', `Bearer ${tokens.pm}`)).status).toBe(200);
    expect((await request(app).get(`/api/v1/core/approvals/${approvalId}`).set('Authorization', `Bearer ${tokens.buyer}`)).status).toBe(200);
    expect((await request(app).get(`/api/v1/core/approvals/${approvalId}`).set('Authorization', `Bearer ${tokens.sm}`)).status).toBe(404);
  });
});

describe('approval rules admin (core.settings.manage)', () => {
  const put = (who: string, docType: string, body: object) =>
    request(app).put(`/api/v1/core/approval-rules/${docType}`).set('Authorization', `Bearer ${tokens[who]}`).send(body);

  it('lists the seeded matrix', async () => {
    const res = await request(app).get('/api/v1/core/approval-rules').set('Authorization', `Bearer ${tokens.admin}`);
    const po = res.body.find((r: { docType: string }) => r.docType === 'PO');
    expect(po.bands).toHaveLength(3);
    expect(po.bands[2].steps.map((s: { roleCode: string }) => s.roleCode)).toEqual(['PURCHASE_MANAGER', 'FINANCE_MANAGER']);
  });

  it('refuses overlapping bands, gaps in step numbers, and non-admins', async () => {
    const roleId = (await client.query(`SELECT id FROM core.roles WHERE code = 'QA_MANAGER'`)).rows[0].id as string;
    const overlap = await put('admin', 'AVL', {
      measure: 'AMOUNT_PKR',
      bands: [
        { upperBound: '1000', steps: [{ stepNo: 1, roleId }] },
        { lowerBound: '500', steps: [{ stepNo: 1, roleId }] },
      ],
      reason: 'Overlap test',
    });
    expect(overlap.status).toBe(400);
    expect(overlap.body.error.details.rules).toContain('Bands overlap: each value must fall in exactly one band');
    const gap = await put('admin', 'AVL', { measure: 'NONE', bands: [{ steps: [{ stepNo: 2, roleId }] }], reason: 'Gap test' });
    expect(gap.status).toBe(400);
    expect((await put('fm', 'AVL', { measure: 'NONE', bands: [{ steps: [{ stepNo: 1, roleId }] }], reason: 'Not admin' })).status).toBe(403);
  });

  it('replaces a rule set for new approvals only; pending approvals keep their steps', async () => {
    const fmRole = (await client.query(`SELECT id FROM core.roles WHERE code = 'FINANCE_MANAGER'`)).rows[0].id as string;
    const qaRole = (await client.query(`SELECT id FROM core.roles WHERE code = 'QA_MANAGER'`)).rows[0].id as string;
    const first = await put('admin', 'MATRIX_DEMO', {
      measure: 'NONE',
      bands: [{ steps: [{ stepNo: 1, roleId: qaRole }] }],
      reason: 'Demo rule',
      countersign: fmCountersign(),
    });
    expect(first.status).toBe(200);
    const pending = await start('MATRIX_DEMO', { measure: 'NONE' });
    expect(await stepsOf(pending.approvalId)).toEqual(['1:QA_MANAGER:PENDING']);
    const res = await put('admin', 'MATRIX_DEMO', {
      measure: 'NONE',
      bands: [{ steps: [{ stepNo: 1, roleId: qaRole }, { stepNo: 2, roleId: fmRole }] }],
      reason: 'Finance also signs',
      countersign: fmCountersign(),
    });
    expect(res.status).toBe(200);
    expect(await stepsOf(pending.approvalId)).toEqual(['1:QA_MANAGER:PENDING']);
    const fresh = await start('MATRIX_DEMO', { measure: 'NONE' });
    expect(await stepsOf(fresh.approvalId)).toEqual(['1:QA_MANAGER:PENDING', '2:FINANCE_MANAGER:WAITING']);
    const audit = await client.query(
      `SELECT count(*)::int AS n FROM core.audit_log WHERE table_name = 'core.approval_rules' AND reason LIKE 'Finance also signs [countersign e-signature %]'`,
    );
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });
});

describe('admin roles never approve business documents (rules review, finding A)', () => {
  const roleId = async (code: string) => (await client.query<{ id: string }>(`SELECT id FROM core.roles WHERE code = $1`, [code])).rows[0]!.id;

  it('refuses approval rules that route a step to a role holding admin keys', async () => {
    const res = await request(app)
      .put('/api/v1/core/approval-rules/PO')
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({
        measure: 'AMOUNT_PKR',
        bands: [{ steps: [{ stepNo: 1, roleId: await roleId('SYSTEM_ADMIN') }] }],
        reason: 'Admins approve POs',
        countersign: fmCountersign(),
      });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ROLE_ADMIN_CONFLICT');
    // The PO matrix is unchanged.
    expect(await stepsOf((await start('PO', { measure: 'AMOUNT_PKR', amount: '1000' })).approvalId)).toEqual(['1:PURCHASE_MANAGER:PENDING']);
  });

  it('refuses to start an approval from a rule written around the API that routes to an admin role', async () => {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id','1',true), set_config('app.company_id','1',true)`);
    await client.query(
      `INSERT INTO core.approval_rules (doc_type, measure, step_no, role_id) VALUES ('ADMIN_ROUTED', 'NONE', 1, $1)`,
      [await roleId('SYSTEM_ADMIN')],
    );
    await client.query('COMMIT');
    registerApprovalHandler('ADMIN_ROUTED', { onApproved: async () => undefined, onRejected: async () => undefined });
    await expect(start('ADMIN_ROUTED', { measure: 'NONE' })).rejects.toMatchObject({ code: 'ROLE_ADMIN_CONFLICT' });
  });

  it('refuses the approval when the step role has gained an admin key since the approval started', async () => {
    // A view-only role (CEO) may legitimately be an approver; give it an admin key afterwards.
    const ceoRole = await roleId('CEO');
    const res = await request(app)
      .put('/api/v1/core/approval-rules/MATRIX_DEMO')
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ measure: 'NONE', bands: [{ steps: [{ stepNo: 1, roleId: ceoRole }] }], reason: 'CEO signs (test)', countersign: fmCountersign() });
    expect(res.status).toBe(200);
    const { approvalId } = await start('MATRIX_DEMO', { measure: 'NONE' });
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id','1',true), set_config('app.company_id','1',true)`);
    await client.query(
      `INSERT INTO core.role_permissions (role_id, permission_id) SELECT $1, id FROM core.permissions WHERE key = 'core.settings.manage'`,
      [ceoRole],
    );
    await client.query('COMMIT');
    const approve = await act('ceo', approvalId, 'approve');
    expect(approve.status).toBe(403);
    expect(approve.body.error.message).toMatch(/Admin roles cannot approve/);
    expect(await approvalStatus(approvalId)).toBe('PENDING');
  });
});

describe('approval matrix changes (rules review B)', () => {
  const roleId = async (code: string) => (await client.query<{ id: string }>(`SELECT id FROM core.roles WHERE code = $1`, [code])).rows[0]!.id;
  const put = (body: object, docType: string) =>
    request(app).put(`/api/v1/core/approval-rules/${docType}`).set('Authorization', `Bearer ${tokens.admin}`).send(body);

  it('locks GMP document types in code: AVL cannot go to a Planner, a Finance Manager or a QC Manager', async () => {
    for (const code of ['PLANNER', 'FINANCE_MANAGER', 'QC_MANAGER']) {
      const res = await put({ measure: 'NONE', bands: [{ steps: [{ stepNo: 1, roleId: await roleId(code) }] }], reason: 'Re-route AVL' }, 'AVL');
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'APPROVER_ROLE_NOT_ALLOWED', details: { permission: 'master.avl.approve' } });
    }
  });

  it('accepts a GMP-locked rule set routed to the right role without a Finance countersign', async () => {
    const res = await put({ measure: 'NONE', bands: [{ steps: [{ stepNo: 1, roleId: await roleId('QA_MANAGER') }] }], reason: 'Confirm QA signs AVL' }, 'AVL');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ docType: 'AVL', lockedToKey: 'master.avl.approve' });
  });

  it('keeps BATCH_CLOSE with the key holder (Production Manager, architecture §4); QA cannot be put there', async () => {
    const res = await put({ measure: 'NONE', bands: [{ steps: [{ stepNo: 1, roleId: await roleId('QA_MANAGER') }] }], reason: 'QA closes' }, 'BATCH_CLOSE');
    expect(res.body.error).toMatchObject({ code: 'APPROVER_ROLE_NOT_ALLOWED', details: { permission: 'prod.batch.approve_close' } });
  });

  it('refuses to start a locked approval from a rule written around the API', async () => {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id','1',true), set_config('app.company_id','1',true)`);
    await client.query(`INSERT INTO core.approval_rules (doc_type, measure, step_no, role_id) VALUES ('AVL', 'NONE', 1, $1)`, [await roleId('PLANNER')]);
    await client.query('COMMIT');
    await expect(start('AVL', { measure: 'NONE' })).rejects.toMatchObject({ code: 'APPROVER_ROLE_NOT_ALLOWED' });
    const restore = await put({ measure: 'NONE', bands: [{ steps: [{ stepNo: 1, roleId: await roleId('QA_MANAGER') }] }], reason: 'Restore AVL' }, 'AVL');
    expect(restore.status).toBe(200);
  });

  it('needs a Finance Manager countersign for every other matrix change', async () => {
    const body = { measure: 'AMOUNT_PKR', bands: [{ steps: [{ stepNo: 1, roleId: await roleId('FINANCE_MANAGER') }] }], reason: 'All payments to FM' };
    const none = await put(body, 'VENDOR_PAYMENT');
    expect(none.status).toBe(403);
    expect(none.body.error).toMatchObject({ code: 'COUNTERSIGN_REQUIRED', details: { permission: 'fin.approval_rules.countersign' } });

    const self = await put({ ...body, countersign: fmCountersign('r_admin') }, 'VENDOR_PAYMENT');
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SEGREGATION_OF_DUTIES');

    const notFinance = await put({ ...body, countersign: fmCountersign('r_qam') }, 'VENDOR_PAYMENT');
    expect(notFinance.status).toBe(403);
    expect(notFinance.body.error).toMatchObject({ code: 'FORBIDDEN', details: { permission: 'fin.approval_rules.countersign' } });

    const before = (await client.query(`SELECT failed_attempts FROM core.users WHERE id = $1`, [userIds.fm])).rows[0].failed_attempts as number;
    const wrong = await put({ ...body, countersign: fmCountersign('r_fm', 'Wrong-Pass-123') }, 'VENDOR_PAYMENT');
    expect(wrong.body.error.code).toBe('ESIGN_FAILED');
    expect((await client.query(`SELECT failed_attempts FROM core.users WHERE id = $1`, [userIds.fm])).rows[0].failed_attempts).toBe(before + 1);

    const meaning = await put({ ...body, countersign: { ...fmCountersign(), meaning: 'REVIEWED' } }, 'VENDOR_PAYMENT');
    expect(meaning.body.error.code).toBe('ESIGN_FAILED');

    const ok = await put({ ...body, countersign: fmCountersign() }, 'VENDOR_PAYMENT');
    expect(ok.status).toBe(200);
    const sigRow = await client.query(
      `SELECT user_id, meaning FROM core.e_signatures WHERE record_table = 'core.approval_rules' AND record_id = 'VENDOR_PAYMENT'`,
    );
    expect(sigRow.rows).toEqual([{ user_id: userIds.fm, meaning: 'APPROVED' }]);
  });

  it('refuses the approval when the locked key was removed from the step role after it started', async () => {
    const { approvalId } = await start('AVL', { measure: 'NONE' });
    const qaRole = await roleId('QA_MANAGER');
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id','1',true), set_config('app.company_id','1',true)`);
    await client.query(
      `DELETE FROM core.role_permissions WHERE role_id = $1 AND permission_id = (SELECT id FROM core.permissions WHERE key = 'master.avl.approve')`,
      [qaRole],
    );
    await client.query('COMMIT');
    const res = await act('qam', approvalId, 'approve');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', details: { permission: 'master.avl.approve' } });
  });
});

describe('money NUMERIC(18,2), percents NUMERIC(9,4) (rule 10, rules review D)', () => {
  it('stores PKR amounts and percents in columns of the right scale', async () => {
    const { rows } = await client.query<{ table_name: string; column_name: string; numeric_precision: number; numeric_scale: number }>(
      `SELECT table_name, column_name, numeric_precision, numeric_scale FROM information_schema.columns
        WHERE table_schema = 'core' AND table_name IN ('approvals', 'approval_rules') AND data_type = 'numeric'
        ORDER BY table_name, column_name`,
    );
    expect(rows).toEqual([
      { table_name: 'approval_rules', column_name: 'lower_amount', numeric_precision: 18, numeric_scale: 2 },
      { table_name: 'approval_rules', column_name: 'lower_percent', numeric_precision: 9, numeric_scale: 4 },
      { table_name: 'approval_rules', column_name: 'upper_amount', numeric_precision: 18, numeric_scale: 2 },
      { table_name: 'approval_rules', column_name: 'upper_percent', numeric_precision: 9, numeric_scale: 4 },
      { table_name: 'approvals', column_name: 'amount', numeric_precision: 18, numeric_scale: 2 },
      { table_name: 'approvals', column_name: 'exchange_rate', numeric_precision: 9, numeric_scale: 4 },
      { table_name: 'approvals', column_name: 'measured_amount', numeric_precision: 18, numeric_scale: 2 },
      { table_name: 'approvals', column_name: 'measured_percent', numeric_precision: 9, numeric_scale: 4 },
    ]);
  });

  it('stores a quotation discount in the percent column only', async () => {
    const { approvalId } = await start('QUOTATION_DISCOUNT', { measure: 'PERCENT', percent: '5.25' });
    const { rows } = await client.query(`SELECT measured_amount, measured_percent FROM core.approvals WHERE id = $1`, [approvalId]);
    expect(rows[0]).toEqual({ measured_amount: null, measured_percent: '5.2500' });
  });

  it('refuses a PKR band limit with more than 2 decimals', async () => {
    const pm = (await client.query<{ id: string }>(`SELECT id FROM core.roles WHERE code = 'PURCHASE_MANAGER'`)).rows[0]!.id;
    const res = await request(app)
      .put('/api/v1/core/approval-rules/PO')
      .set('Authorization', `Bearer ${tokens.admin}`)
      .send({ measure: 'AMOUNT_PKR', bands: [{ upperBound: '500000.005', steps: [{ stepNo: 1, roleId: pm }] }], reason: 'Too precise', countersign: fmCountersign() });
    expect(res.status).toBe(400);
    expect(res.body.error.details.rules).toContain('Band 1: PKR amounts take at most 2 decimals');
  });

  it('refuses, in the database, a value in the column that does not match the measure', async () => {
    const pm = (await client.query<{ id: string }>(`SELECT id FROM core.roles WHERE code = 'PURCHASE_MANAGER'`)).rows[0]!.id;
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id','1',true), set_config('app.company_id','1',true)`);
    await expect(
      client.query(`INSERT INTO core.approval_rules (doc_type, measure, upper_percent, step_no, role_id) VALUES ('X_TEST', 'AMOUNT_PKR', 5, 1, $1)`, [pm]),
    ).rejects.toThrow(/approval_rules_bounds_by_measure/);
    await client.query('ROLLBACK');
  });
});

describe('approval rules refusal paths (rules review E)', () => {
  it('refuses rules naming an unknown or inactive role', async () => {
    const put = (roleId: string) =>
      request(app)
        .put('/api/v1/core/approval-rules/MATRIX_DEMO')
        .set('Authorization', `Bearer ${tokens.admin}`)
        .send({ measure: 'NONE', bands: [{ steps: [{ stepNo: 1, roleId }] }], reason: 'Bad role', countersign: fmCountersign() });
    const unknown = await put('987654');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toMatchObject({ message: 'Unknown or inactive roles', details: { missing: ['987654'] } });

    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id','1',true), set_config('app.company_id','1',true)`);
    const { rows } = await client.query<{ id: string }>(`INSERT INTO core.roles (code, name, is_active) VALUES ('E_INACTIVE', 'Inactive', false) RETURNING id`);
    await client.query('COMMIT');
    const inactive = await put(rows[0]!.id);
    expect(inactive.status).toBe(404);
  });
});
