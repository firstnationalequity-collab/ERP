// pnpm db:seed:dev (owner request 18-11-2026): development-only demo users and FY 2026-27 through the
// normal periods service. The guard refuses any other NODE_ENV and any database whose name says production.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl } from '../config/env';
import { assertDevTarget, demoUsername, runDevSeed } from '../db/seed/dev';
import { ROLE_SEEDS } from '../db/seed/roles';

const client = new pg.Client({ connectionString: databaseUrl });
const DEMO = 'Demo-Password-2026';
const devOpts = { nodeEnv: 'development', databaseUrl, demoPassword: DEMO };

beforeAll(async () => {
  await client.connect();
});
afterAll(async () => {
  await client.end();
});

describe('db:seed:dev guard', () => {
  it('refuses unless NODE_ENV is development', () => {
    expect(() => assertDevTarget('production', 'postgres://a:b@h/albert_erp')).toThrow(/must be "development"/);
    expect(() => assertDevTarget('test', 'postgres://a:b@h/albert_erp')).toThrow(/must be "development"/);
    expect(() => assertDevTarget(undefined, 'postgres://a:b@h/albert_erp')).toThrow(/must be "development"/);
  });

  it('refuses a database whose name looks like production, or no database name', () => {
    expect(() => assertDevTarget('development', 'postgres://a:b@h/albert_erp_prod')).toThrow(/looks like production/);
    expect(() => assertDevTarget('development', 'postgres://a:b@h/PRODUCTION')).toThrow(/looks like production/);
    expect(() => assertDevTarget('development', 'postgres://a:b@h/')).toThrow(/names no database/);
    expect(() => assertDevTarget('development', 'postgres://a:b@h/albert_erp')).not.toThrow();
  });

  it('refuses without DEV_DEMO_PASSWORD or with one that breaks the password policy; writes nothing', async () => {
    await expect(runDevSeed({ ...devOpts, demoPassword: undefined })).rejects.toThrow(/DEV_DEMO_PASSWORD/);
    await expect(runDevSeed({ ...devOpts, demoPassword: 'alllowercase1' })).rejects.toThrow(/password policy/);
    await expect(runDevSeed({ ...devOpts, nodeEnv: 'production' })).rejects.toThrow(/must be "development"/);
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM core.users WHERE username LIKE 'demo.%'`);
    expect(rows[0].n).toBe(0);
  });
});

describe('db:seed:dev', () => {
  it('creates one demo user per role, then FY 2026-27 as the demo Finance Manager through core/transition', async () => {
    const report = await runDevSeed(devOpts);
    expect(report.usersCreated.sort()).toEqual(ROLE_SEEDS.map((r) => demoUsername(r.code)).sort());
    expect(report.fiscalYearCreated).toBe(true);

    const users = await client.query<{ username: string; must_change_password: boolean; roles: string[] }>(
      `SELECT u.username, u.must_change_password, array_agg(r.code) AS roles
         FROM core.users u JOIN core.user_roles ur ON ur.user_id = u.id JOIN core.roles r ON r.id = ur.role_id
        WHERE u.username LIKE 'demo.%' GROUP BY u.id`,
    );
    expect(users.rows).toHaveLength(ROLE_SEEDS.length);
    for (const u of users.rows) {
      expect(u.must_change_password).toBe(false);
      expect(u.roles).toEqual([u.username.slice('demo.'.length).toUpperCase()]);
    }

    const fm = await client.query<{ id: string }>(`SELECT id::text FROM core.users WHERE username = 'demo.finance_manager'`);
    const periods = await client.query(`SELECT name, status, created_by::text AS by FROM core.fiscal_periods WHERE fiscal_year = '2026-27' ORDER BY period_no`);
    expect(periods.rows).toHaveLength(12);
    expect(periods.rows[0]).toMatchObject({ name: 'Jul-2026', status: 'OPEN', by: fm.rows[0]!.id });
    const history = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.status_history WHERE entity_table = 'core.fiscal_periods' AND to_status = 'OPEN' AND actor_id = $1`,
      [fm.rows[0]!.id],
    );
    expect(history.rows[0]!.n).toBe(12);
    // Signed out afterwards: no open session left.
    const sessions = await client.query(`SELECT count(*)::int AS n FROM core.sessions WHERE user_id = $1 AND revoked_at IS NULL`, [fm.rows[0]!.id]);
    expect(sessions.rows[0].n).toBe(0);
  });

  it('is idempotent: a second run creates nothing', async () => {
    const report = await runDevSeed(devOpts);
    expect(report).toEqual({ usersCreated: [], fiscalYearCreated: false });
  });
});
