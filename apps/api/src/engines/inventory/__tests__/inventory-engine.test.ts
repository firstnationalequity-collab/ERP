// engines/inventory (M2 task 6): lots, movements, transfers, reversals, reservations and FEFO — the happy path and
// every refusal, against the real database (0014 + 0015 guards behind the engine). Valuation follows the owner's
// decision 2026-11-18 (Option A): qty × unit cost rounded half-up, last-out residual, FG at exact batch cost.
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl } from '../../../config/env';
import { systemContext, withTransaction, type Tx } from '../../../db/client';
import { runSeed } from '../../../db/seed/run';
import { permissionKeysForUser } from '../../../core/auth/auth.repo';
import type { Actor } from '../../../core/transition/transition';
import { createTestUser } from '../../../test/factories';
import {
  allocateFefo,
  createLot,
  fefoCandidates,
  fgUnitCost,
  postMovement,
  releaseReservation,
  reservationsOfDocument,
  reserve,
  reverseMovements,
  transfer,
  type MovementInput,
  type NewLot,
} from '..';

const client = new pg.Client({ connectionString: databaseUrl });
const ids: Record<string, string> = {};
const actors: Record<string, Actor> = {};
let seq = 0;

async function raw<T = unknown>(text: string, params: unknown[] = [], userId = '1'): Promise<T[]> {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.user_id', $1, true), set_config('app.company_id', '1', true)`, [userId]);
    const { rows } = await client.query(text, params);
    await client.query('COMMIT');
    return rows as T[];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
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

/** Runs engine work as `who` in one transaction (as a module service would). */
const as = <T>(who: string, work: (tx: Tx, actor: Actor) => Promise<T>) =>
  withTransaction({ userId: actors[who]!.userId, companyId: '1' }, (tx) => work(tx, actors[who]!));

/** Walks a lot through statuses as the QC/QA services will (history first, rule 7). */
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

const lot = (o: Partial<NewLot> = {}, who = 'store') =>
  as(who, (tx, a) => createLot(tx, a, { source: 'GRN', itemId: ids.rm!, lotNo: `E-${++seq}`, unitCost: '10.00', ...o }));

const base = (o: Partial<MovementInput>): MovementInput => ({
  type: 'RECEIPT',
  lotId: '0',
  locationId: ids.loc1!,
  qty: '1',
  date: '2026-11-18',
  refDocType: 'TEST',
  refDocId: '1',
  ...o,
});
const post = (o: Partial<MovementInput>) => as('store', (tx, a) => postMovement(tx, a, base(o)));

/** Lot with `qty` received and APPROVED. */
async function approvedLot(qty: string, o: Partial<NewLot> = {}): Promise<string> {
  const l = await lot(o);
  await post({ lotId: l.id, qty });
  await setLot(l.id, 'UNDER_TEST', 'APPROVED');
  return l.id;
}

async function ledger(lotId: string) {
  const { rows } = await client.query<{ qty: string; value: string }>(
    `SELECT COALESCE(sum(qty), 0)::text AS qty, COALESCE(sum(value), 0)::text AS value FROM inv.stock_movements WHERE lot_id = $1`,
    [lotId],
  );
  return rows[0]!;
}
async function balance(lotId: string, location = ids.loc1!): Promise<string | undefined> {
  const { rows } = await client.query<{ qty: string }>(`SELECT qty FROM inv.stock_balances WHERE lot_id = $1 AND location_id = $2`, [lotId, location]);
  return rows[0]?.qty;
}

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  actors.store = await actorFor('e_store', ['STOREKEEPER']);
  actors.pm = await actorFor('e_pm', ['PRODUCTION_MANAGER']);
  actors.analyst = await actorFor('e_qca', ['QC_ANALYST']);
  const wm = await createTestUser({ username: 'e_wm', roleCodes: ['WAREHOUSE_MANAGER'] });
  const qa = await createTestUser({ username: 'e_qa', roleCodes: ['QA_MANAGER'] });
  const fm = await createTestUser({ username: 'e_fm', roleCodes: ['FINANCE_MANAGER'] });

  const one = async (text: string, params: unknown[] = []) => (await client.query<{ id: string }>(text, params)).rows[0]!.id;
  await inTx('1', async () => {
    ids.uom = await one(`INSERT INTO master.uoms (code, name) VALUES ('KG', 'Kilogram') RETURNING id`);
    ids.category = await one(`INSERT INTO master.item_categories (code, name) VALUES ('RM', 'Raw material') RETURNING id`);
    ids.fgCategory = await one(`INSERT INTO master.item_categories (code, name) VALUES ('FG', 'Finished goods') RETURNING id`);
    const wh = await one(`INSERT INTO master.warehouses (code, name) VALUES ('MAIN', 'Main store') RETURNING id`);
    ids.loc1 = await one(`INSERT INTO master.locations (warehouse_id, code, name) VALUES ($1, 'A1', 'Rack A1') RETURNING id`, [wh]);
    ids.loc2 = await one(`INSERT INTO master.locations (warehouse_id, code, name) VALUES ($1, 'A2', 'Rack A2') RETURNING id`, [wh]);
    ids.locOff = await one(`INSERT INTO master.locations (warehouse_id, code, name, is_active) VALUES ($1, 'OLD', 'Old', false) RETURNING id`, [wh]);
    for (const [code, toll] of [['TOLL1', true], ['PLAIN', false]] as const) {
      ids[code] = await one(
        `INSERT INTO master.customers (code, name, ntn, is_toll_customer, status) VALUES ($1, $1, '1234567', $2, 'ACTIVE') RETURNING id`,
        [code, toll],
      );
      await history('master.customers', ids[code]!, null, 'ACTIVE');
    }
  });
  for (const [key, code, type, category, activate] of [
    ['rm', 'RM-1', 'RM', ids.category, true],
    ['rm2', 'RM-2', 'RM', ids.category, true],
    ['fg', 'FG-1', 'FG', ids.fgCategory, true],
    ['draft', 'RM-D', 'RM', ids.category, false],
  ] as const) {
    await inTx(wm, async () => {
      ids[key] = await one(
        `INSERT INTO master.items (code, name, type, category_id, base_uom_id, status) VALUES ($1, $1, $2, $3, $4, 'DRAFT') RETURNING id`,
        [code, type, category, ids.uom],
      );
      await history('master.items', ids[key]!, null, 'DRAFT', wm);
    });
    if (activate) {
      await inTx(qa, async () => {
        await history('master.items', ids[key]!, 'DRAFT', 'ACTIVE', qa);
        await client.query(`UPDATE master.items SET status = 'ACTIVE' WHERE id = $1`, [ids[key]]);
      });
    }
  }
  await inTx(fm, async () => {
    for (const [no, name, start, end] of [
      [4, 'Oct-2026', '2026-10-01', '2026-10-31'],
      [5, 'Nov-2026', '2026-11-01', '2026-11-30'],
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
  });
});

afterAll(async () => {
  await client.end();
});

describe('createLot', () => {
  it('creates a QUARANTINE lot through core/transition, by the GRN poster', async () => {
    const l = await lot({ unitCost: '12.5', expiryDate: '2028-01-31' });
    expect(l).toMatchObject({ status: 'QUARANTINE', unitCost: '12.50', ownerType: 'OWN', expiryDate: '2028-01-31' });
    const rows = await raw<{ to_status: string; actor_id: string }>(
      `SELECT to_status, actor_id FROM core.status_history WHERE entity_table = 'inv.lots' AND entity_id = $1`,
      [l.id],
    );
    expect(rows).toEqual([{ to_status: 'QUARANTINE', actor_id: actors.store!.userId }]);
  });

  it('refuses an actor without the key for the source; nothing is saved', async () => {
    await expect(lot({ lotNo: 'NOKEY' }, 'analyst')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(lot({ lotNo: 'NOKEY', source: 'PRODUCTION_OUTPUT', itemId: ids.fg }, 'store')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await raw(`SELECT 1 FROM inv.lots WHERE lot_no = 'NOKEY'`)).toEqual([]);
    const fg = await lot({ source: 'PRODUCTION_OUTPUT', itemId: ids.fg, unitCost: fgUnitCost('1000', '3') }, 'pm');
    expect(fg.unitCost).toBe('333.33');
  });

  it('refuses an inactive item, a bad unit cost and a duplicate lot number', async () => {
    await expect(lot({ itemId: ids.draft })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(lot({ unitCost: '1.234' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(lot({ unitCost: '-1' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await lot({ lotNo: 'DUP-1' });
    await expect(lot({ lotNo: 'DUP-1' })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('customer-owned (toll) lots: an active toll customer and unit cost 0 (rule 12)', async () => {
    await expect(lot({ ownerCustomerId: ids.TOLL1, unitCost: '5.00' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(lot({ ownerCustomerId: ids.PLAIN, unitCost: '0' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const toll = await lot({ ownerCustomerId: ids.TOLL1, unitCost: '0' });
    expect(toll).toMatchObject({ ownerType: 'CUSTOMER', ownerCustomerId: ids.TOLL1, unitCost: '0.00' });
  });
});

describe('postMovement', () => {
  it('posts a receipt valued qty × unit cost rounded half-up, returning what posting needs', async () => {
    const l = await lot({ unitCost: '3.33' });
    const m = await post({ lotId: l.id, qty: '1.2345', refDocType: 'GRN', refDocId: '77' });
    expect(m).toMatchObject({
      movementType: 'RECEIPT', lotId: l.id, itemId: ids.rm, itemCategoryId: ids.category, locationId: ids.loc1,
      qty: '1.2345', unitCost: '3.33', value: '4.11', customerOwned: false, refDocType: 'GRN', refDocId: '77', reversalOf: null,
    });
    expect(await balance(l.id)).toBe('1.2345');
  });

  it('values issues at the lot cost and gives the last one the residual, so the lot ends at zero', async () => {
    const id = await approvedLot('1', { unitCost: '0.03' }); // value 0.03
    const first = await post({ type: 'ISSUE', lotId: id, qty: '0.5' });
    const last = await post({ type: 'ISSUE', lotId: id, qty: '0.5' });
    expect([first.qty, first.value, last.value]).toEqual(['-0.5000', '-0.02', '-0.01']);
    expect(await ledger(id)).toEqual({ qty: '0.0000', value: '0.00' });
  });

  it('never takes out more value than the lot holds while stock remains', async () => {
    const id = await approvedLot('1', { unitCost: '0.03' });
    await post({ type: 'ISSUE', lotId: id, qty: '0.5' }); // −0.02, 0.01 left
    await post({ type: 'ISSUE', lotId: id, qty: '0.25' }); // −0.01, 0 left
    const m = await post({ type: 'ISSUE', lotId: id, qty: '0.2' });
    expect(m.value).toBe('0.00');
    expect(await ledger(id)).toEqual({ qty: '0.0500', value: '0.00' });
  });

  it('books FG output at the exact batch cost; dispatch only RELEASED lots; last dispatch takes the residual', async () => {
    const fg = await lot({ source: 'PRODUCTION_OUTPUT', itemId: ids.fg, unitCost: fgUnitCost('1000.00', '3') }, 'pm');
    await expect(post({ type: 'OUTPUT', lotId: fg.id, qty: '3' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(post({ type: 'OUTPUT', lotId: fg.id, qty: '3', value: '1000.02' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const out = await post({ type: 'OUTPUT', lotId: fg.id, qty: '3', value: '1000.00' });
    expect([out.value, out.itemCategoryId]).toEqual(['1000.00', ids.fgCategory]);
    await setLot(fg.id, 'UNDER_TEST', 'APPROVED');
    // Refused by the engine first (its details name the status), the database refuses it again (0014).
    await expect(post({ type: 'DISPATCH', lotId: fg.id, qty: '1' })).rejects.toMatchObject({ code: 'LOT_NOT_RELEASED', details: { status: 'APPROVED' } });
    await setLot(fg.id, 'RELEASED');
    expect((await post({ type: 'DISPATCH', lotId: fg.id, qty: '1' })).value).toBe('-333.33');
    expect((await post({ type: 'DISPATCH', lotId: fg.id, qty: '2' })).value).toBe('-666.67');
    expect(await ledger(fg.id)).toEqual({ qty: '0.0000', value: '0.00' });
  });

  it('moves customer-owned stock at zero value (rule 12)', async () => {
    const toll = await lot({ ownerCustomerId: ids.TOLL1, unitCost: '0' });
    const m = await post({ lotId: toll.id, qty: '100' });
    expect([m.value, m.customerOwned]).toEqual(['0.00', true]);
  });

  it('issues only APPROVED lots (rule 2) and receives only into QUARANTINE lots', async () => {
    const l = await lot();
    await post({ lotId: l.id, qty: '10' });
    await expect(post({ type: 'ISSUE', lotId: l.id, qty: '1' })).rejects.toMatchObject({ code: 'LOT_NOT_APPROVED', details: { status: 'QUARANTINE' } });
    await setLot(l.id, 'UNDER_TEST', 'APPROVED');
    await expect(post({ lotId: l.id, qty: '1' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await setLot(l.id, 'HOLD');
    await expect(post({ type: 'ISSUE', lotId: l.id, qty: '1' })).rejects.toMatchObject({ code: 'LOT_NOT_APPROVED', details: { status: 'HOLD' } });
  });

  it('a REJECTED lot leaves only by destroy / return; a destroyed lot never moves', async () => {
    const l = await lot();
    await post({ lotId: l.id, qty: '10' });
    await expect(post({ type: 'DESTROY', lotId: l.id, qty: '1' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await setLot(l.id, 'UNDER_TEST', 'REJECTED');
    await expect(post({ type: 'ADJUSTMENT_OUT', lotId: l.id, qty: '1' })).rejects.toMatchObject({ code: 'LOT_NOT_APPROVED' });
    await post({ type: 'RETURN_TO_VENDOR', lotId: l.id, qty: '4' });
    const last = await post({ type: 'DESTROY', lotId: l.id, qty: '6' });
    expect(last.value).toBe('-60.00');
    await setLot(l.id, 'DESTROYED');
    await expect(post({ type: 'ADJUSTMENT_IN', lotId: l.id, qty: '1' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('refuses taking out more than the location holds (rule 3)', async () => {
    const id = await approvedLot('5');
    await expect(post({ type: 'ISSUE', lotId: id, qty: '5.0001' })).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    await expect(post({ type: 'ISSUE', lotId: id, qty: '1', locationId: ids.loc2 })).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(await balance(id)).toBe('5.0000');
  });

  it('refuses bad input: quantity, date, document, location, lot, transfer type, a value off OUTPUT', async () => {
    const l = await lot();
    for (const qty of ['0', '-1', '1.23456', 'abc']) {
      await expect(post({ lotId: l.id, qty })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    await expect(post({ lotId: l.id, date: '18-11-2026' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(post({ lotId: l.id, refDocType: 'grn' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(post({ lotId: l.id, locationId: ids.locOff })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(post({ lotId: '999999' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(post({ lotId: l.id, type: 'TRANSFER_IN' as MovementInput['type'] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(post({ lotId: l.id, value: '10.00' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(post({ lotId: l.id, consumeReservation: { refDocType: 'X', refDocId: '1' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a date in a closed or undefined period (rule 11)', async () => {
    const l = await lot();
    await expect(post({ lotId: l.id, date: '2026-10-15' })).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    await expect(post({ lotId: l.id, date: '2030-01-01' })).rejects.toMatchObject({ code: 'PERIOD_NOT_DEFINED' });
  });

  it('serialises concurrent issues of the same stock: one wins, the other gets INSUFFICIENT_STOCK', async () => {
    const id = await approvedLot('10');
    const results = await Promise.allSettled([post({ type: 'ISSUE', lotId: id, qty: '6' }), post({ type: 'ISSUE', lotId: id, qty: '6' })]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(await balance(id)).toBe('4.0000');
  });
});

describe('transfer', () => {
  it('moves stock and its value between locations; the lot total is unchanged', async () => {
    const l = await lot({ unitCost: '0.03' });
    await post({ lotId: l.id, qty: '1' });
    const [out, into] = await as('store', (tx, a) =>
      transfer(tx, a, { lotId: l.id, fromLocationId: ids.loc1!, toLocationId: ids.loc2!, qty: '0.5', date: '2026-11-18', refDocType: 'TRANSFER', refDocId: '1' }),
    );
    expect([out.qty, out.value, into.qty, into.value]).toEqual(['-0.5000', '-0.02', '0.5000', '0.02']);
    expect([await balance(l.id), await balance(l.id, ids.loc2)]).toEqual(['0.5000', '0.5000']);
    expect(await ledger(l.id)).toEqual({ qty: '1.0000', value: '0.03' });
  });

  it('refuses the same location, too much, an inactive target, a REJECTED lot', async () => {
    const l = await lot();
    await post({ lotId: l.id, qty: '2' });
    const t = (o: Partial<Parameters<typeof transfer>[2]>) =>
      as('store', (tx, a) =>
        transfer(tx, a, { lotId: l.id, fromLocationId: ids.loc1!, toLocationId: ids.loc2!, qty: '1', date: '2026-11-18', refDocType: 'TRANSFER', refDocId: '2', ...o }),
      );
    await expect(t({ toLocationId: ids.loc1 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(t({ qty: '3' })).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    await expect(t({ toLocationId: ids.locOff })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await setLot(l.id, 'UNDER_TEST', 'REJECTED');
    await expect(t({})).rejects.toMatchObject({ code: 'LOT_NOT_APPROVED' });
  });
});

describe('reverseMovements', () => {
  const reverse = (movementIds: string[], refDocId = '9') =>
    as('store', (tx, a) => reverseMovements(tx, a, { movementIds, date: '2026-11-18', refDocType: 'REVERSAL', refDocId }));

  it('mirrors an issue (stock and value back), once; a reversal is not reversed', async () => {
    const id = await approvedLot('1', { unitCost: '0.03' });
    const issue = await post({ type: 'ISSUE', lotId: id, qty: '0.5' });
    const [rev] = await reverse([issue.id]);
    expect(rev).toMatchObject({ movementType: 'ISSUE', qty: '0.5000', value: '0.02', reversalOf: issue.id, locationId: ids.loc1 });
    expect(await ledger(id)).toEqual({ qty: '1.0000', value: '0.03' });
    await expect(reverse([issue.id])).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    await expect(reverse([rev!.id])).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(reverse(['999999'])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reverses a transfer only as a whole', async () => {
    const l = await lot();
    await post({ lotId: l.id, qty: '4' });
    const [out, into] = await as('store', (tx, a) =>
      transfer(tx, a, { lotId: l.id, fromLocationId: ids.loc1!, toLocationId: ids.loc2!, qty: '4', date: '2026-11-18', refDocType: 'TRANSFER', refDocId: '3' }),
    );
    await expect(reverse([out.id])).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await reverse([into.id, out.id]);
    expect([await balance(l.id), await balance(l.id, ids.loc2)]).toEqual(['4.0000', '0.0000']);
  });

  it('cannot reverse a receipt whose stock has already been issued', async () => {
    const l = await lot();
    const receipt = await post({ lotId: l.id, qty: '5' });
    await setLot(l.id, 'UNDER_TEST', 'APPROVED');
    await post({ type: 'ISSUE', lotId: l.id, qty: '1' });
    await expect(reverse([receipt.id])).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
  });
});

describe('reservations', () => {
  const doc = (n: string) => ({ refDocType: 'PROD_ORDER', refDocId: n });
  const res = (lotId: string, qty: string, n = '1') => as('store', (tx, a) => reserve(tx, a, { lotId, qty, ...doc(n) }));

  it('reserve only APPROVED lots (rule 2) and never more than the free stock', async () => {
    const l = await lot();
    await post({ lotId: l.id, qty: '50' });
    await expect(res(l.id, '1')).rejects.toMatchObject({ code: 'LOT_NOT_APPROVED', details: { status: 'QUARANTINE' } });
    await setLot(l.id, 'UNDER_TEST', 'APPROVED');
    await res(l.id, '30', '1');
    const again = await res(l.id, '10', '1');
    expect(again.qty).toBe('40.0000');
    await expect(res(l.id, '10.0001', '2')).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    await res(l.id, '10', '2');
  });

  it('stock reserved for one document cannot be issued to another; the owner consumes its own', async () => {
    const id = await approvedLot('50');
    await res(id, '40', '11');
    await expect(post({ type: 'ISSUE', lotId: id, qty: '11' })).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    await post({ type: 'ISSUE', lotId: id, qty: '10' });
    await post({ type: 'ISSUE', lotId: id, qty: '25', consumeReservation: doc('11') });
    const [r] = await as('store', (tx, a) => reservationsOfDocument(tx, a.companyId, doc('11')));
    expect(r!.qty).toBe('15.0000');
    expect(await balance(id)).toBe('15.0000');
  });

  it('release lowers a reservation, in part or in full; never below zero', async () => {
    const id = await approvedLot('20');
    await res(id, '12', '21');
    const rel = (qty?: string, n = '21') => as('store', (tx, a) => releaseReservation(tx, a, { lotId: id, qty, ...doc(n) }));
    expect((await rel('2')).qty).toBe('10.0000');
    await expect(rel('10.0001')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(rel(undefined, '22')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await setLot(id, 'HOLD'); // releasing is allowed whatever the status
    expect((await rel()).qty).toBe('0.0000');
  });
});

describe('FEFO', () => {
  it('offers usable lots earliest expiry first, net of other reservations, and allocates across them', async () => {
    const mk = async (qty: string, o: Partial<NewLot>, status: string[] = ['UNDER_TEST', 'APPROVED']) => {
      const l = await lot({ itemId: ids.rm2, ...o });
      await post({ lotId: l.id, qty });
      await setLot(l.id, ...status);
      return l.id;
    };
    const noExpiry = await mk('100', {});
    const late = await mk('10', { expiryDate: '2028-06-30' });
    const early = await mk('10', { expiryDate: '2027-01-31' });
    await mk('10', { expiryDate: '2026-11-18' }); // expires today: not offered
    await mk('10', { expiryDate: '2029-01-31', retestDate: '2026-11-01' }); // retest date passed
    await mk('10', { expiryDate: '2026-12-31' }, ['UNDER_TEST']); // not APPROVED
    await mk('10', { expiryDate: '2026-12-15', ownerCustomerId: ids.TOLL1, unitCost: '0' }); // toll stock
    await as('store', (tx, a) => reserve(tx, a, { lotId: early, qty: '4', refDocType: 'PROD_ORDER', refDocId: '31' }));
    await as('store', (tx, a) => reserve(tx, a, { lotId: late, qty: '3', refDocType: 'PROD_ORDER', refDocId: '32' }));

    const own = await as('store', (tx, a) =>
      fefoCandidates(tx, a.companyId, { itemId: ids.rm2!, purpose: 'ISSUE', asOf: '2026-11-18', ownerCustomerId: null, forDocument: { refDocType: 'PROD_ORDER', refDocId: '32' } }),
    );
    expect(own.map((c) => [c.lotId, c.available, c.reservedForOthers, c.reservedForDocument])).toEqual([
      [early, '6.0000', '4.0000', '0.0000'],
      [late, '10.0000', '0.0000', '3.0000'],
      [noExpiry, '100.0000', '0.0000', '0.0000'],
    ]);
    expect(allocateFefo(own, '20')).toEqual([
      { lotId: early, qty: '6.0000' },
      { lotId: late, qty: '10.0000' },
      { lotId: noExpiry, qty: '4.0000' },
    ]);
    expect(() => allocateFefo(own, '116.0001')).toThrow(expect.objectContaining({ code: 'INSUFFICIENT_STOCK' }));

    const toll = await as('store', (tx, a) => fefoCandidates(tx, a.companyId, { itemId: ids.rm2!, purpose: 'ISSUE', asOf: '2026-11-18', ownerCustomerId: ids.TOLL1 }));
    expect(toll.map((c) => [c.customerOwned, c.available])).toEqual([[true, '10.0000']]);
    const dispatchable = await as('store', (tx, a) => fefoCandidates(tx, a.companyId, { itemId: ids.rm2!, purpose: 'DISPATCH', asOf: '2026-11-18' }));
    expect(dispatchable).toEqual([]);
  });

  it('limits to the given locations', async () => {
    const l = await lot({ itemId: ids.rm2, lotNo: 'LOC-ONLY', expiryDate: '2026-11-30' });
    await post({ lotId: l.id, qty: '8' });
    await as('store', (tx, a) =>
      transfer(tx, a, { lotId: l.id, fromLocationId: ids.loc1!, toLocationId: ids.loc2!, qty: '3', date: '2026-11-18', refDocType: 'TRANSFER', refDocId: '40' }),
    );
    await setLot(l.id, 'UNDER_TEST', 'APPROVED');
    const [first] = await as('store', (tx, a) =>
      fefoCandidates(tx, a.companyId, { itemId: ids.rm2!, purpose: 'ISSUE', asOf: '2026-11-18', locationIds: [ids.loc2!] }),
    );
    expect(first).toMatchObject({ lotId: l.id, onHand: '8.0000', available: '3.0000', locations: [{ locationId: ids.loc2, qty: '3.0000' }] });
  });
});
