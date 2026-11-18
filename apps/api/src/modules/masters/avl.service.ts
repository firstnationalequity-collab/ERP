// Approved sources / AVL (decision M2 Q4; architecture §3, §7.2).
//  - Purchase Officer (master.vendor.manage) proposes vendor + GMP item + manufacturer + site → PENDING and
//    an AVL approval starts in the same transaction. Evidence (questionnaire, audit report, sample CoA) is
//    attached to the source; the approval detail lists it for the QA Manager's e-signature.
//  - The AVL approval (QA Manager, locked to master.avl.approve in code) moves PENDING → APPROVED; it is
//    refused while the source has no attachment. A rejected approval moves PENDING → REJECTED.
//  - QA Manager blocks an APPROVED source directly: e-signature (meaning REJECTED) and a reason.
import { eq } from 'drizzle-orm';
import {
  ApprovedSourceStatus,
  AvlItemTypes,
  type ApprovedSourceDto,
  type BlockSourceRequest,
  type CreateApprovedSourceRequest,
  type MasterListQuery,
  type Page,
} from '@albert/shared';
import { db, withTransaction, type Tx } from '../../db/client';
import { approvedSources } from '../../db/schema/masters';
import { AppError } from '../../core/errors';
import { txContext, type AuthContext, type RequestMeta } from '../../core/auth/auth.service';
import { recordSignature, verifySignature } from '../../core/esign/esign.service';
import { defineTransitions, recordInitialStatus, transition } from '../../core/transition/transition';
import { latestApprovalIds, registerApprovalHandler, startApproval } from '../../core/approvals/approvals.service';
import { countForDocument, listForDocument, registerAttachmentTarget } from '../../core/attachments/attachments.service';
import * as repo from './masters.repo';
import { found, page, paging, stamped } from './common';

export const SOURCE_TABLE = 'master.approved_sources';

export const ApprovedSourceMoves = defineTransitions<ApprovedSourceStatus>({
  entityTable: SOURCE_TABLE,
  statuses: ApprovedSourceStatus,
  moves: [
    { from: null, to: 'PENDING', permission: 'master.vendor.manage' },
    { from: 'PENDING', to: 'APPROVED', permission: 'master.avl.approve' },
    { from: 'PENDING', to: 'REJECTED', permission: 'master.avl.approve', reasonRequired: true },
    { from: 'APPROVED', to: 'BLOCKED', permission: 'master.avl.approve', esign: ['REJECTED'], reasonRequired: true },
  ],
});

// ---------------------------------------------------------------- hooks (registered once at start-up)

registerAttachmentTarget(SOURCE_TABLE, {
  readPermission: 'master.view',
  writePermission: 'master.vendor.manage',
  exists: async (q, recordId) => {
    const rows = await q.select({ id: approvedSources.id }).from(approvedSources).where(eq(approvedSources.id, recordId));
    return rows.length > 0;
  },
});

async function lockPending(tx: Tx, companyId: string, id: string) {
  const source = await repo.lockSource(tx, companyId, id);
  if (!source) throw new AppError('NOT_FOUND', 'Approved source not found');
  if (source.status !== 'PENDING') throw new AppError('INVALID_TRANSITION', `The approved source is ${source.status}, not PENDING`);
  return source;
}

registerApprovalHandler('AVL', {
  async onApproved(tx, approval, actor) {
    const source = await lockPending(tx, actor.companyId, approval.docId);
    if ((await countForDocument(tx, actor.companyId, SOURCE_TABLE, source.id)) === 0) {
      throw new AppError('VALIDATION_FAILED', 'Attach the evidence (questionnaire, audit report, sample CoA) before approving this source');
    }
    await transition(tx, ApprovedSourceMoves, { entityId: source.id, to: 'APPROVED', actor });
  },
  async onRejected(tx, approval, actor, reason) {
    const source = await lockPending(tx, actor.companyId, approval.docId);
    await transition(tx, ApprovedSourceMoves, { entityId: source.id, to: 'REJECTED', actor, reason });
  },
});

// ---------------------------------------------------------------- reading

function toDto(row: repo.SourceListRow, approvalId: string | null): ApprovedSourceDto {
  return { ...stamped(row.s), vendorCode: row.vendorCode, vendorName: row.vendorName, itemCode: row.itemCode, itemName: row.itemName, approvalId };
}

export async function listSources(auth: AuthContext, query: MasterListQuery): Promise<Page<ApprovedSourceDto>> {
  const status =
    query.status && (ApprovedSourceStatus as readonly string[]).includes(query.status) ? (query.status as ApprovedSourceStatus) : undefined;
  const where = repo.listWhere(
    approvedSources.companyId,
    {
      search: query.search,
      searchCols: [approvedSources.manufacturer, approvedSources.manufacturingSite],
      extra: [
        status ? eq(approvedSources.status, status) : undefined,
        query.vendorId ? eq(approvedSources.vendorId, query.vendorId) : undefined,
        query.itemId ? eq(approvedSources.itemId, query.itemId) : undefined,
      ],
    },
    auth.companyId,
  );
  const rows = await repo.listSources(db, where, paging(query));
  const approvalsOf = await latestApprovalIds(db, auth.companyId, SOURCE_TABLE, rows.map((r) => r.s.id));
  return page(
    rows.map((r) => toDto(r, approvalsOf.get(r.s.id) ?? null)),
    await repo.countWhere(db, approvedSources, where),
    query,
  );
}

export async function getSource(auth: AuthContext, id: string): Promise<ApprovedSourceDto> {
  const row = found(await repo.findSource(db, auth.companyId, id), 'Approved source');
  const approvalsOf = await latestApprovalIds(db, auth.companyId, SOURCE_TABLE, [id]);
  return { ...toDto(row, approvalsOf.get(id) ?? null), attachments: await listForDocument(auth, SOURCE_TABLE, id) };
}

// ---------------------------------------------------------------- proposing and blocking

export async function proposeSource(auth: AuthContext, input: CreateApprovedSourceRequest): Promise<ApprovedSourceDto> {
  const id = await withTransaction(txContext(auth), async (tx) => {
    const vendor = found(await repo.findVendor(tx, auth.companyId, input.vendorId), 'Vendor');
    if (vendor.status === 'INACTIVE') throw new AppError('VALIDATION_FAILED', 'The vendor is inactive', { field: 'vendorId' });
    const item = found(await repo.findItem(tx, auth.companyId, input.itemId), 'Item');
    if (!item.isActive) throw new AppError('VALIDATION_FAILED', 'The item is not active', { field: 'itemId' });
    if (!AvlItemTypes.includes(item.type)) {
      throw new AppError('VALIDATION_FAILED', `Approved sources are kept for GMP materials (${AvlItemTypes.join(', ')}), not ${item.type}`, {
        field: 'itemId',
      });
    }
    const source = await repo.insertSource(tx, { ...input, notes: input.notes ?? null, status: 'PENDING' });
    await recordInitialStatus(tx, ApprovedSourceMoves, { entityId: source.id, to: 'PENDING', actor: auth });
    await startApproval(tx, auth, {
      docType: 'AVL',
      docTable: SOURCE_TABLE,
      docId: source.id,
      docNo: `${item.code} / ${vendor.code}`,
      value: { measure: 'NONE' },
    });
    return source.id;
  });
  return getSource(auth, id);
}

export async function blockSource(auth: AuthContext, id: string, input: BlockSourceRequest, meta: RequestMeta): Promise<ApprovedSourceDto> {
  if (input.signature.meaning !== 'REJECTED') throw new AppError('VALIDATION_FAILED', 'Blocking a source needs the meaning REJECTED');
  const proof = await verifySignature(auth, input.signature, meta);
  await withTransaction(txContext(auth, `block source: ${input.signature.reason}`), async (tx) => {
    found(await repo.lockSource(tx, auth.companyId, id), 'Approved source');
    const signature = await recordSignature(tx, proof, { table: SOURCE_TABLE, id }, ['REJECTED']);
    await transition(tx, ApprovedSourceMoves, { entityId: id, to: 'BLOCKED', actor: auth, signature });
  });
  return getSource(auth, id);
}
