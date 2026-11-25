// Purchase orders (architecture §3 approval matrix, §4 "Purchase order", §7.5; build-plan M3 task 2; 0023).
//   DRAFT → PENDING_APPROVAL (submit: Finance's rate on the PO date is stamped, the approval matrix decides
//   the steps on the PKR value) → APPROVED; a rejection returns it to DRAFT; CANCELLED before any receipt.
//   AVL block: a GMP material (AvlItemTypes) needs an APPROVED approved source for the vendor; checked when
//   lines are saved, at submit and at approval (service + DB).
//   Segregation (rule 9): the PO creator and the submitter approve no step (SEGREGATION_OF_DUTIES).
// Receipt moves (PARTIALLY_RECEIVED, RECEIVED, CLOSED) come with the GRN (task 3).
import { Decimal } from 'decimal.js';
import {
  PurchaseOrderStatus,
  type CreatePoRequest,
  type Page,
  type PoDto,
  type PoLineDto,
  type PurchListQuery,
  type UpdatePoRequest,
} from '@albert/shared';
import { db, withTransaction, type Queryable, type Tx } from '../../db/client';
import { AppError } from '../../core/errors';
import { companyToday } from '../../core/dates';
import { txContext, type AuthContext } from '../../core/auth/auth.service';
import { defineTransitions, recordInitialStatus, transition, type Actor } from '../../core/transition/transition';
import { cancelApproval, latestApprovalIds, registerApprovalHandler, startApproval } from '../../core/approvals/approvals.service';
import { nextDocNo } from '../../core/settings/numbering.service';
import { assertAvlApproved, assertPurchItems, assertPurchVendor, purchItems, purchVendors } from '../masters/purch-refs.service';
import { rateOn } from '../finance/rates.service';
import * as repo from './procurement.repo';

export const PO_TABLE = 'purch.purchase_orders';
export const PO_APPROVAL_DOC_TYPE = 'PO'; // approval matrix doc type (seed: DEFAULT_RULES)

export const PurchaseOrderMoves = defineTransitions<PurchaseOrderStatus>({
  entityTable: PO_TABLE,
  statuses: PurchaseOrderStatus,
  moves: [
    { from: null, to: 'DRAFT', permission: 'purch.po.manage' },
    { from: 'DRAFT', to: 'PENDING_APPROVAL', permission: 'purch.po.manage' },
    { from: 'PENDING_APPROVAL', to: 'APPROVED', permission: 'purch.po.approve' },
    { from: 'PENDING_APPROVAL', to: 'DRAFT', permission: 'purch.po.approve', reasonRequired: true },
    { from: 'DRAFT', to: 'CANCELLED', permission: 'purch.po.manage', reasonRequired: true },
    { from: 'PENDING_APPROVAL', to: 'CANCELLED', permission: 'purch.po.manage', reasonRequired: true },
    { from: 'APPROVED', to: 'CANCELLED', permission: 'purch.po.manage', reasonRequired: true },
  ],
});

// ---------------------------------------------------------------- approval hooks

async function lockPo(tx: Tx, companyId: string, id: string): Promise<repo.PoRow> {
  const po = await repo.findPo(tx, companyId, id, true);
  if (!po) throw new AppError('NOT_FOUND', 'Purchase order not found');
  return po;
}

/** Vendor ACTIVE, items purchasable and the AVL block, on the PO as saved. */
async function assertOrderable(q: Queryable, companyId: string, po: repo.PoRow): Promise<void> {
  const vendor = await assertPurchVendor(q, companyId, po.vendorId);
  const lines = await repo.poLinesOf(q, [po.id]);
  const items = await assertPurchItems(q, companyId, lines.map((l) => l.itemId));
  await assertAvlApproved(q, companyId, vendor, [...items.values()]);
}

registerApprovalHandler(PO_APPROVAL_DOC_TYPE, {
  async assertMayApprove(tx, approval, actor) {
    const po = await lockPo(tx, actor.companyId, approval.docId);
    if (actor.userId === po.createdBy || actor.userId === po.submittedBy) {
      throw new AppError('SEGREGATION_OF_DUTIES', 'The creator or submitter of a purchase order cannot approve it', {
        rule: 'PO creator ≠ PO approver',
      });
    }
  },
  async onApproved(tx, approval, actor) {
    const po = await lockPo(tx, actor.companyId, approval.docId);
    // A source blocked or a vendor deactivated while the PO waited stops the approval (DB re-checks too).
    await assertOrderable(tx, actor.companyId, po);
    await transition(tx, PurchaseOrderMoves, { entityId: po.id, to: 'APPROVED', actor });
  },
  async onRejected(tx, approval, actor, reason) {
    const po = await lockPo(tx, actor.companyId, approval.docId);
    await transition(tx, PurchaseOrderMoves, { entityId: po.id, to: 'DRAFT', actor, reason });
  },
});

// ---------------------------------------------------------------- reading

async function toDtos(q: Queryable, companyId: string, rows: repo.PoRow[]): Promise<PoDto[]> {
  const lines = await repo.poLinesOf(q, rows.map((r) => r.id));
  const [vendors, items, names, approvals, prLines] = await Promise.all([
    purchVendors(q, companyId, rows.map((r) => r.vendorId)),
    purchItems(q, companyId, lines.map((l) => l.itemId)),
    repo.userNames(q, rows.map((r) => r.createdBy)),
    latestApprovalIds(q, companyId, PO_TABLE, rows.map((r) => r.id)),
    repo.prLinesByIds(q, companyId, lines.flatMap((l) => (l.prLineId ? [l.prLineId] : []))),
  ]);
  const prDocOf = new Map(prLines.map((l) => [l.id, l.prDocNo]));
  return rows.map((r) => {
    const v = vendors.get(r.vendorId);
    const myLines: PoLineDto[] = lines
      .filter((l) => l.poId === r.id)
      .map((l) => {
        const it = items.get(l.itemId);
        return {
          id: l.id,
          lineNo: l.lineNo,
          itemId: l.itemId,
          itemCode: it?.code ?? '',
          itemName: it?.name ?? '',
          itemType: it?.type ?? '',
          uomCode: it?.uomCode ?? '',
          qty: l.qty,
          unitPrice: l.unitPrice,
          lineAmount: l.lineAmount,
          receivedQty: l.receivedQty,
          prLineId: l.prLineId,
          prDocNo: l.prLineId ? (prDocOf.get(l.prLineId) ?? null) : null,
          notes: l.notes,
        };
      });
    return {
      id: r.id,
      docNo: r.docNo,
      poDate: r.poDate,
      vendorId: r.vendorId,
      vendorCode: v?.code ?? '',
      vendorName: v?.name ?? '',
      poType: r.poType,
      currency: r.currency,
      exchangeRate: r.exchangeRate,
      incoterm: r.incoterm,
      deliveryDate: r.deliveryDate,
      notes: r.notes,
      totalAmount: r.totalAmount,
      totalPkr: r.exchangeRate ? new Decimal(r.totalAmount).times(r.exchangeRate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : null,
      status: r.status,
      createdBy: r.createdBy,
      createdByName: names.get(r.createdBy) ?? '',
      createdAt: r.createdAt.toISOString(),
      submittedBy: r.submittedBy,
      submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
      approvalId: approvals.get(r.id) ?? null,
      lines: myLines,
    };
  });
}

export async function listPos(auth: AuthContext, query: PurchListQuery): Promise<Page<PoDto>> {
  const { rows, total } = await repo.listPos(
    db,
    auth.companyId,
    { status: query.status, search: query.search, vendorId: query.vendorId },
    { limit: query.pageSize, offset: (query.page - 1) * query.pageSize },
  );
  return { items: await toDtos(db, auth.companyId, rows), total, page: query.page, pageSize: query.pageSize };
}

export async function getPo(auth: AuthContext, id: string): Promise<PoDto> {
  const row = await repo.findPo(db, auth.companyId, id);
  if (!row) throw new AppError('NOT_FOUND', 'Purchase order not found');
  const [dto] = await toDtos(db, auth.companyId, [row]);
  if (!dto) throw new AppError('NOT_FOUND', 'Purchase order not found');
  return dto;
}

// ---------------------------------------------------------------- writing

type PoHeader = Omit<CreatePoRequest, 'lines'>;
export interface PoLineInput {
  itemId: string;
  qty: string;
  unitPrice: string;
  notes?: string | null;
  prLineId?: string | null;
}

/** qty × unit price (a 6-decimal rate), half-up to 2 decimals (the DB CHECK uses the same rounding). */
export function lineAmount(qty: string, unitPrice: string): string {
  return new Decimal(qty).times(unitPrice).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** Header and lines checked, amounts computed; ready to write. */
async function prepare(q: Queryable, auth: AuthContext, header: PoHeader, lines: PoLineInput[]) {
  if (header.poDate > companyToday()) throw new AppError('VALIDATION_FAILED', 'The PO date cannot be in the future', { field: 'poDate' });
  const vendor = await assertPurchVendor(q, auth.companyId, header.vendorId);
  if (vendor.isForeign && header.poType !== 'IMPORT') {
    throw new AppError('VALIDATION_FAILED', `${vendor.code} is a foreign vendor: the PO must be an import PO`, { field: 'poType' });
  }
  const items = await assertPurchItems(q, auth.companyId, lines.map((l) => l.itemId));
  await assertAvlApproved(q, auth.companyId, vendor, [...items.values()]);
  const rows = lines.map((l, i) => ({
    lineNo: i + 1,
    itemId: l.itemId,
    qty: new Decimal(l.qty).toFixed(4),
    unitPrice: new Decimal(l.unitPrice).toFixed(6),
    lineAmount: lineAmount(l.qty, l.unitPrice),
    prLineId: l.prLineId ?? null,
    notes: l.notes?.trim() || null,
  }));
  const total = rows.reduce((s, l) => s.plus(l.lineAmount), new Decimal(0)).toFixed(2);
  const values: repo.PoHeaderValues = {
    poDate: header.poDate,
    vendorId: header.vendorId,
    poType: header.poType,
    currency: header.currency,
    incoterm: header.poType === 'IMPORT' ? (header.incoterm ?? null) : null,
    deliveryDate: header.deliveryDate ?? null,
    notes: header.notes?.trim() || null,
    totalAmount: total,
  };
  return { values, rows };
}

/** Create a DRAFT PO inside the caller's transaction (also used by requisition conversion). */
export async function createPoInTx(tx: Tx, auth: AuthContext, header: PoHeader, lines: PoLineInput[]): Promise<string> {
  const { values, rows } = await prepare(tx, auth, header, lines);
  const docNo = await nextDocNo(tx, 'PO', header.poDate);
  const id = await repo.insertPo(tx, { ...values, docNo });
  await recordInitialStatus(tx, PurchaseOrderMoves, { entityId: id, to: 'DRAFT', actor: auth });
  await repo.replacePoLines(tx, id, rows);
  return id;
}

export async function createPo(auth: AuthContext, input: CreatePoRequest): Promise<PoDto> {
  const { lines, ...header } = input;
  const id = await withTransaction(txContext(auth, 'create purchase order'), (tx) => createPoInTx(tx, auth, header, lines));
  return getPo(auth, id);
}

function assertDraft(po: repo.PoRow): void {
  if (po.status !== 'DRAFT') {
    throw new AppError('RECORD_LOCKED', `Purchase order ${po.docNo} is ${po.status} and can no longer be edited`, { status: po.status });
  }
}

/** Replace a DRAFT. Lines taken from a requisition must stay on it (cancel the PO to release them). */
export async function updatePo(auth: AuthContext, id: string, input: UpdatePoRequest): Promise<PoDto> {
  const { lines, ...header } = input;
  await withTransaction(txContext(auth, `edit purchase order`), async (tx) => {
    const po = await lockPo(tx, auth.companyId, id);
    assertDraft(po);
    const current = await repo.poLinesOf(tx, [id]);
    const kept = new Set(lines.flatMap((l) => (l.prLineId ? [l.prLineId] : [])));
    const dropped = current.filter((l) => l.prLineId && !kept.has(l.prLineId));
    if (dropped.length > 0) {
      throw new AppError('VALIDATION_FAILED', 'Lines taken from a requisition stay on the PO; cancel the PO to release them', {
        prLineIds: dropped.map((l) => l.prLineId),
      });
    }
    const known = new Map(current.flatMap((l) => (l.prLineId ? [[l.prLineId, l.itemId] as const] : [])));
    for (const l of lines) {
      if (l.prLineId && known.get(l.prLineId) !== l.itemId) {
        throw new AppError('VALIDATION_FAILED', 'A requisition line keeps its item and cannot be added here', { prLineId: l.prLineId });
      }
    }
    const { values, rows } = await prepare(tx, auth, header, lines);
    await repo.updatePoHeader(tx, id, values);
    await repo.replacePoLines(tx, id, rows);
  });
  return getPo(auth, id);
}

/** Submit for approval: stamps Finance's rate on the PO date and starts the approval on the PKR value. */
export async function submitPo(auth: AuthContext, id: string): Promise<PoDto> {
  await withTransaction(txContext(auth, 'submit purchase order'), async (tx) => {
    const po = await lockPo(tx, auth.companyId, id);
    assertDraft(po);
    await assertOrderable(tx, auth.companyId, po);
    const rate = await rateOn(tx, auth.companyId, po.currency, po.poDate);
    await transition(tx, PurchaseOrderMoves, {
      entityId: id,
      to: 'PENDING_APPROVAL',
      actor: auth,
      alsoSet: { exchange_rate: rate, submitted_by: auth.userId, submitted_at: new Date().toISOString() },
    });
    await startApproval(tx, auth, {
      docType: PO_APPROVAL_DOC_TYPE,
      docTable: PO_TABLE,
      docId: id,
      docNo: po.docNo,
      value: { measure: 'AMOUNT_PKR', amount: po.totalAmount, currency: po.currency, exchangeRate: rate },
    });
  });
  return getPo(auth, id);
}

/** Cancel before any receipt (a pending approval is cancelled with it). */
export async function cancelPo(auth: AuthContext, id: string, reason: string): Promise<PoDto> {
  await withTransaction(txContext(auth, `cancel purchase order: ${reason}`), async (tx) => {
    const po = await lockPo(tx, auth.companyId, id);
    if (!new Decimal(await repo.totalReceived(tx, id)).isZero()) {
      throw new AppError('INVALID_TRANSITION', `Purchase order ${po.docNo} has receipts and cannot be cancelled`);
    }
    if (po.status === 'PENDING_APPROVAL') await cancelApproval(tx, auth satisfies Actor, PO_TABLE, id, reason);
    await transition(tx, PurchaseOrderMoves, { entityId: id, to: 'CANCELLED', actor: auth, reason });
  });
  return getPo(auth, id);
}
