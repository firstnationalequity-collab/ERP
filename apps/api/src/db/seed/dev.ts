// Development-only demo data (`pnpm db:seed:dev`; owner request 18-11-2026, docs/decisions.md).
// Refuses unless NODE_ENV is exactly "development" and the database name does not look like production.
// 1. Runs the normal seed (idempotent).
// 2. Creates one demo user per role (`demo.<role>`), password DEV_DEMO_PASSWORD, no forced change (dev only),
//    written as SYSTEM with reason "dev demo seed" (audited, like the main seed applying docs/roles.md).
// 3. Signs in as the demo Finance Manager and creates FY 2026-27 through the normal periods service, so the
//    first status of every period goes through core/transition under a real person holding core.period.manage
//    (rule 7). Then signs out.
import { inArray, sql } from 'drizzle-orm';
import { systemContext, withTransaction } from '../client';
import { roles, userCredentials, userRoles, users } from '../schema/core';
import { assertPasswordPolicy, hashPassword } from '../../core/auth/password';
import { authenticateToken, login, logout } from '../../core/auth/auth.service';
import { createFiscalYear, listPeriods } from '../../core/settings/periods.service';
import { AppError } from '../../core/errors';
import { ROLE_SEEDS } from './roles';
import { runSeed } from './run';

export const DEV_FISCAL_YEAR_START = 2026; // FY 2026-27
export const DEMO_FINANCE_ROLE = 'FINANCE_MANAGER';

export interface DevSeedOptions {
  nodeEnv: string | undefined;
  databaseUrl: string;
  demoPassword: string | undefined;
}

export interface DevSeedReport {
  usersCreated: string[];
  fiscalYearCreated: boolean;
}

export const demoUsername = (roleCode: string): string => `demo.${roleCode.toLowerCase()}`;

/** The guard: development only, never a database whose name says production. Also used by db:seed:demo-data. */
export function assertDevTarget(nodeEnv: string | undefined, databaseUrl: string, command = 'db:seed:dev'): void {
  if (nodeEnv !== 'development') {
    throw new Error(`${command} refused: NODE_ENV is "${nodeEnv ?? ''}", it must be "development"`);
  }
  let dbName: string;
  try {
    dbName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  } catch {
    throw new Error(`${command} refused: DATABASE_URL is not a valid URL`);
  }
  if (!dbName) throw new Error(`${command} refused: DATABASE_URL names no database`);
  if (/prod/i.test(dbName)) throw new Error(`${command} refused: database "${dbName}" looks like production`);
}

export async function runDevSeed(opts: DevSeedOptions): Promise<DevSeedReport> {
  assertDevTarget(opts.nodeEnv, opts.databaseUrl);
  const password = opts.demoPassword ?? '';
  if (!password) throw new Error('db:seed:dev refused: set DEV_DEMO_PASSWORD in .env');
  for (const r of ROLE_SEEDS) {
    try {
      assertPasswordPolicy(password, demoUsername(r.code));
    } catch (err) {
      throw new Error(`db:seed:dev refused: DEV_DEMO_PASSWORD breaks the password policy (${err instanceof AppError ? err.message : String(err)})`);
    }
  }

  await runSeed({ nodeEnv: 'development' });
  const report: DevSeedReport = { usersCreated: [], fiscalYearCreated: false };
  await createDemoUsers(password, report);

  // Sign in as the demo Finance Manager and create the fiscal year through the normal service.
  const meta = { ip: null, userAgent: 'db:seed:dev' };
  const tokens = await login({ username: demoUsername(DEMO_FINANCE_ROLE), password }, meta);
  try {
    const auth = await authenticateToken(tokens.accessToken);
    if (!auth.permissions.has('core.period.manage')) {
      throw new AppError('FORBIDDEN', `${auth.username} does not hold core.period.manage`);
    }
    const fy = `${DEV_FISCAL_YEAR_START}-${String((DEV_FISCAL_YEAR_START + 1) % 100).padStart(2, '0')}`;
    if ((await listPeriods(auth, fy)).length === 0) {
      await createFiscalYear(auth, DEV_FISCAL_YEAR_START);
      report.fiscalYearCreated = true;
    }
  } finally {
    await logout(tokens.refreshToken, meta);
  }
  return report;
}

async function createDemoUsers(password: string, report: DevSeedReport): Promise<void> {
  const hash = await hashPassword(password);
  await withTransaction(systemContext('dev demo seed'), async (tx) => {
    const wanted = ROLE_SEEDS.map((r) => demoUsername(r.code));
    const existing = new Set(
      (await tx.select({ username: users.username }).from(users).where(inArray(sql`lower(${users.username})`, wanted))).map((u) =>
        u.username.toLowerCase(),
      ),
    );
    const roleIds = new Map((await tx.select({ id: roles.id, code: roles.code }).from(roles)).map((r) => [r.code, r.id]));
    for (const r of ROLE_SEEDS) {
      const username = demoUsername(r.code);
      if (existing.has(username)) continue;
      const roleId = roleIds.get(r.code);
      if (!roleId) throw new Error(`db:seed:dev: role ${r.code} missing`);
      const [user] = await tx
        .insert(users)
        .values({ username, fullName: `Demo ${r.name}`, mustChangePassword: false, passwordChangedAt: new Date() })
        .returning({ id: users.id });
      if (!user) throw new Error('db:seed:dev: user insert returned no row');
      await tx.insert(userCredentials).values({ userId: user.id, passwordHash: hash });
      await tx.insert(userRoles).values({ userId: user.id, roleId });
      report.usersCreated.push(username);
    }
  });
}
