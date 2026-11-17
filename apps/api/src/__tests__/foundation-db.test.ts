// Proves the database guards in 0000_foundation.sql. Needs the test database:
//   pnpm db:up   (Docker)   — creates albert_erp_test on first start
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { migrate } from '../db/migrate';
import { databaseUrl } from '../config/env';

const client = new pg.Client({ connectionString: databaseUrl });

beforeAll(async () => {
  await migrate(databaseUrl);
  await client.connect();
  await client.query(`
    DROP TABLE IF EXISTS core.t_doc;
    CREATE TABLE core.t_doc (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('DRAFT','POSTED','REVERSED')),
      amount NUMERIC(18,2) NOT NULL
    );
    SELECT core.enable_audit('core.t_doc');
    SELECT core.protect_posted('core.t_doc');
  `);
});

afterAll(async () => {
  await client.query('DROP TABLE IF EXISTS core.t_doc');
  await client.end();
});

describe('foundation database guards', () => {
  it('writes an audit row with the acting user and reason', async () => {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id','7',true), set_config('app.reason','test entry',true)`);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO core.t_doc (status, amount) VALUES ('DRAFT', 100.50) RETURNING id`,
    );
    await client.query('COMMIT');
    const audit = await client.query(
      `SELECT action, changed_by, reason, new_data->>'amount' AS amount
         FROM core.audit_log WHERE table_name = 'core.t_doc' AND record_id = $1`,
      [rows[0]?.id],
    );
    expect(audit.rows[0]).toMatchObject({ action: 'INSERT', changed_by: '7', reason: 'test entry', amount: '100.50' });
  });

  it('refuses to edit a posted document but allows reversal', async () => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO core.t_doc (status, amount) VALUES ('POSTED', 50) RETURNING id`,
    );
    const id = rows[0]?.id;
    await expect(client.query('UPDATE core.t_doc SET amount = 60 WHERE id = $1', [id])).rejects.toThrow(
      /POSTED_IMMUTABLE/,
    );
    await expect(client.query('DELETE FROM core.t_doc WHERE id = $1', [id])).rejects.toThrow(/POSTED_IMMUTABLE/);
    await client.query(`UPDATE core.t_doc SET status = 'REVERSED' WHERE id = $1`, [id]);
    await expect(client.query(`UPDATE core.t_doc SET status = 'POSTED' WHERE id = $1`, [id])).rejects.toThrow(
      /POSTED_IMMUTABLE/,
    );
  });

  it('keeps the audit log append-only', async () => {
    await expect(client.query('DELETE FROM core.audit_log')).rejects.toThrow(/APPEND_ONLY/);
    await expect(client.query(`UPDATE core.audit_log SET reason = 'x'`)).rejects.toThrow(/APPEND_ONLY/);
  });
});
