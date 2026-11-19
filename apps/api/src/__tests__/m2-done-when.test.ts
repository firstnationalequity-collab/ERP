// M2 "Done when" (docs/build-plan.md M2, task 8), against a freshly migrated database through the real engines:
//  1. a test receipt posts a stock movement AND a balanced journal in one transaction;
//  2. a forced error rolls back both;
//  3. negative stock is refused by the database;
//  4. customer-owned (toll) stock posts no journal (rule 12);
//  5. GL inventory = Σ ledger movement values after EVERY movement type (owner, 18-11-2026; not qty × unit cost),
//     including value-only adjustments and customer returns (owner Q8/Q9, 18-11-2026), reversals and the rounding
//     sweep — checked per inventory account, and the walk must cover every StockMovementType.
import pg from 'pg';
import { Decimal } from 'decimal.js';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StockMovementType } from '@albert/shared';
import { databaseUrl } from '../config/env';
import { systemContext, withTransaction, type Tx } from '../db/client';
import { runSeed } from '../db/seed/run';
import { permissionKeysForUser } from '../core/auth/auth.repo';
import type { Actor } from '../core/transition/transition';
import { verifyWitness } from '../core/esign/esign.service';
import { createTestUser, TEST_PASSWORD } from '../test/factories';
import {
  closeBatchCost,
  closeDisposedLot,
  createLot,
  disposalSubject,
  type DisposalMovementType,
  createReturnLot,
  fgUnitCost,
  postMovement,
  reverseMovements,
  transfer,
  type MovementInput,
  type NewLot,
  type PostedMovement,
} from '../engines/inventory';
import { postStockJournal, reverseStockJournal, type JournalEntry, type StockPosting } from '../engines/posting';

const client = new pg.Client({ connectionString: databaseUrl });
const ids: Record<string, string> = {};
const acct: Record<string, string> = {};
const actors: Record<string, Actor> = {};
let docSeq = 7000;
const DATE = '2026-11-18';

const history = (table: string, id: string, from: string | null, to: string, actor = '1') =>
  client.query(`INSERT INTO core.status_history (entity_table, entity_id, from_status, to_status, actor_id) VALUES ($1, $2, $3, $4, $5)`, [
    table, id, from, to, actor,
  ]);
async function inTx(userId: string, work: () => Promise<unknown>): Promise<void> {
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
/** One business transaction as `who`, as a module service runs it. */
const as = <T>(who: string, work: (tx: Tx, actor: Actor) => Promise<T>) =>
  withTransaction({ userId: actors[who]!.userId, companyId: '1' }, (tx) => work(tx, actors[who]!));

/** QC / QA status moves (their modules come later), history first as core/transition does. */
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

const doc = () => String(++docSeq);
/** DISPATCH and SALES_RETURN name a customer (0018): the toll customer for its own stock, else CUST1. */
const mv = (o: Partial<MovementInput>): MovementInput => ({
  type: 'RECEIPT', lotId: '0', locationId: ids.loc1!, qty: '1', date: DATE, refDocType: 'TEST', refDocId: doc(),
  ...(o.type === 'DISPATCH' || o.type === 'SALES_RETURN' ? { customerId: ids.cust! } : {}),
  ...o,
});
/** Several movements of ONE document + their journal in one transaction (rule 5). */
const postDoc = (who: string, inputs: Partial<MovementInput>[], refDocType = 'TEST') =>
  as(who, async (tx, a) => {
    const refDocId = doc();
    const movements: PostedMovement[] = [];
    for (const o of inputs) movements.push(await postMovement(tx, a, mv({ refDocType, refDocId, ...o })));
    const posting = await postStockJournal(tx, a, { movements, narration: `${movements[0]!.movementType} (done-when)` });
    return { movements, ...posting };
  });
/**
 * A disposal as M4/M7 will post it (rule 1; owner 2026-11-19): the QA witness signs at the Warehouse Manager's
 * terminal for this lot, type and quantity; then ONE transaction posts the movement, its journal, and — the lot
 * being empty — moves it to DESTROYED / RETURNED with the same signature.
 */
async function disposeDoc(type: DisposalMovementType, lotId: string, qty: string) {
  const wm = actors.wm!;
  const witness = await verifyWitness(
    { userId: wm.userId, companyId: '1', sessionId: '0', username: 'd_wm', mustChangePassword: false, passwordExpired: false, permissions: wm.permissions },
    { username: 'd_qa', password: TEST_PASSWORD, meaning: 'WITNESSED', reason: 'Witnessed the disposal' },
    { ip: null, userAgent: 'vitest' },
    disposalSubject(type, lotId, qty),
  );
  return as('wm', async (tx, a) => {
    const m = await postMovement(tx, a, mv({ type, lotId, qty, witness, refDocType: 'DISPOSAL', refDocId: doc() }));
    const posting = await postStockJournal(tx, a, { movements: [m], narration: `${type} (done-when)` });
    await closeDisposedLot(tx, a, m);
    return { movements: [m], ...posting };
  });
}
const newLot = (who: string, o: Partial<NewLot> & { lotNo: string }) =>
  as(who, (tx, a) => createLot(tx, a, { source: 'GRN', itemId: ids.rm!, unitCost: '0', ...o }));

const lineView = (e: JournalEntry) => e.lines.map((l) => [Object.keys(acct).find((c) => acct[c] === l.accountId), l.debit, l.credit]);
async function q<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query<T>(text, params)).rows;
}
async function ledger(lotId: string) {
  const [row] = await q<{ qty: string; value: string }>(
    `SELECT COALESCE(sum(qty), 0)::text AS qty, COALESCE(sum(value), 0)::text AS value FROM inv.stock_movements WHERE lot_id = $1`,
    [lotId],
  );
  return row!;
}

/**
 * The owner's check (18-11-2026): the inventory GL equals the sum of the ledger movement values — in total and per
 * inventory account (API stock has its own account here; everything else uses the default 1310). Own stock only:
 * toll stock carries no value and no journal (rule 12).
 */
async function glVsLedger() {
  const gl = await q<{ code: string; v: string }>(
    `SELECT a.code, sum(l.debit - l.credit)::text AS v FROM fin.journal_lines l
       JOIN fin.journal_entries e ON e.id = l.entry_id JOIN fin.accounts a ON a.id = l.account_id
      WHERE e.status IN ('POSTED', 'REVERSED') AND a.code IN ('1310', '1315') GROUP BY a.code`,
  );
  const led = await q<{ code: string; v: string }>(
    `SELECT CASE WHEN i.category_id = $1 THEN '1315' ELSE '1310' END AS code, sum(m.value)::text AS v
       FROM inv.stock_movements m JOIN inv.lots l ON l.id = m.lot_id JOIN master.items i ON i.id = l.item_id
      WHERE l.owner_type = 'OWN' GROUP BY 1`,
    [ids.apiCategory],
  );
  const by = (rows: { code: string; v: string }[], code: string) => new Decimal(rows.find((r) => r.code === code)?.v ?? 0).toFixed(2);
  return {
    gl: { '1310': by(gl, '1310'), '1315': by(gl, '1315') },
    ledger: { '1310': by(led, '1310'), '1315': by(led, '1315') },
  };
}
const checked = new Set<string>();
/** After a step: GL = ledger, per account; remembers which movement types the walk has posted so far. */
async function expectGlEqualsLedger(step: string): Promise<void> {
  const { gl, ledger: led } = await glVsLedger();
  expect({ step, ...gl }).toEqual({ step, ...led });
  for (const { movement_type } of await q<{ movement_type: string }>(`SELECT DISTINCT movement_type FROM inv.stock_movements`)) {
    checked.add(movement_type);
  }
}

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  actors.store = await actorFor('d_store', ['STOREKEEPER']);
  actors.sup = await actorFor('d_sup', ['PRODUCTION_SUPERVISOR']);
  actors.pm = await actorFor('d_pm', ['PRODUCTION_MANAGER']);
  actors.fm = await actorFor('d_fm', ['FINANCE_MANAGER']);
  actors.wm = await actorFor('d_wm', ['WAREHOUSE_MANAGER']);
  const qa = await createTestUser({ username: 'd_qa', roleCodes: ['QA_MANAGER'] });
  const wm = actors.wm.userId;
  const fm = actors.fm.userId;

  const one = async (text: string, params: unknown[] = []) => (await q<{ id: string }>(text, params))[0]!.id;
  for (const { id, code } of await q<{ id: string; code: string }>(`SELECT id, code FROM fin.accounts`)) acct[code] = id;
  await inTx('1', async () => {
    ids.uom = await one(`INSERT INTO master.uoms (code, name) VALUES ('KG', 'Kilogram') RETURNING id`);
    ids.rmCategory = await one(`INSERT INTO master.item_categories (code, name) VALUES ('RM', 'Raw material') RETURNING id`);
    ids.apiCategory = await one(`INSERT INTO master.item_categories (code, name) VALUES ('API', 'Active ingredient') RETURNING id`);
    ids.fgCategory = await one(`INSERT INTO master.item_categories (code, name) VALUES ('FG', 'Finished goods') RETURNING id`);
    const wh = await one(`INSERT INTO master.warehouses (code, name) VALUES ('MAIN', 'Main store') RETURNING id`);
    ids.loc1 = await one(`INSERT INTO master.locations (warehouse_id, code, name) VALUES ($1, 'A1', 'Rack A1') RETURNING id`, [wh]);
    ids.loc2 = await one(`INSERT INTO master.locations (warehouse_id, code, name) VALUES ($1, 'A2', 'Rack A2') RETURNING id`, [wh]);
    ids.ret = await one(`INSERT INTO master.locations (warehouse_id, code, name, is_returns_area) VALUES ($1, 'RET', 'Returns bay', true) RETURNING id`, [wh]);
    ids.toll = await one(`INSERT INTO master.customers (code, name, ntn, is_toll_customer, status) VALUES ('TOLL1', 'Toll', '1234567', true, 'ACTIVE') RETURNING id`);
    await history('master.customers', ids.toll, null, 'ACTIVE');
    ids.cust = await one(`INSERT INTO master.customers (code, name, ntn, status) VALUES ('CUST1', 'Customer', '7654321', 'ACTIVE') RETURNING id`);
    await history('master.customers', ids.cust, null, 'ACTIVE');
  });
  for (const [key, code, type, category] of [
    ['rm', 'RM-1', 'RM', ids.rmCategory],
    ['api', 'API-1', 'API', ids.apiCategory],
    ['fg', 'FG-1', 'FG', ids.fgCategory],
  ] as const) {
    await inTx(wm, async () => {
      ids[key] = await one(
        `INSERT INTO master.items (code, name, type, category_id, base_uom_id, status) VALUES ($1, $1, $2, $3, $4, 'DRAFT') RETURNING id`,
        [code, type, category, ids.uom],
      );
      await history('master.items', ids[key]!, null, 'DRAFT', wm);
    });
    await inTx(qa, async () => {
      await history('master.items', ids[key]!, 'DRAFT', 'ACTIVE', qa);
      await client.query(`UPDATE master.items SET status = 'ACTIVE' WHERE id = $1`, [ids[key]]);
    });
  }
  await inTx(fm, async () => {
    // API stock on its own account for every event that touches inventory (Finance adds such category rules).
    acct['1315'] = await one(`INSERT INTO fin.accounts (code, name, type, parent_id) VALUES ('1315', 'Stock - API', 'ASSET', $1) RETURNING id`, [acct['1300']]);
    for (const { event } of await q<{ event: string }>(`SELECT DISTINCT event FROM fin.posting_rules WHERE account_role = 'INVENTORY'`)) {
      await client.query(`INSERT INTO fin.posting_rules (event, account_role, item_category_id, account_id) VALUES ($1, 'INVENTORY', $2, $3)`, [
        event, ids.apiCategory, acct['1315'],
      ]);
    }
    const id = await one(
      `INSERT INTO core.fiscal_periods (fiscal_year, period_no, name, start_date, end_date, status) VALUES ('2026-27', 5, 'Nov-2026', '2026-11-01', '2026-11-30', 'OPEN') RETURNING id`,
    );
    await history('core.fiscal_periods', id, null, 'OPEN', fm);
  });
});

afterAll(async () => {
  await client.end();
});

describe('M2 Done when', () => {
  it('1. a receipt posts a stock movement AND a balanced journal in one transaction', async () => {
    const lot = await newLot('store', { lotNo: 'DW-REC', unitCost: '3.33' });
    const { movements: [m], entry } = await postDoc('store', [{ lotId: lot.id, qty: '1.2345' }], 'GRN');
    expect([m!.movementType, m!.value]).toEqual(['RECEIPT', '4.11']); // 1.2345 × 3.33 = 4.110885 → 4.11
    expect(entry).toMatchObject({ event: 'GRN_RECEIPT', status: 'POSTED', sourceType: 'GRN', sourceId: m!.refDocId });
    expect(lineView(entry!)).toEqual([['1310', '4.11', '0.00'], ['2120', '0.00', '4.11']]);
    const [totals] = await q<{ dr: string; cr: string; n: string }>(
      `SELECT sum(debit)::text AS dr, sum(credit)::text AS cr, count(*)::text AS n FROM fin.journal_lines WHERE entry_id = $1`,
      [entry!.id],
    );
    expect(totals).toEqual({ dr: '4.11', cr: '4.11', n: '2' });
    // Same transaction: the ledger row, the balance it moved and the journal entry carry the same xmin.
    const [txIds] = await q<{ movement: string; balance: string; journal: string }>(
      `SELECT (SELECT xmin::text FROM inv.stock_movements WHERE id = $1) AS movement,
              (SELECT xmin::text FROM inv.stock_balances WHERE lot_id = $2) AS balance,
              (SELECT xmin::text FROM fin.journal_entries WHERE id = $3) AS journal`,
      [m!.id, lot.id, entry!.id],
    );
    expect(new Set(Object.values(txIds!)).size).toBe(1);
    await expectGlEqualsLedger('receipt');
  });

  it('2. a forced error rolls back both the movement and the journal', async () => {
    const lot = await newLot('store', { lotNo: 'DW-RB', unitCost: '10.00' });
    const count = async () => {
      const [r] = await q<{ m: string; j: string; s: string }>(
        `SELECT (SELECT count(*) FROM inv.stock_movements WHERE lot_id = $1)::text AS m,
                (SELECT count(*) FROM fin.journal_entries WHERE source_type = 'GRN' AND source_id = 999)::text AS j,
                (SELECT string_agg(c.period_key || ':' || c.next_value, ',') FROM core.number_series_counters c
                   JOIN core.number_series s ON s.id = c.series_id WHERE s.doc_type = 'SJ') AS s`,
        [lot.id],
      );
      return r!;
    };
    const before = await count();
    // (a) An error after both are written.
    await expect(
      as('store', async (tx, a) => {
        const m = await postMovement(tx, a, mv({ lotId: lot.id, qty: '5', refDocType: 'GRN', refDocId: '999' }));
        const { entry } = await postStockJournal(tx, a, { movements: [m], narration: 'to be rolled back' });
        expect(entry!.status).toBe('POSTED');
        throw new Error('forced failure after posting');
      }),
    ).rejects.toThrow(/forced failure/);
    expect(await count()).toEqual(before);
    // (b) The journal fails (no posting rule): the movement written before it goes too.
    await withTransaction(systemContext('test'), (tx) => tx.execute(sql`UPDATE fin.posting_rules SET is_active = false WHERE event = 'GRN_RECEIPT' AND account_role = 'GRNI'`));
    try {
      await expect(postDoc('store', [{ lotId: lot.id, qty: '5' }], 'GRN')).rejects.toMatchObject({ code: 'POSTING_RULE_MISSING' });
    } finally {
      await withTransaction(systemContext('test'), (tx) => tx.execute(sql`UPDATE fin.posting_rules SET is_active = true WHERE event = 'GRN_RECEIPT' AND account_role = 'GRNI'`));
    }
    expect(await ledger(lot.id)).toEqual({ qty: '0', value: '0' });
    expect(await q(`SELECT 1 FROM inv.stock_balances WHERE lot_id = $1`, [lot.id])).toEqual([]);
    await expectGlEqualsLedger('rollback');
  });

  it('3. negative stock is refused by the database', async () => {
    const lot = await newLot('store', { lotNo: 'DW-NEG', unitCost: '2.00' });
    await postDoc('store', [{ lotId: lot.id, qty: '3' }], 'GRN');
    await setLot(lot.id, 'UNDER_TEST', 'APPROVED');
    // Engine first (clear error), nothing written.
    await expect(postDoc('store', [{ type: 'ISSUE', lotId: lot.id, qty: '3.0001' }])).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    // Around the engine: the ledger trigger refuses the row ...
    await expect(
      inTx(actors.store!.userId, () =>
        client.query(
          `INSERT INTO inv.stock_movements (movement_type, movement_date, lot_id, from_location_id, qty, unit_cost, value, ref_doc_type, ref_doc_id)
           VALUES ('ISSUE', $1, $2, $3, -4, 2.00, -6.00, 'TEST', 1)`,
          [DATE, lot.id, ids.loc1],
        ),
      ),
    ).rejects.toThrow(/INSUFFICIENT_STOCK|INSUFFICIENT/);
    // ... a balance cannot be written around the ledger, and the CHECK (rule 3) is the last backstop.
    await expect(inTx('1', () => client.query(`UPDATE inv.stock_balances SET qty = -1 WHERE lot_id = $1`, [lot.id]))).rejects.toThrow();
    await expect(
      inTx('1', () => client.query(`INSERT INTO inv.stock_balances (lot_id, location_id, qty) VALUES ($1, $2, -1)`, [lot.id, ids.loc2])),
    ).rejects.toThrow(/stock_balance_not_negative/);
    expect(await ledger(lot.id)).toEqual({ qty: '3.0000', value: '6.00' });
    await expectGlEqualsLedger('negative stock refused');
  });

  it('4. customer-owned (toll) stock moves at zero value and posts no journal (rule 12)', async () => {
    const journals = async () => (await q<{ n: string }>(`SELECT count(*)::text AS n FROM fin.journal_entries`))[0]!.n;
    const before = await journals();
    const lot = await newLot('store', { lotNo: 'DW-TOLL', ownerCustomerId: ids.toll });
    const rec = await postDoc('store', [{ lotId: lot.id, qty: '50' }], 'GRN');
    await setLot(lot.id, 'UNDER_TEST', 'APPROVED');
    const iss = await postDoc('store', [{ type: 'ISSUE', lotId: lot.id, qty: '20' }], 'PROD_ORDER');
    const fg = await as('sup', (tx, a) => createLot(tx, a, { source: 'PRODUCTION_OUTPUT', itemId: ids.fg!, lotNo: 'DW-TOLL-FG', ownerCustomerId: ids.toll, unitCost: '0' }));
    const out = await postDoc('sup', [{ type: 'OUTPUT', lotId: fg.id, qty: '200', value: '0.00' }], 'PROD_ORDER');
    const close = await as('pm', (tx, a) => closeBatchCost(tx, a, { lotId: fg.id, batchCost: '0.00', date: DATE, refDocType: 'PROD_ORDER', refDocId: doc() }));
    await setLot(fg.id, 'UNDER_TEST', 'APPROVED', 'RELEASED');
    const dsp = await postDoc('store', [{ type: 'DISPATCH', lotId: fg.id, qty: '150', customerId: ids.toll }], 'DELIVERY');
    const ret = await as('store', (tx, a) => createReturnLot(tx, a, { originalLotId: fg.id }));
    const back = await postDoc('store', [{ type: 'SALES_RETURN', lotId: ret.id, qty: '10', locationId: ids.ret, customerId: ids.toll }], 'SALES_RETURN');
    for (const p of [rec, iss, out, dsp, back]) {
      expect(p.movements.every((m) => m.value === '0.00' && m.customerOwned)).toBe(true);
      expect([p.entry, p.rounding]).toEqual([null, null]);
    }
    expect(close.adjustment).toBeNull();
    expect(await journals()).toBe(before);
    await expectGlEqualsLedger('toll');
  });

  it('5. GL inventory = Σ ledger movement values after every movement type (per inventory account)', async () => {
    // RECEIPT — RM and API (API on its own stock account).
    const rmA = await newLot('store', { lotNo: 'DW-A', unitCost: '3.33' });
    await postDoc('store', [{ lotId: rmA.id, qty: '100' }], 'GRN'); // 333.00
    const api = await newLot('store', { lotNo: 'DW-P', itemId: ids.api, unitCost: '1234.56' });
    const recApi = await postDoc('store', [{ lotId: api.id, qty: '10' }], 'GRN'); // 12345.60
    expect(lineView(recApi.entry!)).toEqual([['1315', '12345.60', '0.00'], ['2120', '0.00', '12345.60']]);
    await expectGlEqualsLedger('RECEIPT');

    // TRANSFER_OUT / TRANSFER_IN — value moves with the stock, no journal.
    const pair = await as('store', (tx, a) => transfer(tx, a, { lotId: rmA.id, fromLocationId: ids.loc1!, toLocationId: ids.loc2!, qty: '30', date: DATE, refDocType: 'TRANSFER', refDocId: doc() }));
    expect(pair.map((m) => m.value)).toEqual(['-99.90', '99.90']);
    await expectGlEqualsLedger('TRANSFER');

    // ISSUE (two categories, one production order, one journal) and ISSUE_RETURN.
    await setLot(rmA.id, 'UNDER_TEST', 'APPROVED');
    await setLot(api.id, 'UNDER_TEST', 'APPROVED');
    const order = doc();
    const issue = await as('store', async (tx, a) => {
      const ms = [
        await postMovement(tx, a, mv({ type: 'ISSUE', lotId: rmA.id, qty: '40', refDocType: 'PROD_ORDER', refDocId: order })),
        await postMovement(tx, a, mv({ type: 'ISSUE', lotId: api.id, qty: '2', refDocType: 'PROD_ORDER', refDocId: order })),
      ];
      return { ms, ...(await postStockJournal(tx, a, { movements: ms, narration: 'Issue to batch', dimensions: {} })) };
    });
    expect(issue.ms.map((m) => m.value)).toEqual(['-133.20', '-2469.12']);
    await expectGlEqualsLedger('ISSUE');
    const back = await as('store', async (tx, a) => {
      const m = await postMovement(tx, a, mv({ type: 'ISSUE_RETURN', lotId: rmA.id, qty: '5', refDocType: 'PROD_ORDER', refDocId: order }));
      return { m, ...(await postStockJournal(tx, a, { movements: [m], narration: 'Return from floor' })) };
    });
    expect(back.m.value).toBe('16.65');
    await expectGlEqualsLedger('ISSUE_RETURN');

    // OUTPUT at the provisional value (materials net of returns), then VALUE_ADJUSTMENT at batch close (owner Q8).
    const provisional = new Decimal('133.20').plus('2469.12').minus('16.65').toFixed(2); // 2585.67
    const fg = await as('sup', (tx, a) => createLot(tx, a, { source: 'PRODUCTION_OUTPUT', itemId: ids.fg!, lotNo: 'AP26-0001', unitCost: fgUnitCost(provisional, '1000') }));
    await as('sup', async (tx, a) => {
      const m = await postMovement(tx, a, mv({ type: 'OUTPUT', lotId: fg.id, qty: '1000', value: provisional, refDocType: 'PROD_ORDER', refDocId: order }));
      await postStockJournal(tx, a, { movements: [m], narration: 'Output recorded at packing' });
    });
    await expectGlEqualsLedger('OUTPUT');
    const close = await as('pm', async (tx, a) => {
      const c = await closeBatchCost(tx, a, { lotId: fg.id, batchCost: '3000.00', date: DATE, refDocType: 'PROD_ORDER', refDocId: order });
      return { ...c, ...(await postStockJournal(tx, a, { movements: [c.adjustment!], narration: 'Batch close: conversion and true-up' })) };
    });
    expect([close.adjustment!.value, close.lot.unitCost]).toEqual(['414.33', '3.00']);
    expect(lineView(close.entry!)).toEqual([['1310', '414.33', '0.00'], ['1320', '0.00', '414.33']]);
    await expectGlEqualsLedger('VALUE_ADJUSTMENT');

    // DISPATCH (released, batch closed), then SALES_RETURN into AP26-0001-R1 (owner Q9).
    await setLot(fg.id, 'UNDER_TEST', 'APPROVED', 'RELEASED');
    const dsp = await postDoc('store', [{ type: 'DISPATCH', lotId: fg.id, qty: '400' }], 'DELIVERY');
    expect(dsp.movements[0]!.value).toBe('-1200.00');
    await expectGlEqualsLedger('DISPATCH');
    const r1 = await as('store', (tx, a) => createReturnLot(tx, a, { originalLotId: fg.id }));
    expect([r1.lotNo, r1.status]).toEqual(['AP26-0001-R1', 'HOLD']);
    const sret = await postDoc('store', [{ type: 'SALES_RETURN', lotId: r1.id, qty: '25', locationId: ids.ret }], 'SALES_RETURN');
    expect(lineView(sret.entry!)).toEqual([['1310', '75.00', '0.00'], ['5100', '0.00', '75.00']]);
    await expectGlEqualsLedger('SALES_RETURN');

    // ADJUSTMENT_IN + ADJUSTMENT_OUT on one adjustment document, then its reversal.
    const adj = await postDoc('fm', [
      { type: 'ADJUSTMENT_IN', lotId: rmA.id, qty: '2' },
      { type: 'ADJUSTMENT_OUT', lotId: api.id, qty: '1' },
    ], 'ADJUSTMENT');
    expect(adj.movements.map((m) => m.value)).toEqual(['6.66', '-1234.56']);
    await expectGlEqualsLedger('ADJUSTMENT_IN / ADJUSTMENT_OUT');
    await as('fm', async (tx, a) => {
      const rows = await reverseMovements(tx, a, { movementIds: adj.movements.map((m) => m.id), date: DATE, refDocType: 'ADJUSTMENT', refDocId: doc() });
      return reverseStockJournal(tx, a, { entryId: adj.entry!.id, movements: rows, reason: 'counted twice' });
    });
    await expectGlEqualsLedger('reversal of an adjustment');

    // DESTROY and RETURN_TO_VENDOR of REJECTED lots (Warehouse Manager, inv.lot.dispose, QA witness qa.lot.witness).
    const rej = await newLot('store', { lotNo: 'DW-B', unitCost: '5.00' });
    await postDoc('store', [{ lotId: rej.id, qty: '10' }], 'GRN');
    const vend = await newLot('store', { lotNo: 'DW-C', unitCost: '7.77' });
    await postDoc('store', [{ lotId: vend.id, qty: '4' }], 'GRN');
    await setLot(rej.id, 'UNDER_TEST', 'REJECTED');
    await setLot(vend.id, 'UNDER_TEST', 'REJECTED');
    await expect(postDoc('wm', [{ type: 'DESTROY', lotId: rej.id, qty: '10' }], 'DISPOSAL')).rejects.toMatchObject({ code: 'WITNESS_REQUIRED' });
    const destroy = await disposeDoc('DESTROY', rej.id, '10');
    expect(lineView(destroy.entry!)).toEqual([['1310', '0.00', '50.00'], ['6200', '50.00', '0.00']]);
    await expectGlEqualsLedger('DESTROY');
    const rtv = await disposeDoc('RETURN_TO_VENDOR', vend.id, '4');
    expect(lineView(rtv.entry!)).toEqual([['1310', '0.00', '31.08'], ['2110', '31.08', '0.00']]);
    await expectGlEqualsLedger('RETURN_TO_VENDOR');
    // Each lot closed with the witness signature its movement carries.
    for (const [lotId, status, posted] of [[rej.id, 'DESTROYED', destroy], [vend.id, 'RETURNED', rtv]] as const) {
      const [row] = await q<{ status: string; witness: string; on_move: string }>(
        `SELECT l.status, h.witness_esign_id AS witness, m.witness_esign_id AS on_move
           FROM inv.lots l
           JOIN core.status_history h ON h.entity_table = 'inv.lots' AND h.entity_id = l.id::text AND h.to_status = l.status
           JOIN inv.stock_movements m ON m.id = $2
          WHERE l.id = $1`,
        [lotId, posted.movements[0]!.id],
      );
      expect(row).toEqual({ status, witness: posted.movements[0]!.witness!.id, on_move: posted.movements[0]!.witness!.id });
    }

    // ROUNDING_SWEEP: a reversal that empties a lot leaves -0.01; swept to 5400 in the same transaction.
    const d = await newLot('store', { lotNo: 'DW-D', unitCost: '3.33' });
    await postDoc('store', [{ lotId: d.id, qty: '1' }], 'GRN');
    await setLot(d.id, 'UNDER_TEST', 'APPROVED');
    await postDoc('store', [{ type: 'ISSUE', lotId: d.id, qty: '0.5' }]); // -1.67
    const ret: StockPosting & { movements: PostedMovement[] } = await postDoc('store', [{ type: 'ISSUE_RETURN', lotId: d.id, qty: '0.5' }]); // +1.67
    await postDoc('store', [{ type: 'ISSUE', lotId: d.id, qty: '0.5' }]); // -1.67 → 0.5 / 1.66
    const swept = await as('store', async (tx, a) => {
      const rows = await reverseMovements(tx, a, { movementIds: [ret.movements[0]!.id], date: DATE, refDocType: 'TEST', refDocId: doc() });
      return reverseStockJournal(tx, a, { entryId: ret.entry!.id, movements: rows, reason: 'return booked twice' });
    });
    expect(swept.rounding!.movements[0]).toMatchObject({ movementType: 'ROUNDING_SWEEP', value: '0.01' });
    expect(await ledger(d.id)).toEqual({ qty: '0.0000', value: '0.00' });
    await expectGlEqualsLedger('ROUNDING_SWEEP');

    // Every movement type was posted, and the GL matched the ledger after each.
    expect([...checked].sort()).toEqual([...StockMovementType].sort());
    const [rev] = await q<{ n: string }>(`SELECT count(*)::text AS n FROM inv.stock_movements WHERE reversal_of IS NOT NULL`);
    expect(Number(rev!.n)).toBeGreaterThanOrEqual(3);
  });
});
