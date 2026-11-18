// Entry point for `pnpm db:seed:dev` (development only; see seed/dev.ts).
import { env, databaseUrl } from '../config/env';
import { pool } from './client';
import { runDevSeed } from './seed/dev';

async function main(): Promise<void> {
  // NODE_ENV is read raw: the env schema defaults it to "development", and this command needs it set explicitly.
  const report = await runDevSeed({ nodeEnv: process.env.NODE_ENV, databaseUrl, demoPassword: env.DEV_DEMO_PASSWORD });
  console.log(
    [
      `Demo users created: ${report.usersCreated.length ? report.usersCreated.join(', ') : 'none (all exist)'}`,
      `FY 2026-27 periods: ${report.fiscalYearCreated ? 'created by demo.finance_manager' : 'already exist'}`,
      'Demo users sign in with DEV_DEMO_PASSWORD from .env (no forced change; development only).',
    ].join('\n'),
  );
  await pool.end();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  await pool.end();
  process.exit(1);
});
