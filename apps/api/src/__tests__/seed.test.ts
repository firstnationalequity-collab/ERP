// Seed: permissions, roles from docs/roles.md, SYSTEM user, first admin (decisions Q7, Q9, Q14).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Permissions, PermissionKeys, ViewPermissionKeys } from '@albert/shared';
import { databaseUrl } from '../config/env';
import { runSeed } from '../db/seed/run';
import { FIRST_ADMIN_USERNAME, ROLE_SEEDS } from '../db/seed/roles';

const client = new pg.Client({ connectionString: databaseUrl });
// Must meet the policy, including "must not contain the username" (the username is "admin").
const ADMIN_PASSWORD = 'Initial-Pharma-2026';

async function count(sqlText: string, params: unknown[] = []): Promise<number> {
  const { rows } = await client.query<{ n: number }>(`SELECT (${sqlText})::int AS n`, params);
  return rows[0]!.n;
}

async function keysOf(roleCode: string): Promise<string[]> {
  const { rows } = await client.query<{ key: string }>(
    `SELECT p.key FROM core.role_permissions rp
       JOIN core.roles r ON r.id = rp.role_id JOIN core.permissions p ON p.id = rp.permission_id
      WHERE r.code = $1 ORDER BY p.key`,
    [roleCode],
  );
  return rows.map((r) => r.key);
}

beforeAll(async () => {
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe('seed refusals', () => {
  it('refuses to run in production without INITIAL_ADMIN_PASSWORD and writes nothing', async () => {
    await expect(runSeed({ nodeEnv: 'production' })).rejects.toThrow(/INITIAL_ADMIN_PASSWORD/);
    expect(await count('SELECT count(*) FROM core.permissions')).toBe(0);
  });

  it('refuses an initial admin password that breaks the policy', async () => {
    await expect(runSeed({ nodeEnv: 'development', initialAdminPassword: 'short' })).rejects.toMatchObject({
      code: 'PASSWORD_POLICY',
    });
    await expect(runSeed({ nodeEnv: 'development', initialAdminPassword: 'Xadmin12345' })).rejects.toMatchObject({
      code: 'PASSWORD_POLICY',
    });
    expect(await count('SELECT count(*) FROM core.permissions')).toBe(0);
  });
});

describe('first seed', () => {
  beforeAll(async () => {
    await runSeed({ nodeEnv: 'development', initialAdminPassword: ADMIN_PASSWORD });
  });

  it('syncs every permission key with its class', async () => {
    const { rows } = await client.query<{ key: string; class: string; is_active: boolean }>(
      `SELECT key, class, is_active FROM core.permissions ORDER BY key`,
    );
    expect(rows.map((r) => r.key)).toEqual([...PermissionKeys].sort());
    for (const row of rows) {
      expect(row.class).toBe(Permissions[row.key as keyof typeof Permissions].class);
      expect(row.is_active).toBe(true);
    }
  });

  it('creates the 20 roles with exactly the bundles in seed/roles.ts', async () => {
    expect(await count('SELECT count(*) FROM core.roles')).toBe(20);
    for (const role of ROLE_SEEDS) {
      expect(await keysOf(role.code)).toEqual([...role.keys].sort());
    }
  });

  it('gives the CEO every view key and nothing else', async () => {
    expect(await keysOf('CEO')).toEqual([...ViewPermissionKeys].sort());
  });

  it('gives every role the approvals inbox and System Admin no action key', async () => {
    for (const role of ROLE_SEEDS) expect(await keysOf(role.code)).toContain('core.approval.inbox');
    const adminKeys = await keysOf('SYSTEM_ADMIN');
    for (const key of adminKeys) expect(Permissions[key as keyof typeof Permissions].class).not.toBe('ACTION');
  });

  it('gives item master to the Planner and formula drafting to the QA Officer only (docs/roles.md point 2)', async () => {
    const { rows } = await client.query<{ key: string; code: string }>(
      `SELECT p.key, r.code FROM core.role_permissions rp
         JOIN core.permissions p ON p.id = rp.permission_id JOIN core.roles r ON r.id = rp.role_id
        WHERE p.key IN ('master.item.manage', 'master.formula.manage') ORDER BY p.key, r.code`,
    );
    expect(rows).toEqual([
      { key: 'master.formula.manage', code: 'QA_OFFICER' },
      { key: 'master.item.manage', code: 'PLANNER' },
    ]);
  });

  it('creates the first admin: forced password change, one credential, System Admin role only', async () => {
    const { rows } = await client.query(
      `SELECT u.must_change_password, u.is_system, u.password_changed_at IS NOT NULL AS has_changed_at,
              (SELECT count(*)::int FROM core.user_credentials c WHERE c.user_id = u.id AND c.is_current) AS creds,
              (SELECT array_agg(r.code) FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS roles
         FROM core.users u WHERE u.username = $1`,
      [FIRST_ADMIN_USERNAME],
    );
    expect(rows[0]).toEqual({
      must_change_password: true,
      is_system: false,
      has_changed_at: true,
      creds: 1,
      roles: ['SYSTEM_ADMIN'],
    });
  });

  it('records the seed as the SYSTEM user in the audit trail, without any password hash', async () => {
    expect(await count(`SELECT count(*) FROM core.audit_log WHERE changed_by IS DISTINCT FROM 1`)).toBe(0);
    expect(await count(`SELECT count(*) FROM core.audit_log WHERE reason = 'seed'`)).toBeGreaterThan(0);
    expect(
      await count(
        `SELECT count(*) FROM core.audit_log WHERE coalesce(new_data::text,'') LIKE '%$argon2%' OR coalesce(old_data::text,'') LIKE '%$argon2%'`,
      ),
    ).toBe(0);
  });

  it('gives the SYSTEM user no password and no roles', async () => {
    expect(await count(`SELECT count(*) FROM core.user_credentials WHERE user_id = 1`)).toBe(0);
    expect(await count(`SELECT count(*) FROM core.user_roles WHERE user_id = 1`)).toBe(0);
  });
});

describe('second seed', () => {
  it('changes nothing (no new rows, no audit entries)', async () => {
    const auditBefore = await count('SELECT count(*) FROM core.audit_log');
    const report = await runSeed({ nodeEnv: 'development', initialAdminPassword: ADMIN_PASSWORD });
    expect(report).toMatchObject({
      permissionsCreated: 0,
      permissionsUpdated: 0,
      permissionsDeactivated: 0,
      rolesCreated: [],
      seriesCreated: [],
      approvalRulesCreated: [],
      adminCreated: false,
      adminSkipped: 'already exists',
    });
    expect(await count('SELECT count(*) FROM core.audit_log')).toBe(auditBefore);
  });

  it('never edits an existing role (role changes go through the role admin)', async () => {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id','1',true), set_config('app.company_id','1',true)`);
    await client.query(
      `DELETE FROM core.role_permissions WHERE role_id = (SELECT id FROM core.roles WHERE code = 'PLANNER')
         AND permission_id = (SELECT id FROM core.permissions WHERE key = 'sales.view')`,
    );
    await client.query('COMMIT');
    await runSeed({ nodeEnv: 'development' });
    expect(await keysOf('PLANNER')).not.toContain('sales.view');
  });

  it('deactivates a key that was removed from the code', async () => {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.user_id','1',true), set_config('app.company_id','1',true)`);
    await client.query(`INSERT INTO core.permissions (key, class, description) VALUES ('core.legacy.thing','VIEW','old')`);
    await client.query('COMMIT');
    const report = await runSeed({ nodeEnv: 'development' });
    expect(report.permissionsDeactivated).toBe(1);
    const { rows } = await client.query(`SELECT is_active FROM core.permissions WHERE key = 'core.legacy.thing'`);
    expect(rows[0]).toEqual({ is_active: false });
  });
});

describe('docs/roles.md and seed/roles.ts agree', () => {
  it('has the same keys per role in the document as in the seed', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const doc = await readFile(path.resolve(here, '../../../../docs/roles.md'), 'utf8');
    const section = doc.split('## Role → keys')[1]?.split('\n## ')[0] ?? '';
    const docRoles = new Map<string, string[]>();
    for (const line of section.split('\n')) {
      const cells = line.split('|').map((c) => c.trim());
      // | # | Role | View keys | Action / admin keys |
      if (cells.length < 6 || !/^\d+$/.test(cells[1] ?? '')) continue;
      const name = cells[2] ?? '';
      const keys = [...`${cells[3]} ${cells[4]}`.matchAll(/`([a-z_.]+)`/g)].map((m) => m[1]!);
      docRoles.set(name, [...new Set([...keys, 'core.approval.inbox'])].sort());
    }
    expect(docRoles.size).toBe(ROLE_SEEDS.length);
    for (const role of ROLE_SEEDS) {
      expect(docRoles.get(role.name), role.name).toEqual([...role.keys].sort());
    }
  });
});
