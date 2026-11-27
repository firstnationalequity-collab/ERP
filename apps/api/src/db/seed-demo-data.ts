// Entry point for `pnpm db:seed:demo-data` (development only; see seed/demo-data.ts).
import { env, databaseUrl } from '../config/env';
import { pool } from './client';
import { runDemoDataSeed } from './seed/demo-data';

async function main(): Promise<void> {
  // NODE_ENV is read raw: the env schema defaults it to "development", and this command needs it set explicitly.
  const report = await runDemoDataSeed({ nodeEnv: process.env.NODE_ENV, databaseUrl, demoPassword: env.DEV_DEMO_PASSWORD });
  console.log(report.done.length ? `Demo data done:\n  ${report.done.join('\n  ')}` : 'Demo data: nothing to do (all present).');
  if (report.skipped.length) console.log(`Left alone:\n  ${report.skipped.join('\n  ')}`);
  await pool.end();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  await pool.end();
  process.exit(1);
});
