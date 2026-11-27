// Approval engine (docs/architecture.md §3; decisions Q12, Q13; approvals are e-signatures, §1).
//
// Modules call startApproval(tx, ...) when a document needs approval, and register a handler for their
// doc type that moves the document when the approval is APPROVED or REJECTED (same transaction).
//   - The band is chosen on the measured value: PKR amount (foreign amounts × the document's exchange rate)
//     or a percent; NONE = one band for any value. No matching band = refused, never "no approval needed".
//   - Steps snapshot the matrix at start; later rule changes do not affect it.
//   - Same step_no = parallel ("and"); higher step_no opens after the lower is complete ("then").
//   - Each step goes to a role; anyone holding it may act — except the requester (also enforced in the DB),
//     and nobody approves two steps of the same approval (DB unique index).
//   - Approve/reject re-verify the password (e-signature) and every status change goes through core/transition.
import { Decimal } from 'decimal.js';
import { sql } from 'drizzle-orm';
import {
  APPROVAL_MATRIX_COUNTERSIGN_KEY,
  ApprovalStatus,
  ApprovalStepStatus,
  GmpLockedApprovals,
  type ApprovalDecisionRequest,
  type ApprovalDto,
  type ApprovalMeasure,
  type ApprovalRuleSetDto,
  type InboxItemDto,
  type ListQuery,
  type Page,
  type PermissionKey,
  type SetApprovalRulesRequest,
} from '@albert/shared';
import { db, withTransaction, type Queryable, type Tx } from '../../db/client';
import { AppError } from '../errors';
import { env } from '../../config/env';
import { txContext, type AuthContext, type RequestMeta } from '../auth/auth.service';
import { recordSignature, verifySignature, verifyWitness } from '../esign/esign.service';
import * as authRepo from '../auth/auth.repo';
import { listForDocument } from '../attachments/attachments.service';
import { defineTransitions, recordInitialStatus, transition, type Actor } from '../transition/transition';
import * as repo from './approvals.repo';
import type { ApprovalRow, ApprovalRuleRow, ApprovalStepRow } from './approvals.repo';

// ---------------------------------------------------------------- status maps (rule 7)

export const ApprovalMoves = defineTransitions<ApprovalStatus>({
  entityTable: 'core.approvals',
  statuses: ApprovalStatus,
  moves: [
    { from: null, to: 'PENDING', permission: 'core.approval.inbox' },
    { from: 'PENDING', to: 'APPROVED', permission: 'core.approval.inbox' },
    { from: 'PENDING', to: 'REJECTED', permission: 'core.approval.inbox', reasonRequired: true },
    { from: 'PENDING', to: 'CANCELLED', permission: 'core.approval.inbox', reasonRequired: true },
  ],
});

export const ApprovalStepMoves = defineTransitions<ApprovalStepStatus>({
  entityTable: 'core.approval_steps',
  statuses: ApprovalStepStatus,
  moves: [
    { from: null, to: 'PENDING', permission: 'core.approval.inbox' },
    { from: null, to: 'WAITING', permission: 'core.approval.inbox' },
    { from: 'WAITING', to: 'PENDING', permission: 'core.approval.inbox' },
    { from: 'PENDING', to: 'APPROVED', permission: 'core.approval.inbox', esign: ['APPROVED'] },
    { from: 'PENDING', to: 'REJECTED', permission: 'core.approval.inbox', esign: ['REJECTED'], reasonRequired: true },
    { from: 'PENDING', to: 'SKIPPED', permission: 'core.approval.inbox', reasonRequired: true },
    { from: 'WAITING', to: 'SKIPPED', permission: 'core.approval.inbox', reasonRequired: true },
  ],
});

// ---------------------------------------------------------------- module hooks

export interface ApprovalHandler {
  /** The last step was approved. Move the document (e.g. PO → APPROVED). Runs in the same transaction. */
  onApproved(tx: Tx, approval: ApprovalRow, actor: AuthContext): Promise<void>;
  /** A step was rejected. Move the document back (e.g. PO → DRAFT). Runs in the same transaction. */
  onRejected(tx: Tx, approval: ApprovalRow, actor: AuthContext, reason: string): Promise<void>;
  /**
   * Optional: refuse this actor before any step is approved (e.g. PO creator ≠ approver, rule 9).
   * Runs for every step, so a two-step approval never has the document creator on any step. `acknowledgements`: the
   * warning codes the approver accepted (ApprovalDecisionRequest); a handler that raises a warning refuses without its
   * code (ACKNOWLEDGEMENT_REQUIRED) and may record the acknowledgement on the document.
   */
  assertMayApprove?(tx: Tx, approval: ApprovalRow, actor: AuthContext, acknowledgements: readonly string[]): Promise<void>;
}

const handlers = new Map<string, ApprovalHandler>();

/** Each module registers one handler per doc type at start-up. */
export function registerApprovalHandler(docType: string, handler: ApprovalHandler, opts: { replaceInTests?: boolean } = {}): void {
  // Engine tests swap a real module handler (e.g. PO) for a stand-in; never allowed outside NODE_ENV=test.
  const replace = opts.replaceInTests === true && env.NODE_ENV === 'test';
  if (handlers.has(docType) && !replace) throw new Error(`Approval handler for ${docType} is already registered`);
  handlers.set(docType, handler);
}

function handlerFor(docType: string): ApprovalHandler {
  const h = handlers.get(docType);
  if (!h) throw new AppError('APPROVAL_RULE_MISSING', `No approval handler is registered for ${docType}`);
  return h;
}

// ---------------------------------------------------------------- starting an approval

export type ApprovalValue =
  | { measure: 'AMOUNT_PKR'; amount: string; currency?: string; exchangeRate?: string }
  | { measure: 'PERCENT'; percent: string }
  | { measure: 'NONE' };

export interface StartApprovalInput {
  docType: string;
  /** "<schema>.<table>" of the document. */
  docTable: string;
  docId: string;
  docNo?: string | null;
  value: ApprovalValue;
}

function toDecimal(value: string, label: string): Decimal {
  let d: Decimal;
  try {
    d = new Decimal(value);
  } catch {
    throw new AppError('VALIDATION_FAILED', `${label} is not a number`);
  }
  if (!d.isFinite() || d.isNegative()) throw new AppError('VALIDATION_FAILED', `${label} must be zero or more`);
  return d;
}

/** The value the band is chosen on, and what is stored on the approval. */
function measure(value: ApprovalValue) {
  if (value.measure === 'NONE') return { measured: null, amount: null, currency: null, exchangeRate: null };
  if (value.measure === 'PERCENT') {
    return { measured: toDecimal(value.percent, 'Percent'), amount: null, currency: null, exchangeRate: null };
  }
  const amount = toDecimal(value.amount, 'Amount').toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const currency = (value.currency ?? 'PKR').toUpperCase();
  if (currency === 'PKR') return { measured: amount, amount, currency: null, exchangeRate: null };
  if (!value.exchangeRate) throw new AppError('VALIDATION_FAILED', `An exchange rate is needed for ${currency}`);
  const rate = toDecimal(value.exchangeRate, 'Exchange rate');
  if (rate.isZero()) throw new AppError('VALIDATION_FAILED', 'Exchange rate must be above zero');
  return {
    measured: amount.times(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
    amount,
    currency,
    exchangeRate: rate,
  };
}

/** The band limits of a rule, from the column pair that matches its measure (0007). */
function boundsOf(rule: Pick<ApprovalRuleRow, 'measure' | 'lowerAmount' | 'upperAmount' | 'lowerPercent' | 'upperPercent'>) {
  if (rule.measure === 'AMOUNT_PKR') return { lower: rule.lowerAmount, upper: rule.upperAmount };
  if (rule.measure === 'PERCENT') return { lower: rule.lowerPercent, upper: rule.upperPercent };
  return { lower: null, upper: null };
}

function inBand(rule: ApprovalRuleRow, v: Decimal | null): boolean {
  if (v === null) return true;
  const { lower, upper } = boundsOf(rule);
  if (lower !== null && !v.greaterThan(lower)) return false;
  if (upper !== null && v.greaterThan(upper)) return false;
  return true;
}

/** Start the approval of a document, inside the document's own transaction. */
export async function startApproval(tx: Tx, actor: Actor, input: StartApprovalInput): Promise<ApprovalRow> {
  handlerFor(input.docType);
  const rules = await repo.activeRules(tx, actor.companyId, input.docType);
  if (rules.length === 0) throw new AppError('APPROVAL_RULE_MISSING', `No approval rules are set up for ${input.docType}`);
  const ruleMeasure = rules[0]!.measure;
  if (ruleMeasure !== input.value.measure) {
    throw new AppError('VALIDATION_FAILED', `${input.docType} approvals are measured as ${ruleMeasure}`);
  }
  const m = measure(input.value);
  const band = rules.filter((r) => inBand(r, m.measured));
  if (band.length === 0) {
    throw new AppError('APPROVAL_RULE_MISSING', `No approval band of ${input.docType} covers ${m.measured?.toFixed() ?? 'this document'}`, {
      measuredValue: m.measured?.toFixed() ?? null,
    });
  }

  // Defence in depth (rule 1 / architecture §3: System Admin approves nothing): even a rule written
  // around setRules cannot route a step to a role holding admin keys.
  const adminRoles = await repo.adminRoleIds(tx, [...new Set(band.map((r) => r.roleId))]);
  if (adminRoles.length > 0) {
    throw new AppError('ROLE_ADMIN_CONFLICT', `The ${input.docType} approval rule routes to an admin role; fix the approval rules`, {
      roles: adminRoles,
    });
  }

  await assertLockedRoles(tx, input.docType, [...new Set(band.map((r) => r.roleId))]);

  const approval = await repo.insertApproval(tx, {
    docType: input.docType,
    docTable: input.docTable,
    docId: input.docId,
    docNo: input.docNo ?? null,
    measure: ruleMeasure,
    amount: m.amount?.toFixed(2) ?? null,
    currency: m.currency,
    exchangeRate: m.exchangeRate?.toFixed(6) ?? null,
    measuredAmount: ruleMeasure === 'AMOUNT_PKR' ? (m.measured?.toFixed(2) ?? null) : null,
    measuredPercent: ruleMeasure === 'PERCENT' ? (m.measured?.toFixed(4) ?? null) : null,
    requestedBy: actor.userId,
    status: 'PENDING',
  });
  await recordInitialStatus(tx, ApprovalMoves, { entityId: approval.id, to: 'PENDING', actor });

  const firstStep = Math.min(...band.map((r) => r.stepNo));
  for (const rule of band) {
    const status = rule.stepNo === firstStep ? 'PENDING' : 'WAITING';
    const step = await repo.insertStep(tx, { approvalId: approval.id, stepNo: rule.stepNo, roleId: rule.roleId, ruleId: rule.id, status });
    await recordInitialStatus(tx, ApprovalStepMoves, { entityId: step.id, to: status, actor });
  }
  return approval;
}

/** Withdraw the open approval of a document (e.g. the document was cancelled). Returns false if none. */
export async function cancelApproval(tx: Tx, actor: Actor, docTable: string, docId: string, reason: string): Promise<boolean> {
  const approval = await repo.findOpenApprovalForDoc(tx, docTable, docId, true);
  if (!approval) return false;
  await closeOpenSteps(tx, actor, await repo.stepsOf(tx, approval.id, true), `Approval cancelled: ${reason}`);
  await repo.setDecidedAt(tx, approval.id);
  await transition(tx, ApprovalMoves, { entityId: approval.id, to: 'CANCELLED', actor, reason });
  return true;
}

async function closeOpenSteps(tx: Tx, actor: Actor, steps: ApprovalStepRow[], reason: string): Promise<void> {
  for (const s of steps) {
    if (s.status === 'PENDING' || s.status === 'WAITING') {
      await transition(tx, ApprovalStepMoves, { entityId: s.id, to: 'SKIPPED', actor, reason });
    }
  }
}

// ---------------------------------------------------------------- deciding

/** Find the step this user may act on, applying segregation of duties. Locks approval and steps. */
async function stepForUser(tx: Tx, auth: AuthContext, approvalId: string) {
  const approval = await repo.findApproval(tx, auth.companyId, approvalId, true);
  if (!approval) throw new AppError('NOT_FOUND', 'Approval not found');
  if (approval.status !== 'PENDING') throw new AppError('INVALID_TRANSITION', `This approval is already ${approval.status}`);
  if (approval.requestedBy === auth.userId) {
    throw new AppError('SEGREGATION_OF_DUTIES', 'You cannot approve or reject your own document');
  }
  const steps = await repo.stepsOf(tx, approval.id, true);
  if (steps.some((s) => s.actedBy === auth.userId)) {
    throw new AppError('SEGREGATION_OF_DUTIES', 'You have already acted on this approval; another person must take the next step');
  }
  const myRoles = await repo.activeRoleIdsOfUser(tx, auth.userId);
  const step = steps.find((s) => s.status === 'PENDING' && myRoles.includes(s.roleId));
  if (!step) {
    const waiting = steps.some((s) => s.status === 'WAITING' && myRoles.includes(s.roleId));
    throw new AppError(
      'FORBIDDEN',
      waiting ? 'Your step is not open yet; an earlier step must be approved first' : 'No open step of this approval is assigned to your roles',
    );
  }
  // A role that has gained an admin key since the approval started can no longer approve.
  if ((await repo.adminRoleIds(tx, [step.roleId])).length > 0) {
    throw new AppError('FORBIDDEN', 'Admin roles cannot approve business documents');
  }
  // GMP-locked document: the step role must still hold the required key (it may have been removed).
  const lockedKey = GmpLockedApprovals[approval.docType];
  if (lockedKey && (await repo.rolesHoldingKey(tx, [step.roleId], lockedKey)).length === 0) {
    throw new AppError('FORBIDDEN', `Only roles holding ${lockedKey} may approve ${approval.docType}`, { permission: lockedKey });
  }
  return { approval, steps, step };
}

export async function approve(auth: AuthContext, approvalId: string, input: ApprovalDecisionRequest, meta: RequestMeta): Promise<ApprovalDto> {
  if (input.signature.meaning !== 'APPROVED') throw new AppError('VALIDATION_FAILED', 'Approving needs the meaning APPROVED');
  const proof = await verifySignature(auth, input.signature, meta);
  await withTransaction(txContext(auth, `approve: ${input.signature.reason}`), async (tx) => {
    const { approval, steps, step } = await stepForUser(tx, auth, approvalId);
    await handlerFor(approval.docType).assertMayApprove?.(tx, approval, auth, input.acknowledgements ?? []);
    const signature = await recordSignature(tx, proof, { table: 'core.approval_steps', id: step.id }, ['APPROVED']);
    await repo.markStepActed(tx, step.id, auth.userId, signature.id);
    await transition(tx, ApprovalStepMoves, { entityId: step.id, to: 'APPROVED', actor: auth, signature });

    const statusOf = (s: ApprovalStepRow) => (s.id === step.id ? 'APPROVED' : s.status);
    const groupDone = steps.filter((s) => s.stepNo === step.stepNo).every((s) => statusOf(s) === 'APPROVED');
    if (!groupDone) return;

    const waiting = steps.filter((s) => s.status === 'WAITING');
    if (waiting.length > 0) {
      const nextNo = Math.min(...waiting.map((s) => s.stepNo));
      for (const s of waiting.filter((w) => w.stepNo === nextNo)) {
        await transition(tx, ApprovalStepMoves, { entityId: s.id, to: 'PENDING', actor: auth });
      }
      return;
    }
    await repo.setDecidedAt(tx, approval.id); // before the status leaves PENDING (decided approvals are frozen)
    await transition(tx, ApprovalMoves, { entityId: approval.id, to: 'APPROVED', actor: auth });
    await handlerFor(approval.docType).onApproved(tx, { ...approval, status: 'APPROVED' }, auth);
  });
  return getApproval(auth, approvalId);
}

export async function reject(auth: AuthContext, approvalId: string, input: ApprovalDecisionRequest, meta: RequestMeta): Promise<ApprovalDto> {
  if (input.signature.meaning !== 'REJECTED') throw new AppError('VALIDATION_FAILED', 'Rejecting needs the meaning REJECTED');
  const proof = await verifySignature(auth, input.signature, meta);
  const reason = input.signature.reason;
  await withTransaction(txContext(auth, `reject: ${reason}`), async (tx) => {
    const { approval, steps, step } = await stepForUser(tx, auth, approvalId);
    const signature = await recordSignature(tx, proof, { table: 'core.approval_steps', id: step.id }, ['REJECTED']);
    await repo.markStepActed(tx, step.id, auth.userId, signature.id);
    await transition(tx, ApprovalStepMoves, { entityId: step.id, to: 'REJECTED', actor: auth, signature });
    await closeOpenSteps(tx, auth, steps.filter((s) => s.id !== step.id), `Approval rejected: ${reason}`);
    await repo.setDecidedAt(tx, approval.id);
    await transition(tx, ApprovalMoves, { entityId: approval.id, to: 'REJECTED', actor: auth, reason });
    await handlerFor(approval.docType).onRejected(tx, { ...approval, status: 'REJECTED' }, auth, reason);
  });
  return getApproval(auth, approvalId);
}

// ---------------------------------------------------------------- reading

/** For module lists: the latest approval id of each document (so the UI can link to it). */
export async function latestApprovalIds(q: Queryable, companyId: string, docTable: string, docIds: string[]): Promise<Map<string, string>> {
  return repo.latestApprovalIds(q, companyId, docTable, docIds);
}

/** For segregation checks in modules (e.g. GRN receiver ≠ PO approver): who approved a step of the document. */
export async function approversOf(q: Queryable, companyId: string, docTable: string, docId: string): Promise<string[]> {
  return repo.approverIds(q, companyId, docTable, docId);
}

export async function getApproval(auth: AuthContext, approvalId: string): Promise<ApprovalDto> {
  const approval = await repo.findApproval(db, auth.companyId, approvalId);
  if (!approval) throw new AppError('NOT_FOUND', 'Approval not found');
  const steps = await repo.stepsOf(db, approval.id);
  const myRoles = await repo.activeRoleIdsOfUser(db, auth.userId);
  const visible =
    approval.requestedBy === auth.userId ||
    steps.some((s) => s.actedBy === auth.userId || myRoles.includes(s.roleId));
  if (!visible) throw new AppError('NOT_FOUND', 'Approval not found');

  const roleRows = await repo.rolesByIds(db, [...new Set(steps.map((s) => s.roleId))]);
  const userRows = await repo.userBrief(db, [
    approval.requestedBy,
    ...steps.map((s) => s.actedBy).filter((x): x is string => x !== null),
  ]);
  const role = (id: string) => roleRows.find((r) => r.id === id);
  const user = (id: string) => userRows.find((u) => u.id === id);
  const requester = user(approval.requestedBy);
  return {
    id: approval.id,
    docType: approval.docType,
    docTable: approval.docTable,
    docId: approval.docId,
    docNo: approval.docNo,
    measure: approval.measure,
    amount: approval.amount,
    currency: approval.currency,
    exchangeRate: approval.exchangeRate,
    measuredValue: approval.measuredAmount ?? approval.measuredPercent,
    requestedBy: { id: approval.requestedBy, username: requester?.username ?? '', fullName: requester?.fullName ?? '' },
    status: approval.status,
    createdAt: approval.createdAt.toISOString(),
    decidedAt: approval.decidedAt?.toISOString() ?? null,
    steps: steps.map((s) => ({
      id: s.id,
      stepNo: s.stepNo,
      roleCode: role(s.roleId)?.code ?? '',
      roleName: role(s.roleId)?.name ?? '',
      status: s.status,
      actedBy: s.actedBy ? (user(s.actedBy)?.fullName ?? null) : null,
      actedAt: s.actedAt?.toISOString() ?? null,
    })),
    attachments: await listForDocument(auth, approval.docTable, approval.docId),
  };
}

export async function inbox(auth: AuthContext, query: ListQuery): Promise<Page<InboxItemDto>> {
  const rows = await repo.inboxRows(db, auth.companyId, auth.userId, query.pageSize, (query.page - 1) * query.pageSize);
  const total = await repo.inboxCount(db, auth.companyId, auth.userId);
  return {
    items: rows.map((r) => ({
      approvalId: r.approval_id,
      stepId: r.step_id,
      stepNo: r.step_no,
      roleCode: r.role_code,
      docType: r.doc_type,
      docNo: r.doc_no,
      docId: r.doc_id,
      measure: r.measure,
      measuredValue: r.measured_value,
      amount: r.amount,
      currency: r.currency,
      requestedBy: r.requested_by,
      requestedAt: new Date(r.requested_at).toISOString(),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function inboxCount(auth: AuthContext): Promise<number> {
  return repo.inboxCount(db, auth.companyId, auth.userId);
}

// ---------------------------------------------------------------- rule administration (core.settings.manage)

interface NormalisedBand {
  lower: Decimal | null;
  upper: Decimal | null;
  steps: { stepNo: number; roleId: string }[];
}

function validateBands(measureType: ApprovalMeasure, input: SetApprovalRulesRequest['bands']): NormalisedBand[] {
  const bands: NormalisedBand[] = input.map((b) => ({
    lower: b.lowerBound ? new Decimal(b.lowerBound) : null,
    upper: b.upperBound ? new Decimal(b.upperBound) : null,
    steps: b.steps,
  }));
  const problems: string[] = [];
  if (measureType === 'NONE') {
    if (bands.length !== 1 || bands[0]!.lower !== null || bands[0]!.upper !== null) {
      problems.push('Measure NONE takes exactly one band without limits');
    }
  }
  const maxDecimals = measureType === 'AMOUNT_PKR' ? 2 : 4;
  const maxValue = measureType === 'AMOUNT_PKR' ? new Decimal('9999999999999999.99') : new Decimal('99999.9999');
  bands.forEach((b, i) => {
    for (const v of [b.lower, b.upper]) {
      if (v && v.decimalPlaces() > maxDecimals) {
        problems.push(`Band ${i + 1}: ${measureType === 'AMOUNT_PKR' ? 'PKR amounts' : 'percents'} take at most ${maxDecimals} decimals`);
      }
      if (v && v.greaterThan(maxValue)) problems.push(`Band ${i + 1}: limit is too large`);
    }
    if (b.lower && b.upper && !b.lower.lessThan(b.upper)) problems.push(`Band ${i + 1}: lower limit must be below upper limit`);
    const numbers = [...new Set(b.steps.map((s) => s.stepNo))].sort((x, y) => x - y);
    if (numbers.some((n, k) => n !== k + 1)) problems.push(`Band ${i + 1}: step numbers must run 1, 2, 3… without gaps`);
    const keys = b.steps.map((s) => `${s.stepNo}:${s.roleId}`);
    if (new Set(keys).size !== keys.length) problems.push(`Band ${i + 1}: the same role appears twice in one step`);
  });
  const sorted = [...bands].sort((a, b) => {
    if (a.lower === null) return -1;
    if (b.lower === null) return 1;
    return a.lower.comparedTo(b.lower);
  });
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const next = sorted[i]!;
    // (a, b] and (c, d] overlap when c < b (or either is unbounded on that side).
    if (prev.upper === null || next.lower === null || next.lower.lessThan(prev.upper)) {
      problems.push('Bands overlap: each value must fall in exactly one band');
      break;
    }
  }
  if (problems.length > 0) throw new AppError('VALIDATION_FAILED', 'Invalid approval rules', { rules: problems });
  return bands;
}

/** GMP-locked document types (rules review B, option 2): every approver role must hold the locked key. */
async function assertLockedRoles(tx: Tx, docType: string, roleIds: string[]): Promise<void> {
  const lockedKey: PermissionKey | undefined = GmpLockedApprovals[docType];
  if (!lockedKey) return;
  const holding = await repo.rolesHoldingKey(tx, roleIds, lockedKey);
  const wrong = roleIds.filter((id) => !holding.includes(id));
  if (wrong.length > 0) {
    throw new AppError('APPROVER_ROLE_NOT_ALLOWED', `${docType} may only be approved by roles holding ${lockedKey}`, {
      permission: lockedKey,
      roles: wrong,
    });
  }
}

/**
 * Replace the rule set of a document type (core.settings.manage).
 * - GMP-locked types: every approver role must hold the locked key (no countersign needed: fixed in code).
 * - Every other type: a Finance Manager countersign (fin.approval_rules.countersign), by a different person
 *   from the admin making the change (rules review B, option 1).
 */
export async function setRules(
  auth: AuthContext,
  docType: string,
  input: SetApprovalRulesRequest,
  meta: RequestMeta,
): Promise<ApprovalRuleSetDto | undefined> {
  if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(docType)) throw new AppError('VALIDATION_FAILED', 'Invalid document type');
  const bands = validateBands(input.measure, input.bands);
  const locked = GmpLockedApprovals[docType] !== undefined;
  if (!locked && !input.countersign) {
    throw new AppError('COUNTERSIGN_REQUIRED', 'Changing the approval matrix needs a Finance Manager countersign', {
      permission: APPROVAL_MATRIX_COUNTERSIGN_KEY,
    });
  }
  if (!locked && input.countersign && input.countersign.meaning !== 'APPROVED') {
    throw new AppError('ESIGN_FAILED', 'A countersign must have the meaning APPROVED');
  }
  // Verified before the business transaction, so a wrong password is counted even though the change fails.
  const proof = !locked && input.countersign ? await verifyWitness(auth, input.countersign, meta) : undefined;

  await withTransaction(txContext(auth, input.reason), async (tx) => {
    const roleIds = [...new Set(bands.flatMap((b) => b.steps.map((s) => s.roleId)))];
    const found = await repo.rolesByIds(tx, roleIds);
    const missing = roleIds.filter((id) => !found.some((r) => r.id === id && r.isActive));
    if (missing.length > 0) throw new AppError('NOT_FOUND', 'Unknown or inactive roles', { missing });
    const adminRoles = await repo.adminRoleIds(tx, roleIds);
    if (adminRoles.length > 0) {
      throw new AppError('ROLE_ADMIN_CONFLICT', 'Approval steps cannot go to a role that holds admin keys', { roles: adminRoles });
    }
    await assertLockedRoles(tx, docType, roleIds);
    if (proof) {
      const witnessKeys = await authRepo.permissionKeysForUser(tx, proof.userId);
      if (!witnessKeys.includes(APPROVAL_MATRIX_COUNTERSIGN_KEY)) {
        throw new AppError('FORBIDDEN', `The countersigner does not hold ${APPROVAL_MATRIX_COUNTERSIGN_KEY}`, {
          permission: APPROVAL_MATRIX_COUNTERSIGN_KEY,
        });
      }
      const signature = await recordSignature(tx, proof, { table: 'core.approval_rules', id: docType }, ['APPROVED']);
      await tx.execute(sql`select set_config('app.reason', ${`${input.reason} [countersign e-signature ${signature.id}]`}, true)`);
    }
    await repo.deactivateRules(tx, auth.companyId, docType);
    await repo.insertRules(
      tx,
      bands.flatMap((b) =>
        b.steps.map((s) => ({
          docType,
          measure: input.measure,
          lowerAmount: input.measure === 'AMOUNT_PKR' ? (b.lower?.toFixed(2) ?? null) : null,
          upperAmount: input.measure === 'AMOUNT_PKR' ? (b.upper?.toFixed(2) ?? null) : null,
          lowerPercent: input.measure === 'PERCENT' ? (b.lower?.toFixed(4) ?? null) : null,
          upperPercent: input.measure === 'PERCENT' ? (b.upper?.toFixed(4) ?? null) : null,
          stepNo: s.stepNo,
          roleId: s.roleId,
        })),
      ),
    );
  });
  return (await listRules(auth)).find((r) => r.docType === docType);
}

export async function listRules(auth: AuthContext): Promise<ApprovalRuleSetDto[]> {
  const rows = await repo.allActiveRules(db, auth.companyId);
  const sets = new Map<string, ApprovalRuleSetDto>();
  for (const { rule, roleCode, roleName } of rows) {
    const set = sets.get(rule.docType) ?? {
      docType: rule.docType,
      measure: rule.measure,
      lockedToKey: GmpLockedApprovals[rule.docType] ?? null,
      bands: [],
    };
    sets.set(rule.docType, set);
    const { lower, upper } = boundsOf(rule);
    let band = set.bands.find((b) => b.lowerBound === lower && b.upperBound === upper);
    if (!band) {
      band = { lowerBound: lower, upperBound: upper, steps: [] };
      set.bands.push(band);
    }
    band.steps.push({ stepNo: rule.stepNo, roleId: rule.roleId, roleCode, roleName });
  }
  return [...sets.values()];
}
