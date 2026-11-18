// engines/posting (M2 task 7): system journals from posting rules, stock journals in the same transaction as their
// movements (rule 5), toll = no journal (rule 12), reversals as mirror entries (rule 4), status through
// core/transition (rule 7), closed periods refused (rule 11), and the owner's rounding sweep (18-11-2026):
// a lot with zero quantity has zero value. Real database, PLACEHOLDER chart from the seed.
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl } from '../../../config/env';
import { systemContext, withTransaction, type Tx } from '../../../db/client';
import { runSeed } from '../../../db/seed/run';
import { permissionKeysForUser } from '../../../core/auth/auth.repo';
import type { Actor } from '../../../core/transition/transition';
import { createTestUser } from '../../../test/factories';
import { createLot, postMovement, reverseMovements, transfer, type MovementInput, type NewLot, type PostedMovement } from '../../inventory';
import { postJournal, postStockJournal, reverseJournal, reverseStockJournal, type JournalEntry } from '..';

const client = new pg.Client({ connectionString: databaseUrl });
const ids: Record<string, string> = {};
const acct: Record<string, string> = {};
const actors: Record<string, Actor> = {};
let seq = 0;
let docSeq = 100;

const history = (table: string, id: string, from: string | null, to: string, actor = '1') =>
  client.query(`INSERT INTO core.status_history (entity_table, entity_id, from_status, to_status, actor_id) VALUES ($1, $2, $3, $4, $5)`, [
    table, id, from, to, actor,
  ]);
async function inTx(userId: string, work: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.user_id', $1, true), set_config('app.company_id', '1', true)`, [userId]);
    await work();
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
async function actorFor(username: string, roleCodes: string[]): Promise<Actor> {
  const userId = await createTestUser({ username, roleCodes });
  const keys = await withTransaction(systemContext('test'), (tx) => permissionKeysForUser(tx, userId));
  return { userId, companyId: '1', permissions: new Set(keys) };
}
/** One business transaction as `who` (as a module service runs it). */
const as = <T>(who: string, work: (tx: Tx, actor: Actor) => Promise<T>) =>
  withTransaction({ userId: actors[who]!.userId, companyId: '1' }, (tx) => work(tx, actors[who]!));

async function setLot(lotId: string, ...path: string[]): Promise<void> {
  await withTransaction(systemContext('test'), async (tx) => {
    const { rows } = await tx.execute<{ status: string }>(sql`SELECT status FROM inv.lots WHERE id = ${lotId}`);
    let from = rows[0]!.status;
    for (const to of path) {
      await tx.execute(sql`INSERT INTO core.status_history (entity_table, entity_id, from_status, to_status, actor_id)
                           VALUES ('inv.lots', ${lotId}, ${from}, ${to}, 1)`);
      await tx.execute(sql`UPDATE inv.lots SET status = ${to} WHERE id = ${lotId}`);
      from = to;
    }
  });
}

const newLot = (o: Partial<NewLot> = {}) =>
  as('store', (tx, a) => createLot(tx, a, { source: 'GRN', itemId: ids.rm!, lotNo: `P-${++seq}`, unitCost: '10.00', ...o }));

const mv = (o: Partial<MovementInput>): MovementInput => ({
  ...(o.type === 'DISPATCH' || o.type === 'SALES_RETURN' ? { customerId: ids.toll! } : {}), // 0018: these name a customer
  type: 'RECEIPT',
  lotId: '0',
  locationId: ids.loc1!,
  qty: '1',
  date: '2026-11-18',
  refDocType: 'TEST',
  refDocId: String(++docSeq),
  ...o,
});

/** Movement + its journal in one transaction (rule 5), as a module service does. */
const postWithJournal = (o: Partial<MovementInput>, who = 'store') =>
  as(who, async (tx, a) => {
    const m = await postMovement(tx, a, mv(o));
    const posting = await postStockJournal(tx, a, { movements: [m], narration: `${m.movementType} test` });
    return { m, ...posting };
  });

async function receivedLot(qty: string, o: Partial<NewLot> = {}, approve = true): Promise<string> {
  const l = await newLot(o);
  await postWithJournal({ lotId: l.id, qty });
  if (approve) await setLot(l.id, 'UNDER_TEST', 'APPROVED');
  return l.id;
}

const lineView = (e: JournalEntry) =>
  e.lines.map((l) => [Object.keys(acct).find((c) => acct[c] === l.accountId), l.debit, l.credit]);

async function ledger(lotId: string) {
  const { rows } = await client.query<{ qty: string; value: string }>(
    `SELECT COALESCE(sum(qty), 0)::text AS qty, COALESCE(sum(value), 0)::text AS value FROM inv.stock_movements WHERE lot_id = $1`,
    [lotId],
  );
  return rows[0]!;
}
/** Inventory GL (all INVENTORY accounts in use) vs the sum of own-stock ledger values: equal after every posting. */
async function glEqualsLedger(): Promise<{ gl: string; ledger: string }> {
  const { rows: gl } = await client.query<{ v: string }>(
    `SELECT COALESCE(sum(l.debit - l.credit), 0)::text AS v FROM fin.journal_lines l
       JOIN fin.journal_entries e ON e.id = l.entry_id
      WHERE e.status IN ('POSTED', 'REVERSED') AND e.source_type <> 'NOSTOCK' AND l.account_id IN (SELECT account_id FROM fin.posting_rules WHERE account_role = 'INVENTORY')`,
  );
  const { rows: led } = await client.query<{ v: string }>(
    `SELECT COALESCE(sum(m.value), 0)::text AS v FROM inv.stock_movements m JOIN inv.lots l ON l.id = m.lot_id WHERE l.owner_type = 'OWN'`,
  );
  return { gl: gl[0]!.v, ledger: led[0]!.v };
}

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  actors.store = await actorFor('p_store', ['STOREKEEPER']);
  actors.fm = await actorFor('p_fm', ['FINANCE_MANAGER']);
  const wm = await createTestUser({ username: 'p_wm', roleCodes: ['WAREHOUSE_MANAGER'] });
  const qa = await createTestUser({ username: 'p_qa', roleCodes: ['QA_MANAGER'] });
  const fm = actors.fm.userId;

  const one = async (text: string, params: unknown[] = []) => (await client.query<{ id: string }>(text, params)).rows[0]!.id;
  for (const { id, code } of (await client.query<{ id: string; code: string }>(`SELECT id, code FROM fin.accounts`)).rows) acct[code] = id;
  await inTx('1', async () => {
    ids.uom = await one(`INSERT INTO master.uoms (code, name) VALUES ('KG', 'Kilogram') RETURNING id`);
    ids.category = await one(`INSERT INTO master.item_categories (code, name) VALUES ('RM', 'Raw material') RETURNING id`);
    ids.apiCategory = await one(`INSERT INTO master.item_categories (code, name) VALUES ('API', 'Active ingredient') RETURNING id`);
    const wh = await one(`INSERT INTO master.warehouses (code, name) VALUES ('MAIN', 'Main store') RETURNING id`);
    ids.loc1 = await one(`INSERT INTO master.locations (warehouse_id, code, name) VALUES ($1, 'A1', 'Rack A1') RETURNING id`, [wh]);
    ids.loc2 = await one(`INSERT INTO master.locations (warehouse_id, code, name) VALUES ($1, 'A2', 'Rack A2') RETURNING id`, [wh]);
    ids.toll = await one(
      `INSERT INTO master.customers (code, name, ntn, is_toll_customer, status) VALUES ('TOLL1', 'Toll', '1234567', true, 'ACTIVE') RETURNING id`,
    );
    await history('master.customers', ids.toll, null, 'ACTIVE');
  });
  for (const [key, code, category] of [['rm', 'RM-1', ids.category], ['api', 'API-1', ids.apiCategory]] as const) {
    await inTx(wm, async () => {
      ids[key] = await one(
        `INSERT INTO master.items (code, name, type, category_id, base_uom_id, status) VALUES ($1, $1, 'RM', $2, $3, 'DRAFT') RETURNING id`,
        [code, category, ids.uom],
      );
      await history('master.items', ids[key]!, null, 'DRAFT', wm);
    });
    await inTx(qa, async () => {
      await history('master.items', ids[key]!, 'DRAFT', 'ACTIVE', qa);
      await client.query(`UPDATE master.items SET status = 'ACTIVE' WHERE id = $1`, [ids[key]]);
    });
  }
  await inTx(fm, async () => {
    // A separate stock account for the API category (Finance adds such rules; the default covers the rest).
    acct['1315'] = await one(
      `INSERT INTO fin.accounts (code, name, type, parent_id) VALUES ('1315', 'Stock - API', 'ASSET', $1) RETURNING id`,
      [acct['1300']],
    );
    for (const event of ['GRN_RECEIPT', 'MATERIAL_ISSUE', 'MATERIAL_RETURN', 'ROUNDING_DIFFERENCE']) {
      await client.query(`INSERT INTO fin.posting_rules (event, account_role, item_category_id, account_id) VALUES ($1, 'INVENTORY', $2, $3)`, [
        event, ids.apiCategory, acct['1315'],
      ]);
    }
    for (const [no, name, start, end, status] of [
      [4, 'Oct-2026', '2026-10-01', '2026-10-31', 'CLOSED'],
      [5, 'Nov-2026', '2026-11-01', '2026-11-30', 'OPEN'],
      [6, 'Dec-2026', '2026-12-01', '2026-12-31', 'OPEN'],
    ] as const) {
      const id = await one(
        `INSERT INTO core.fiscal_periods (fiscal_year, period_no, name, start_date, end_date, status) VALUES ('2026-27', $1, $2, $3, $4, 'OPEN') RETURNING id`,
        [no, name, start, end],
      );
      await history('core.fiscal_periods', id, null, 'OPEN', fm);
      if (status === 'CLOSED') {
        await history('core.fiscal_periods', id, 'OPEN', 'CLOSED', fm);
        await client.query(`UPDATE core.fiscal_periods SET status = 'CLOSED' WHERE id = $1`, [id]);
      }
    }
  });
});

afterAll(async () => {
  await client.end();
});

describe('postStockJournal', () => {
  it('posts a receipt and its journal in one transaction: SJ series, balanced, POSTED, names its source (rule 5)', async () => {
    const l = await newLot({ unitCost: '3.33' });
    const { m, entry, rounding } = await postWithJournal({ lotId: l.id, qty: '1.2345', refDocType: 'GRN', refDocId: '501' });
    expect(m.value).toBe('4.11');
    expect(rounding).toBeNull();
    expect(entry).toMatchObject({ status: 'POSTED', event: 'GRN_RECEIPT', sourceType: 'GRN', sourceId: '501', entryDate: '2026-11-18', reversalOf: null });
    expect(entry!.docNo).toMatch(/^SJ/);
    expect(entry!.postedBy).toBe(actors.store!.userId);
    expect(lineView(entry!)).toEqual([['1310', '4.11', '0.00'], ['2120', '0.00', '4.11']]);
    const { rows } = await client.query(`SELECT from_status, to_status FROM core.status_history WHERE entity_table = 'fin.journal_entries' AND entity_id = $1 ORDER BY id`, [
      entry!.id,
    ]);
    expect(rows).toEqual([{ from_status: null, to_status: 'DRAFT' }, { from_status: 'DRAFT', to_status: 'POSTED' }]);
    expect(await glEqualsLedger()).toSatisfy(({ gl, ledger }: { gl: string; ledger: string }) => gl === ledger);
  });

  it('takes the item category rule when there is one, else the default; issue credits stock, debits WIP', async () => {
    const apiLot = await receivedLot('10', { itemId: ids.api });
    const { entry } = await postWithJournal({ type: 'ISSUE', lotId: apiLot, qty: '4' });
    expect(lineView(entry!)).toEqual([['1315', '0.00', '40.00'], ['1320', '40.00', '0.00']]);
    const rmLot = await receivedLot('10');
    const { entry: e2 } = await postWithJournal({ type: 'ISSUE_RETURN', lotId: rmLot, qty: '2' });
    expect(lineView(e2!)).toEqual([['1310', '20.00', '0.00'], ['1320', '0.00', '20.00']]);
  });

  it('customer-owned (toll) stock moves with no journal (rule 12)', async () => {
    const l = await newLot({ ownerCustomerId: ids.toll, unitCost: '0' });
    const { m, entry, rounding } = await postWithJournal({ lotId: l.id, qty: '50' });
    expect(m).toMatchObject({ customerOwned: true, value: '0.00' });
    expect(entry).toBeNull();
    expect(rounding).toBeNull();
    const { rows } = await client.query(`SELECT 1 FROM fin.journal_entries WHERE source_type = 'TEST' AND source_id = $1`, [m.refDocId]);
    expect(rows).toHaveLength(0);
  });

  it('an actor without the event key posts nothing: the movement rolls back with the journal', async () => {
    const lotId = await receivedLot('5');
    const doc = String(++docSeq);
    // The Finance Manager holds no stock key; even if a module let the movement through, the journal refuses it.
    const fmWithIssue: Actor = { ...actors.fm!, permissions: new Set([...actors.fm!.permissions]) };
    await expect(
      withTransaction({ userId: fmWithIssue.userId, companyId: '1' }, async (tx) => {
        const m = await postMovement(tx, fmWithIssue, mv({ type: 'ISSUE', lotId, qty: '1', refDocId: doc }));
        await postStockJournal(tx, fmWithIssue, { movements: [m], narration: 'x' });
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await ledger(lotId)).toEqual({ qty: '5.0000', value: '50.00' });
    const { rows } = await client.query(`SELECT 1 FROM inv.stock_movements WHERE ref_doc_id = $1`, [doc]);
    expect(rows).toHaveLength(0);
  });

  it('a failure in the journal rolls back the movement (one transaction, rule 5)', async () => {
    const lotId = await receivedLot('5');
    await withTransaction(systemContext('test'), (tx) => tx.execute(sql`UPDATE fin.posting_rules SET is_active = false WHERE event = 'MATERIAL_ISSUE' AND account_role = 'WIP'`));
    try {
      await expect(postWithJournal({ type: 'ISSUE', lotId, qty: '1' })).rejects.toMatchObject({ code: 'POSTING_RULE_MISSING' });
    } finally {
      await withTransaction(systemContext('test'), (tx) => tx.execute(sql`UPDATE fin.posting_rules SET is_active = true WHERE event = 'MATERIAL_ISSUE' AND account_role = 'WIP'`));
    }
    expect(await ledger(lotId)).toEqual({ qty: '5.0000', value: '50.00' });
  });

  it('refuses transfers, reversal rows, a sales return into a released lot, mixed events, documents or dates', async () => {
    const lotId = await receivedLot('10');
    const run = (work: (tx: Tx, a: Actor) => Promise<unknown>) => as('store', work);
    await expect(
      run(async (tx, a) => {
        const pair = await transfer(tx, a, { lotId, fromLocationId: ids.loc1!, toLocationId: ids.loc2!, qty: '1', date: '2026-11-18', refDocType: 'TEST', refDocId: '9' });
        await postStockJournal(tx, a, { movements: pair, narration: 'x' });
      }),
    ).rejects.toThrow(/Transfers .* post no journal/);
    await expect(
      run(async (tx, a) => {
        const m = await postMovement(tx, a, mv({ type: 'SALES_RETURN', lotId, qty: '1' }));
        await postStockJournal(tx, a, { movements: [m], narration: 'x' });
      }),
    ).rejects.toThrow(/SALES_RETURN goes into a lot made for it/); // owner Q9: only into a new return lot
    await expect(
      run(async (tx, a) => {
        const doc = mv({}).refDocId;
        const i = await postMovement(tx, a, mv({ type: 'ISSUE', lotId, qty: '1', refDocId: doc }));
        const r = await postMovement(tx, a, mv({ type: 'ISSUE_RETURN', lotId, qty: '1', refDocId: doc }));
        await postStockJournal(tx, a, { movements: [i, r], narration: 'x' });
      }),
    ).rejects.toThrow(/One journal posts one event/);
    await expect(
      run(async (tx, a) => {
        const i = await postMovement(tx, a, mv({ type: 'ISSUE', lotId, qty: '1' }));
        const j = await postMovement(tx, a, mv({ type: 'ISSUE', lotId, qty: '1' }));
        await postStockJournal(tx, a, { movements: [i, j], narration: 'x' });
      }),
    ).rejects.toThrow(/one document/);
    await expect(
      run(async (tx, a) => {
        const doc = mv({}).refDocId;
        const i = await postMovement(tx, a, mv({ type: 'ISSUE', lotId, qty: '1', refDocId: doc }));
        const j = await postMovement(tx, a, mv({ type: 'ISSUE', lotId, qty: '1', refDocId: doc, date: '2026-12-01' }));
        await postStockJournal(tx, a, { movements: [i, j], narration: 'x' });
      }),
    ).rejects.toThrow(/one date/);
    await expect(
      run(async (tx, a) => {
        const i = await postMovement(tx, a, mv({ type: 'ISSUE', lotId, qty: '1' }));
        const [r] = await reverseMovements(tx, a, { movementIds: [i.id], date: '2026-11-18', refDocType: 'TEST', refDocId: '9' });
        await postStockJournal(tx, a, { movements: [r!], narration: 'x' });
      }),
    ).rejects.toThrow(/reverseStockJournal/);
    await expect(run((tx, a) => postStockJournal(tx, a, { movements: [], narration: 'x' }))).rejects.toThrow(/Name the movements/);
    expect(await ledger(lotId)).toEqual({ qty: '10.0000', value: '100.00' });
  });
});

describe('postJournal', () => {
  const lines = (debit = '10.00', credit = '10.00') => [
    { role: 'INVENTORY' as const, debit },
    { role: 'GRNI' as const, credit },
  ];
  const base = { event: 'GRN_RECEIPT' as const, sourceType: 'NOSTOCK', sourceId: '777', date: '2026-11-18', narration: 'manual test' };
  const postAs = (who: string, input: Parameters<typeof postJournal>[2]) => as(who, (tx, a) => postJournal(tx, a, input));

  it('posts a balanced journal; refuses unbalanced, one-line, two-sided, wrong-role and bad amounts', async () => {
    const e = await postAs('store', { ...base, lines: lines() });
    expect(lineView(e)).toEqual([['1310', '10.00', '0.00'], ['2120', '0.00', '10.00']]);
    await expect(postAs('store', { ...base, lines: lines('10.00', '9.99') })).rejects.toMatchObject({ code: 'JOURNAL_UNBALANCED' });
    await expect(postAs('store', { ...base, lines: [{ role: 'INVENTORY', debit: '1' }] })).rejects.toMatchObject({ code: 'JOURNAL_UNBALANCED' });
    await expect(
      postAs('store', { ...base, lines: [{ role: 'INVENTORY', debit: '1', credit: '1' }, { role: 'GRNI', credit: '0' }] }),
    ).rejects.toThrow(/debit or a credit/);
    await expect(postAs('store', { ...base, lines: [{ role: 'INVENTORY', debit: '1' }, { role: 'COGS', credit: '1' }] })).rejects.toThrow(
      /does not use account role COGS/,
    );
    await expect(postAs('store', { ...base, lines: lines('1.005', '1.005') })).rejects.toThrow(/at most 2 decimals/);
  });

  it('refuses a closed or undefined period (rule 11), an actor without the key, events without a key yet', async () => {
    await expect(postAs('store', { ...base, date: '2026-10-15', lines: lines() })).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    await expect(postAs('store', { ...base, date: '2030-01-01', lines: lines() })).rejects.toMatchObject({ code: 'PERIOD_NOT_DEFINED' });
    await expect(postAs('fm', { ...base, lines: lines() })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      postAs('fm', { ...base, event: 'VENDOR_INVOICE', lines: [{ role: 'GRNI', debit: '1' }, { role: 'ACCOUNTS_PAYABLE', credit: '1' }] }),
    ).rejects.toThrow(/No posting key is defined for VENDOR_INVOICE/);
    await expect(
      postAs('store', { ...base, event: 'ROUNDING_DIFFERENCE', lines: [{ role: 'INVENTORY', debit: '1' }, { role: 'ROUNDING_DIFFERENCE', credit: '1' }] }),
    ).rejects.toThrow(/only by the stock sweep/);
    await expect(postAs('store', { ...base, sourceType: 'MANUAL', lines: lines() })).rejects.toThrow(/names its source document/);
    const { rows } = await client.query(`SELECT 1 FROM fin.journal_entries WHERE source_id = 777 AND entry_date <> '2026-11-18'`);
    expect(rows).toHaveLength(0);
  });
});

describe('reverseJournal', () => {
  it('posts the mirror and marks the original REVERSED, once; a reversal or a rounding entry is never reversed', async () => {
    const e = await as('store', (tx, a) =>
      postJournal(tx, a, {
        event: 'GRN_RECEIPT', sourceType: 'NOSTOCK', sourceId: '778', date: '2026-11-18', narration: 'to reverse',
        lines: [{ role: 'INVENTORY', debit: '70.00' }, { role: 'GRNI', credit: '70.00' }],
      }),
    );
    await expect(as('store', (tx, a) => reverseJournal(tx, a, { entryId: e.id, date: '2026-12-01', reason: '' }))).rejects.toThrow(/reason/);
    await expect(as('fm', (tx, a) => reverseJournal(tx, a, { entryId: e.id, date: '2026-12-01', reason: 'wrong GRN' }))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    const r = await as('store', (tx, a) => reverseJournal(tx, a, { entryId: e.id, date: '2026-12-01', reason: 'wrong GRN' }));
    expect(r).toMatchObject({ status: 'POSTED', reversalOf: e.id, event: 'GRN_RECEIPT', sourceType: 'NOSTOCK', sourceId: '778', entryDate: '2026-12-01' });
    expect(lineView(r)).toEqual([['1310', '0.00', '70.00'], ['2120', '70.00', '0.00']]);
    const { rows } = await client.query(`SELECT status, reversal_id FROM fin.journal_entries WHERE id = $1`, [e.id]);
    expect(rows[0]).toEqual({ status: 'REVERSED', reversal_id: r.id });
    const { rows: h } = await client.query(
      `SELECT reason FROM core.status_history WHERE entity_table = 'fin.journal_entries' AND entity_id = $1 AND to_status = 'REVERSED'`,
      [e.id],
    );
    expect(h).toEqual([{ reason: 'wrong GRN' }]);
    await expect(as('store', (tx, a) => reverseJournal(tx, a, { entryId: e.id, date: '2026-12-01', reason: 'again' }))).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
    await expect(as('store', (tx, a) => reverseJournal(tx, a, { entryId: r.id, date: '2026-12-01', reason: 'undo' }))).rejects.toThrow(/itself a reversal/);
    await expect(as('store', (tx, a) => reverseJournal(tx, a, { entryId: '999999', date: '2026-12-01', reason: 'x y z' }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('reverseStockJournal', () => {
  it('reverses an issue with its journal; GL still equals the ledger', async () => {
    const lotId = await receivedLot('10');
    const { m, entry } = await postWithJournal({ type: 'ISSUE', lotId, qty: '3' });
    const out = await as('store', async (tx, a) => {
      const rows = await reverseMovements(tx, a, { movementIds: [m.id], date: '2026-11-18', refDocType: 'TEST', refDocId: String(++docSeq) });
      return reverseStockJournal(tx, a, { entryId: entry!.id, movements: rows, reason: 'issued to the wrong batch' });
    });
    expect(out.entry).toMatchObject({ reversalOf: entry!.id });
    expect(lineView(out.entry!)).toEqual([['1310', '30.00', '0.00'], ['1320', '0.00', '30.00']]);
    expect(await ledger(lotId)).toEqual({ qty: '10.0000', value: '100.00' });
    const { gl, ledger: led } = await glEqualsLedger();
    expect(gl).toBe(led);
  });

  it('refuses a journal that does not match the movements; everything rolls back', async () => {
    const lotId = await receivedLot('10');
    const a1 = await postWithJournal({ type: 'ISSUE', lotId, qty: '3' });
    const a2 = await postWithJournal({ type: 'ISSUE', lotId, qty: '2' });
    const reverse = (entryId: string | null, ids: string[]) =>
      as('store', async (tx, a) => {
        const rows = await reverseMovements(tx, a, { movementIds: ids, date: '2026-11-18', refDocType: 'TEST', refDocId: '9' });
        return reverseStockJournal(tx, a, { entryId, movements: rows, reason: 'test reversal' });
      });
    await expect(reverse(a2.entry!.id, [a1.m.id])).rejects.toThrow(/belongs to another document/);
    await expect(reverse(null, [a1.m.id])).rejects.toThrow(/name the journal entry/);
    await expect(
      as('store', (tx, a) => reverseStockJournal(tx, a, { entryId: a1.entry!.id, movements: [a1.m], reason: 'x y z' })),
    ).rejects.toThrow(/not a reversal/);
    expect(await ledger(lotId)).toEqual({ qty: '5.0000', value: '50.00' });

    // One document, two issues, one journal: reversing only one of them would leave the GL off the ledger.
    const doc = String(++docSeq);
    const both = await as('store', async (tx, a) => {
      const i1 = await postMovement(tx, a, mv({ type: 'ISSUE', lotId, qty: '1', refDocId: doc }));
      const i2 = await postMovement(tx, a, mv({ type: 'ISSUE', lotId, qty: '2', refDocId: doc }));
      return { i1, ...(await postStockJournal(tx, a, { movements: [i1, i2], narration: 'two issues' })) };
    });
    expect(lineView(both.entry!)).toEqual([['1310', '0.00', '30.00'], ['1320', '30.00', '0.00']]);
    await expect(reverse(both.entry!.id, [both.i1.id])).rejects.toThrow(/carries 30.00, the movements 10.00/);
    expect(await ledger(lotId)).toEqual({ qty: '2.0000', value: '20.00' });
  });
});

describe('rounding sweep (owner, 18-11-2026: a lot with zero quantity has zero value)', () => {
  /** Reversal of a return that empties the lot: the mirror leaves -0.01 on it; the sweep takes it to the rounding account. */
  it('after a reversal empties a lot with paisa left, sweeps them to the Rounding difference account', async () => {
    const lotId = await receivedLot('1', { unitCost: '3.33' }); // 3.33
    await postWithJournal({ type: 'ISSUE', lotId, qty: '0.5' }); // -1.67 → 0.5 / 1.66
    const ret = await postWithJournal({ type: 'ISSUE_RETURN', lotId, qty: '0.5' }); // +1.67 → 1 / 3.33
    await postWithJournal({ type: 'ISSUE', lotId, qty: '0.5' }); // -1.67 → 0.5 / 1.66
    const out = await as('store', async (tx, a) => {
      const rows = await reverseMovements(tx, a, { movementIds: [ret.m.id], date: '2026-11-18', refDocType: 'TEST', refDocId: String(++docSeq) });
      return reverseStockJournal(tx, a, { entryId: ret.entry!.id, movements: rows, reason: 'return booked twice' });
    }); // -1.67 → 0 / -0.01 → swept +0.01
    expect(out.rounding!.movements).toMatchObject([{ movementType: 'ROUNDING_SWEEP', qty: '0.0000', value: '0.01', locationId: null }]);
    expect(out.rounding!.entry).toMatchObject({ event: 'ROUNDING_DIFFERENCE', status: 'POSTED', sourceId: out.rounding!.movements[0]!.refDocId });
    expect(lineView(out.rounding!.entry)).toEqual([['1310', '0.01', '0.00'], ['5400', '0.00', '0.01']]);
    expect(await ledger(lotId)).toEqual({ qty: '0.0000', value: '0.00' });
    const { gl, ledger: led } = await glEqualsLedger();
    expect(gl).toBe(led);
  });

  it('after a last-out that cannot take a negative value, sweeps it in the same posting', async () => {
    const lotId = await receivedLot('1', { unitCost: '0.03' }); // 0.03
    const ret = await postWithJournal({ type: 'ISSUE_RETURN', lotId, qty: '0.25' }); // +0.01 → 1.25 / 0.04
    for (let i = 0; i < 4; i++) await postWithJournal({ type: 'ISSUE', lotId, qty: '0.2' }); // 0.01 each (last one capped) → 0.45 / 0.00
    expect(await ledger(lotId)).toEqual({ qty: '0.4500', value: '0.00' });
    await as('store', async (tx, a) => {
      const rows = await reverseMovements(tx, a, { movementIds: [ret.m.id], date: '2026-11-18', refDocType: 'TEST', refDocId: String(++docSeq) });
      return reverseStockJournal(tx, a, { entryId: ret.entry!.id, movements: rows, reason: 'return reversed' });
    }); // 0.20 / -0.01: stock remains, nothing to sweep yet
    expect(await ledger(lotId)).toEqual({ qty: '0.2000', value: '-0.01' });
    const last = await postWithJournal({ type: 'ISSUE', lotId, qty: '0.2' }); // last-out takes max(value, 0) = 0
    expect(last.m.value).toBe('0.00');
    expect(last.entry).toBeNull();
    expect(lineView(last.rounding!.entry)).toEqual([['1310', '0.01', '0.00'], ['5400', '0.00', '0.01']]);
    expect(await ledger(lotId)).toEqual({ qty: '0.0000', value: '0.00' });
    const { gl, ledger: led } = await glEqualsLedger();
    expect(gl).toBe(led);
  });

  it('a positive leftover goes the other way (debit Rounding difference), on the item category stock account', async () => {
    const lotId = await receivedLot('1', { unitCost: '3.33', itemId: ids.api }); // 3.33
    await postWithJournal({ type: 'ISSUE', lotId, qty: '0.25' }); // 0.8325 → -0.83 → 0.75 / 2.50
    await postWithJournal({ type: 'ISSUE', lotId, qty: '0.25' }); // → 0.50 / 1.67
    const ret = await postWithJournal({ type: 'ISSUE_RETURN', lotId, qty: '0.25' }); // +0.83 → 0.75 / 2.50
    await postWithJournal({ type: 'ISSUE', lotId, qty: '0.25' }); // → 0.50 / 1.67
    await postWithJournal({ type: 'ISSUE', lotId, qty: '0.25' }); // → 0.25 / 0.84
    const out = await as('store', async (tx, a) => {
      const rows = await reverseMovements(tx, a, { movementIds: [ret.m.id], date: '2026-11-18', refDocType: 'TEST', refDocId: String(++docSeq) });
      return reverseStockJournal(tx, a, { entryId: ret.entry!.id, movements: rows, reason: 'return reversed' });
    }); // -0.83 → 0 / 0.01 → swept -0.01
    expect(out.rounding!.movements).toMatchObject([{ value: '-0.01' }]);
    expect(lineView(out.rounding!.entry)).toEqual([['1315', '0.00', '0.01'], ['5400', '0.01', '0.00']]);
    expect(await ledger(lotId)).toEqual({ qty: '0.0000', value: '0.00' });
    const { gl, ledger: led } = await glEqualsLedger();
    expect(gl).toBe(led);
  });

  it('a commit that leaves an empty lot holding value is refused when the posting engine is bypassed (0016)', async () => {
    const lotId = await receivedLot('1', { unitCost: '3.33' });
    await postWithJournal({ type: 'ISSUE', lotId, qty: '0.5' });
    const ret = await postWithJournal({ type: 'ISSUE_RETURN', lotId, qty: '0.5' });
    await postWithJournal({ type: 'ISSUE', lotId, qty: '0.5' });
    await expect(
      as('store', (tx, a) => reverseMovements(tx, a, { movementIds: [ret.m.id], date: '2026-11-18', refDocType: 'TEST', refDocId: '9' })),
    ).rejects.toThrow(/holds no stock but -0.01 of value/);
    expect(await ledger(lotId)).toEqual({ qty: '0.5000', value: '1.66' });
  });
});
