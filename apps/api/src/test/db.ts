// Test-database helpers. Destructive: only ever runs against a *_test database with NODE_ENV=test.
import pg from 'pg';
import { databaseUrl, env } from '../config/env';
import { migrate } from '../db/migrate';

const MODULE_SCHEMAS = ['core', 'inv', 'sales', 'purch', 'qc', 'prod', 'qa', 'fin', 'master'] as const;

/** Throws unless the target is clearly a test database. Exported so the guard itself is tested. */
export function assertTestDatabase(url: string, nodeEnv: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (nodeEnv !== 'test' || !name.endsWith('_test')) {
    throw new Error(
      `Refusing to reset database "${name}" with NODE_ENV=${nodeEnv}: only *_test databases may be reset`,
    );
  }
}

/** Drop every module schema and re-apply all migrations, so each test file starts from a clean database. */
export async function resetTestDatabase(): Promise<void> {
  assertTestDatabase(databaseUrl, env.NODE_ENV);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${MODULE_SCHEMAS.join(', ')} CASCADE`);
  } finally {
    await client.end();
  }
  await migrate(databaseUrl);
}
