// Database guards of 0011_item_activation.sql (owner decisions 18-11-2026): the item rules hold even if a service
// forgets them. Statements run as raw SQL with the status_history rows core/transition would write.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GmpItemTypes, ItemType } from '@albert/shared';
import { databaseUrl } from '../config/env';
import { runSeed } from '../db/seed/run';
import { createTestUser } from '../test/factories';

const client = new pg.Client({ connectionString: databaseUrl });
let keeper1: string; // Warehouse Manager (master.item.manage)
let keeper2: string; // Purchase Manager (master.item.manage)
let keeper3: string; // Warehouse Manager (master.item.manage)
let qa: string; // QA Manager (master.item.approve)
let uom: string;
let category: string;

async function tx<T>(userId: string, work: () => Promise<T>): Promise<T> {
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

/** Create an item as `actor` the way the service does: DRAFT plus its first history row. */
function newItem(actor: string, code: string, type: string): Promise<string> {
  return tx(actor, async () => {
    const id = await one(
      `INSERT INTO master.items (code, name, type, category_id, base_uom_id, status) VALUES ($1, $1, $2, $3, $4, 'DRAFT') RETURNING id`,
      [code, type, category, uom],
    );
    await client.query(
      `INSERT INTO core.status_history (entity_table, entity_id, from_status, to_status, actor_id) VALUES ('master.items', $1, NULL, 'DRAFT', $2)`,
      [id, actor],
    );
    return id;
  });
}

/** Move an item's status as `actor`, writing the history row first (as core/transition does). */
function move(actor: string, id: string, from: string, to: string): Promise<void> {
  return tx(actor, async () => {
    await client.query(
      `INSERT INTO core.status_history (entity_table, entity_id, from_status, to_status, actor_id) VALUES ('master.items', $1, $2, $3, $4)`,
      [id, from, to, actor],
    );
    await client.query(`UPDATE master.items SET status = $1 WHERE id = $2`, [to, id]);
  });
}

async function statusOf(id: string): Promise<{ status: string; is_active: boolean }> {
  const { rows } = await client.query<{ status: string; is_active: boolean }>(`SELECT status, is_active FROM master.items WHERE id = $1`, [id]);
  return rows[0]!;
}

function sign(userId: string, id: string): Promise<unknown> {
  return client.query(
    `INSERT INTO core.e_signatures (user_id, signer_username, signer_name, meaning, reason, record_table, record_id)
     VALUES ($1, 'x', 'x', 'APPROVED', 'countersign', 'master.items', $2)`,
    [userId, id],
  );
}

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  keeper1 = await createTestUser({ username: 'wm001', roleCodes: ['WAREHOUSE_MANAGER'] });
  keeper2 = await createTestUser({ username: 'pm001', roleCodes: ['PURCHASE_MANAGER'] });
  keeper3 = await createTestUser({ username: 'wm002', roleCodes: ['WAREHOUSE_MANAGER'] });
  qa = await createTestUser({ username: 'qam001', roleCodes: ['QA_MANAGER'] });
  await tx('1', async () => {
    uom = await one(`INSERT INTO master.uoms (code, name) VALUES ('KG', 'Kilogram') RETURNING id`);
    category = await one(`INSERT INTO master.item_categories (code, name) VALUES ('RM', 'Raw material') RETURNING id`);
  });
});

afterAll(async () => {
  await client.end();
});

describe('GMP item types', () => {
  it('master.is_gmp_item_type() agrees with GmpItemTypes for every item type', async () => {
    for (const type of ItemType) {
      const { rows } = await client.query<{ gmp: boolean }>(`SELECT master.is_gmp_item_type($1) AS gmp`, [type]);
      expect({ type, gmp: rows[0]!.gmp }).toEqual({ type, gmp: GmpItemTypes.includes(type) });
    }
  });
});

describe('item lifecycle in the database', () => {
  it('starts every item as DRAFT and keeps is_active generated from the status', async () => {
    await expect(
      tx(keeper1, () =>
        client.query(`INSERT INTO master.items (code, name, type, category_id, base_uom_id, status) VALUES ('X', 'X', 'RM', $1, $2, 'ACTIVE')`, [category, uom]),
      ),
    ).rejects.toThrow(/INVALID_TRANSITION: a new item starts as DRAFT/);
    const id = await newItem(keeper1, 'RM-GEN', 'RM');
    expect(await statusOf(id)).toEqual({ status: 'DRAFT', is_active: false });
    await expect(tx(qa, () => client.query(`UPDATE master.items SET is_active = true WHERE id = $1`, [id]))).rejects.toThrow(/can only be updated to DEFAULT/);
  });

  it('refuses a status change without its history row (core/transition only)', async () => {
    const id = await newItem(keeper1, 'RM-RAW', 'RM');
    await expect(tx(qa, () => client.query(`UPDATE master.items SET status = 'ACTIVE' WHERE id = $1`, [id]))).rejects.toThrow(/INVALID_TRANSITION/);
  });

  it('GMP item: only a master.item.approve holder moves it, never its creator', async () => {
    const id = await newItem(keeper1, 'API-1', 'API');
    await expect(move(keeper2, id, 'DRAFT', 'ACTIVE')).rejects.toThrow(/FORBIDDEN: only a holder of master.item.approve/);
    const qaMade = await newItem(qa, 'API-2', 'API');
    await expect(move(qa, qaMade, 'DRAFT', 'ACTIVE')).rejects.toThrow(/SEGREGATION_OF_DUTIES/);
    await move(qa, id, 'DRAFT', 'ACTIVE');
    expect(await statusOf(id)).toEqual({ status: 'ACTIVE', is_active: true });
    await expect(move(keeper1, id, 'ACTIVE', 'INACTIVE')).rejects.toThrow(/FORBIDDEN/);
    await move(qa, id, 'ACTIVE', 'INACTIVE');
    await move(qa, id, 'INACTIVE', 'ACTIVE'); // QA may reactivate what QA deactivated
    expect((await statusOf(id)).status).toBe('ACTIVE');
  });

  it('non-GMP item: a master.item.manage holder who neither created nor last edited it; not reactivated by its deactivator', async () => {
    const id = await newItem(keeper1, 'SP-1', 'SPARE');
    await expect(move(keeper1, id, 'DRAFT', 'ACTIVE')).rejects.toThrow(/SEGREGATION_OF_DUTIES/);
    await tx(keeper2, () => client.query(`UPDATE master.items SET name = 'Belt' WHERE id = $1`, [id]));
    await expect(move(keeper2, id, 'DRAFT', 'ACTIVE')).rejects.toThrow(/SEGREGATION_OF_DUTIES/); // last editor
    await expect(move(keeper1, id, 'DRAFT', 'ACTIVE')).rejects.toThrow(/SEGREGATION_OF_DUTIES/); // still the creator
    await expect(move(qa, id, 'DRAFT', 'ACTIVE')).rejects.toThrow(/FORBIDDEN: only a holder of master.item.manage/);
    await move(keeper3, id, 'DRAFT', 'ACTIVE');
    await move(keeper2, id, 'ACTIVE', 'INACTIVE');
    await expect(move(keeper2, id, 'INACTIVE', 'ACTIVE')).rejects.toThrow(/SEGREGATION_OF_DUTIES: the person who deactivated/);
    await move(keeper1, id, 'INACTIVE', 'ACTIVE');
    expect((await statusOf(id)).status).toBe('ACTIVE');
  });
});

describe('GMP fields of a GMP item after DRAFT need a QA countersign', () => {
  let gmp: string;
  let spare: string;

  beforeAll(async () => {
    gmp = await newItem(keeper1, 'EXC-1', 'EXCIPIENT');
    spare = await newItem(keeper1, 'SP-2', 'CONSUMABLE');
    await tx(keeper1, () => client.query(`UPDATE master.items SET shelf_life_days = 700 WHERE id = $1`, [gmp])); // DRAFT: free
    await move(qa, gmp, 'DRAFT', 'ACTIVE');
    await move(keeper2, spare, 'DRAFT', 'ACTIVE');
  });

  it.each([
    ['shelf_life_days', '365'],
    ['retest_days', '90'],
    ['storage_zone', "'COLD_2_8C'"],
    ['is_controlled', 'true'],
  ])('refuses a change of %s without a countersign', async (col, value) => {
    await expect(tx(keeper1, () => client.query(`UPDATE master.items SET ${col} = ${value} WHERE id = $1`, [gmp]))).rejects.toThrow(
      /COUNTERSIGN_REQUIRED/,
    );
  });

  it('refuses a countersign by the editor or by someone without master.item.approve; accepts QA', async () => {
    const change = (signer: string) =>
      tx(keeper1, async () => {
        await client.query(`UPDATE master.items SET shelf_life_days = 365 WHERE id = $1`, [gmp]);
        await sign(signer, gmp);
      });
    await expect(change(keeper1)).rejects.toThrow(/COUNTERSIGN_REQUIRED/);
    await expect(change(keeper2)).rejects.toThrow(/COUNTERSIGN_REQUIRED/);
    await change(qa);
    const { rows } = await client.query(`SELECT shelf_life_days FROM master.items WHERE id = $1`, [gmp]);
    expect(rows[0]).toEqual({ shelf_life_days: 365 });
  });

  it('leaves the name of a GMP item and every field of a non-GMP item free', async () => {
    await tx(keeper1, () => client.query(`UPDATE master.items SET name = 'Microcrystalline cellulose' WHERE id = $1`, [gmp]));
    await tx(keeper1, () => client.query(`UPDATE master.items SET shelf_life_days = 100, storage_zone = 'FROZEN' WHERE id = $1`, [spare]));
  });
});

describe('item identity is fixed', () => {
  it.each([
    ['code', "'NEW-CODE'"],
    ['type', "'PM'"],
  ])('refuses a change of %s', async (col, value) => {
    const id = await newItem(keeper1, `ID-${col}`.toUpperCase(), 'RM');
    await expect(tx(keeper1, () => client.query(`UPDATE master.items SET ${col} = ${value} WHERE id = $1`, [id]))).rejects.toThrow(
      /VALIDATION_FAILED: item code, type and base unit/,
    );
  });

  it('refuses a change of base unit', async () => {
    const id = await newItem(keeper1, 'ID-UOM', 'RM');
    const g = await tx('1', () => one(`INSERT INTO master.uoms (code, name) VALUES ('G', 'Gram') RETURNING id`));
    await expect(tx(keeper1, () => client.query(`UPDATE master.items SET base_uom_id = $1 WHERE id = $2`, [g, id]))).rejects.toThrow(
      /VALIDATION_FAILED/,
    );
  });
});
