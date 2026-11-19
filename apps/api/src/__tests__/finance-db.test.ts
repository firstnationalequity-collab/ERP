// Database guards of 0012_finance_masters.sql (architecture §5 "Finance", §6; CLAUDE.md rules 4, 5, 10, 11):
// the rules hold even if a service forgets them. Raw SQL, with the status_history rows core/transition writes.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountRole, PostingEvent, PostingEventRoles } from '@albert/shared';
import { databaseUrl } from '../config/env';
import { runSeed } from '../db/seed/run';
import { PLACEHOLDER_ACCOUNTS, PLACEHOLDER_TAX_CODES } from '../db/seed/finance';
import { createTestUser } from '../test/factories';

const client = new pg.Client({ connectionString: databaseUrl });
let fm: string;
const acct: Record<string, string> = {};
let seq = 0;

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

const history = (table: string, id: string, from: string | null, to: string, actor: string) =>
  client.query(
    `INSERT INTO core.status_history (entity_table, entity_id, from_status, to_status, actor_id) VALUES ($1, $2, $3, $4, $5)`,
    [table, id, from, to, actor],
  );

/** A DRAFT entry with lines [account code, debit, credit][], in its own transaction. */
function draft(lines: [string, string, string][], date = '2026-11-18', extra: { reversalOf?: string } = {}): Promise<string> {
  return tx(fm, async () => {
    seq += 1;
    const id = await one(
      `INSERT INTO fin.journal_entries (doc_no, entry_date, source_type, narration, status, reversal_of)
       VALUES ($1, $2, 'MANUAL', 'test', 'DRAFT', $3) RETURNING id`,
      [`JV-T-${seq}`, date, extra.reversalOf ?? null],
    );
    await history('fin.journal_entries', id, null, 'DRAFT', fm);
    let n = 0;
    for (const [code, debit, credit] of lines) {
      n += 1;
      await client.query(`INSERT INTO fin.journal_lines (entry_id, line_no, account_id, debit, credit) VALUES ($1, $2, $3, $4, $5)`, [
        id, n, acct[code], debit, credit,
      ]);
    }
    return id;
  });
}

const post = (id: string) =>
  tx(fm, async () => {
    await history('fin.journal_entries', id, 'DRAFT', 'POSTED', fm);
    await client.query(`UPDATE fin.journal_entries SET status = 'POSTED' WHERE id = $1`, [id]);
  });

async function entry(id: string): Promise<Record<string, unknown>> {
  return (await client.query(`SELECT * FROM fin.journal_entries WHERE id = $1`, [id])).rows[0];
}

beforeAll(async () => {
  await client.connect();
  await runSeed({ nodeEnv: 'test' });
  fm = await createTestUser({ username: 'fm001', roleCodes: ['FINANCE_MANAGER'] });
  const { rows } = await client.query<{ id: string; code: string }>(`SELECT id, code FROM fin.accounts`);
  for (const r of rows) acct[r.code] = r.id;
  // FY 2026-27 periods, OPEN (as the Fiscal periods page creates them), and Oct-2026 closed.
  await tx(fm, async () => {
    for (const [name, start, end] of [
      ['Oct-2026', '2026-10-01', '2026-10-31'],
      ['Nov-2026', '2026-11-01', '2026-11-30'],
      ['Dec-2026', '2026-12-01', '2026-12-31'],
    ]) {
      const id = await one(
        `INSERT INTO core.fiscal_periods (fiscal_year, period_no, name, start_date, end_date, status)
         VALUES ('2026-27', $1, $2, $3, $4, 'OPEN') RETURNING id`,
        [Number(start!.slice(5, 7)) - 6, name, start, end],
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

describe('posting events and placeholder seed', () => {
  it('fin.is_valid_posting_role equals PostingEventRoles for every event × role', async () => {
    for (const event of PostingEvent) {
      for (const role of AccountRole) {
        const { rows } = await client.query<{ ok: boolean }>(`SELECT fin.is_valid_posting_role($1, $2) AS ok`, [event, role]);
        expect(rows[0]!.ok, `${event}/${role}`).toBe(PostingEventRoles[event].includes(role));
      }
    }
  });

  it('seeds the PLACEHOLDER chart, a default rule for every event/role, placeholder tax codes and the JV and SJ series', async () => {
    const accounts = await client.query(`SELECT count(*)::int AS n FROM fin.accounts WHERE is_placeholder`);
    expect(accounts.rows[0].n).toBe(PLACEHOLDER_ACCOUNTS.length);
    const expectedRules = Object.values(PostingEventRoles).reduce((n, r) => n + r.length, 0);
    const rules = await client.query(
      `SELECT count(*)::int AS n FROM fin.posting_rules r JOIN fin.accounts a ON a.id = r.account_id
        WHERE r.is_placeholder AND r.item_category_id IS NULL AND a.is_postable AND a.is_active`,
    );
    expect(rules.rows[0].n).toBe(expectedRules);
    const tax = await client.query(`SELECT code FROM master.tax_codes WHERE is_placeholder ORDER BY code`);
    expect(tax.rows.map((r) => r.code)).toEqual(PLACEHOLDER_TAX_CODES.map((t) => t.code).sort());
    const wht = await client.query(`SELECT name FROM master.tax_codes WHERE kind = 'WITHHOLDING' AND is_placeholder`);
    expect(wht.rows.length).toBeGreaterThan(0);
    for (const r of wht.rows) expect(r.name).toMatch(/RATE NOT CONFIRMED$/);
    const series = await client.query(`SELECT doc_type, prefix, pattern, reset FROM core.number_series WHERE doc_type IN ('JV', 'SJ') ORDER BY doc_type`);
    expect(series.rows).toEqual([
      { doc_type: 'JV', prefix: 'JV', pattern: '{PREFIX}-{FY}-{SEQ:5}', reset: 'FISCAL_YEAR' },
      { doc_type: 'SJ', prefix: 'SJ', pattern: '{PREFIX}-{FY}-{SEQ:5}', reset: 'FISCAL_YEAR' },
    ]);
  });
});

describe('accounts', () => {
  it('fixes code and type; never re-marks placeholder', async () => {
    await expect(tx(fm, () => client.query(`UPDATE fin.accounts SET code = '1111' WHERE code = '1110'`))).rejects.toThrow(/code and type never change/);
    await expect(tx(fm, () => client.query(`UPDATE fin.accounts SET type = 'EXPENSE' WHERE code = '1110'`))).rejects.toThrow(/code and type never change/);
    await tx(fm, () => client.query(`UPDATE fin.accounts SET is_placeholder = false, name = 'Petty cash' WHERE code = '1110'`));
    await expect(tx(fm, () => client.query(`UPDATE fin.accounts SET is_placeholder = true WHERE code = '1110'`))).rejects.toThrow(/placeholder again/);
  });

  it('needs a header parent of the same type and refuses cycles', async () => {
    await expect(
      tx(fm, () => client.query(`INSERT INTO fin.accounts (code, name, type, parent_id) VALUES ('1399', 'x', 'ASSET', $1)`, [acct['1310']])),
    ).rejects.toThrow(/must be a header/);
    await expect(
      tx(fm, () => client.query(`INSERT INTO fin.accounts (code, name, type, parent_id) VALUES ('1398', 'x', 'EXPENSE', $1)`, [acct['1300']])),
    ).rejects.toThrow(/same type/);
    await expect(tx(fm, () => client.query(`UPDATE fin.accounts SET parent_id = $1 WHERE code = '1000'`, [acct['1300']]))).rejects.toThrow(
      /under itself/,
    );
  });

  it('refuses to deactivate an account used by an active posting rule, or a header with active sub-accounts', async () => {
    await expect(tx(fm, () => client.query(`UPDATE fin.accounts SET is_active = false WHERE code = '1310'`))).rejects.toThrow(/IN_USE/);
    await expect(tx(fm, () => client.query(`UPDATE fin.accounts SET is_active = false WHERE code = '1300'`))).rejects.toThrow(/IN_USE/);
    await expect(tx(fm, () => client.query(`DELETE FROM fin.accounts WHERE code = '3100'`))).rejects.toThrow(/IN_USE/);
  });

  it('a header with sub-accounts stays a header', async () => {
    await expect(tx(fm, () => client.query(`UPDATE fin.accounts SET is_postable = true WHERE code = '1300'`))).rejects.toThrow(/stay a header/);
  });
});

describe('posting rules', () => {
  it('refuses a role the event does not use, a duplicate rule, a header account, and changing the key', async () => {
    await expect(
      tx(fm, () =>
        client.query(`INSERT INTO fin.posting_rules (event, account_role, account_id) VALUES ('DISPATCH', 'BANK', $1)`, [acct['1120']]),
      ),
    ).rejects.toThrow(/posting_rule_role_valid/);
    await expect(
      tx(fm, () =>
        client.query(`INSERT INTO fin.posting_rules (event, account_role, account_id) VALUES ('DISPATCH', 'COGS', $1)`, [acct['5100']]),
      ),
    ).rejects.toThrow(/posting_rule_unique/);
    await expect(
      tx(fm, () => client.query(`UPDATE fin.posting_rules SET account_id = $1 WHERE event = 'DISPATCH' AND account_role = 'COGS'`, [acct['5000']])),
    ).rejects.toThrow(/active postable account/);
    await expect(
      tx(fm, () => client.query(`UPDATE fin.posting_rules SET account_role = 'INVENTORY' WHERE event = 'DISPATCH' AND account_role = 'COGS'`)),
    ).rejects.toThrow(/never change/);
  });

  it('accepts a per-category rule next to the default', async () => {
    const cat = await tx(fm, () => one(`INSERT INTO master.item_categories (code, name) VALUES ('API', 'API') RETURNING id`));
    await tx(fm, () =>
      client.query(`INSERT INTO fin.posting_rules (event, account_role, item_category_id, account_id) VALUES ('GRN_RECEIPT', 'INVENTORY', $1, $2)`, [
        cat, acct['1310'],
      ]),
    );
  });
});

describe('journal entries', () => {
  it('posts a balanced entry: period from the date, posted_at/by set, audited', async () => {
    const id = await draft([['1310', '1000.50', '0'], ['2120', '0', '1000.50']]);
    await post(id);
    const e = await entry(id);
    expect(e).toMatchObject({ status: 'POSTED', posted_by: fm });
    expect(e.posted_at).not.toBeNull();
    const period = await client.query(`SELECT name FROM core.fiscal_periods WHERE id = $1`, [e.period_id]);
    expect(period.rows[0].name).toBe('Nov-2026');
    const audit = await client.query(`SELECT count(*)::int AS n FROM core.audit_log WHERE table_name LIKE 'fin.journal_%'`);
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });

  it('is created DRAFT only', async () => {
    await expect(
      tx(fm, () =>
        client.query(`INSERT INTO fin.journal_entries (doc_no, entry_date, source_type, narration, status) VALUES ('JV-X', '2026-11-18', 'MANUAL', 'x', 'POSTED')`),
      ),
    ).rejects.toThrow(/created DRAFT/);
  });

  it('refuses an unbalanced entry, a one-line entry and an empty entry (JOURNAL_UNBALANCED)', async () => {
    await expect(post(await draft([['1310', '100', '0'], ['2120', '0', '99.99']]))).rejects.toThrow(/JOURNAL_UNBALANCED/);
    await expect(post(await draft([['1310', '100', '0']]))).rejects.toThrow(/JOURNAL_UNBALANCED/);
    await expect(post(await draft([]))).rejects.toThrow(/JOURNAL_UNBALANCED/);
  });

  it('a line has exactly one side and money scale 2', async () => {
    const id = await draft([]);
    const bad = (debit: string, credit: string) =>
      tx(fm, () => client.query(`INSERT INTO fin.journal_lines (entry_id, line_no, account_id, debit, credit) VALUES ($1, 1, $2, $3, $4)`, [id, acct['1310'], debit, credit]));
    await expect(bad('10', '10')).rejects.toThrow(/journal_line_one_side/);
    await expect(bad('0', '0')).rejects.toThrow(/journal_line_one_side/);
    await expect(bad('-5', '0')).rejects.toThrow(/check/);
    const col = await client.query(
      `SELECT numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema = 'fin' AND table_name = 'journal_lines' AND column_name = 'debit'`,
    );
    expect(col.rows[0]).toEqual({ numeric_precision: 18, numeric_scale: 2 });
  });

  it('refuses lines on a header or inactive account', async () => {
    await expect(draft([['1300', '1', '0'], ['2120', '0', '1']])).rejects.toThrow(/not an active postable account/);
    await tx(fm, () => client.query(`UPDATE fin.accounts SET is_active = false WHERE code = '3100'`));
    await expect(draft([['3100', '1', '0'], ['2120', '0', '1']])).rejects.toThrow(/not an active postable account/);
  });

  it('a posted entry and its lines never change; only a reversal undoes it (rule 4)', async () => {
    const id = await draft([['1310', '50', '0'], ['2120', '0', '50']]);
    await post(id);
    await expect(tx(fm, () => client.query(`UPDATE fin.journal_entries SET narration = 'changed' WHERE id = $1`, [id]))).rejects.toThrow(/POSTED_IMMUTABLE/);
    await expect(tx(fm, () => client.query(`DELETE FROM fin.journal_entries WHERE id = $1`, [id]))).rejects.toThrow(/POSTED_IMMUTABLE/);
    await expect(tx(fm, () => client.query(`UPDATE fin.journal_lines SET debit = 60 WHERE entry_id = $1 AND line_no = 1`, [id]))).rejects.toThrow(/POSTED_IMMUTABLE/);
    await expect(tx(fm, () => client.query(`DELETE FROM fin.journal_lines WHERE entry_id = $1`, [id]))).rejects.toThrow(/POSTED_IMMUTABLE/);
    await expect(
      tx(fm, () => client.query(`INSERT INTO fin.journal_lines (entry_id, line_no, account_id, debit) VALUES ($1, 9, $2, 1)`, [id, acct['1310']])),
    ).rejects.toThrow(/POSTED_IMMUTABLE/);
  });

  it('a status change without core/transition is refused (rule 7)', async () => {
    const id = await draft([['1310', '5', '0'], ['2120', '0', '5']]);
    await expect(tx(fm, () => client.query(`UPDATE fin.journal_entries SET status = 'POSTED' WHERE id = $1`, [id]))).rejects.toThrow(/INVALID_TRANSITION/);
  });

  it('refuses posting into a closed or undefined period (rule 11)', async () => {
    await expect(post(await draft([['1310', '5', '0'], ['2120', '0', '5']], '2026-10-15'))).rejects.toThrow(/PERIOD_CLOSED/);
    await expect(draft([['1310', '5', '0'], ['2120', '0', '5']], '2030-01-01')).rejects.toThrow(/PERIOD_NOT_DEFINED/);
  });

  it('reversal: mirror lines, original POSTED, marked REVERSED only by its posted reversal, once', async () => {
    const original = await draft([['1310', '70', '0'], ['2120', '0', '70']]);
    await post(original);

    // Not a mirror (wrong amount) → refused.
    const wrong = await draft([['1310', '0', '60'], ['2120', '60', '0']], '2026-12-01', { reversalOf: original });
    await expect(post(wrong)).rejects.toThrow(/mirror/);

    // Cannot mark REVERSED without a posted reversal.
    await expect(
      tx(fm, async () => {
        await history('fin.journal_entries', original, 'POSTED', 'REVERSED', fm);
        await client.query(`UPDATE fin.journal_entries SET status = 'REVERSED', reversal_id = $2 WHERE id = $1`, [original, wrong]);
      }),
    ).rejects.toThrow(/its own posted reversal/);

    // Mirror posted (in a later open period), then the original marked REVERSED, in one transaction.
    await tx(fm, () => client.query(`DELETE FROM fin.journal_lines WHERE entry_id = $1`, [wrong]));
    await tx(fm, () => client.query(`DELETE FROM fin.journal_entries WHERE id = $1`, [wrong]));
    const reversal = await draft([['2120', '70', '0'], ['1310', '0', '70']], '2026-12-01', { reversalOf: original });
    await tx(fm, async () => {
      await history('fin.journal_entries', reversal, 'DRAFT', 'POSTED', fm);
      await client.query(`UPDATE fin.journal_entries SET status = 'POSTED' WHERE id = $1`, [reversal]);
      await history('fin.journal_entries', original, 'POSTED', 'REVERSED', fm);
      await client.query(`UPDATE fin.journal_entries SET status = 'REVERSED', reversal_id = $2 WHERE id = $1`, [original, reversal]);
    });
    expect(await entry(original)).toMatchObject({ status: 'REVERSED', reversal_id: reversal, reversed_by: fm });

    // A second reversal of the same entry is refused.
    await expect(draft([['2120', '70', '0'], ['1310', '0', '70']], '2026-12-01', { reversalOf: original })).rejects.toThrow(/unique|duplicate/i);
    // A reversed entry never changes again.
    await expect(tx(fm, () => client.query(`UPDATE fin.journal_entries SET narration = 'x' WHERE id = $1`, [original]))).rejects.toThrow(/POSTED_IMMUTABLE/);
  });

  it('a reversal of a DRAFT entry cannot be posted', async () => {
    const d = await draft([['1310', '3', '0'], ['2120', '0', '3']]);
    const r = await draft([['2120', '3', '0'], ['1310', '0', '3']], '2026-11-18', { reversalOf: d });
    await expect(post(r)).rejects.toThrow(/only a POSTED entry/);
  });
});

describe('deactivating an account with a balance (owner 2026-11-19, 0021)', () => {
  it('is refused while posted lines leave a balance, and allowed once they net to zero; drafts do not count', async () => {
    acct['1199'] = await tx(fm, () =>
      one(`INSERT INTO fin.accounts (code, name, type, parent_id) VALUES ('1199', 'Guard test cash', 'ASSET', (SELECT parent_id FROM fin.accounts WHERE code = '1110')) RETURNING id`),
    );
    const off = () => tx(fm, () => client.query(`UPDATE fin.accounts SET is_active = false WHERE code = '1199'`));
    const on = () => tx(fm, () => client.query(`UPDATE fin.accounts SET is_active = true WHERE code = '1199'`));
    await draft([['1199', '250.00', '0'], ['1110', '0', '250.00']]); // a DRAFT has no effect
    await off();
    await on();
    await post(await draft([['1199', '250.00', '0'], ['1110', '0', '250.00']]));
    await expect(off()).rejects.toThrow(/IN_USE: account 1199 has a balance of 250/);
    await post(await draft([['1110', '250.00', '0'], ['1199', '0', '250.00']]));
    await off();
    await on();
  });
});

describe('manual and system journals (0013)', () => {
  const insert = (sourceType: string, sourceId: string | null, event: string | null) =>
    tx(fm, () =>
      client.query(
        `INSERT INTO fin.journal_entries (doc_no, entry_date, source_type, source_id, event, narration, status)
         VALUES ($1, '2026-11-18', $2, $3, $4, 'x', 'DRAFT')`,
        [`SRC-${++seq}`, sourceType, sourceId, event],
      ),
    );

  it('a manual journal has no posting event and no source document', async () => {
    await expect(insert('MANUAL', null, 'GRN_RECEIPT')).rejects.toThrow(/journal_manual_has_no_event/);
    await expect(insert('MANUAL', '5', null)).rejects.toThrow(/journal_system_names_source/);
  });

  it('a system journal names its posting event and source document', async () => {
    await expect(insert('GRN', null, 'GRN_RECEIPT')).rejects.toThrow(/journal_system_names_source/);
    await expect(insert('GRN', '5', null)).rejects.toThrow(/journal_manual_has_no_event/);
  });
});

describe('withholding tax needs a confirmed rate (0013)', () => {
  async function whtEntry(taxCodeId: string): Promise<string> {
    const id = await draft([['5300', '100', '0'], ['2120', '0', '96']]);
    await tx(fm, () =>
      client.query(`INSERT INTO fin.journal_lines (entry_id, line_no, account_id, credit, tax_code_id) VALUES ($1, 3, $2, 4, $3)`, [
        id, acct['2220'], taxCodeId,
      ]),
    );
    return id;
  }
  const taxId = (code: string) => one(`SELECT id FROM master.tax_codes WHERE code = $1`, [code]);

  it('refuses to post a line with a placeholder WHT rate until Finance confirms it', async () => {
    const wht = await taxId('WHT-153-1A');
    const id = await whtEntry(wht);
    await expect(post(id)).rejects.toThrow(/TAX_RATE_NOT_CONFIRMED/);
    expect((await entry(id)).status).toBe('DRAFT');

    await tx(fm, () => client.query(`UPDATE master.tax_codes SET is_placeholder = false WHERE id = $1`, [wht]));
    await post(id);
    expect((await entry(id)).status).toBe('POSTED');
  });

  it('a placeholder sales-tax code does not block posting (the owner rule covers WHT)', async () => {
    const st = await taxId('ST-18');
    const id = await draft([['1210', '118', '0'], ['4100', '0', '100']]);
    await tx(fm, () =>
      client.query(`INSERT INTO fin.journal_lines (entry_id, line_no, account_id, credit, tax_code_id) VALUES ($1, 3, $2, 18, $3)`, [id, acct['2210'], st]),
    );
    await post(id);
  });

  it('a confirmed tax code is never marked placeholder again, and its kind never changes', async () => {
    const wht = await taxId('WHT-153-1A');
    await expect(tx(fm, () => client.query(`UPDATE master.tax_codes SET is_placeholder = true WHERE id = $1`, [wht]))).rejects.toThrow(/placeholder again/);
    await expect(tx(fm, () => client.query(`UPDATE master.tax_codes SET kind = 'SALES_TAX' WHERE id = $1`, [wht]))).rejects.toThrow(/kind never changes/);
  });
});
