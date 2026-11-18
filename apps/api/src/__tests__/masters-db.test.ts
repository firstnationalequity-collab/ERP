// Database guards of 0008_masters.sql: the rules hold even if a service forgets them.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl } from '../config/env';
import { createTestUser } from '../test/factories';

const client = new pg.Client({ connectionString: databaseUrl });
let editor: string;
let qa: string;
let uom: string;
let category: string;
let fgItem: string;
let rmItem: string;
let apiItem: string;
let salesTax: string;
let wht: string;

/** Run statements in one transaction acting as `userId` (as withTransaction does). */
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

/** Insert a row with a status and the status_history row core/transition would write. */
async function insertWithStatus(table: string, cols: string, values: unknown[], status: string, actor: string): Promise<string> {
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
  const id = await one(`INSERT INTO ${table} (${cols}, status) VALUES (${placeholders}, '${status}') RETURNING id`, values);
  await client.query(
    `INSERT INTO core.status_history (entity_table, entity_id, from_status, to_status, actor_id) VALUES ($1, $2, NULL, $3, $4)`,
    [table, id, status, actor],
  );
  return id;
}

async function setStatus(table: string, id: string, from: string, to: string, actor: string): Promise<void> {
  await client.query(
    `INSERT INTO core.status_history (entity_table, entity_id, from_status, to_status, actor_id) VALUES ($1, $2, $3, $4, $5)`,
    [table, id, from, to, actor],
  );
  await client.query(`UPDATE ${table} SET status = $1 WHERE id = $2`, [to, id]);
}

async function sign(userId: string, table: string, id: string): Promise<void> {
  await client.query(
    `INSERT INTO core.e_signatures (user_id, signer_username, signer_name, meaning, reason, record_table, record_id)
     VALUES ($1, 'x', 'x', 'APPROVED', 'countersign', $2, $3)`,
    [userId, table, id],
  );
}

beforeAll(async () => {
  await client.connect();
  editor = await createTestUser({ username: 'sm001' });
  qa = await createTestUser({ username: 'qa001' });
  await tx('1', async () => {
    uom = await one(`INSERT INTO master.uoms (code, name) VALUES ('KG', 'Kilogram') RETURNING id`);
    category = await one(`INSERT INTO master.item_categories (code, name) VALUES ('RM', 'Raw material') RETURNING id`);
    salesTax = await one(`INSERT INTO master.tax_codes (code, name, kind, rate) VALUES ('GST18', 'GST', 'SALES_TAX', 18) RETURNING id`);
    wht = await one(`INSERT INTO master.tax_codes (code, name, kind, rate) VALUES ('WHT4', 'WHT', 'WITHHOLDING', 4.5) RETURNING id`);
    const item = (code: string, type: string) =>
      one(`INSERT INTO master.items (code, name, type, category_id, base_uom_id) VALUES ($1, $1, $2, $3, $4) RETURNING id`, [code, type, category, uom]);
    fgItem = await item('FG-1', 'FG');
    rmItem = await item('RM-1', 'RM');
    apiItem = await item('API-1', 'API');
  });
});

afterAll(async () => {
  await client.end();
});

describe('masters are never deleted', () => {
  it('refuses DELETE on a master row', async () => {
    await expect(tx('1', () => client.query('DELETE FROM master.uoms WHERE id = $1', [uom]))).rejects.toThrow(/IN_USE/);
  });

  it('audits every master change', async () => {
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE table_name = 'master.items'`);
    expect(rows[0].n).toBe(3);
  });
});

describe('items', () => {
  it('accepts a sales tax code and refuses a withholding code', async () => {
    await tx('1', () => client.query('UPDATE master.items SET tax_code_id = $1 WHERE id = $2', [salesTax, rmItem]));
    await expect(tx('1', () => client.query('UPDATE master.items SET tax_code_id = $1 WHERE id = $2', [wht, rmItem]))).rejects.toThrow(
      /sales tax code/,
    );
  });

  it('refuses a retest period longer than the shelf life', async () => {
    await expect(
      tx('1', () => client.query('UPDATE master.items SET shelf_life_days = 365, retest_days = 400 WHERE id = $1', [rmItem])),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('customers and vendors', () => {
  it('needs an NTN or a CNIC', async () => {
    await expect(
      tx('1', () => insertWithStatus('master.customers', 'code, name', ['C1', 'No tax id'], 'DRAFT', '1')),
    ).rejects.toThrow(/check constraint/);
    await tx('1', () => insertWithStatus('master.customers', 'code, name, ntn', ['C1', 'With NTN', '1234567-8'], 'DRAFT', '1'));
  });

  it('lets a foreign vendor have no NTN, but not a local one', async () => {
    await expect(tx('1', () => insertWithStatus('master.vendors', 'code, name', ['V1', 'Local'], 'DRAFT', '1'))).rejects.toThrow(
      /check constraint/,
    );
    await tx('1', () => insertWithStatus('master.vendors', 'code, name, is_foreign, country, currency', ['V2', 'Foreign', true, 'CN', 'USD'], 'DRAFT', '1'));
  });

  it('refuses a status change that did not go through core/transition', async () => {
    const id = await tx('1', () => insertWithStatus('master.customers', 'code, name, cnic', ['C2', 'Person', '35202-1234567-1'], 'DRAFT', '1'));
    await expect(tx('1', () => client.query(`UPDATE master.customers SET status = 'ACTIVE' WHERE id = $1`, [id]))).rejects.toThrow(
      /INVALID_TRANSITION/,
    );
  });
});

describe('approved sources', () => {
  it('allows one live row per source and locks its identity', async () => {
    const vendor = await tx('1', () => insertWithStatus('master.vendors', 'code, name, ntn', ['V3', 'Vendor', '7654321'], 'ACTIVE', '1'));
    const id = await tx('1', () =>
      insertWithStatus('master.approved_sources', 'vendor_id, item_id, manufacturer, manufacturing_site', [vendor, apiItem, 'Maker', 'Site A'], 'PENDING', '1'),
    );
    await expect(
      tx('1', () =>
        insertWithStatus('master.approved_sources', 'vendor_id, item_id, manufacturer, manufacturing_site', [vendor, apiItem, 'MAKER', 'site a'], 'PENDING', '1'),
      ),
    ).rejects.toThrow(/approved_sources_live_uq/);
    await expect(tx('1', () => client.query(`UPDATE master.approved_sources SET manufacturing_site = 'Site B' WHERE id = $1`, [id]))).rejects.toThrow(
      /RECORD_LOCKED/,
    );
  });
});

describe('products', () => {
  it('must be an FG item', async () => {
    await expect(tx(editor, () => client.query('INSERT INTO master.products (item_id) VALUES ($1)', [rmItem]))).rejects.toThrow(/FG/);
  });

  it('needs a countersign by another person for registration, artwork and quality agreement', async () => {
    const id = await tx(editor, () => one('INSERT INTO master.products (item_id) VALUES ($1) RETURNING id', [fgItem]));
    // No signature
    await expect(tx(editor, () => client.query(`UPDATE master.products SET registration_no = 'REG-1' WHERE id = $1`, [id]))).rejects.toThrow(
      /COUNTERSIGN_REQUIRED/,
    );
    // Signed by the editor himself
    await expect(
      tx(editor, async () => {
        await client.query(`UPDATE master.products SET artwork_version = 'A1' WHERE id = $1`, [id]);
        await sign(editor, 'master.products', id);
      }),
    ).rejects.toThrow(/COUNTERSIGN_REQUIRED/);
    // Signed by another person in the same transaction
    await tx(editor, async () => {
      await client.query(`UPDATE master.products SET quality_agreement_signed_on = '2026-11-18', registration_no = 'REG-1' WHERE id = $1`, [id]);
      await sign(qa, 'master.products', id);
    });
    // Other fields need no countersign
    await tx(editor, () => client.query('UPDATE master.products SET is_active = true WHERE id = $1', [id]));
  });
});

describe('master formulas', () => {
  let product: string;
  let formula: string;

  beforeAll(async () => {
    const fg2 = await tx('1', () =>
      one(`INSERT INTO master.items (code, name, type, category_id, base_uom_id) VALUES ('FG-2', 'FG-2', 'FG', $1, $2) RETURNING id`, [category, uom]),
    );
    product = await tx(editor, () => one('INSERT INTO master.products (item_id) VALUES ($1) RETURNING id', [fg2]));
    formula = await tx(editor, () =>
      insertWithStatus('master.master_formulas', 'product_id, version, batch_size, batch_uom_id', [product, 1, '100', uom], 'DRAFT', editor),
    );
  });

  const line = (no: number, item: string, extra: string, extraVals: unknown[] = []) =>
    client.query(
      `INSERT INTO master.master_formula_lines (formula_id, line_no, item_id, qty_per_batch, uom_id${extra ? ', ' + extra : ''})
       VALUES ($1, $2, $3, '10.0000', $4${extraVals.map((_, i) => `, $${i + 5}`).join('')})`,
      [formula, no, item, uom, ...extraVals],
    );

  it('refuses to leave DRAFT with no lines, or with API lines but no filler', async () => {
    await expect(tx(editor, () => setStatus('master.master_formulas', formula, 'DRAFT', 'PENDING_APPROVAL', editor))).rejects.toThrow(
      /at least one line/,
    );
    await tx(editor, () => line(1, apiItem, 'is_api, assay_basis', [true, 'DRIED']));
    await expect(tx(editor, () => setStatus('master.master_formulas', formula, 'DRAFT', 'PENDING_APPROVAL', editor))).rejects.toThrow(
      /exactly one filler/,
    );
  });

  it('allows only one filler line and an assay basis only on API lines', async () => {
    await tx(editor, () => line(2, rmItem, 'is_filler', [true]));
    await expect(tx(editor, () => line(3, rmItem, 'is_filler', [true]))).rejects.toThrow(/one_filler/);
    await expect(tx(editor, () => line(3, rmItem, 'assay_basis', ['AS_IS']))).rejects.toThrow(/check constraint/);
  });

  it('locks header and lines once the formula leaves DRAFT', async () => {
    await tx(editor, () => setStatus('master.master_formulas', formula, 'DRAFT', 'PENDING_APPROVAL', editor));
    await expect(tx(editor, () => client.query(`UPDATE master.master_formulas SET batch_size = 200 WHERE id = $1`, [formula]))).rejects.toThrow(
      /RECORD_LOCKED/,
    );
    await expect(tx(editor, () => line(4, rmItem, ''))).rejects.toThrow(/RECORD_LOCKED/);
    await expect(
      tx(editor, () => client.query(`UPDATE master.master_formula_lines SET qty_per_batch = 11 WHERE formula_id = $1`, [formula])),
    ).rejects.toThrow(/RECORD_LOCKED/);
    await expect(tx(editor, () => client.query(`DELETE FROM master.master_formula_lines WHERE formula_id = $1`, [formula]))).rejects.toThrow(
      /RECORD_LOCKED/,
    );
  });

  it('allows only one APPROVED and one open version per product', async () => {
    await tx(qa, () => setStatus('master.master_formulas', formula, 'PENDING_APPROVAL', 'APPROVED', qa));
    const v2 = await tx(editor, () =>
      insertWithStatus('master.master_formulas', 'product_id, version, batch_size, batch_uom_id', [product, 2, '100', uom], 'DRAFT', editor),
    );
    await expect(
      tx(editor, () =>
        insertWithStatus('master.master_formulas', 'product_id, version, batch_size, batch_uom_id', [product, 3, '100', uom], 'DRAFT', editor),
      ),
    ).rejects.toThrow(/one_open/);
    // Approving v2 while v1 is still APPROVED is refused; v1 must become OBSOLETE first.
    await tx(editor, async () => {
      await client.query(
        `INSERT INTO master.master_formula_lines (formula_id, line_no, item_id, qty_per_batch, uom_id) VALUES ($1, 1, $2, 5, $3)`,
        [v2, rmItem, uom],
      );
    });
    await expect(tx(qa, () => setStatus('master.master_formulas', v2, 'DRAFT', 'APPROVED', qa))).rejects.toThrow(/one_approved/);
    await tx(qa, async () => {
      await setStatus('master.master_formulas', formula, 'APPROVED', 'OBSOLETE', qa);
      await setStatus('master.master_formulas', v2, 'DRAFT', 'APPROVED', qa);
    });
  });
});
