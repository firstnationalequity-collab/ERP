// Entry point for `pnpm db:seed`. The seed itself lives in seed/run.ts (idempotent; acts as SYSTEM).
import { env } from '../config/env';
import { pool } from './client';
import { runSeed } from './seed/run';

async function main(): Promise<void> {
  const report = await runSeed({ nodeEnv: env.NODE_ENV, initialAdminPassword: env.INITIAL_ADMIN_PASSWORD });
  console.log(
    [
      `Permissions: ${report.permissionsCreated} created, ${report.permissionsUpdated} updated, ${report.permissionsDeactivated} deactivated`,
      `Roles created: ${report.rolesCreated.length ? report.rolesCreated.join(', ') : 'none'}`,
      `Keys added to existing roles: ${
        Object.keys(report.keysAdded).length
          ? Object.entries(report.keysAdded)
              .map(([role, keys]) => `\n  ${role}: ${keys.join(', ')}`)
              .join('')
          : 'none'
      }`,
      `Number series created: ${report.seriesCreated.length ? report.seriesCreated.join(', ') : 'none'}`,
      `Approval rules created: ${report.approvalRulesCreated.length ? report.approvalRulesCreated.join(', ') : 'none'}`,
      `First admin: ${report.adminCreated ? 'created (username "admin", must change password at first login)' : `not created (${report.adminSkipped ?? ''})`}`,
    ].join('\n'),
  );
  await pool.end();
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  await pool.end();
  process.exit(1);
});
