// Idempotent seed: running it twice changes nothing.
// 1. Sync core.permissions with packages/shared/src/permissions.ts (insert new, update text, deactivate removed).
// 2. Create missing roles with their bundles from seed/roles.ts (existing roles are never touched).
// 3. Create the first admin from INITIAL_ADMIN_PASSWORD (forced change at first login).
// Acts as the SYSTEM user. Refuses to run in production without INITIAL_ADMIN_PASSWORD (decision Q7).
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Permissions, PermissionKeys } from '@albert/shared';
import { systemContext, withTransaction, type Tx } from '../client';
import { approvalRules, numberSeries, permissions, rolePermissions, roles, userCredentials, userRoles, users } from '../schema/core';
import { assertPasswordPolicy, hashPassword } from '../../core/auth/password';
import { FIRST_ADMIN_USERNAME, ROLE_SEEDS } from './roles';

/** Decision Q16 defaults: PO-2627-00042 (resets each fiscal year), AP26-0001 (resets each calendar year). */
export const DEFAULT_SERIES = [
  { docType: 'PO', name: 'Purchase order', prefix: 'PO', pattern: '{PREFIX}-{FY}-{SEQ:5}', reset: 'FISCAL_YEAR' },
  { docType: 'BATCH', name: 'Batch number', prefix: 'AP', pattern: '{PREFIX}{YY}-{SEQ:4}', reset: 'CALENDAR_YEAR' },
] as const;

/**
 * Approval matrix from docs/architecture.md §3 — PLACEHOLDER limits until Finance confirms.
 * Bands: (lower exclusive, upper inclusive]. Same stepNo = parallel ("and"); higher = after ("then").
 */
export const DEFAULT_APPROVAL_RULES: {
  docType: string;
  measure: 'AMOUNT_PKR' | 'PERCENT' | 'NONE';
  bands: { lower: string | null; upper: string | null; steps: [number, string][] }[];
}[] = [
  {
    docType: 'PO',
    measure: 'AMOUNT_PKR',
    bands: [
      { lower: null, upper: '500000', steps: [[1, 'PURCHASE_MANAGER']] },
      { lower: '500000', upper: '5000000', steps: [[1, 'FINANCE_MANAGER']] },
      { lower: '5000000', upper: null, steps: [[1, 'PURCHASE_MANAGER'], [2, 'FINANCE_MANAGER']] },
    ],
  },
  {
    docType: 'QUOTATION_DISCOUNT',
    measure: 'PERCENT',
    bands: [
      { lower: null, upper: '5', steps: [[1, 'SALES_MANAGER']] },
      { lower: '5', upper: null, steps: [[1, 'SALES_MANAGER'], [2, 'FINANCE_MANAGER']] },
    ],
  },
  { docType: 'SO_CREDIT', measure: 'AMOUNT_PKR', bands: [{ lower: '0', upper: null, steps: [[1, 'FINANCE_MANAGER']] }] },
  { docType: 'VENDOR_PAYMENT', measure: 'AMOUNT_PKR', bands: [{ lower: null, upper: null, steps: [[1, 'FINANCE_MANAGER']] }] },
  {
    docType: 'STOCK_ADJUSTMENT',
    measure: 'AMOUNT_PKR',
    bands: [{ lower: null, upper: null, steps: [[1, 'FINANCE_MANAGER'], [1, 'QA_MANAGER']] }],
  },
  { docType: 'AVL', measure: 'NONE', bands: [{ lower: null, upper: null, steps: [[1, 'QA_MANAGER']] }] },
  { docType: 'MASTER_FORMULA', measure: 'NONE', bands: [{ lower: null, upper: null, steps: [[1, 'QA_MANAGER']] }] },
  { docType: 'BATCH_CLOSE', measure: 'NONE', bands: [{ lower: null, upper: null, steps: [[1, 'PRODUCTION_MANAGER']] }] },
];

export interface SeedOptions {
  nodeEnv: 'development' | 'test' | 'production';
  initialAdminPassword?: string;
}

export interface SeedReport {
  permissionsCreated: number;
  permissionsUpdated: number;
  permissionsDeactivated: number;
  rolesCreated: string[];
  seriesCreated: string[];
  approvalRulesCreated: string[];
  adminCreated: boolean;
  /** Why the admin was not created, when it was not. */
  adminSkipped?: string;
}

export async function runSeed(opts: SeedOptions): Promise<SeedReport> {
  if (opts.nodeEnv === 'production' && !opts.initialAdminPassword) {
    throw new Error('Seed refused: INITIAL_ADMIN_PASSWORD must be set in production');
  }
  // Check the policy before touching the database, so a bad password fails fast.
  if (opts.initialAdminPassword) assertPasswordPolicy(opts.initialAdminPassword, FIRST_ADMIN_USERNAME);

  return withTransaction(systemContext('seed'), async (tx) => {
    const report: SeedReport = {
      permissionsCreated: 0,
      permissionsUpdated: 0,
      permissionsDeactivated: 0,
      rolesCreated: [],
      seriesCreated: [],
      approvalRulesCreated: [],
      adminCreated: false,
    };
    await syncPermissions(tx, report);
    await createMissingRoles(tx, report);
    await createMissingSeries(tx, report);
    await createMissingApprovalRules(tx, report);
    await createFirstAdmin(tx, opts.initialAdminPassword, report);
    return report;
  });
}

async function syncPermissions(tx: Tx, report: SeedReport): Promise<void> {
  const existing = await tx.select().from(permissions);
  const byKey = new Map(existing.map((p) => [p.key, p]));

  for (const key of PermissionKeys) {
    const def = Permissions[key];
    const row = byKey.get(key);
    if (!row) {
      await tx.insert(permissions).values({ key, class: def.class, description: def.description });
      report.permissionsCreated += 1;
    } else if (row.class !== def.class || row.description !== def.description || !row.isActive) {
      // A class change on a key that roles already use is refused by the database (ROLE_ADMIN_CONFLICT).
      await tx
        .update(permissions)
        .set({ class: def.class, description: def.description, isActive: true })
        .where(eq(permissions.id, row.id));
      report.permissionsUpdated += 1;
    }
  }

  const codeKeys = new Set<string>(PermissionKeys);
  const removed = existing.filter((p) => p.isActive && !codeKeys.has(p.key)).map((p) => p.id);
  if (removed.length > 0) {
    await tx.update(permissions).set({ isActive: false }).where(inArray(permissions.id, removed));
    report.permissionsDeactivated = removed.length;
  }
}

async function createMissingRoles(tx: Tx, report: SeedReport): Promise<void> {
  const keyToId = new Map((await tx.select({ id: permissions.id, key: permissions.key }).from(permissions)).map((p) => [p.key, p.id]));
  const existingCodes = new Set((await tx.select({ code: roles.code }).from(roles)).map((r) => r.code));

  for (const seed of ROLE_SEEDS) {
    if (existingCodes.has(seed.code)) continue;
    const [role] = await tx.insert(roles).values({ code: seed.code, name: seed.name }).returning({ id: roles.id });
    if (!role) throw new Error(`Seed: role ${seed.code} was not created`);
    const rows = seed.keys.map((key) => {
      const permissionId = keyToId.get(key);
      if (!permissionId) throw new Error(`Seed: permission ${key} missing for role ${seed.code}`);
      return { roleId: role.id, permissionId };
    });
    await tx.insert(rolePermissions).values(rows);
    report.rolesCreated.push(seed.code);
  }
}

/**
 * The two default series named in decision Q16. Other document types add their series in their own
 * milestone. Existing series are never changed (the admin may have edited them).
 */
async function createMissingSeries(tx: Tx, report: SeedReport): Promise<void> {
  const existing = new Set((await tx.select({ docType: numberSeries.docType }).from(numberSeries)).map((s) => s.docType));
  for (const s of DEFAULT_SERIES) {
    if (existing.has(s.docType)) continue;
    await tx.insert(numberSeries).values(s);
    report.seriesCreated.push(s.docType);
  }
}

/** Placeholder approval matrix for doc types that have no active rules yet. Existing rule sets are kept. */
async function createMissingApprovalRules(tx: Tx, report: SeedReport): Promise<void> {
  const existing = new Set(
    (await tx.select({ docType: approvalRules.docType }).from(approvalRules).where(eq(approvalRules.isActive, true))).map((r) => r.docType),
  );
  const roleIds = new Map((await tx.select({ id: roles.id, code: roles.code }).from(roles)).map((r) => [r.code, r.id]));
  for (const set of DEFAULT_APPROVAL_RULES) {
    if (existing.has(set.docType)) continue;
    const rows = set.bands.flatMap((b) =>
      b.steps.map(([stepNo, roleCode]) => {
        const roleId = roleIds.get(roleCode);
        if (!roleId) throw new Error(`Seed: role ${roleCode} missing for approval rule ${set.docType}`);
        return {
          docType: set.docType,
          measure: set.measure,
          lowerAmount: set.measure === 'AMOUNT_PKR' ? b.lower : null,
          upperAmount: set.measure === 'AMOUNT_PKR' ? b.upper : null,
          lowerPercent: set.measure === 'PERCENT' ? b.lower : null,
          upperPercent: set.measure === 'PERCENT' ? b.upper : null,
          stepNo,
          roleId,
        };
      }),
    );
    await tx.insert(approvalRules).values(rows);
    report.approvalRulesCreated.push(set.docType);
  }
}

async function createFirstAdmin(tx: Tx, password: string | undefined, report: SeedReport): Promise<void> {
  const [existing] = await tx
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) = ${FIRST_ADMIN_USERNAME}`);
  if (existing) {
    report.adminSkipped = 'already exists';
    return;
  }
  if (!password) {
    report.adminSkipped = 'INITIAL_ADMIN_PASSWORD not set';
    return;
  }

  const [adminRole] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.code, 'SYSTEM_ADMIN'));
  if (!adminRole) throw new Error('Seed: SYSTEM_ADMIN role missing');

  const [admin] = await tx
    .insert(users)
    .values({ username: FIRST_ADMIN_USERNAME, fullName: 'System Administrator', mustChangePassword: true })
    .returning({ id: users.id });
  if (!admin) throw new Error('Seed: admin user was not created');

  await tx.insert(userCredentials).values({ userId: admin.id, passwordHash: await hashPassword(password) });
  await tx.update(users).set({ passwordChangedAt: new Date() }).where(eq(users.id, admin.id));
  await tx.insert(userRoles).values({ userId: admin.id, roleId: adminRole.id });
  report.adminCreated = true;
}

/** For tests and reports: the permission keys a role currently holds. */
export async function roleKeys(tx: Tx, roleCode: string): Promise<string[]> {
  const rows = await tx
    .select({ key: permissions.key })
    .from(rolePermissions)
    .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(and(eq(roles.code, roleCode), eq(permissions.isActive, true)));
  return rows.map((r) => r.key).sort();
}
