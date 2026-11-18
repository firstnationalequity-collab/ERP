// Seed: permissions, roles from docs/roles.md, SYSTEM user, first admin (decisions Q7, Q9, Q14).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Permissions, PermissionKeys, ViewPermissionKeys } from '@albert/shared';
import { databaseUrl } from '../config/env';
import { ROLE_SYNC_REASON, RoleBundleDriftError, runSeed } from '../db/seed/run';
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

/**
 * Formula segregation breaches in a set of role bundles. A "QA role" is a QA-department role (code QA_*) or any
 * role holding a qa.* action key other than qa.deviation.manage (raising a deviation is open to Production too).
 */
function formulaSegregationBreaches(bundles: Map<string, string[]>): string[] {
  const breaches: string[] = [];
  for (const [code, keys] of bundles) {
    const drafts = keys.includes('master.formula.manage');
    if (drafts && keys.includes('master.formula.approve')) {
      breaches.push(`${code} holds master.formula.manage and master.formula.approve`);
    }
    const isQa = code.startsWith('QA_') || keys.some((k) => k.startsWith('qa.') && k !== 'qa.view' && k !== 'qa.deviation.manage');
    if (drafts && isQa) breaches.push(`QA role ${code} holds master.formula.manage`);
  }
  return breaches;
}

/** Run one statement as the SYSTEM user (what the role admin would do, minus its service checks). */
async function asSystem(sqlText: string): Promise<void> {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.user_id','1',true), set_config('app.company_id','1',true)`);
  await client.query(sqlText);
  await client.query('COMMIT');
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

  it('gives item master to the Warehouse and Purchase Managers and formula drafting to the Production Manager only (roles.md point 2)', async () => {
    const { rows } = await client.query<{ key: string; code: string }>(
      `SELECT p.key, r.code FROM core.role_permissions rp
         JOIN core.permissions p ON p.id = rp.permission_id JOIN core.roles r ON r.id = rp.role_id
        WHERE p.key IN ('master.item.manage', 'master.formula.manage') ORDER BY p.key, r.code`,
    );
    expect(rows).toEqual([
      { key: 'master.formula.manage', code: 'PRODUCTION_MANAGER' },
      { key: 'master.item.manage', code: 'PURCHASE_MANAGER' },
      { key: 'master.item.manage', code: 'WAREHOUSE_MANAGER' },
    ]);
  });

  it('keeps formula drafting away from its approvers and from QA, in the seeded database', async () => {
    const { rows } = await client.query<{ code: string; key: string }>(
      `SELECT r.code, p.key FROM core.role_permissions rp
         JOIN core.roles r ON r.id = rp.role_id JOIN core.permissions p ON p.id = rp.permission_id
        WHERE p.is_active`,
    );
    const bundles = new Map<string, string[]>();
    for (const r of rows) bundles.set(r.code, [...(bundles.get(r.code) ?? []), r.key]);
    expect(formulaSegregationBreaches(bundles)).toEqual([]);
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
      keysAdded: {},
      seriesCreated: [],
      approvalRulesCreated: [],
      accountsCreated: [],
      postingRulesCreated: [],
      taxCodesCreated: [],
      adminCreated: false,
      adminSkipped: 'already exists',
    });
    expect(await count('SELECT count(*) FROM core.audit_log')).toBe(auditBefore);
  });

  it('adds keys missing from existing roles, reports them and audits them as SYSTEM with the sync reason', async () => {
    await asSystem(
      `DELETE FROM core.role_permissions WHERE role_id IN (SELECT id FROM core.roles WHERE code IN ('PLANNER','QA_MANAGER'))
         AND permission_id IN (SELECT id FROM core.permissions WHERE key IN ('sales.view','qa.product.countersign'))`,
    );
    const auditBefore = await count('SELECT max(id) FROM core.audit_log');
    const report = await runSeed({ nodeEnv: 'development' });
    expect(report.rolesCreated).toEqual([]);
    expect(report.keysAdded).toEqual({ PLANNER: ['sales.view'], QA_MANAGER: ['qa.product.countersign'] });
    expect(await keysOf('PLANNER')).toContain('sales.view');
    const { rows } = await client.query<{ changed_by: string; reason: string }>(
      `SELECT changed_by::text, reason FROM core.audit_log WHERE id > $1 AND table_name = 'core.role_permissions'`,
      [auditBefore],
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toEqual({ changed_by: '1', reason: ROLE_SYNC_REASON });
  });

  it('adds a key that needs a QA countersign (qa.product.countersign) without one: SYSTEM from approved roles.md', async () => {
    // Covered by the previous test's QA_MANAGER row; here: no e-signature was needed or written.
    expect(await keysOf('QA_MANAGER')).toContain('qa.product.countersign');
    expect(await count(`SELECT count(*) FROM core.e_signatures`)).toBe(0);
  });

  it('stops when a role holds a key roles.md does not list: lists it, removes nothing, adds nothing', async () => {
    await asSystem(
      `INSERT INTO core.role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM core.roles r, core.permissions p WHERE r.code = 'PLANNER' AND p.key = 'purch.view'`,
    );
    // A missing key elsewhere must NOT be added by the refused run.
    await asSystem(
      `DELETE FROM core.role_permissions WHERE role_id = (SELECT id FROM core.roles WHERE code = 'CEO')
         AND permission_id = (SELECT id FROM core.permissions WHERE key = 'fin.view')`,
    );
    const auditBefore = await count('SELECT count(*) FROM core.audit_log');
    const err = await runSeed({ nodeEnv: 'development' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoleBundleDriftError);
    expect((err as RoleBundleDriftError).extraKeys).toEqual({ PLANNER: ['purch.view'] });
    expect((err as RoleBundleDriftError).message).toContain('PLANNER: purch.view');
    expect(await keysOf('PLANNER')).toContain('purch.view');
    expect(await keysOf('CEO')).not.toContain('fin.view');
    expect(await count('SELECT count(*) FROM core.audit_log')).toBe(auditBefore);

    // Owner decides: remove the extra key; the next run then restores the CEO key.
    await asSystem(
      `DELETE FROM core.role_permissions WHERE role_id = (SELECT id FROM core.roles WHERE code = 'PLANNER')
         AND permission_id = (SELECT id FROM core.permissions WHERE key = 'purch.view')`,
    );
    const report = await runSeed({ nodeEnv: 'development' });
    expect(report.keysAdded).toEqual({ CEO: ['fin.view'] });
  });

  it('migration 0010 removes exactly the two owner-approved grants, audited as SYSTEM with reason "roles.md correction"', async () => {
    // Recreate the drift the 18-11-2026 seed run left on the dev database.
    await asSystem(
      `INSERT INTO core.role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM core.roles r, core.permissions p
        WHERE (r.code = 'PLANNER' AND p.key = 'master.item.manage') OR (r.code = 'QA_OFFICER' AND p.key = 'master.formula.manage')`,
    );
    const err = await runSeed({ nodeEnv: 'development' }).catch((e: unknown) => e);
    expect((err as RoleBundleDriftError).extraKeys).toEqual({ PLANNER: ['master.item.manage'], QA_OFFICER: ['master.formula.manage'] });

    const here = path.dirname(fileURLToPath(import.meta.url));
    const body = await readFile(path.resolve(here, '../db/migrations/0010_roles_correction.sql'), 'utf8');
    const auditBefore = await count('SELECT max(id) FROM core.audit_log');
    const totalBefore = await count('SELECT count(*) FROM core.role_permissions');
    await client.query('BEGIN');
    await client.query(body);
    await client.query('COMMIT');

    expect(await count('SELECT count(*) FROM core.role_permissions')).toBe(totalBefore - 2);
    expect(await keysOf('PLANNER')).not.toContain('master.item.manage');
    expect(await keysOf('QA_OFFICER')).not.toContain('master.formula.manage');
    const { rows } = await client.query<{ table_name: string; action: string; changed_by: string; reason: string; role: string; key: string }>(
      `SELECT a.table_name, a.action, a.changed_by::text, a.reason, r.code AS role, p.key
         FROM core.audit_log a
         JOIN core.roles r ON r.id = (a.old_data->>'role_id')::bigint
         JOIN core.permissions p ON p.id = (a.old_data->>'permission_id')::bigint
        WHERE a.id > $1 ORDER BY r.code`,
      [auditBefore],
    );
    expect(rows).toEqual([
      { table_name: 'core.role_permissions', action: 'DELETE', changed_by: '1', reason: 'roles.md correction', role: 'PLANNER', key: 'master.item.manage' },
      { table_name: 'core.role_permissions', action: 'DELETE', changed_by: '1', reason: 'roles.md correction', role: 'QA_OFFICER', key: 'master.formula.manage' },
    ]);

    // The seed is clean again; running the migration a second time removes nothing.
    expect((await runSeed({ nodeEnv: 'development' })).keysAdded).toEqual({});
    await client.query('BEGIN');
    await client.query(body);
    await client.query('COMMIT');
    expect(await count('SELECT count(*) FROM core.role_permissions')).toBe(totalBefore - 2);
  });

  it('does not check roles that are not in roles.md (created later on the Roles page)', async () => {
    await asSystem(`INSERT INTO core.roles (code, name) VALUES ('AUDITOR_TEMP', 'Temp auditor')`);
    await asSystem(
      `INSERT INTO core.role_permissions (role_id, permission_id)
       SELECT r.id, p.id FROM core.roles r, core.permissions p WHERE r.code = 'AUDITOR_TEMP' AND p.key = 'fin.view'`,
    );
    const report = await runSeed({ nodeEnv: 'development' });
    expect(report.keysAdded).toEqual({});
    expect(await keysOf('AUDITOR_TEMP')).toEqual(['fin.view']);
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

describe('formula segregation (owner decision 18-11-2026: QA cannot draft what it approves)', () => {
  it('holds for the bundles in seed/roles.ts (= docs/roles.md)', () => {
    expect(formulaSegregationBreaches(new Map(ROLE_SEEDS.map((r) => [r.code, [...r.keys]])))).toEqual([]);
  });

  it('catches a role holding both keys, and a QA role holding the drafting key (the check itself works)', () => {
    expect(
      formulaSegregationBreaches(
        new Map([
          ['PRODUCTION_MANAGER', ['master.formula.manage', 'master.formula.approve']],
          ['QA_OFFICER', ['qa.deviation.manage', 'master.formula.manage']],
          ['NEW_QA_LEAD', ['qa.batch.release', 'master.formula.manage']],
          ['OK_ROLE', ['master.formula.manage', 'qa.deviation.manage']],
        ]),
      ),
    ).toEqual([
      'PRODUCTION_MANAGER holds master.formula.manage and master.formula.approve',
      'QA role QA_OFFICER holds master.formula.manage',
      'QA role NEW_QA_LEAD holds master.formula.manage',
    ]);
  });
});

/**
 * Lot-decision segregation breaches (owner 2026-11-18, rule 1 clarification): QC decides material lots, QA decides
 * FG and return lots. Only the QA Manager rejects FG / return lots, and no role decides both kinds of lot.
 */
function lotDecisionBreaches(bundles: Map<string, string[]>): string[] {
  const breaches: string[] = [];
  for (const [code, keys] of bundles) {
    const rejectsFg = keys.includes('qa.lot.reject_fg');
    if (rejectsFg && code !== 'QA_MANAGER') breaches.push(`${code} holds qa.lot.reject_fg (QA Manager only)`);
    if (rejectsFg && keys.includes('qc.lot.change_status')) breaches.push(`${code} holds qc.lot.change_status and qa.lot.reject_fg`);
  }
  return breaches;
}

describe('lot-decision segregation (owner 2026-11-18: QC decides material lots, QA decides FG and return lots)', () => {
  const bundles = new Map(ROLE_SEEDS.map((r) => [r.code, [...r.keys] as string[]]));

  it('holds for the bundles in seed/roles.ts (= docs/roles.md): QA Manager rejects FG lots, QC Manager material lots', () => {
    expect(lotDecisionBreaches(bundles)).toEqual([]);
    const holders = (key: string) => [...bundles].filter(([, keys]) => keys.includes(key)).map(([code]) => code);
    expect(holders('qa.lot.reject_fg')).toEqual(['QA_MANAGER']);
    expect(holders('qc.lot.change_status')).toEqual(['QC_MANAGER']);
    // Return-lot re-release uses the QA release key, held only by the QA Manager.
    expect(holders('qa.batch.release')).toEqual(['QA_MANAGER']);
  });

  it('qa.lot.reject_fg is a QA-controlled action key (role changes touching it need a QA Manager countersign)', () => {
    expect(Permissions['qa.lot.reject_fg']).toMatchObject({ class: 'ACTION', qaControlled: true });
  });

  it('catches another role holding qa.lot.reject_fg, and a role holding both lot-decision keys (the check itself works)', () => {
    expect(
      lotDecisionBreaches(
        new Map([
          ['QC_MANAGER', ['qc.lot.change_status', 'qa.lot.reject_fg']],
          ['QA_MANAGER', ['qa.lot.reject_fg', 'qc.lot.change_status']],
          ['WAREHOUSE_MANAGER', ['inv.lot.dispose', 'qa.lot.reject_fg']],
        ]),
      ),
    ).toEqual([
      'QC_MANAGER holds qa.lot.reject_fg (QA Manager only)',
      'QC_MANAGER holds qc.lot.change_status and qa.lot.reject_fg',
      'QA_MANAGER holds qc.lot.change_status and qa.lot.reject_fg',
      'WAREHOUSE_MANAGER holds qa.lot.reject_fg (QA Manager only)',
    ]);
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
