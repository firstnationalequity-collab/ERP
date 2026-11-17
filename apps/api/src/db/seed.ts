// Seed data: permissions, roles with their permission bundles, first admin user,
// chart of accounts, number series, fiscal periods. Built out in M1 and M2 (docs/build-plan.md).
// Must be idempotent: running it twice changes nothing.
import { pool } from './client';

async function main(): Promise<void> {
  console.log('Seed: nothing to seed yet — implemented in milestone M1.');
  await pool.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
