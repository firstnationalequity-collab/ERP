// Queries for the approval engine. No business rules here — see approvals.service.ts.
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ApprovalMeasure, ApprovalStepStatus } from '@albert/shared';
import type { Queryable } from '../../db/client';
import { approvalRules, approvalSteps, approvals, roles, users } from '../../db/schema/core';

export type ApprovalRuleRow = typeof approvalRules.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
export type ApprovalStepRow = typeof approvalSteps.$inferSelect;

export async function activeRules(q: Queryable, companyId: string, docType: string): Promise<ApprovalRuleRow[]> {
  return q
    .select()
    .from(approvalRules)
    .where(and(eq(approvalRules.companyId, companyId), eq(approvalRules.docType, docType), eq(approvalRules.isActive, true)))
    .orderBy(sql`${approvalRules.lowerBound} ASC NULLS FIRST`, asc(approvalRules.stepNo), asc(approvalRules.id));
}

export async function allActiveRules(q: Queryable, companyId: string) {
  return q
    .select({ rule: approvalRules, roleCode: roles.code, roleName: roles.name })
    .from(approvalRules)
    .innerJoin(roles, eq(roles.id, approvalRules.roleId))
    .where(and(eq(approvalRules.companyId, companyId), eq(approvalRules.isActive, true)))
    .orderBy(asc(approvalRules.docType), sql`${approvalRules.lowerBound} ASC NULLS FIRST`, asc(approvalRules.stepNo));
}

export async function deactivateRules(q: Queryable, companyId: string, docType: string): Promise<void> {
  await q
    .update(approvalRules)
    .set({ isActive: false })
    .where(and(eq(approvalRules.companyId, companyId), eq(approvalRules.docType, docType), eq(approvalRules.isActive, true)));
}

export async function insertRules(
  q: Queryable,
  rows: { docType: string; measure: ApprovalMeasure; lowerBound: string | null; upperBound: string | null; stepNo: number; roleId: string }[],
): Promise<void> {
  if (rows.length > 0) await q.insert(approvalRules).values(rows);
}

export async function insertApproval(q: Queryable, values: typeof approvals.$inferInsert): Promise<ApprovalRow> {
  const [row] = await q.insert(approvals).values(values).returning();
  if (!row) throw new Error('approval insert returned no row');
  return row;
}

export async function insertStep(
  q: Queryable,
  values: { approvalId: string; stepNo: number; roleId: string; ruleId: string | null; status: ApprovalStepStatus },
): Promise<ApprovalStepRow> {
  const [row] = await q.insert(approvalSteps).values(values).returning();
  if (!row) throw new Error('approval step insert returned no row');
  return row;
}

export async function findApproval(q: Queryable, companyId: string, id: string, lock = false): Promise<ApprovalRow | undefined> {
  const query = q.select().from(approvals).where(and(eq(approvals.companyId, companyId), eq(approvals.id, id)));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

export async function findOpenApprovalForDoc(q: Queryable, docTable: string, docId: string, lock = false): Promise<ApprovalRow | undefined> {
  const query = q
    .select()
    .from(approvals)
    .where(and(eq(approvals.docTable, docTable), eq(approvals.docId, docId), eq(approvals.status, 'PENDING')));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

export async function stepsOf(q: Queryable, approvalId: string, lock = false): Promise<ApprovalStepRow[]> {
  const query = q
    .select()
    .from(approvalSteps)
    .where(eq(approvalSteps.approvalId, approvalId))
    .orderBy(asc(approvalSteps.stepNo), asc(approvalSteps.id));
  return lock ? query.for('update') : query;
}

export async function markStepActed(q: Queryable, stepId: string, actedBy: string, esignId: string): Promise<void> {
  await q.update(approvalSteps).set({ actedBy, esignId, actedAt: new Date() }).where(eq(approvalSteps.id, stepId));
}

export async function setDecidedAt(q: Queryable, approvalId: string): Promise<void> {
  await q.update(approvals).set({ decidedAt: new Date() }).where(eq(approvals.id, approvalId));
}

/** Active role ids of a user. */
export async function activeRoleIdsOfUser(q: Queryable, userId: string): Promise<string[]> {
  const rows = await q.execute<{ id: string }>(sql`
    SELECT r.id FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id AND r.is_active
     WHERE ur.user_id = ${userId}`);
  return rows.rows.map((r) => r.id);
}

export async function rolesByIds(q: Queryable, ids: string[]) {
  if (ids.length === 0) return [];
  return q.select({ id: roles.id, code: roles.code, name: roles.name, isActive: roles.isActive }).from(roles).where(inArray(roles.id, ids));
}

export async function userBrief(q: Queryable, ids: string[]) {
  if (ids.length === 0) return [];
  return q.select({ id: users.id, username: users.username, fullName: users.fullName }).from(users).where(inArray(users.id, ids));
}

/**
 * Open steps the user may act on: PENDING step of a PENDING approval, for one of the user's active roles,
 * not requested by the user, and the user has not already acted on another step of the same approval.
 */
export async function inboxRows(q: Queryable, companyId: string, userId: string, limit: number, offset: number) {
  const rows = await q.execute<{
    approval_id: string;
    step_id: string;
    step_no: number;
    role_code: string;
    doc_type: string;
    doc_no: string | null;
    doc_id: string;
    measure: ApprovalMeasure;
    measured_value: string | null;
    amount: string | null;
    currency: string | null;
    requested_by: string;
    requested_at: Date;
  }>(sql`
    SELECT * FROM (
    SELECT DISTINCT ON (a.id)
           a.id AS approval_id, s.id AS step_id, s.step_no, r.code AS role_code, a.doc_type, a.doc_no, a.doc_id,
           a.measure, a.measured_value, a.amount, a.currency, u.full_name AS requested_by, a.created_at AS requested_at
      FROM core.approval_steps s
      JOIN core.approvals a ON a.id = s.approval_id AND a.status = 'PENDING'
      JOIN core.roles r ON r.id = s.role_id AND r.is_active
      JOIN core.user_roles ur ON ur.role_id = s.role_id AND ur.user_id = ${userId}
      JOIN core.users u ON u.id = a.requested_by
     WHERE s.status = 'PENDING'
       AND a.company_id = ${companyId}
       AND a.requested_by <> ${userId}
       AND NOT EXISTS (SELECT 1 FROM core.approval_steps x WHERE x.approval_id = a.id AND x.acted_by = ${userId})
     ORDER BY a.id, s.step_no, s.id
    ) open_items
    ORDER BY requested_at, approval_id
    LIMIT ${limit} OFFSET ${offset}`);
  return rows.rows;
}

export async function inboxCount(q: Queryable, companyId: string, userId: string): Promise<number> {
  const rows = await q.execute<{ n: number }>(sql`
    SELECT count(DISTINCT a.id)::int AS n
      FROM core.approval_steps s
      JOIN core.approvals a ON a.id = s.approval_id AND a.status = 'PENDING'
      JOIN core.roles r ON r.id = s.role_id AND r.is_active
      JOIN core.user_roles ur ON ur.role_id = s.role_id AND ur.user_id = ${userId}
     WHERE s.status = 'PENDING'
       AND a.company_id = ${companyId}
       AND a.requested_by <> ${userId}
       AND NOT EXISTS (SELECT 1 FROM core.approval_steps x WHERE x.approval_id = a.id AND x.acted_by = ${userId})`);
  return rows.rows[0]?.n ?? 0;
}

export async function recentApprovalsOf(q: Queryable, companyId: string, docTable: string, docId: string) {
  return q
    .select()
    .from(approvals)
    .where(and(eq(approvals.companyId, companyId), eq(approvals.docTable, docTable), eq(approvals.docId, docId)))
    .orderBy(desc(approvals.id));
}
