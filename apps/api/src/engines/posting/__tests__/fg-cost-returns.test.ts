// Owner decisions 2026-11-18 (Q8, Q9), engines/inventory + engines/posting against the real database (0017):
//  Q8 — an FG lot is created at output (prod.output.verify, the checker; owner 2026-11-18) at the provisional value of the materials issued so far;
//       batch close (prod.batch.approve_close) adds conversion + true-up as a value-only VALUE_ADJUSTMENT in the
//       same transaction as its journal, on the stock still held (samples keep their provisional value); the lot is
//       dispatched only after its batch is closed. A value-only adjustment never takes a lot below zero and is
//       refused on an empty lot.
//  Q9 — a customer return goes into a new HOLD return lot "<original>-R<n>" at a returns area, valued at the
//       original lot's unit cost (Dr FG inventory / Cr COGS, key fg.delivery.manage); toll: zero value, no GL.
import pg from 'pg';
import { Decimal } from 'decimal.js';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl } from '../../../config/env';
import { systemContext, withTransaction, type Tx } from '../../../db/client';
import { runSeed } from '../../../db/seed/run';
import { permissionKeysForUser } from '../../../core/auth/auth.repo';
import type { Actor } from '../../../core/transition/transition';
import { createTestUser } from '../../../test/factories';
import {
  closeBatchCost,
  createLot,
  createReturnLot,
  fgUnitCost,
  postMovement,
  postValueAdjustment,
  reverseMovements,
  type MovementInput,
  type NewLot,
} from '../../inventory';
import { postStockJournal, reverseStockJournal, type JournalEntry } from '..';

const client = new pg.Client({ connectionString: databaseUrl });
const ids: Record<string, string> = {};
const acct: Record<string, string> = {};
const actors: Record<string, Actor> = {};
let seq = 0;
let docSeq = 5000;
const DATE = '2026-11-18';

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
const as = <T>(who: string, work: (tx: Tx, actor: Actor) => Promise<T>) =>
  withTransaction({ userId: actors[who]!.userId, companyId: '1' }, (tx) => work(tx, actors[who]!));

/** Status moves stand in for QC / QA (their modules come later); history first, as core/transition does. */
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
/** DISPATCH and SALES_RETURN name a customer (0018); the default is customer CUST1. */
const mv = (o: Partial<MovementInput>): MovementInput => ({
  type: 'RECEIPT', lotId: '0', locationId: ids.loc!, qty: '1', date: DATE, refDocType: 'TEST', refDocId: doc(),
  ...(o.type === 'DISPATCH' || o.type === 'SALES_RETURN' ? { customerId: ids.cust! } : {}),
  ...o,
});
/** Movement + its journal in one transaction (rule 5). */
const postWithJournal = (who: string, o: Partial<MovementInput>) =>
  as(who, async (tx, a) => {
    const m = await postMovement(tx, a, mv(o));
    return { m, ...(await postStockJournal(tx, a, { movements: [m], narration: `${m.movementType} test` })) };
  });

const lineView = (e: JournalEntry) => e.lines.map((l) => [Object.keys(acct).find((c) => acct[c] === l.accountId), l.debit, l.credit]);

async function ledger(lotId: string) {
  const { rows } = await client.query<{ qty: string; value: string }>(
    `SELECT COALESCE(sum(qty), 0)::text AS qty, COALESCE(sum(value), 0)::text AS value FROM inv.stock_movements WHERE lot_id = $1`,
    [lotId],
  );
  return rows[0]!;
}
async function lotRow(lotId: string) {
  const { rows } = await client.query(`SELECT lot_no, status, unit_cost, source, parent_lot_id, batch_closed_at FROM inv.lots WHERE id = $1`, [lotId]);
  return rows[0] as { lot_no: string; status: string; unit_cost: string; source: string; parent_lot_id: string | null; batch_closed_at: Date | null };
}
/** Inventory GL vs Σ own-stock ledger values (owner 18-11-2026: equal after every movement type). */
async function glEqualsLedger(): Promise<{ gl: string; ledger: string }> {
  const { rows: gl } = await client.query<{ v: string }>(
    `SELECT COALESCE(sum(l.debit - l.credit), 0)::text AS v FROM fin.journal_lines l JOIN fin.journal_entries e ON e.id = l.entry_id
      WHERE e.status IN ('POSTED', 'REVERSED') AND l.account_id IN (SELECT account_id FROM fin.posting_rules WHERE account_role = 'INVENTORY')`,
  );
  const { rows: led } = await client.query<{ v: string }>(
    `SELECT COALESCE(sum(m.value), 0)::text AS v FROM inv.stock_movements m JOIN inv.lots l ON l.id = m.lot_id WHERE l.owner_type = 'OWN'`,
  );
  return { gl: gl[0]!.v, ledger: led[0]!.v };
}
const expectGlEqualsLedger = async () => {
  const { gl, ledger: led } = await glEqualsLedger();
  expect(gl).toBe(led);
};

/** RM lot received and APPROVED (Storekeeper), ready to issue. */
async function approvedRm(qty: string, unitCost: string): Promise<string> {
  const l = await as('store', (tx, a) => createLot(tx, a, { source: 'GRN', itemId: ids.rm!, lotNo: `RM-${++seq}`, unitCost }));
  await postWithJournal('store', { lotId: l.id, qty });
  await setLot(l.id, 'UNDER_TEST', 'APPROVED');
  return l.id;
}

/**
 * A batch: materials issued (WIP), then FG output recorded at their value (provisional, owner Q8).
 * Returns the FG lot id, the production order id and the provisional value.
 */
async function producedLot(o: { fgQty: string; rmQty?: string; rmCost?: string; lotNo?: string; owner?: string } = { fgQty: '10' }) {
  const order = doc();
  let provisional = '0.00';
  if (!o.owner) {
    const rm = await approvedRm(o.rmQty ?? '100', o.rmCost ?? '9.99');
    const { m } = await postWithJournal('store', { type: 'ISSUE', lotId: rm, qty: o.rmQty ?? '100', refDocType: 'PROD_ORDER', refDocId: order });
    provisional = new Decimal(m.value).neg().toFixed(2);
  }
  const lot: Partial<NewLot> = o.owner ? { ownerCustomerId: o.owner, unitCost: '0' } : { unitCost: fgUnitCost(provisional, o.fgQty) };
  const fg = await as('sup', async (tx, a) => {
    const l = await createLot(tx, a, { source: 'PRODUCTION_OUTPUT', itemId: ids.fg!, lotNo: o.lotNo ?? `AP26-${String(++seq).padStart(4, '0')}`, unitCost: '0', ...lot });
    const m = await postMovement(tx, a, mv({ type: 'OUTPUT', lotId: l.id, qty: o.fgQty, value: provisional, refDocType: 'PROD_ORDER', refDocId: order }));
    await postStockJournal(tx, a, { movements: [m], narration: 'Output recorded at packing' });
    return l;
  });
  return { fg: fg.id, order, provisional };
}

/** Batch close as the Production Manager: value adjustment + its journal in one transaction. */
const closeBatch = (lotId: string, order: string, batchCost: string, who = 'pm') =>
  as(who, async (tx, a) => {
    const closed = await closeBatchCost(tx, a, { lotId, batchCost, date: DATE, refDocType: 'PROD_ORDER', refDocId: order });
    const posting = closed.adjustment
      ? await postStockJournal(tx, a, { movements: [closed.adjustment], narration: 'Batch close: conversion and true-up', dimensions: {} })
      : null;
    return { ...closed, entry: posting?.entry ?? null };
  });

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  actors.store = await actorFor('q_store', ['STOREKEEPER']);
  actors.sup = await actorFor('q_sup', ['PRODUCTION_SUPERVISOR']);
  actors.pm = await actorFor('q_pm', ['PRODUCTION_MANAGER']);
  actors.fm = await actorFor('q_fm', ['FINANCE_MANAGER']);
  const wm = await createTestUser({ username: 'q_wm', roleCodes: ['WAREHOUSE_MANAGER'] });
  const qa = await createTestUser({ username: 'q_qa', roleCodes: ['QA_MANAGER'] });
  const fm = actors.fm.userId;

  const one = async (text: string, params: unknown[] = []) => (await client.query<{ id: string }>(text, params)).rows[0]!.id;
  for (const { id, code } of (await client.query<{ id: string; code: string }>(`SELECT id, code FROM fin.accounts`)).rows) acct[code] = id;
  await inTx('1', async () => {
    ids.uom = await one(`INSERT INTO master.uoms (code, name) VALUES ('NOS', 'Number') RETURNING id`);
    ids.rmCategory = await one(`INSERT INTO master.item_categories (code, name) VALUES ('RM', 'Raw material') RETURNING id`);
    ids.fgCategory = await one(`INSERT INTO master.item_categories (code, name) VALUES ('FG', 'Finished goods') RETURNING id`);
    const wh = await one(`INSERT INTO master.warehouses (code, name) VALUES ('FGW', 'FG store') RETURNING id`);
    ids.loc = await one(`INSERT INTO master.locations (warehouse_id, code, name) VALUES ($1, 'F1', 'Rack F1') RETURNING id`, [wh]);
    ids.ret = await one(`INSERT INTO master.locations (warehouse_id, code, name, is_returns_area) VALUES ($1, 'RET', 'Returns bay', true) RETURNING id`, [wh]);
    ids.toll = await one(
      `INSERT INTO master.customers (code, name, ntn, is_toll_customer, status) VALUES ('TOLLQ', 'Toll', '1234567', true, 'ACTIVE') RETURNING id`,
    );
    await history('master.customers', ids.toll, null, 'ACTIVE');
    for (const [key, code] of [['cust', 'CUST1'], ['cust2', 'CUST2']] as const) {
      ids[key] = await one(`INSERT INTO master.customers (code, name, ntn, status) VALUES ($1, $1, '7654321', 'ACTIVE') RETURNING id`, [code]);
      await history('master.customers', ids[key]!, null, 'ACTIVE');
    }
  });
  for (const [key, code, type, category] of [['rm', 'RM-Q', 'RM', ids.rmCategory], ['fg', 'FG-Q', 'FG', ids.fgCategory]] as const) {
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
    const id = await one(
      `INSERT INTO core.fiscal_periods (fiscal_year, period_no, name, start_date, end_date, status) VALUES ('2026-27', 5, 'Nov-2026', '2026-11-01', '2026-11-30', 'OPEN') RETURNING id`,
    );
    await history('core.fiscal_periods', id, null, 'OPEN', fm);
  });
});

afterAll(async () => {
  await client.end();
});

// ---------------------------------------------------------------- Q8: FG lot valuation

describe('FG lot valuation (owner Q8, Option A)', () => {
  it('books output at the provisional value (prod.output.verify); batch close adds conversion + true-up to the lot (Dr FG / Cr WIP)', async () => {
    const { fg, order, provisional } = await producedLot({ fgQty: '10', rmQty: '100', rmCost: '9.99' });
    expect(provisional).toBe('999.00');
    expect(await ledger(fg)).toEqual({ qty: '10.0000', value: '999.00' });
    expect((await lotRow(fg)).unit_cost).toBe('99.90');

    const closed = await closeBatch(fg, order, '1500.00'); // materials 999.00 + conversion 501.00
    expect(closed.adjustment).toMatchObject({ movementType: 'VALUE_ADJUSTMENT', qty: '0.0000', value: '501.00', locationId: null, reasonCode: 'BATCH_CLOSE' });
    expect(closed.entry).toMatchObject({ event: 'FG_COST_ADJUSTMENT', sourceType: 'PROD_ORDER', sourceId: order, status: 'POSTED' });
    expect(closed.entry!.postedBy).toBe(actors.pm!.userId);
    expect(lineView(closed.entry!)).toEqual([['1310', '501.00', '0.00'], ['1320', '0.00', '501.00']]);
    expect(await ledger(fg)).toEqual({ qty: '10.0000', value: '1500.00' });
    const row = await lotRow(fg);
    expect([row.unit_cost, row.batch_closed_at]).toEqual(['150.00', expect.any(Date)]);
    // Balances do not move: a value-only row moves no stock.
    const { rows } = await client.query(`SELECT qty FROM inv.stock_balances WHERE lot_id = $1`, [fg]);
    expect(rows).toEqual([{ qty: '10.0000' }]);
    await expectGlEqualsLedger();
  });

  it('applies the close adjustment to the stock still held; stock out before close keeps its provisional value', async () => {
    const { fg, order } = await producedLot({ fgQty: '10', rmQty: '100', rmCost: '10' }); // 1000.00, 100.00 each
    // A sample taken before close (stands in for the QC sample issue of M4): provisional value.
    const sample = await as('fm', async (tx, a) => {
      const m = await postMovement(tx, a, mv({ type: 'ADJUSTMENT_OUT', lotId: fg, qty: '1', reasonCode: 'QC_SAMPLE' }));
      await postStockJournal(tx, a, { movements: [m], narration: 'QC sample' });
      return m;
    });
    expect(sample.value).toBe('-100.00');
    const closed = await closeBatch(fg, order, '1300.00'); // the whole difference goes to the 9 units held
    expect(closed.adjustment!.value).toBe('300.00');
    expect(await ledger(fg)).toEqual({ qty: '9.0000', value: '1200.00' });
    expect((await lotRow(fg)).unit_cost).toBe('133.33'); // 1200.00 ÷ 9, half-up
    // Later outbound movements: qty × the new unit cost; the last one takes the residual.
    await setLot(fg, 'UNDER_TEST', 'APPROVED', 'RELEASED');
    expect((await postWithJournal('store', { type: 'DISPATCH', lotId: fg, qty: '3' })).m.value).toBe('-399.99');
    expect((await postWithJournal('store', { type: 'DISPATCH', lotId: fg, qty: '6' })).m.value).toBe('-800.01');
    expect(await ledger(fg)).toEqual({ qty: '0.0000', value: '0.00' });
    await expectGlEqualsLedger();
  });

  it('lowers the lot when the batch cost is below the provisional value (Dr WIP / Cr FG); no adjustment when equal', async () => {
    const a = await producedLot({ fgQty: '4', rmQty: '10', rmCost: '10' }); // 100.00
    const down = await closeBatch(a.fg, a.order, '90.00');
    expect(down.adjustment!.value).toBe('-10.00');
    expect(lineView(down.entry!)).toEqual([['1310', '0.00', '10.00'], ['1320', '10.00', '0.00']]);
    expect((await lotRow(a.fg)).unit_cost).toBe('22.50');
    const b = await producedLot({ fgQty: '4', rmQty: '10', rmCost: '10' });
    const same = await closeBatch(b.fg, b.order, '100.00');
    expect([same.adjustment, same.entry]).toEqual([null, null]);
    expect((await lotRow(b.fg)).batch_closed_at).toEqual(expect.any(Date));
    await expectGlEqualsLedger();
  });

  it('refuses to dispatch an FG lot before its batch is closed (BATCH_NOT_CLOSED), in the engine and the database', async () => {
    const { fg, order } = await producedLot({ fgQty: '5', rmQty: '5', rmCost: '10' });
    await setLot(fg, 'UNDER_TEST', 'APPROVED', 'RELEASED');
    await expect(postWithJournal('store', { type: 'DISPATCH', lotId: fg, qty: '1' })).rejects.toMatchObject({ code: 'BATCH_NOT_CLOSED' });
    await expect(
      inTx(actors.store!.userId, async () => {
        await client.query(
          `INSERT INTO inv.stock_movements (movement_type, movement_date, lot_id, from_location_id, qty, unit_cost, value, ref_doc_type, ref_doc_id, customer_id)
           VALUES ('DISPATCH', $1, $2, $3, -1, 10, -10, 'TEST', 1, $4)`,
          [DATE, fg, ids.loc, ids.cust],
        );
      }),
    ).rejects.toThrow(/BATCH_NOT_CLOSED/);
    await closeBatch(fg, order, '50.00');
    expect((await postWithJournal('store', { type: 'DISPATCH', lotId: fg, qty: '1' })).m.value).toBe('-10.00');
  });

  it('closeBatchCost refuses an actor without prod.batch.approve_close, a non-production lot, a second close; nothing is saved', async () => {
    const { fg, order } = await producedLot({ fgQty: '2', rmQty: '2', rmCost: '10' });
    await expect(closeBatch(fg, order, '30.00', 'sup')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(closeBatch(fg, order, '30.00', 'store')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await ledger(fg)).toEqual({ qty: '2.0000', value: '20.00' });
    expect((await lotRow(fg)).batch_closed_at).toBeNull();
    const rm = await approvedRm('1', '5');
    await expect(closeBatch(rm, order, '5.00')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(closeBatch(fg, order, '30.0001')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await closeBatch(fg, order, '30.00');
    await expect(closeBatch(fg, order, '35.00')).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await ledger(fg)).toEqual({ qty: '2.0000', value: '30.00' });
  });

  it('a value-only adjustment is refused on a lot with zero quantity (LOT_EMPTY) and below zero (LOT_VALUE_NEGATIVE)', async () => {
    const empty = await producedLot({ fgQty: '1', rmQty: '1', rmCost: '10' });
    await as('fm', async (tx, a) => {
      const m = await postMovement(tx, a, mv({ type: 'ADJUSTMENT_OUT', lotId: empty.fg, qty: '1' }));
      await postStockJournal(tx, a, { movements: [m], narration: 'all sampled' });
    });
    await expect(closeBatch(empty.fg, empty.order, '15.00')).rejects.toMatchObject({ code: 'LOT_EMPTY' });

    const low = await producedLot({ fgQty: '10', rmQty: '10', rmCost: '10' }); // 100.00
    await as('fm', async (tx, a) => {
      const m = await postMovement(tx, a, mv({ type: 'ADJUSTMENT_OUT', lotId: low.fg, qty: '5' }));
      await postStockJournal(tx, a, { movements: [m], narration: 'half out' });
    });
    // 50.00 held; batch cost 40.00 → adjustment −60.00 would leave −10.00.
    await expect(closeBatch(low.fg, low.order, '40.00')).rejects.toMatchObject({ code: 'LOT_VALUE_NEGATIVE', details: { lotValue: '50.00', adjustment: '-60.00' } });
    expect((await lotRow(low.fg)).batch_closed_at).toBeNull();
    await expectGlEqualsLedger();
  });

  it('postValueAdjustment refuses customer-owned stock, a zero or malformed amount, an unknown reason; BATCH_CLOSE only on open production lots', async () => {
    const toll = await producedLot({ fgQty: '5', owner: ids.toll });
    const adjust = (lotId: string, value: string, reason = 'BATCH_CLOSE') =>
      as('pm', (tx, a) => postValueAdjustment(tx, a, { lotId, value, reason: reason as 'BATCH_CLOSE', date: DATE, refDocType: 'PROD_ORDER', refDocId: '1' }));
    await expect(adjust(toll.fg, '10.00')).rejects.toThrow(/customer-owned/);
    const own = await producedLot({ fgQty: '2', rmQty: '2', rmCost: '10' });
    await expect(adjust(own.fg, '0.00')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(adjust(own.fg, '1.234')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(adjust(own.fg, '1.00', 'LANDED_COST')).rejects.toThrow(/Unknown value adjustment reason/);
    const rm = await approvedRm('1', '5');
    await expect(adjust(rm, '1.00')).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    // A toll batch closes with no value and no journal (rule 12).
    const tollClose = await closeBatch(toll.fg, toll.order, '0.00');
    expect([tollClose.adjustment, tollClose.entry]).toEqual([null, null]);
  });

  it('never reverses a value adjustment, nor the output of a closed batch', async () => {
    const { fg, order } = await producedLot({ fgQty: '2', rmQty: '2', rmCost: '10' });
    const { adjustment } = await closeBatch(fg, order, '30.00');
    const reverse = (id: string) => as('pm', (tx, a) => reverseMovements(tx, a, { movementIds: [id], date: DATE, refDocType: 'TEST', refDocId: doc() }));
    await expect(reverse(adjustment!.id)).rejects.toThrow(/value adjustment; it is not reversed/);
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM inv.stock_movements WHERE lot_id = $1 AND movement_type = 'OUTPUT'`, [fg]);
    await expect(reverse(rows[0]!.id)).rejects.toThrow(/batch is closed; its output is not reversed/);
  });
});

describe('VALUE_ADJUSTMENT database guards (0017)', () => {
  const insertAdjustment = (lotId: string, value: string, unitCost: string, reason: string | null = 'BATCH_CLOSE') =>
    client.query(
      `INSERT INTO inv.stock_movements (movement_type, movement_date, lot_id, qty, unit_cost, value, ref_doc_type, ref_doc_id, reason_code)
       VALUES ('VALUE_ADJUSTMENT', $1, $2, 0, $3, $4, 'TEST', 1, $5)`,
      [DATE, lotId, unitCost, value, reason],
    );

  it('needs the new unit cost on the lot and the row, a known reason, no location and no quantity', async () => {
    const { fg } = await producedLot({ fgQty: '3', rmQty: '3', rmCost: '10' }); // 30.00, unit 10.00
    await expect(inTx('1', () => insertAdjustment(fg, '3.00', '10.00').then(() => undefined))).rejects.toThrow(/unit cost is 11.00/);
    const atNewCost = (work: () => Promise<unknown>) =>
      inTx('1', async () => {
        await client.query(`UPDATE inv.lots SET unit_cost = 11.00 WHERE id = $1`, [fg]);
        await work();
      });
    await expect(atNewCost(() => insertAdjustment(fg, '3.00', '11.00', null))).rejects.toThrow(/movement_value_adjustment_reason/);
    await expect(
      atNewCost(async () => {
        await client.query(
          `INSERT INTO inv.stock_movements (movement_type, movement_date, lot_id, to_location_id, qty, unit_cost, value, ref_doc_type, ref_doc_id, reason_code)
           VALUES ('VALUE_ADJUSTMENT', $1, $2, $3, 1, 11, 3, 'TEST', 1, 'BATCH_CLOSE')`,
          [DATE, fg, ids.loc],
        );
      }),
    ).rejects.toThrow(/movement_one_location/);
    // Done right (lot first, then the row), every guard passes, the deferred ones included; rolled back so the
    // GL (no journal here) keeps equal to the ledger for the other tests.
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('app.user_id', '1', true), set_config('app.company_id', '1', true)`);
      await client.query(`UPDATE inv.lots SET unit_cost = 11.00 WHERE id = $1`, [fg]);
      await insertAdjustment(fg, '3.00', '11.00');
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      expect(await ledger(fg)).toEqual({ qty: '3.0000', value: '33.00' });
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('refuses an empty lot (LOT_EMPTY) and a value below zero (LOT_VALUE_NEGATIVE)', async () => {
    const { fg } = await producedLot({ fgQty: '1', rmQty: '1', rmCost: '10' });
    await expect(
      inTx('1', async () => {
        await client.query(`UPDATE inv.lots SET unit_cost = 0 WHERE id = $1`, [fg]);
        await insertAdjustment(fg, '-11.00', '0.00');
      }),
    ).rejects.toThrow(/LOT_VALUE_NEGATIVE/);
    await as('fm', async (tx, a) => {
      const m = await postMovement(tx, a, mv({ type: 'ADJUSTMENT_OUT', lotId: fg, qty: '1' }));
      await postStockJournal(tx, a, { movements: [m], narration: 'out' });
    });
    await expect(inTx('1', () => insertAdjustment(fg, '5.00', '10.00').then(() => undefined))).rejects.toThrow(/LOT_EMPTY/);
  });

  it("refuses, at commit, a lot unit cost changed without a value adjustment; a lot's closed batch never changes", async () => {
    const { fg, order } = await producedLot({ fgQty: '2', rmQty: '2', rmCost: '10' });
    await expect(inTx('1', () => client.query(`UPDATE inv.lots SET unit_cost = 12 WHERE id = $1`, [fg]).then(() => undefined))).rejects.toThrow(
      /changes only by a value adjustment/,
    );
    await closeBatch(fg, order, '20.00');
    await expect(inTx('1', () => client.query(`UPDATE inv.lots SET batch_closed_at = NULL WHERE id = $1`, [fg]).then(() => undefined))).rejects.toThrow(
      /its batch is closed/,
    );
    const rm = await approvedRm('1', '5');
    await expect(inTx('1', () => client.query(`UPDATE inv.lots SET batch_closed_at = now() WHERE id = $1`, [rm]).then(() => undefined))).rejects.toThrow(
      /lot_batch_closed_only_production/,
    );
  });
});

// ---------------------------------------------------------------- Q9: customer returns

/** A closed, released FG lot with `dispatched` units dispatched (own stock unless owner given). */
async function dispatchedLot(dispatched: string, o: { owner?: string; lotNo?: string } = {}) {
  const p = await producedLot(o.owner ? { fgQty: '10', owner: o.owner, lotNo: o.lotNo } : { fgQty: '3', rmQty: '10', rmCost: '10', lotNo: o.lotNo });
  await closeBatch(p.fg, p.order, o.owner ? '0.00' : '100.00'); // own: 3 units, 33.33 each
  await setLot(p.fg, 'UNDER_TEST', 'APPROVED', 'RELEASED');
  await postWithJournal('store', { type: 'DISPATCH', lotId: p.fg, qty: dispatched, customerId: o.owner ?? ids.cust! });
  return p.fg;
}
const returnLot = (originalLotId: string, who = 'store') => as(who, (tx, a) => createReturnLot(tx, a, { originalLotId }));
const receiveReturn = (lotId: string, qty: string, o: Partial<MovementInput> = {}, who = 'store') =>
  postWithJournal(who, { type: 'SALES_RETURN', lotId, qty, locationId: ids.ret!, refDocType: 'SALES_RETURN', ...o });

describe('customer sales returns (owner Q9)', () => {
  it('receive into a new HOLD lot "<lot>-R<n>" at a returns area, at the original unit cost: Dr FG inventory / Cr COGS', async () => {
    const original = await dispatchedLot('2', { lotNo: 'AP26-0901' });
    const r1 = await returnLot(original);
    expect(r1).toMatchObject({ lotNo: 'AP26-0901-R1', status: 'HOLD', source: 'SALES_RETURN', parentLotId: original, unitCost: '33.33', itemId: ids.fg });
    const { rows: hist } = await client.query(`SELECT from_status, to_status, actor_id FROM core.status_history WHERE entity_table = 'inv.lots' AND entity_id = $1`, [r1.id]);
    expect(hist).toEqual([{ from_status: null, to_status: 'HOLD', actor_id: actors.store!.userId }]);

    const { m, entry } = await receiveReturn(r1.id, '1');
    expect([m.movementType, m.value, m.locationId]).toEqual(['SALES_RETURN', '33.33', ids.ret]);
    expect(entry).toMatchObject({ event: 'SALES_RETURN_RECEIPT', status: 'POSTED', sourceType: 'SALES_RETURN' });
    expect(lineView(entry!)).toEqual([['1310', '33.33', '0.00'], ['5100', '0.00', '33.33']]);
    expect((await lotRow(original)).status).toBe('RELEASED'); // the released lot is untouched
    expect(await ledger(original)).toEqual({ qty: '1.0000', value: '33.34' });

    const r2 = await returnLot(original);
    expect(r2.lotNo).toBe('AP26-0901-R2');
    expect((await receiveReturn(r2.id, '1')).m.value).toBe('33.33');
    // A return lot named as the original: numbered from the original lot.
    expect((await returnLot(r1.id)).lotNo).toBe('AP26-0901-R3');
    await expectGlEqualsLedger();
  });

  it('a HOLD return lot is not dispatched; only QA moves it on (status through core/transition)', async () => {
    const original = await dispatchedLot('1');
    const r = await returnLot(original);
    await receiveReturn(r.id, '1');
    await expect(postWithJournal('store', { type: 'DISPATCH', lotId: r.id, qty: '1' })).rejects.toMatchObject({ code: 'LOT_NOT_RELEASED' });
    await expect(inTx('1', () => client.query(`UPDATE inv.lots SET status = 'RELEASED' WHERE id = $1`, [r.id]).then(() => undefined))).rejects.toThrow(
      /INVALID_TRANSITION/,
    );
  });

  it('refuses an actor without fg.delivery.manage, a non-returns location, more than dispatched, the released lot itself, a non-FG lot', async () => {
    const original = await dispatchedLot('2');
    await expect(returnLot(original, 'sup')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const r = await returnLot(original);
    await expect(receiveReturn(r.id, '1', { locationId: ids.loc })).rejects.toThrow(/not a returns area/);
    await expect(receiveReturn(r.id, '1', {}, 'sup')).rejects.toMatchObject({ code: 'FORBIDDEN' }); // journal key
    expect(await ledger(r.id)).toEqual({ qty: '0', value: '0' }); // nothing was posted
    await expect(receiveReturn(r.id, '3')).rejects.toMatchObject({ code: 'RETURN_EXCEEDS_DISPATCH' });
    await receiveReturn(r.id, '2');
    const r2 = await returnLot(original);
    await expect(receiveReturn(r2.id, '0.0001')).rejects.toMatchObject({ code: 'RETURN_EXCEEDS_DISPATCH' });
    await expect(receiveReturn(original, '1')).rejects.toThrow(/SALES_RETURN goes into a lot made for it/);
    const rm = await approvedRm('1', '5');
    await expect(returnLot(rm)).rejects.toThrow(/not finished goods/);
  });

  it('database: a return lot is HOLD, numbered from its original, with its item, owner and unit cost; returns never exceed dispatch', async () => {
    const original = await dispatchedLot('1', { lotNo: 'AP26-0902' });
    const insert = (lotNo: string, status = 'HOLD', unitCost = '33.33', parent = original) =>
      inTx('1', async () => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO inv.lots (item_id, lot_no, status, unit_cost, source, parent_lot_id) VALUES ($1, $2, $3, $4, 'SALES_RETURN', $5) RETURNING id`,
          [ids.fg, lotNo, status, unitCost, parent],
        );
        await history('inv.lots', rows[0]!.id, null, status);
      });
    await expect(insert('AP26-0902-R1', 'QUARANTINE')).rejects.toThrow(/created in HOLD/);
    await expect(insert('AP26-0902-X1')).rejects.toThrow(/numbered AP26-0902-R<n>/);
    await expect(insert('AP26-0902-R0')).rejects.toThrow(/numbered AP26-0902-R<n>/);
    await expect(insert('AP26-0902-R1', 'HOLD', '30.00')).rejects.toThrow(/original lot's unit cost/);
    await expect(
      inTx('1', () => client.query(`INSERT INTO inv.lots (item_id, lot_no, status, source) VALUES ($1, 'NOPARENT', 'HOLD', 'SALES_RETURN')`, [ids.fg]).then(() => undefined)),
    ).rejects.toThrow(/original lot's item and owner/);
    const r = await returnLot(original);
    await expect(insert(`${r.lotNo}-R1`, 'HOLD', '33.33', r.id)).rejects.toThrow(/not to another return lot/);
    await expect(
      inTx(actors.store!.userId, async () => {
        await client.query(
          `INSERT INTO inv.stock_movements (movement_type, movement_date, lot_id, to_location_id, qty, unit_cost, value, ref_doc_type, ref_doc_id, customer_id)
           VALUES ('SALES_RETURN', $1, $2, $3, 2, 33.33, 66.66, 'TEST', 1, $4)`,
          [DATE, r.id, ids.ret, ids.cust],
        );
      }),
    ).rejects.toThrow(/RETURN_EXCEEDS_DISPATCH/);
  });

  it('toll stock comes back at zero value with no journal (rule 12)', async () => {
    const original = await dispatchedLot('4', { owner: ids.toll });
    const r = await returnLot(original);
    expect([r.ownerType, r.ownerCustomerId, r.unitCost]).toEqual(['CUSTOMER', ids.toll, '0.00']);
    const { m, entry } = await receiveReturn(r.id, '4', { customerId: ids.toll });
    expect([m.value, m.customerOwned, entry]).toEqual(['0.00', true, null]);
    await expectGlEqualsLedger();
  });

  it('a return never exceeds what was dispatched to THAT customer from the lot, less that customer\'s earlier returns (owner 2026-11-18)', async () => {
    // 3 units: 2 to CUST1, 1 to CUST2.
    const p = await producedLot({ fgQty: '3', rmQty: '10', rmCost: '10' });
    await closeBatch(p.fg, p.order, '100.00');
    await setLot(p.fg, 'UNDER_TEST', 'APPROVED', 'RELEASED');
    await postWithJournal('store', { type: 'DISPATCH', lotId: p.fg, qty: '2', customerId: ids.cust });
    await postWithJournal('store', { type: 'DISPATCH', lotId: p.fg, qty: '1', customerId: ids.cust2 });
    const r = await returnLot(p.fg);

    // CUST2 got 1: it cannot return 2, even though 3 left the lot in total.
    await expect(receiveReturn(r.id, '2', { customerId: ids.cust2 })).rejects.toMatchObject({
      code: 'RETURN_EXCEEDS_DISPATCH',
      details: { customerId: ids.cust2, dispatched: '1.0000', returned: '0.0000' },
    });
    await receiveReturn(r.id, '1', { customerId: ids.cust2 });
    // Its earlier return counts, in a later return lot too.
    const r2 = await returnLot(p.fg);
    await expect(receiveReturn(r2.id, '0.0001', { customerId: ids.cust2 })).rejects.toMatchObject({ code: 'RETURN_EXCEEDS_DISPATCH' });
    // CUST1's limit is its own 2 units.
    await receiveReturn(r2.id, '2', { customerId: ids.cust });
    await expect(receiveReturn(r2.id, '0.0001', { customerId: ids.cust })).rejects.toMatchObject({ code: 'RETURN_EXCEEDS_DISPATCH' });

    // A reversed dispatch no longer counts (the reversal row carries the same customer).
    const p2 = await producedLot({ fgQty: '3', rmQty: '10', rmCost: '10' });
    await closeBatch(p2.fg, p2.order, '100.00');
    await setLot(p2.fg, 'UNDER_TEST', 'APPROVED', 'RELEASED');
    const wrong = await postWithJournal('store', { type: 'DISPATCH', lotId: p2.fg, qty: '1', customerId: ids.cust2 });
    const reversal = await as('store', async (tx, a) => {
      const rows = await reverseMovements(tx, a, { movementIds: [wrong.m.id], date: DATE, refDocType: 'TEST', refDocId: doc() });
      await reverseStockJournal(tx, a, { entryId: wrong.entry!.id, movements: rows, reason: 'dispatched to the wrong customer' });
      return rows;
    });
    const { rows: rev } = await client.query(`SELECT customer_id FROM inv.stock_movements WHERE id = $1`, [reversal[0]!.id]);
    expect(rev[0]!.customer_id).toBe(ids.cust2);
    const r3 = await returnLot(p2.fg);
    await expect(receiveReturn(r3.id, '1', { customerId: ids.cust2 })).rejects.toMatchObject({ code: 'RETURN_EXCEEDS_DISPATCH' });
    await expectGlEqualsLedger();
  });

  it('a dispatch and a customer return name an existing customer; no other movement names one', async () => {
    const original = await dispatchedLot('1');
    const r = await returnLot(original);
    await expect(receiveReturn(r.id, '1', { customerId: undefined })).rejects.toThrow(/SALES_RETURN names the customer/);
    await expect(receiveReturn(r.id, '1', { customerId: '987654' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(postWithJournal('store', { type: 'DISPATCH', lotId: original, qty: '1', customerId: undefined })).rejects.toThrow(
      /DISPATCH names the customer/,
    );
    const rm = await approvedRm('2', '5');
    await expect(postWithJournal('store', { type: 'ISSUE', lotId: rm, qty: '1', customerId: ids.cust })).rejects.toThrow(
      /Only a dispatch or a customer return names a customer/,
    );
    expect(await ledger(r.id)).toEqual({ qty: '0', value: '0' });
  });

  it('database: customer on DISPATCH / SALES_RETURN only, required there, per-customer return limit, reversal keeps the customer', async () => {
    const original = await dispatchedLot('2'); // 2 units to CUST1
    const r = await returnLot(original);
    const insert = (type: string, lotId: string, qty: string, customer: string | null, extra: { loc?: string; reversalOf?: string } = {}) =>
      inTx(actors.store!.userId, async () => {
        const inbound = Number(qty) > 0;
        await client.query(
          `INSERT INTO inv.stock_movements (movement_type, movement_date, lot_id, from_location_id, to_location_id, qty, unit_cost, value,
                                            ref_doc_type, ref_doc_id, customer_id, reversal_of)
           VALUES ($1, $2, $3, $4, $5, $6, 33.33, round($6::numeric * 33.33, 2), 'TEST', 1, $7, $8)`,
          [type, DATE, lotId, inbound ? null : (extra.loc ?? ids.loc), inbound ? (extra.loc ?? ids.ret) : null, qty, customer, extra.reversalOf ?? null],
        );
      });
    await expect(insert('SALES_RETURN', r.id, '1', null)).rejects.toThrow(/SALES_RETURN names the customer/);
    await expect(insert('SALES_RETURN', r.id, '1', ids.cust2!)).rejects.toThrow(/RETURN_EXCEEDS_DISPATCH: 0 was dispatched to this customer/);
    await expect(insert('DISPATCH', original, '-1', null)).rejects.toThrow(/DISPATCH names the customer/);
    const rm = await approvedRm('2', '5');
    await expect(
      inTx(actors.store!.userId, async () => {
        await client.query(
          `INSERT INTO inv.stock_movements (movement_type, movement_date, lot_id, from_location_id, qty, unit_cost, value, ref_doc_type, ref_doc_id, customer_id)
           VALUES ('ISSUE', $1, $2, $3, -1, 5, -5, 'TEST', 1, $4)`,
          [DATE, rm, ids.loc, ids.cust],
        );
      }),
    ).rejects.toThrow(/movement_customer_only_dispatch_return/);
    // A reversal of CUST1's dispatch must carry CUST1.
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM inv.stock_movements WHERE lot_id = $1 AND movement_type = 'DISPATCH'`,
      [original],
    );
    await expect(insert('DISPATCH', original, '2', ids.cust2!, { loc: ids.loc, reversalOf: rows[0]!.id })).rejects.toThrow(
      /reversal carries the customer/,
    );
  });

  it('a dispatch goes only to an ACTIVE customer; a return may come from an inactive one; a reversal still works (owner 2026-11-18, 0019)', async () => {
    const newCustomer = async (code: string, status: string) => {
      let id = '';
      await inTx('1', async () => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO master.customers (code, name, ntn, status) VALUES ($1, $1, '7654321', $2) RETURNING id`,
          [code, status],
        );
        id = rows[0]!.id;
        await history('master.customers', id, null, status);
      });
      return id;
    };
    const draft = await newCustomer('CUSTD', 'DRAFT');
    const leaving = await newCustomer('CUSTX', 'ACTIVE');
    const p = await producedLot({ fgQty: '3', rmQty: '10', rmCost: '10' });
    await closeBatch(p.fg, p.order, '100.00');
    await setLot(p.fg, 'UNDER_TEST', 'APPROVED', 'RELEASED');
    const dispatch = (customerId: string) => postWithJournal('store', { type: 'DISPATCH', lotId: p.fg, qty: '1', customerId });

    await expect(dispatch(draft)).rejects.toMatchObject({ code: 'CUSTOMER_NOT_ACTIVE', details: { customerId: draft, status: 'DRAFT' } });
    await dispatch(leaving);
    const second = await dispatch(leaving);
    await inTx('1', async () => {
      await history('master.customers', leaving, 'ACTIVE', 'INACTIVE');
      await client.query(`UPDATE master.customers SET status = 'INACTIVE' WHERE id = $1`, [leaving]);
    });
    await expect(dispatch(leaving)).rejects.toMatchObject({ code: 'CUSTOMER_NOT_ACTIVE', details: { status: 'INACTIVE' } });

    // Returns: the customer only has to exist (owner confirmed). Reversal of a dispatch to a now-inactive customer works.
    const r = await returnLot(p.fg);
    await receiveReturn(r.id, '1', { customerId: leaving });
    await as('store', async (tx, a) => {
      const rows = await reverseMovements(tx, a, { movementIds: [second.m.id], date: DATE, refDocType: 'TEST', refDocId: doc() });
      await reverseStockJournal(tx, a, { entryId: second.entry!.id, movements: rows, reason: 'customer closed before delivery' });
    });
    expect(await ledger(p.fg)).toMatchObject({ qty: '2.0000' });

    // The database refuses the same dispatch on its own (engine bypassed).
    for (const customer of [draft, leaving]) {
      await expect(
        inTx(actors.store!.userId, async () => {
          await client.query(
            `INSERT INTO inv.stock_movements (movement_type, movement_date, lot_id, from_location_id, qty, unit_cost, value, ref_doc_type, ref_doc_id, customer_id)
             VALUES ('DISPATCH', $1, $2, $3, -1, 33.33, -33.33, 'TEST', 1, $4)`,
            [DATE, p.fg, ids.loc, customer],
          );
        }),
      ).rejects.toThrow(/CUSTOMER_NOT_ACTIVE: customer [0-9]+ is (DRAFT|INACTIVE)/);
    }
    await expectGlEqualsLedger();
  });
});
