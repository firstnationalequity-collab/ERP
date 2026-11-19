// Master formulas (architecture §4, §7.2; PRD-01). Versioned per product:
//   DRAFT (editable, master.formula.manage) → PENDING_APPROVAL (submit + MASTER_FORMULA approval)
//   → APPROVED (QA Manager via the approval; the previous APPROVED version becomes OBSOLETE first)
//   PENDING_APPROVAL → DRAFT when the approval is rejected.
// A new version copies the latest version's header and lines. Creator ≠ approver comes from the approvals
// engine (the requester cannot approve). The DB locks non-DRAFT formulas and checks completeness on submit.
import { eq } from 'drizzle-orm';
import {
  FormulaStatus,
  type CreateFormulaRequest,
  type FormulaDto,
  type FormulaLineDto,
  type MasterListQuery,
  type Page,
  type SetFormulaLinesRequest,
  type UpdateFormulaRequest,
} from '@albert/shared';
import { db, withTransaction, type Tx } from '../../db/client';
import { masterFormulas } from '../../db/schema/masters';
import { AppError } from '../../core/errors';
import { txContext, type AuthContext } from '../../core/auth/auth.service';
import { defineTransitions, recordInitialStatus, transition, type Actor } from '../../core/transition/transition';
import { latestApprovalIds, registerApprovalHandler, startApproval } from '../../core/approvals/approvals.service';
import * as repo from './masters.repo';
import { assertReference, found, page, paging, sent, stamped } from './common';

export const FORMULA_TABLE = 'master.master_formulas';

export const FormulaMoves = defineTransitions<FormulaStatus>({
  entityTable: FORMULA_TABLE,
  statuses: FormulaStatus,
  moves: [
    { from: null, to: 'DRAFT', permission: 'master.formula.manage' },
    { from: 'DRAFT', to: 'PENDING_APPROVAL', permission: 'master.formula.manage' },
    { from: 'PENDING_APPROVAL', to: 'APPROVED', permission: 'master.formula.approve' },
    { from: 'PENDING_APPROVAL', to: 'DRAFT', permission: 'master.formula.approve', reasonRequired: true },
    { from: 'APPROVED', to: 'OBSOLETE', permission: 'master.formula.approve' },
  ],
});

// ---------------------------------------------------------------- approval hooks

async function lockPendingFormula(tx: Tx, actor: Actor, formulaId: string) {
  const formula = await repo.lockFormula(tx, actor.companyId, formulaId);
  if (!formula) throw new AppError('NOT_FOUND', 'Master formula not found');
  // Lock every version of the product so two approvals cannot race on "one APPROVED per product".
  const versions = await repo.lockFormulasOfProduct(tx, formula.productId);
  if (formula.status !== 'PENDING_APPROVAL') {
    throw new AppError('INVALID_TRANSITION', `Master formula v${formula.version} is ${formula.status}, not PENDING_APPROVAL`);
  }
  return { formula, versions };
}

registerApprovalHandler('MASTER_FORMULA', {
  async onApproved(tx, approval, actor) {
    const { formula, versions } = await lockPendingFormula(tx, actor, approval.docId);
    // Old APPROVED → OBSOLETE first: the DB allows one APPROVED version per product.
    for (const v of versions.filter((x) => x.status === 'APPROVED')) {
      await transition(tx, FormulaMoves, { entityId: v.id, to: 'OBSOLETE', actor, reason: `Superseded by v${formula.version}` });
    }
    await transition(tx, FormulaMoves, { entityId: formula.id, to: 'APPROVED', actor });
  },
  async onRejected(tx, approval, actor, reason) {
    const { formula } = await lockPendingFormula(tx, actor, approval.docId);
    await transition(tx, FormulaMoves, { entityId: formula.id, to: 'DRAFT', actor, reason });
  },
});

// ---------------------------------------------------------------- reading

function lineDto(r: { l: repo.FormulaLineRow; itemCode: string; itemName: string }): FormulaLineDto {
  return {
    id: r.l.id,
    lineNo: r.l.lineNo,
    itemId: r.l.itemId,
    itemCode: r.itemCode,
    itemName: r.itemName,
    qtyPerBatch: r.l.qtyPerBatch,
    uomId: r.l.uomId,
    isApi: r.l.isApi,
    isFiller: r.l.isFiller,
    assayBasis: r.l.assayBasis,
  };
}

function toDto(row: repo.FormulaListRow, approvalId: string | null): FormulaDto {
  return { ...stamped(row.f), productItemCode: row.itemCode, productItemName: row.itemName, approvalId };
}

export async function listFormulas(auth: AuthContext, query: MasterListQuery): Promise<Page<FormulaDto>> {
  const status = query.status && (FormulaStatus as readonly string[]).includes(query.status) ? (query.status as FormulaStatus) : undefined;
  const where = repo.listWhere(
    masterFormulas.companyId,
    {
      search: undefined,
      searchCols: [],
      extra: [
        status ? eq(masterFormulas.status, status) : undefined,
        query.productId ? eq(masterFormulas.productId, query.productId) : undefined,
        query.search ? repo.formulaSearch(query.search) : undefined,
      ],
    },
    auth.companyId,
  );
  const rows = await repo.listFormulas(db, where, paging(query));
  const approvalsOf = await latestApprovalIds(db, auth.companyId, FORMULA_TABLE, rows.map((r) => r.f.id));
  return page(
    rows.map((r) => toDto(r, approvalsOf.get(r.f.id) ?? null)),
    await repo.countWhere(db, masterFormulas, where),
    query,
  );
}

export async function getFormula(auth: AuthContext, id: string): Promise<FormulaDto> {
  const row = found(await repo.findFormula(db, auth.companyId, id), 'Master formula');
  const approvalsOf = await latestApprovalIds(db, auth.companyId, FORMULA_TABLE, [id]);
  return { ...toDto(row, approvalsOf.get(id) ?? null), lines: (await repo.formulaLines(db, id)).map(lineDto) };
}

// ---------------------------------------------------------------- drafting

async function lockDraft(tx: Tx, auth: AuthContext, id: string) {
  const formula = found(await repo.lockFormula(tx, auth.companyId, id), 'Master formula');
  if (formula.status !== 'DRAFT') {
    throw new AppError('RECORD_LOCKED', `Master formula v${formula.version} is ${formula.status}; only a DRAFT can be edited`);
  }
  return formula;
}

/** New version of a product's formula. Copies the latest version's header and lines unless given. */
export async function createFormula(auth: AuthContext, input: CreateFormulaRequest): Promise<FormulaDto> {
  const id = await withTransaction(txContext(auth), async (tx) => {
    const product = found(await repo.findProduct(tx, auth.companyId, input.productId, true), 'Product');
    if (!product.p.isActive) throw new AppError('VALIDATION_FAILED', 'The product is not active', { field: 'productId' });
    const versions = await repo.lockFormulasOfProduct(tx, input.productId);
    const open = versions.find((v) => v.status === 'DRAFT' || v.status === 'PENDING_APPROVAL');
    if (open) {
      throw new AppError('ALREADY_EXISTS', `Version ${open.version} of this formula is still ${open.status}; finish it first`, { formulaId: open.id });
    }
    const latest = versions[0];
    const batchSize = input.batchSize ?? latest?.batchSize;
    const batchUomId = input.batchUomId ?? latest?.batchUomId;
    if (!batchSize || !batchUomId) {
      throw new AppError('VALIDATION_FAILED', 'The first version needs a batch size and its unit', { field: 'batchSize' });
    }
    if (batchUomId !== latest?.batchUomId) await assertReference(tx, 'master.uoms', auth.companyId, batchUomId, 'Batch unit');
    const formula = await repo.insertFormula(tx, {
      productId: input.productId,
      version: (latest?.version ?? 0) + 1,
      batchSize,
      batchUomId,
      notes: input.notes !== undefined ? input.notes : (latest?.notes ?? null),
      status: 'DRAFT',
    });
    await recordInitialStatus(tx, FormulaMoves, { entityId: formula.id, to: 'DRAFT', actor: auth });
    if (latest) {
      const lines = await repo.formulaLines(tx, latest.id);
      await repo.insertFormulaLines(
        tx,
        lines.map(({ l }) => ({
          formulaId: formula.id,
          lineNo: l.lineNo,
          itemId: l.itemId,
          qtyPerBatch: l.qtyPerBatch,
          uomId: l.uomId,
          isApi: l.isApi,
          isFiller: l.isFiller,
          assayBasis: l.assayBasis,
        })),
      );
    }
    return formula.id;
  });
  return getFormula(auth, id);
}

export async function updateFormula(auth: AuthContext, id: string, input: UpdateFormulaRequest): Promise<FormulaDto> {
  await withTransaction(txContext(auth), async (tx) => {
    const formula = await lockDraft(tx, auth, id);
    const changes = sent(input);
    if (changes.batchUomId && changes.batchUomId !== formula.batchUomId) {
      await assertReference(tx, 'master.uoms', auth.companyId, changes.batchUomId, 'Batch unit');
    }
    await repo.updateFormula(tx, id, changes);
  });
  return getFormula(auth, id);
}

/** Replace all lines of a DRAFT formula (numbered 1..n in the order given). */
export async function setFormulaLines(auth: AuthContext, id: string, input: SetFormulaLinesRequest): Promise<FormulaDto> {
  await withTransaction(txContext(auth), async (tx) => {
    const formula = await lockDraft(tx, auth, id);
    const product = found(await repo.findProduct(tx, auth.companyId, formula.productId), 'Product');
    if (input.lines.filter((l) => l.isFiller).length > 1) {
      throw new AppError('VALIDATION_FAILED', 'A formula has at most one filler line', { field: 'lines' });
    }
    const itemIds = [...new Set(input.lines.map((l) => l.itemId))];
    const found_ = await repo.itemsByIds(tx, auth.companyId, itemIds);
    for (const [i, line] of input.lines.entries()) {
      const item = found_.find((x) => x.id === line.itemId);
      if (!item) throw new AppError('VALIDATION_FAILED', `Line ${i + 1}: item does not exist`, { line: i + 1 });
      if (!item.isActive) throw new AppError('VALIDATION_FAILED', `Line ${i + 1}: item ${item.code} is not active`, { line: i + 1 });
      if (item.id === product.p.itemId) throw new AppError('VALIDATION_FAILED', `Line ${i + 1}: a formula cannot use its own product`, { line: i + 1 });
      if (line.isApi && item.type !== 'API') {
        throw new AppError('VALIDATION_FAILED', `Line ${i + 1}: only an API item can be an API line`, { line: i + 1 });
      }
      await assertReference(tx, 'master.uoms', auth.companyId, line.uomId, `Line ${i + 1} unit`);
    }
    await repo.deleteFormulaLines(tx, id);
    await repo.insertFormulaLines(
      tx,
      input.lines.map((l, i) => ({
        formulaId: id,
        lineNo: i + 1,
        itemId: l.itemId,
        qtyPerBatch: l.qtyPerBatch,
        uomId: l.uomId,
        isApi: l.isApi,
        isFiller: l.isFiller,
        assayBasis: l.assayBasis ?? null,
      })),
    );
  });
  return getFormula(auth, id);
}

/** DRAFT → PENDING_APPROVAL and start the MASTER_FORMULA approval (QA Manager). */
export async function submitFormula(auth: AuthContext, id: string): Promise<FormulaDto> {
  await withTransaction(txContext(auth), async (tx) => {
    const formula = await lockDraft(tx, auth, id);
    const product = found(await repo.findProduct(tx, auth.companyId, formula.productId), 'Product');
    await transition(tx, FormulaMoves, { entityId: id, to: 'PENDING_APPROVAL', actor: auth });
    await startApproval(tx, auth, {
      docType: 'MASTER_FORMULA',
      docTable: FORMULA_TABLE,
      docId: id,
      docNo: `${product.itemCode} v${formula.version}`,
      value: { measure: 'NONE' },
    });
  });
  return getFormula(auth, id);
}
