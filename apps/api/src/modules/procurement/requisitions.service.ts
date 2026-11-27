// Purchase requisitions (owner 2026-11-25, Q6: no approval; the value approval is on the PO; 0023).
//   DRAFT → SUBMITTED → CONVERTED (every line is on a PO), or CANCELLED (nothing ordered yet).
// Conversion turns chosen SUBMITTED lines into a new DRAFT PO for one vendor; a line is ordered once.
import {
  PurchaseRequisitionStatus,
  type ConvertPrRequest,
  type CreatePrRequest,
  type Page,
  type PoDto,
  type PrDto,
  type PurchListQuery,
  type UpdatePrRequest,
} from '@albert/shared';
import { Decimal } from 'decimal.js';
import { db, withTransaction, type Queryable, type Tx } from '../../db/client';
import { AppError } from '../../core/errors';
import { companyToday } from '../../core/dates';
import { txContext, type AuthContext } from '../../core/auth/auth.service';
import { defineTransitions, recordInitialStatus, transition } from '../../core/transition/transition';
import { nextDocNo } from '../../core/settings/numbering.service';
import { assertPurchItems, purchItems } from '../masters/purch-refs.service';
import { createPoInTx, getPo } from './orders.service';
import * as repo from './procurement.repo';
import { userNames } from '../../core/access/access.service';
import { allowBulkFgPurchase } from './procurement.settings';

export const PR_TABLE = 'purch.purchase_requisitions';

export const RequisitionMoves = defineTransitions<PurchaseRequisitionStatus>({
  entityTable: PR_TABLE,
  statuses: PurchaseRequisitionStatus,
  moves: [
    { from: null, to: 'DRAFT', permission: 'purch.pr.manage' },
    { from: 'DRAFT', to: 'SUBMITTED', permission: 'purch.pr.manage' },
    { from: 'SUBMITTED', to: 'CONVERTED', permission: 'purch.po.manage' },
    // Owner 2026-11-25 (answer 4): cancelling a PO frees its lines; the requisition is open again.
    { from: 'CONVERTED', to: 'SUBMITTED', permission: 'purch.po.manage', reasonRequired: true },
    { from: 'DRAFT', to: 'CANCELLED', permission: 'purch.pr.manage', reasonRequired: true },
    { from: 'SUBMITTED', to: 'CANCELLED', permission: 'purch.pr.manage', reasonRequired: true },
  ],
});

/**
 * Owner 2026-11-25 (answer 4): a PO cancelled before any receipt frees its requisition lines. Each PO line keeps
 * the link as released_pr_line_id (history); a CONVERTED requisition goes back to SUBMITTED. Called by cancelPo
 * inside its transaction, after the PO is CANCELLED (0025 allows the change only then).
 */
export async function freePrLinesOfCancelledPo(tx: Tx, auth: AuthContext, poId: string, poDocNo: string): Promise<void> {
  const prIds = await repo.freePrLinks(tx, poId);
  for (const prId of prIds) {
    const pr = await lockPr(tx, auth.companyId, prId);
    if (pr.status === 'CONVERTED') {
      await transition(tx, RequisitionMoves, {
        entityId: prId,
        to: 'SUBMITTED',
        actor: auth,
        reason: `Purchase order ${poDocNo} cancelled: its lines may be ordered again`,
      });
    }
  }
}

// ---------------------------------------------------------------- reading

async function toDtos(q: Queryable, companyId: string, rows: repo.PrRow[]): Promise<PrDto[]> {
  const lines = await repo.prLinesOf(q, rows.map((r) => r.id));
  const [items, names, orders] = await Promise.all([
    purchItems(q, companyId, lines.map((l) => l.itemId)),
    userNames(q, rows.map((r) => r.createdBy)),
    repo.ordersOfPrLines(q, lines.map((l) => l.id)),
  ]);
  return rows.map((r) => ({
    id: r.id,
    docNo: r.docNo,
    prDate: r.prDate,
    requiredBy: r.requiredBy,
    department: r.department,
    notes: r.notes,
    status: r.status,
    createdBy: r.createdBy,
    createdByName: names.get(r.createdBy) ?? '',
    createdAt: r.createdAt.toISOString(),
    lines: lines
      .filter((l) => l.prId === r.id)
      .map((l) => {
        const it = items.get(l.itemId);
        const po = orders.get(l.id);
        return {
          id: l.id,
          lineNo: l.lineNo,
          itemId: l.itemId,
          itemCode: it?.code ?? '',
          itemName: it?.name ?? '',
          itemType: it?.type ?? '',
          uomCode: it?.uomCode ?? '',
          qty: l.qty,
          notes: l.notes,
          poId: po?.poId ?? null,
          poDocNo: po?.poDocNo ?? null,
        };
      }),
  }));
}

export async function listPrs(auth: AuthContext, query: PurchListQuery): Promise<Page<PrDto>> {
  const { rows, total } = await repo.listPrs(
    db,
    auth.companyId,
    { status: query.status, search: query.search },
    { limit: query.pageSize, offset: (query.page - 1) * query.pageSize },
  );
  return { items: await toDtos(db, auth.companyId, rows), total, page: query.page, pageSize: query.pageSize };
}

export async function getPr(auth: AuthContext, id: string): Promise<PrDto> {
  const row = await repo.findPr(db, auth.companyId, id);
  if (!row) throw new AppError('NOT_FOUND', 'Purchase requisition not found');
  const [dto] = await toDtos(db, auth.companyId, [row]);
  if (!dto) throw new AppError('NOT_FOUND', 'Purchase requisition not found');
  return dto;
}

// ---------------------------------------------------------------- writing

async function lockPr(tx: Tx, companyId: string, id: string): Promise<repo.PrRow> {
  const pr = await repo.findPr(tx, companyId, id, true);
  if (!pr) throw new AppError('NOT_FOUND', 'Purchase requisition not found');
  return pr;
}

async function prepare(q: Queryable, auth: AuthContext, input: CreatePrRequest) {
  if (input.prDate > companyToday()) throw new AppError('VALIDATION_FAILED', 'The requisition date cannot be in the future', { field: 'prDate' });
  if (input.requiredBy && input.requiredBy < input.prDate) {
    throw new AppError('VALIDATION_FAILED', 'Required-by cannot be before the requisition date', { field: 'requiredBy' });
  }
  await assertPurchItems(q, auth.companyId, input.lines.map((l) => l.itemId), { allowBulkFg: await allowBulkFgPurchase(q, auth.companyId) });
  return {
    header: { prDate: input.prDate, requiredBy: input.requiredBy ?? null, department: input.department?.trim() || null, notes: input.notes?.trim() || null },
    lines: input.lines.map((l, i) => ({ lineNo: i + 1, itemId: l.itemId, qty: new Decimal(l.qty).toFixed(4), notes: l.notes?.trim() || null })),
  };
}

export async function createPr(auth: AuthContext, input: CreatePrRequest): Promise<PrDto> {
  const id = await withTransaction(txContext(auth, 'create purchase requisition'), async (tx) => {
    const { header, lines } = await prepare(tx, auth, input);
    const docNo = await nextDocNo(tx, 'PR', input.prDate);
    const prId = await repo.insertPr(tx, { ...header, docNo });
    await recordInitialStatus(tx, RequisitionMoves, { entityId: prId, to: 'DRAFT', actor: auth });
    await repo.replacePrLines(tx, prId, lines);
    return prId;
  });
  return getPr(auth, id);
}

export async function updatePr(auth: AuthContext, id: string, input: UpdatePrRequest): Promise<PrDto> {
  await withTransaction(txContext(auth, 'edit purchase requisition'), async (tx) => {
    const pr = await lockPr(tx, auth.companyId, id);
    if (pr.status !== 'DRAFT') {
      throw new AppError('RECORD_LOCKED', `Requisition ${pr.docNo} is ${pr.status} and can no longer be edited`, { status: pr.status });
    }
    const { header, lines } = await prepare(tx, auth, input);
    await repo.updatePrHeader(tx, id, header);
    await repo.replacePrLines(tx, id, lines);
  });
  return getPr(auth, id);
}

export async function submitPr(auth: AuthContext, id: string): Promise<PrDto> {
  await withTransaction(txContext(auth, 'submit purchase requisition'), async (tx) => {
    const pr = await lockPr(tx, auth.companyId, id);
    const lines = await repo.prLinesOf(tx, [id]);
    if (pr.status === 'DRAFT') await assertPurchItems(tx, auth.companyId, lines.map((l) => l.itemId), { allowBulkFg: await allowBulkFgPurchase(tx, auth.companyId) });
    await transition(tx, RequisitionMoves, { entityId: id, to: 'SUBMITTED', actor: auth });
  });
  return getPr(auth, id);
}

export async function cancelPr(auth: AuthContext, id: string, reason: string): Promise<PrDto> {
  await withTransaction(txContext(auth, `cancel purchase requisition: ${reason}`), async (tx) => {
    const pr = await lockPr(tx, auth.companyId, id);
    const lines = await repo.prLinesOf(tx, [id]);
    if ((await repo.ordersOfPrLines(tx, lines.map((l) => l.id))).size > 0) {
      throw new AppError('INVALID_TRANSITION', `Requisition ${pr.docNo} is already partly on a purchase order`);
    }
    await transition(tx, RequisitionMoves, { entityId: id, to: 'CANCELLED', actor: auth, reason });
  });
  return getPr(auth, id);
}

/** Order chosen lines of a SUBMITTED requisition on a new DRAFT PO; CONVERTED once every line is ordered. */
export async function convertPr(auth: AuthContext, id: string, input: ConvertPrRequest): Promise<PoDto> {
  const { lines: picked, ...header } = input;
  const poId = await withTransaction(txContext(auth, 'convert purchase requisition'), async (tx) => {
    const pr = await lockPr(tx, auth.companyId, id);
    if (pr.status !== 'SUBMITTED') {
      throw new AppError('INVALID_TRANSITION', `Requisition ${pr.docNo} is ${pr.status}; only a submitted requisition is ordered`);
    }
    const prLines = new Map((await repo.prLinesOf(tx, [id])).map((l) => [l.id, l]));
    const ids = picked.map((p) => p.prLineId);
    if (new Set(ids).size !== ids.length) throw new AppError('VALIDATION_FAILED', 'A requisition line is picked twice');
    const foreign = ids.filter((x) => !prLines.has(x));
    if (foreign.length > 0) throw new AppError('VALIDATION_FAILED', 'Lines do not belong to this requisition', { prLineIds: foreign });
    const ordered = await repo.ordersOfPrLines(tx, ids);
    if (ordered.size > 0) {
      throw new AppError('INVALID_TRANSITION', 'Some lines are already on a purchase order', {
        orders: [...ordered.entries()].map(([prLineId, o]) => ({ prLineId, poDocNo: o.poDocNo })),
      });
    }
    const newPo = await createPoInTx(
      tx,
      auth,
      header,
      picked.map((p) => {
        const l = prLines.get(p.prLineId);
        if (!l) throw new AppError('VALIDATION_FAILED', 'Line not found');
        return { itemId: l.itemId, qty: l.qty, unitPrice: p.unitPrice, notes: l.notes, prLineId: l.id };
      }),
    );
    if ((await repo.unorderedPrLineCount(tx, id)) === 0) {
      await transition(tx, RequisitionMoves, { entityId: id, to: 'CONVERTED', actor: auth });
    }
    return newPo;
  });
  return getPo(auth, poId);
}
