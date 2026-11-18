// Entry point: pnpm --filter @albert/api bootstrap:qa-manager -- --user <employee code> --reason "<why>"
// One-time: refuses once an active QA Manager exists. See db/seed/bootstrap-qa-manager.ts.
import { parseArgs } from 'node:util';
import { pool } from './client';
import { bootstrapQaManager } from './seed/bootstrap-qa-manager';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { user: { type: 'string' }, reason: { type: 'string' } },
    allowPositionals: false,
  });
  await bootstrapQaManager({ username: values.user ?? '', reason: values.reason ?? '' });
  console.log(`QA Manager role given to "${values.user}". Recorded in the audit trail as SYSTEM with your reason.`);
  await pool.end();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  await pool.end();
  process.exit(1);
});
