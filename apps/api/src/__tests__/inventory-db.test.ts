// Database guards of 0014_inventory.sql (M2 task 5; architecture §4–§6; CLAUDE.md rules 1–4, 7, 11, 12):
// the inventory rules hold even if the engine forgets them. Raw SQL, with the status_history rows
// core/transition writes.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InboundMovementTypes, StockMovementType } from '@albert/shared';
import { databaseUrl } from '../config/env';
import { runSeed } from '../db/seed/run';
import { createTestUser } from '../test/factories';

const client = new pg.Client({ connectionString: databaseUrl });
let wm: string; // Warehouse Manager: creates items
let qa: string; // QA Manager: activates GMP items
const ids: Record<string, string> = {};
let seq = 0;

async function tx<T>(work: () => Promise<T>, userId = '1'): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.user_id', $1, true), set_config('app.company_id', '1', true)`, [userId]);
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function one(sqlText: string, params: unknown[] = []): Promise<string> {
  const { rows } = await client.query<{ id: string }>(sqlText, params);
  return rows[0]!.id;
}

const history = (table: string, id: string, from: string | null, to: string, actor = '1') =>
  client.query(`INSERT INTO core.status_history (entity_table, entity_id, from_status, to_status, actor_id) VALUES ($1, $2, $3, $4, $5)`, [
    table, id, from, to, actor,
  ]);

async function activeItem(code: string, type: string): Promise<string> {
  const id = await tx(async () => {
    const itemId = await one(
      `INSERT INTO master.items (code, name, type, category_id, base_uom_id, status) VALUES ($1, $1, $2, $3, $4, 'DRAFT') RETURNING id`,
      [code, type, ids.category, ids.uom],
    );
    await history('master.items', itemId, null, 'DRAFT', wm);
    return itemId;
  }, wm);
  await tx(async () => {
    await history('master.items', id, 'DRAFT', 'ACTIVE', qa);
    await client.query(`UPDATE master.items SET status = 'ACTIVE' WHERE id = $1`, [id]);
  }, qa);
  return id;
}

interface LotOptions {
  item?: string;
  unitCost?: string;
  owner?: string;
}
/** A new QUARANTINE lot, as the engine creates it. */
function newLot(opts: LotOptions = {}): Promise<string> {
  seq += 1;
  return tx(async () => {
    const id = await one(
      `INSERT INTO inv.lots (item_id, lot_no, status, unit_cost, owner_type, owner_customer_id)
       VALUES ($1, $2, 'QUARANTINE', $3, $4, $5) RETURNING id`,
      [opts.item ?? ids.rm, `L-${seq}`, opts.unitCost ?? '10', opts.owner ? 'CUSTOMER' : 'OWN', opts.owner ?? null],
    );
    await history('inv.lots', id, null, 'QUARANTINE');
    return id;
  });
}

/** Walk a lot through statuses (history first, as core/transition does). */
function setLot(id: string, ...path: string[]): Promise<void> {
  return tx(async () => {
    const { rows } = await client.query<{ status: string }>(`SELECT status FROM inv.lots WHERE id = $1`, [id]);
    let from = rows[0]!.status;
    for (const to of path) {
      await history('inv.lots', id, from, to);
      await client.query(`UPDATE inv.lots SET status = $1 WHERE id = $2`, [to, id]);
      from = to;
    }
  });
}

interface MoveOptions {
  date?: string;
  unitCost?: string;
  value?: string;
  location?: string;
  reversalOf?: string;
}
/** Insert a ledger row; qty > 0 goes into the location, qty < 0 comes out of it. Value defaults to qty × 10. */
function insertMove(type: string, lot: string, qty: string, o: MoveOptions = {}): Promise<string> {
  const inbound = !qty.startsWith('-');
  const loc = o.location ?? ids.loc1;
  return one(
    `INSERT INTO inv.stock_movements
       (movement_type, movement_date, lot_id, from_location_id, to_location_id, qty, unit_cost, value, ref_doc_type, ref_doc_id, reversal_of)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'TEST', 1, $9) RETURNING id`,
    [type, o.date ?? '2026-11-18', lot, inbound ? null : loc, inbound ? loc : null, qty, o.unitCost ?? '10', o.value ?? String(Number(qty) * 10), o.reversalOf ?? null],
  );
}
const move = (type: string, lot: string, qty: string, o: MoveOptions = {}) => tx(() => insertMove(type, lot, qty, o));

async function balance(lot: string, location = ids.loc1): Promise<string | undefined> {
  const { rows } = await client.query<{ qty: string }>(`SELECT qty FROM inv.stock_balances WHERE lot_id = $1 AND location_id = $2`, [lot, location]);
  return rows[0]?.qty;
}

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  wm = await createTestUser({ username: 'wm001', roleCodes: ['WAREHOUSE_MANAGER'] });
  qa = await createTestUser({ username: 'qam001', roleCodes: ['QA_MANAGER'] });
  const fm = await createTestUser({ username: 'fm001', roleCodes: ['FINANCE_MANAGER'] });
  await tx(async () => {
    ids.uom = await one(`INSERT INTO master.uoms (code, name) VALUES ('KG', 'Kilogram') RETURNING id`);
    ids.category = await one(`INSERT INTO master.item_categories (code, name) VALUES ('RM', 'Raw material') RETURNING id`);
    const wh = await one(`INSERT INTO master.warehouses (code, name) VALUES ('MAIN', 'Main store') RETURNING id`);
    ids.loc1 = await one(`INSERT INTO master.locations (warehouse_id, code, name) VALUES ($1, 'A1', 'Rack A1') RETURNING id`, [wh]);
    ids.loc2 = await one(`INSERT INTO master.locations (warehouse_id, code, name) VALUES ($1, 'A2', 'Rack A2') RETURNING id`, [wh]);
    ids.locOff = await one(`INSERT INTO master.locations (warehouse_id, code, name, is_active) VALUES ($1, 'OLD', 'Old', false) RETURNING id`, [wh]);
    for (const [code, toll] of [['TOLL1', true], ['PLAIN', false]] as const) {
      const id = await one(
        `INSERT INTO master.customers (code, name, ntn, is_toll_customer, status) VALUES ($1, $1, '1234567', $2, 'ACTIVE') RETURNING id`,
        [code, toll],
      );
      await history('master.customers', id, null, 'ACTIVE');
      ids[code] = id;
    }
  });
  ids.rm = await activeItem('RM-1', 'RM');
  ids.fg = await activeItem('FG-1', 'FG');
  ids.draft = await tx(async () => {
    const id = await one(
      `INSERT INTO master.items (code, name, type, category_id, base_uom_id, status) VALUES ('RM-D', 'Draft', 'RM', $1, $2, 'DRAFT') RETURNING id`,
      [ids.category, ids.uom],
    );
    await history('master.items', id, null, 'DRAFT', wm);
    return id;
  }, wm);
  // Oct-2026 closed, Nov/Dec-2026 open, as the Fiscal periods page leaves them.
  await tx(async () => {
    for (const [no, name, start, end] of [
      [4, 'Oct-2026', '2026-10-01', '2026-10-31'],
      [5, 'Nov-2026', '2026-11-01', '2026-11-30'],
      [6, 'Dec-2026', '2026-12-01', '2026-12-31'],
    ] as const) {
      const id = await one(
        `INSERT INTO core.fiscal_periods (fiscal_year, period_no, name, start_date, end_date, status) VALUES ('2026-27', $1, $2, $3, $4, 'OPEN') RETURNING id`,
        [no, name, start, end],
      );
      await history('core.fiscal_periods', id, null, 'OPEN', fm);
      if (name === 'Oct-2026') {
        await history('core.fiscal_periods', id, 'OPEN', 'CLOSED', fm);
        await client.query(`UPDATE core.fiscal_periods SET status = 'CLOSED' WHERE id = $1`, [id]);
      }
    }
  }, fm);
});

afterAll(async () => {
  await client.end();
});

describe('movement types', () => {
  it('inv.is_inbound() agrees with InboundMovementTypes for every movement type', async () => {
    for (const type of StockMovementType) {
      const { rows } = await client.query<{ inbound: boolean }>(`SELECT inv.is_inbound($1) AS inbound`, [type]);
      expect({ type, inbound: rows[0]!.inbound }).toEqual({ type, inbound: InboundMovementTypes.includes(type) });
    }
  });
});

describe('lots', () => {
  it('are created in QUARANTINE, through core/transition, for an ACTIVE item', async () => {
    const insert = (status: string, item = ids.rm) =>
      tx(async () => {
        const id = await one(`INSERT INTO inv.lots (item_id, lot_no, status) VALUES ($1, $2, $3) RETURNING id`, [item, `N-${++seq}`, status]);
        await history('inv.lots', id, null, status);
      });
    await expect(insert('APPROVED')).rejects.toThrow(/created in QUARANTINE/);
    await expect(insert('QUARANTINE', ids.draft)).rejects.toThrow(/ACTIVE item/);
    await expect(tx(() => client.query(`INSERT INTO inv.lots (item_id, lot_no, status) VALUES ($1, 'NOHIST', 'QUARANTINE')`, [ids.rm]))).rejects.toThrow(
      /INVALID_TRANSITION/,
    );
    const lot = await newLot();
    await expect(tx(() => client.query(`UPDATE inv.lots SET status = 'APPROVED' WHERE id = $1`, [lot]))).rejects.toThrow(/INVALID_TRANSITION/);
  });

  it('keep item, number and owner; are never deleted; lot numbers are unique per item', async () => {
    const lot = await newLot();
    await expect(tx(() => client.query(`UPDATE inv.lots SET lot_no = 'X' WHERE id = $1`, [lot]))).rejects.toThrow(/never change/);
    await expect(tx(() => client.query(`UPDATE inv.lots SET item_id = $2 WHERE id = $1`, [lot, ids.fg]))).rejects.toThrow(/never change/);
    await expect(tx(() => client.query(`DELETE FROM inv.lots WHERE id = $1`, [lot]))).rejects.toThrow(/IN_USE/);
    await expect(
      tx(async () => {
        const id = await one(`INSERT INTO inv.lots (item_id, lot_no, status) VALUES ($1, $2, 'QUARANTINE') RETURNING id`, [ids.rm, `L-${seq}`]);
        await history('inv.lots', id, null, 'QUARANTINE');
      }),
    ).rejects.toThrow(/duplicate key/);
  });

  it('customer-owned (toll) lots belong to an active toll customer and carry zero value (rule 12)', async () => {
    await expect(newLot({ owner: ids.PLAIN, unitCost: '0' })).rejects.toThrow(/toll customer/);
    await expect(newLot({ owner: ids.TOLL1, unitCost: '5' })).rejects.toThrow(/lot_toll_zero_value/);
    const toll = await newLot({ owner: ids.TOLL1, unitCost: '0' });
    await expect(tx(() => client.query(`UPDATE inv.lots SET unit_cost = 1 WHERE id = $1`, [toll]))).rejects.toThrow(/lot_toll_zero_value/);
    await expect(move('RECEIPT', toll, '100', { unitCost: '0', value: '5' })).rejects.toThrow(/zero value/);
    await move('RECEIPT', toll, '100', { unitCost: '0', value: '0' });
    expect(await balance(toll)).toBe('100.0000');
  });

  it('only a finished-goods lot is RELEASED', async () => {
    const rm = await newLot();
    await expect(setLot(rm, 'UNDER_TEST', 'APPROVED', 'RELEASED')).rejects.toThrow(/only a finished-goods lot/);
    const fg = await newLot({ item: ids.fg });
    await setLot(fg, 'UNDER_TEST', 'APPROVED', 'RELEASED');
  });
});

describe('stock ledger and balances', () => {
  it('a receipt enters a QUARANTINE lot and updates the balance in the same statement', async () => {
    const lot = await newLot();
    await tx(async () => {
      await insertMove('RECEIPT', lot, '250.5', { value: '2505' });
      expect(await balance(lot)).toBe('250.5000');
    });
    await setLot(lot, 'UNDER_TEST', 'APPROVED');
    await expect(move('RECEIPT', lot, '1')).rejects.toThrow(/QUARANTINE lot/);
  });

  it('issues only APPROVED lots (rule 2: LOT_NOT_APPROVED)', async () => {
    const lot = await newLot();
    await move('RECEIPT', lot, '100');
    await expect(move('ISSUE', lot, '-10')).rejects.toThrow(/LOT_NOT_APPROVED/);
    await setLot(lot, 'UNDER_TEST');
    await expect(move('ISSUE', lot, '-10')).rejects.toThrow(/LOT_NOT_APPROVED/);
    await setLot(lot, 'APPROVED');
    await move('ISSUE', lot, '-10');
    expect(await balance(lot)).toBe('90.0000');
    await setLot(lot, 'HOLD');
    await expect(move('ISSUE', lot, '-10')).rejects.toThrow(/LOT_NOT_APPROVED/);
  });

  it('dispatches only RELEASED finished goods (rule 2: LOT_NOT_RELEASED)', async () => {
    const fg = await newLot({ item: ids.fg });
    await move('OUTPUT', fg, '1000');
    await setLot(fg, 'UNDER_TEST', 'APPROVED');
    await expect(move('DISPATCH', fg, '-100')).rejects.toThrow(/LOT_NOT_RELEASED/);
    await setLot(fg, 'RELEASED');
    await move('DISPATCH', fg, '-100');
    expect(await balance(fg)).toBe('900.0000');
  });

  it('never lets stock go negative (rule 3): INSUFFICIENT_STOCK, and the CHECK as backstop', async () => {
    const lot = await newLot();
    await move('RECEIPT', lot, '5');
    await setLot(lot, 'UNDER_TEST', 'APPROVED');
    await expect(move('ISSUE', lot, '-5.0001')).rejects.toThrow(/INSUFFICIENT_STOCK/);
    await expect(move('ISSUE', lot, '-1', { location: ids.loc2 })).rejects.toThrow(/INSUFFICIENT_STOCK/);
    expect(await balance(lot)).toBe('5.0000');
    const { rows } = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'stock_balance_not_negative'`,
    );
    expect(rows[0].def).toBe('CHECK ((qty >= (0)::numeric))');
  });

  it('balances change only through the ledger and are never deleted', async () => {
    const lot = await newLot();
    await move('RECEIPT', lot, '10');
    await expect(tx(() => client.query(`UPDATE inv.stock_balances SET qty = 99 WHERE lot_id = $1`, [lot]))).rejects.toThrow(/only through the stock ledger/);
    await expect(
      tx(() => client.query(`INSERT INTO inv.stock_balances (lot_id, location_id, qty) VALUES ($1, $2, 3)`, [lot, ids.loc2])),
    ).rejects.toThrow(/only through the stock ledger/);
    await expect(tx(() => client.query(`DELETE FROM inv.stock_balances WHERE lot_id = $1`, [lot]))).rejects.toThrow(/APPEND_ONLY/);
    expect(await balance(lot)).toBe('10.0000');
  });

  it('the ledger is append-only (rule 4)', async () => {
    const lot = await newLot();
    const id = await move('RECEIPT', lot, '10');
    await expect(tx(() => client.query(`UPDATE inv.stock_movements SET qty = 11 WHERE id = $1`, [id]))).rejects.toThrow(/APPEND_ONLY/);
    await expect(tx(() => client.query(`DELETE FROM inv.stock_movements WHERE id = $1`, [id]))).rejects.toThrow(/APPEND_ONLY/);
  });

  it('a movement matches its type direction, its lot cost and an active location', async () => {
    const lot = await newLot();
    await expect(move('RECEIPT', lot, '-1')).rejects.toThrow(/must add stock/);
    await expect(move('RECEIPT', lot, '1', { unitCost: '11', value: '11' })).rejects.toThrow(/lot's unit cost/);
    await expect(move('RECEIPT', lot, '1', { location: ids.locOff })).rejects.toThrow(/active location/);
    await expect(move('RECEIPT', lot, '1', { value: '-10' })).rejects.toThrow(/movement_value_sign/);
    await expect(move('RECEIPT', lot, '0', { value: '0' })).rejects.toThrow(/must add stock/);
    // The CHECK holds the same rule for any row the trigger lets through.
    const { rows } = await client.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'movement_one_location'`);
    expect(rows[0].def).toMatch(/qty <> \(0\)::numeric/);
  });

  it('a transfer is an out and an in row; each location keeps its own balance', async () => {
    const lot = await newLot();
    await move('RECEIPT', lot, '40');
    await tx(async () => {
      await insertMove('TRANSFER_OUT', lot, '-15');
      await insertMove('TRANSFER_IN', lot, '15', { location: ids.loc2 });
    });
    expect([await balance(lot), await balance(lot, ids.loc2)]).toEqual(['25.0000', '15.0000']);
  });

  it('a correction is a reversal that mirrors the original, once', async () => {
    const lot = await newLot();
    const receipt = await move('RECEIPT', lot, '30');
    await expect(move('RECEIPT', lot, '-20', { reversalOf: receipt, value: '-200' })).rejects.toThrow(/mirror/);
    const reversal = await move('RECEIPT', lot, '-30', { reversalOf: receipt, value: '-300' });
    expect(await balance(lot)).toBe('0.0000');
    await expect(move('RECEIPT', lot, '-30', { reversalOf: receipt, value: '-300' })).rejects.toThrow(/duplicate key/);
    await expect(move('RECEIPT', lot, '30', { reversalOf: reversal, value: '300' })).rejects.toThrow(/not reversed again/);
  });

  it('refuses a movement dated in a closed or undefined period (rule 11)', async () => {
    const lot = await newLot();
    await expect(move('RECEIPT', lot, '1', { date: '2026-10-15' })).rejects.toThrow(/PERIOD_CLOSED/);
    await expect(move('RECEIPT', lot, '1', { date: '2030-01-01' })).rejects.toThrow(/PERIOD_NOT_DEFINED/);
  });
});

describe('rejected lots (rule 1)', () => {
  it('leave only by DESTROY / RETURN_TO_VENDOR; become DESTROYED only when empty; then never move', async () => {
    const lot = await newLot();
    await move('RECEIPT', lot, '20');
    await expect(move('DESTROY', lot, '-20')).rejects.toThrow(/only a REJECTED lot/);
    await setLot(lot, 'UNDER_TEST', 'REJECTED');
    await expect(move('TRANSFER_OUT', lot, '-5')).rejects.toThrow(/LOT_NOT_APPROVED: .*REJECTED/);
    await expect(move('ADJUSTMENT_OUT', lot, '-5')).rejects.toThrow(/LOT_NOT_APPROVED/);
    await move('DESTROY', lot, '-15');
    await expect(setLot(lot, 'DESTROYED')).rejects.toThrow(/still holds/);
    await move('RETURN_TO_VENDOR', lot, '-5');
    await setLot(lot, 'DESTROYED');
    await expect(move('ADJUSTMENT_IN', lot, '1')).rejects.toThrow(/never moves again/);
  });
});

describe('reservations', () => {
  const reserve = (lot: string, qty: string, ref = 1) =>
    tx(() => client.query(`INSERT INTO inv.stock_reservations (lot_id, qty, ref_doc_type, ref_doc_id) VALUES ($1, $2, 'PROD_ORDER', $3)`, [lot, qty, ref]));

  it('reserve only APPROVED lots (rule 2)', async () => {
    const lot = await newLot();
    await move('RECEIPT', lot, '50');
    await expect(reserve(lot, '10')).rejects.toThrow(/LOT_NOT_APPROVED/);
    await setLot(lot, 'UNDER_TEST', 'APPROVED');
    await reserve(lot, '10');
    await setLot(lot, 'HOLD');
    await expect(
      tx(() => client.query(`UPDATE inv.stock_reservations SET qty = 20 WHERE lot_id = $1`, [lot])),
    ).rejects.toThrow(/LOT_NOT_APPROVED/);
    // Releasing (lowering) is always allowed.
    await tx(() => client.query(`UPDATE inv.stock_reservations SET qty = 0 WHERE lot_id = $1`, [lot]));
  });

  it('never exceed the lot stock, so reserved stock cannot be issued elsewhere', async () => {
    const lot = await newLot();
    await move('RECEIPT', lot, '50');
    await setLot(lot, 'UNDER_TEST', 'APPROVED');
    await expect(reserve(lot, '50.0001')).rejects.toThrow(/INSUFFICIENT_STOCK/);
    await reserve(lot, '40', 1);
    await expect(move('ISSUE', lot, '-11')).rejects.toThrow(/INSUFFICIENT_STOCK: .*reserved/);
    await move('ISSUE', lot, '-10');
    // The order consumes its own reservation in the same transaction as the issue.
    await tx(async () => {
      await client.query(`UPDATE inv.stock_reservations SET qty = qty - 40 WHERE lot_id = $1 AND ref_doc_id = 1`, [lot]);
      await insertMove('ISSUE', lot, '-40');
    });
    expect(await balance(lot)).toBe('0.0000');
  });

  it('keep their lot and document and are never deleted', async () => {
    const lot = await newLot();
    await move('RECEIPT', lot, '5');
    await setLot(lot, 'UNDER_TEST', 'APPROVED');
    await reserve(lot, '1', 7);
    await expect(tx(() => client.query(`UPDATE inv.stock_reservations SET ref_doc_id = 8 WHERE lot_id = $1`, [lot]))).rejects.toThrow(/keeps its lot/);
    await expect(tx(() => client.query(`DELETE FROM inv.stock_reservations WHERE lot_id = $1`, [lot]))).rejects.toThrow(/APPEND_ONLY/);
  });
});

describe('audit (rule 6)', () => {
  it('writes audit rows for lots, movements, balances and reservations', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM core.audit_log WHERE table_name LIKE 'inv.%' ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(['inv.lots', 'inv.stock_balances', 'inv.stock_movements', 'inv.stock_reservations']);
  });
});
