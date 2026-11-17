// core/esign (rule 8, Q3) and core/transition (rules 1 and 7, Q10, Q15).
// Uses a stand-in lot table with the real lot moves from docs/architecture.md §4.
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ESignRequest, WitnessSignRequest } from '@albert/shared';
import { sql } from 'drizzle-orm';
import { databaseUrl } from '../config/env';
import { systemContext, withTransaction } from '../db/client';
import { runSeed } from '../db/seed/run';
import { authenticateToken, login, txContext, type AuthContext } from '../core/auth/auth.service';
import { PROOF_TTL_MS, recordSignature, verifySignature, verifyWitness, type SignatureRecord } from '../core/esign/esign.service';
import { defineTransitions, recordInitialStatus, systemActor, transition, type Actor } from '../core/transition/transition';
import { createTestUser, TEST_PASSWORD } from '../test/factories';

const client = new pg.Client({ connectionString: databaseUrl });
const meta = { ip: '10.0.0.5', userAgent: 'vitest' };
const TABLE = 'core.t_lot';

const LotStatus = ['QUARANTINE', 'UNDER_TEST', 'APPROVED', 'REJECTED', 'HOLD', 'EXPIRED', 'DESTROYED'] as const;
type LotStatus = (typeof LotStatus)[number];

const LotMoves = defineTransitions<LotStatus>({
  entityTable: TABLE,
  statuses: LotStatus,
  moves: [
    { from: null, to: 'QUARANTINE', permission: 'purch.grn.post' },
    { from: 'QUARANTINE', to: 'UNDER_TEST', permission: 'qc.result.enter' },
    { from: 'UNDER_TEST', to: 'APPROVED', permission: 'qc.lot.change_status', esign: ['APPROVED'] },
    { from: 'UNDER_TEST', to: 'REJECTED', permission: 'qc.lot.change_status', esign: ['REJECTED'], reasonRequired: true },
    { from: 'APPROVED', to: 'HOLD', permission: 'qa.lot.hold', reasonRequired: true },
    { from: 'HOLD', to: 'APPROVED', permission: 'qa.lot.hold', esign: ['APPROVED'], reasonRequired: true },
    { from: 'HOLD', to: 'REJECTED', permission: 'qc.lot.change_status', esign: ['REJECTED'], reasonRequired: true },
    { from: 'APPROVED', to: 'EXPIRED', permission: 'SYSTEM' },
    {
      from: 'REJECTED',
      to: 'DESTROYED',
      permission: 'inv.lot.dispose',
      esign: ['PERFORMED'],
      reasonRequired: true,
      witness: { permission: 'qa.lot.witness', meanings: ['WITNESSED'] },
    },
  ],
});

const users: Record<string, AuthContext> = {};

async function signIn(username: string): Promise<AuthContext> {
  const tokens = await login({ username, password: TEST_PASSWORD }, meta);
  return authenticateToken(tokens.accessToken);
}

const sign = (meaning: ESignRequest['meaning'], password = TEST_PASSWORD): ESignRequest => ({
  password,
  meaning,
  reason: `Signed as ${meaning}`,
});

async function newLot(actor: AuthContext = users.store!): Promise<string> {
  return withTransaction(txContext(actor), async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(sql`INSERT INTO core.t_lot (status) VALUES ('QUARANTINE') RETURNING id`);
    const id = rows[0]!.id;
    await recordInitialStatus(tx, LotMoves, { entityId: id, to: 'QUARANTINE', actor });
    return id;
  });
}

interface MoveOptions {
  sign?: ESignRequest;
  witness?: WitnessSignRequest;
  reason?: string;
}

function isUser(actor: AuthContext | Actor): actor is AuthContext {
  return 'sessionId' in actor;
}

async function move(actor: AuthContext | Actor, id: string, to: LotStatus, opts: MoveOptions = {}) {
  const user = isUser(actor) ? actor : undefined;
  if ((opts.sign || opts.witness) && !user) throw new Error('only a signed-in user can sign');
  const proof = opts.sign && user ? await verifySignature(user, opts.sign, meta) : undefined;
  const witnessProof = opts.witness && user ? await verifyWitness(user, opts.witness, meta) : undefined;
  return withTransaction({ userId: actor.userId, companyId: actor.companyId }, async (tx) => {
    const signature = proof ? await recordSignature(tx, proof, { table: TABLE, id }) : undefined;
    const witness = witnessProof ? await recordSignature(tx, witnessProof, { table: TABLE, id }) : undefined;
    return transition(tx, LotMoves, { entityId: id, to, actor, signature, witness, reason: opts.reason });
  });
}

async function statusOf(id: string): Promise<string> {
  const { rows } = await client.query<{ status: string }>(`SELECT status FROM core.t_lot WHERE id = $1`, [id]);
  return rows[0]!.status;
}

async function historyOf(id: string) {
  const { rows } = await client.query(
    `SELECT from_status, to_status, actor_id, esign_id IS NOT NULL AS signed, witness_esign_id IS NOT NULL AS witnessed, reason
       FROM core.status_history WHERE entity_table = $1 AND entity_id = $2 ORDER BY id`,
    [TABLE, id],
  );
  return rows;
}

async function failedAttempts(userId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(`SELECT failed_attempts AS n FROM core.users WHERE id = $1`, [userId]);
  return rows[0]!.n;
}

/** UNDER_TEST lot, ready for QC disposition. */
async function lotUnderTest(): Promise<string> {
  const id = await newLot();
  await move(users.analyst!, id, 'UNDER_TEST');
  return id;
}

async function rejectedLot(): Promise<string> {
  const id = await lotUnderTest();
  await move(users.qcm!, id, 'REJECTED', { sign: sign('REJECTED') });
  return id;
}

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  await client.query(`
    CREATE TABLE core.t_lot (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      company_id BIGINT NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id),
      status TEXT NOT NULL CHECK (status IN ('QUARANTINE','UNDER_TEST','APPROVED','REJECTED','HOLD','EXPIRED','DESTROYED'))
    );
    SELECT core.enable_audit('core.t_lot');
    SELECT core.require_transition('core.t_lot');
  `);
  const roles: Record<string, string> = {
    store: 'STOREKEEPER',
    analyst: 'QC_ANALYST',
    qcm: 'QC_MANAGER',
    qam: 'QA_MANAGER',
    whm: 'WAREHOUSE_MANAGER',
    admin: 'SYSTEM_ADMIN',
    ceo: 'CEO',
    pm: 'PRODUCTION_MANAGER',
  };
  for (const [name, role] of Object.entries(roles)) {
    await createTestUser({ username: `t_${name}`, fullName: `Test ${role}`, roleCodes: [role] });
    users[name] = await signIn(`t_${name}`);
  }
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await client.end();
});

// ------------------------------------------------------------------ e-signatures

describe('e-signature (rule 8)', () => {
  it('re-verifies the password and stores meaning, reason, signer name and IP', async () => {
    const id = await lotUnderTest();
    await move(users.qcm!, id, 'APPROVED', { sign: { password: TEST_PASSWORD, meaning: 'APPROVED', reason: 'All tests within spec' } });
    const { rows } = await client.query(
      `SELECT signer_username, signer_name, meaning, reason, ip, record_table, record_id
         FROM core.e_signatures WHERE record_table = $1 AND record_id = $2`,
      [TABLE, id],
    );
    expect(rows).toEqual([
      {
        signer_username: 't_qcm',
        signer_name: 'Test QC_MANAGER',
        meaning: 'APPROVED',
        reason: 'All tests within spec',
        ip: '10.0.0.5',
        record_table: TABLE,
        record_id: id,
      },
    ]);
    const audit = await client.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE table_name = 'core.e_signatures'`);
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });

  it('refuses a wrong password with ESIGN_FAILED and counts the failure even though the action fails', async () => {
    await createTestUser({ username: 't_qcm2', roleCodes: ['QC_MANAGER'] });
    const qcm2 = await signIn('t_qcm2');
    const id = await lotUnderTest();
    await expect(move(qcm2, id, 'APPROVED', { sign: sign('APPROVED', 'Wrong-Password-9') })).rejects.toMatchObject({
      code: 'ESIGN_FAILED',
      status: 403,
    });
    expect(await statusOf(id)).toBe('UNDER_TEST');
    expect(await failedAttempts(qcm2.userId)).toBe(1);
    const { rows } = await client.query(`SELECT event FROM core.auth_events WHERE user_id = $1 ORDER BY id`, [qcm2.userId]);
    expect(rows.map((r) => r.event)).toEqual(['LOGIN_OK', 'ESIGN_FAIL']);
  });

  it('locks the account on the 5th wrong signature password and ends its sessions', async () => {
    await createTestUser({ username: 't_qcm3', roleCodes: ['QC_MANAGER'] });
    const qcm3 = await signIn('t_qcm3');
    for (let i = 0; i < 4; i += 1) {
      await expect(verifySignature(qcm3, sign('APPROVED', 'Wrong-Password-9'), meta)).rejects.toMatchObject({ code: 'ESIGN_FAILED' });
    }
    await expect(verifySignature(qcm3, sign('APPROVED', 'Wrong-Password-9'), meta)).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED' });
    const { rows } = await client.query(`SELECT revoke_reason FROM core.sessions WHERE user_id = $1`, [qcm3.userId]);
    expect(rows).toEqual([{ revoke_reason: 'LOCKOUT' }]);
    // Even the right password no longer signs.
    await expect(verifySignature(qcm3, sign('APPROVED'), meta)).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED' });
  });

  it('uses a signature once only', async () => {
    const id = await lotUnderTest();
    const proof = await verifySignature(users.qcm!, sign('APPROVED'), meta);
    await withTransaction(txContext(users.qcm!), (tx) => recordSignature(tx, proof, { table: TABLE, id }));
    await expect(
      withTransaction(txContext(users.qcm!), (tx) => recordSignature(tx, proof, { table: TABLE, id })),
    ).rejects.toMatchObject({ code: 'ESIGN_FAILED' });
  });

  it('refuses a signature older than 2 minutes', async () => {
    const id = await lotUnderTest();
    const proof = await verifySignature(users.qcm!, sign('APPROVED'), meta);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + PROOF_TTL_MS + 1000);
    await expect(
      withTransaction(txContext(users.qcm!), (tx) => recordSignature(tx, proof, { table: TABLE, id })),
    ).rejects.toMatchObject({ code: 'ESIGN_FAILED', message: expect.stringMatching(/expired/) });
  });

  it('keeps signatures append-only and never lets SYSTEM sign', async () => {
    await expect(client.query(`UPDATE core.e_signatures SET reason = 'changed'`)).rejects.toThrow(/APPEND_ONLY/);
    await expect(client.query(`DELETE FROM core.e_signatures`)).rejects.toThrow(/APPEND_ONLY/);
    await expect(
      withTransaction(systemContext(), (tx) =>
        tx.execute(
          sql`INSERT INTO core.e_signatures (user_id, signer_username, signer_name, meaning, reason, record_table, record_id)
              VALUES (1, 'SYSTEM', 'System', 'APPROVED', 'auto', 'x', '1')`,
        ),
      ),
    ).rejects.toThrow(/ESIGN_FAILED/);
  });
});

// ------------------------------------------------------------------ transitions

describe('status transitions (rule 7)', () => {
  it('walks QUARANTINE → UNDER_TEST → APPROVED and writes history with actor, signature and reason', async () => {
    const id = await newLot();
    await move(users.analyst!, id, 'UNDER_TEST');
    await move(users.qcm!, id, 'APPROVED', { sign: sign('APPROVED') });
    expect(await statusOf(id)).toBe('APPROVED');
    expect(await historyOf(id)).toEqual([
      { from_status: null, to_status: 'QUARANTINE', actor_id: users.store!.userId, signed: false, witnessed: false, reason: null },
      { from_status: 'QUARANTINE', to_status: 'UNDER_TEST', actor_id: users.analyst!.userId, signed: false, witnessed: false, reason: null },
      { from_status: 'UNDER_TEST', to_status: 'APPROVED', actor_id: users.qcm!.userId, signed: true, witnessed: false, reason: 'Signed as APPROVED' },
    ]);
  });

  it('refuses a move that is not in the map (409) and leaves the status unchanged', async () => {
    const id = await newLot();
    await expect(move(users.qcm!, id, 'APPROVED', { sign: sign('APPROVED') })).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
      status: 409,
      details: { from: 'QUARANTINE', to: 'APPROVED', allowed: ['UNDER_TEST'] },
    });
    expect(await statusOf(id)).toBe('QUARANTINE');
  });

  it('refuses an unknown record with NOT_FOUND', async () => {
    await expect(move(users.analyst!, '999999', 'UNDER_TEST')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('rule 1: only the right key moves a lot — no override for admin or CEO', () => {
  it.each([
    ['QC Analyst (enters results, cannot approve)', 'analyst'],
    ['QA Manager (cannot approve or reject lots)', 'qam'],
    ['System Admin', 'admin'],
    ['CEO', 'ceo'],
  ])('refuses UNDER_TEST → APPROVED by %s', async (_label, who) => {
    const id = await lotUnderTest();
    await expect(move(users[who]!, id, 'APPROVED', { sign: sign('APPROVED') })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
      details: { permission: 'qc.lot.change_status' },
    });
    expect(await statusOf(id)).toBe('UNDER_TEST');
  });

  it('lets only QA place and lift HOLD; QC cannot', async () => {
    const id = await lotUnderTest();
    await move(users.qcm!, id, 'APPROVED', { sign: sign('APPROVED') });
    await expect(move(users.qcm!, id, 'HOLD', { reason: 'Complaint received' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await move(users.qam!, id, 'HOLD', { reason: 'Complaint received' });
    await expect(move(users.qcm!, id, 'APPROVED', { sign: sign('APPROVED') })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await move(users.qam!, id, 'APPROVED', { sign: sign('APPROVED') });
    expect(await statusOf(id)).toBe('APPROVED');
  });

  it('lets only QC reject a held lot (decision: HOLD → REJECTED by QC)', async () => {
    const id = await lotUnderTest();
    await move(users.qcm!, id, 'APPROVED', { sign: sign('APPROVED') });
    await move(users.qam!, id, 'HOLD', { reason: 'Investigation' });
    await expect(move(users.qam!, id, 'REJECTED', { sign: sign('REJECTED') })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await move(users.qcm!, id, 'REJECTED', { sign: sign('REJECTED') });
    expect(await statusOf(id)).toBe('REJECTED');
  });

  it('keeps system moves for the system: no user may expire a lot, and the system may not approve one', async () => {
    const id = await lotUnderTest();
    await move(users.qcm!, id, 'APPROVED', { sign: sign('APPROVED') });
    await expect(move(users.qcm!, id, 'EXPIRED')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(move(users.admin!, id, 'EXPIRED')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await move(systemActor(), id, 'EXPIRED');
    expect((await historyOf(id)).at(-1)).toMatchObject({ to_status: 'EXPIRED', actor_id: '1' });

    const other = await lotUnderTest();
    await expect(move(systemActor(), other, 'APPROVED')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('e-signature, reason and witness requirements on a move', () => {
  it('refuses a signature-required move without a signature', async () => {
    const id = await lotUnderTest();
    await expect(move(users.qcm!, id, 'APPROVED')).rejects.toMatchObject({ code: 'ESIGN_FAILED' });
  });

  it('refuses a signature with the wrong meaning', async () => {
    const id = await lotUnderTest();
    await expect(move(users.qcm!, id, 'APPROVED', { sign: sign('REVIEWED') })).rejects.toMatchObject({ code: 'ESIGN_FAILED' });
  });

  it("refuses someone else's signature and a signature for another record", async () => {
    const id = await lotUnderTest();
    const other = await lotUnderTest();
    await createTestUser({ username: 't_qcm4', roleCodes: ['QC_MANAGER'] });
    const qcm4 = await signIn('t_qcm4');

    const foreign = await verifySignature(qcm4, sign('APPROVED'), meta);
    await expect(
      withTransaction(txContext(users.qcm!), async (tx) => {
        const signature = await recordSignature(tx, foreign, { table: TABLE, id });
        return transition(tx, LotMoves, { entityId: id, to: 'APPROVED', actor: users.qcm!, signature });
      }),
    ).rejects.toMatchObject({ code: 'ESIGN_FAILED', message: expect.stringMatching(/your own/) });

    const mine = await verifySignature(users.qcm!, sign('APPROVED'), meta);
    await expect(
      withTransaction(txContext(users.qcm!), async (tx) => {
        const signature: SignatureRecord = await recordSignature(tx, mine, { table: TABLE, id: other });
        return transition(tx, LotMoves, { entityId: id, to: 'APPROVED', actor: users.qcm!, signature });
      }),
    ).rejects.toMatchObject({ code: 'ESIGN_FAILED', message: expect.stringMatching(/different record/) });
    expect(await statusOf(id)).toBe('UNDER_TEST');
  });

  it('refuses a reason-required move without a reason', async () => {
    const id = await lotUnderTest();
    await move(users.qcm!, id, 'APPROVED', { sign: sign('APPROVED') });
    await expect(move(users.qam!, id, 'HOLD')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(move(users.qam!, id, 'HOLD', { reason: '  ' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('destroys a rejected lot only with the Warehouse Manager signature AND a QA witness', async () => {
    const id = await rejectedLot();
    const performed = sign('PERFORMED');
    const witnessed: WitnessSignRequest = { username: 't_qam', password: TEST_PASSWORD, meaning: 'WITNESSED', reason: 'Witnessed destruction' };

    await expect(move(users.whm!, id, 'DESTROYED', { sign: performed })).rejects.toMatchObject({ code: 'ESIGN_FAILED' });
    // The witness must hold qa.lot.witness (Production Manager does not).
    await expect(
      move(users.whm!, id, 'DESTROYED', { sign: performed, witness: { ...witnessed, username: 't_pm' } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The QA Manager cannot perform the disposal (no inv.lot.dispose).
    await expect(
      move(users.qam!, id, 'DESTROYED', { sign: performed, witness: { ...witnessed, username: 't_whm' } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await move(users.whm!, id, 'DESTROYED', { sign: performed, witness: witnessed });
    expect(await statusOf(id)).toBe('DESTROYED');
    expect((await historyOf(id)).at(-1)).toMatchObject({ to_status: 'DESTROYED', signed: true, witnessed: true });
  });

  it('refuses the actor as their own witness', async () => {
    const id = await rejectedLot();
    await expect(
      move(users.whm!, id, 'DESTROYED', {
        sign: sign('PERFORMED'),
        witness: { username: 't_whm', password: TEST_PASSWORD, meaning: 'WITNESSED', reason: 'Self' },
      }),
    ).rejects.toMatchObject({ code: 'SEGREGATION_OF_DUTIES', status: 403 });
  });

  it("counts a wrong witness password against the witness's own account", async () => {
    await createTestUser({ username: 't_qam2', roleCodes: ['QA_MANAGER'] });
    const before = await client.query<{ id: string }>(`SELECT id FROM core.users WHERE username = 't_qam2'`);
    const id = await rejectedLot();
    await expect(
      move(users.whm!, id, 'DESTROYED', {
        sign: sign('PERFORMED'),
        witness: { username: 't_qam2', password: 'Wrong-Password-9', meaning: 'WITNESSED', reason: 'Witness' },
      }),
    ).rejects.toMatchObject({ code: 'ESIGN_FAILED' });
    expect(await failedAttempts(before.rows[0]!.id)).toBe(1);
    expect(await failedAttempts(users.whm!.userId)).toBe(0);
  });
});

describe('database guard: status changes only through core/transition', () => {
  it('refuses a raw UPDATE of status (no history row)', async () => {
    const id = await lotUnderTest();
    await expect(
      withTransaction(txContext(users.qcm!), (tx) =>
        tx.execute(sql`UPDATE core.t_lot SET status = 'APPROVED' WHERE id = ${id}`),
      ),
    ).rejects.toThrow(/INVALID_TRANSITION/);
    expect(await statusOf(id)).toBe('UNDER_TEST');
  });

  it('refuses a raw INSERT without an initial history row', async () => {
    await expect(
      withTransaction(txContext(users.store!), (tx) => tx.execute(sql`INSERT INTO core.t_lot (status) VALUES ('APPROVED')`)),
    ).rejects.toThrow(/INVALID_TRANSITION/);
  });

  it('refuses a status change whose history row says something else', async () => {
    const id = await lotUnderTest();
    await expect(
      withTransaction(txContext(users.qcm!), async (tx) => {
        await tx.execute(
          sql`INSERT INTO core.status_history (entity_table, entity_id, from_status, to_status, actor_id)
              VALUES ('core.t_lot', ${id}, 'UNDER_TEST', 'REJECTED', ${users.qcm!.userId})`,
        );
        await tx.execute(sql`UPDATE core.t_lot SET status = 'APPROVED' WHERE id = ${id}`);
      }),
    ).rejects.toThrow(/INVALID_TRANSITION/);
  });

  it('keeps status_history append-only', async () => {
    await expect(client.query(`UPDATE core.status_history SET reason = 'x'`)).rejects.toThrow(/APPEND_ONLY/);
    await expect(client.query(`DELETE FROM core.status_history`)).rejects.toThrow(/APPEND_ONLY/);
  });

  it('rolls back status, history and signature together when the business transaction fails', async () => {
    const id = await lotUnderTest();
    const proof = await verifySignature(users.qcm!, sign('APPROVED'), meta);
    await expect(
      withTransaction(txContext(users.qcm!), async (tx) => {
        const signature = await recordSignature(tx, proof, { table: TABLE, id });
        await transition(tx, LotMoves, { entityId: id, to: 'APPROVED', actor: users.qcm!, signature });
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect(await statusOf(id)).toBe('UNDER_TEST');
    expect((await historyOf(id)).length).toBe(2);
    const sigs = await client.query(`SELECT count(*)::int AS n FROM core.e_signatures WHERE record_id = $1`, [id]);
    expect(sigs.rows[0].n).toBe(0);
  });

  it('serialises concurrent moves on the same record: the second sees the new status', async () => {
    const id = await lotUnderTest();
    const results = await Promise.allSettled([
      move(users.qcm!, id, 'APPROVED', { sign: sign('APPROVED') }),
      move(users.qcm!, id, 'REJECTED', { sign: sign('REJECTED') }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: 'INVALID_TRANSITION' });
    expect((await historyOf(id)).length).toBe(3);
  });
});

describe('defineTransitions', () => {
  it('refuses duplicate moves and unknown statuses at startup', () => {
    expect(() =>
      defineTransitions({
        entityTable: 'core.x',
        statuses: ['A', 'B'] as const,
        moves: [
          { from: 'A', to: 'B', permission: 'qc.view' },
          { from: 'A', to: 'B', permission: 'qc.view' },
        ],
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      defineTransitions({ entityTable: 'core.x', statuses: ['A'] as const, moves: [{ from: 'A', to: 'Z' as 'A', permission: 'qc.view' }] }),
    ).toThrow(/unknown status/);
  });
});
