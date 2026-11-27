// QC specifications (architecture §5 QC, §7.6; build-plan M4 task 1; 0034). Versioned per item:
//   DRAFT (editable, qc.spec.manage) → PENDING_APPROVAL (submit, qc.spec.manage)
//   → APPROVED (QC Manager, e-signature APPROVED, qc.spec.approve; the previous APPROVED version → OBSOLETE first)
//   PENDING_APPROVAL → DRAFT on rejection (reason).
// A new version copies the latest version's header and tests. The approver is neither the drafter nor the submitter
// (SEGREGATION_OF_DUTIES, service + DB). Other modules (sampling, M4 task 2) read the APPROVED version via approvedSpec().
import {
  QcSpecItemTypes,
  QcSpecStatus,
  type ApproveSpecRequest,
  type CreateSpecRequest,
  type Page,
  type SetSpecTestsRequest,
  type SpecDto,
  type SpecListQuery,
  type SpecTestDto,
  type UpdateSpecRequest,
} from '@albert/shared';
import { db, withTransaction, type Queryable, type Tx } from '../../db/client';
import { AppError } from '../../core/errors';
import { txContext, type AuthContext, type RequestMeta } from '../../core/auth/auth.service';
import { defineTransitions, recordInitialStatus, transition } from '../../core/transition/transition';
import { recordSignature, verifySignature } from '../../core/esign/esign.service';
import { userNames } from '../../core/access/access.service';
import { qcItemIdsMatching, qcItems, type QcItemRef } from '../masters/qc-refs.service';
import * as repo from './specs.repo';

export const SPEC_TABLE = 'qc.specs';

export const SpecMoves = defineTransitions<QcSpecStatus>({
  entityTable: SPEC_TABLE,
  statuses: QcSpecStatus,
  moves: [
    { from: null, to: 'DRAFT', permission: 'qc.spec.manage' },
    { from: 'DRAFT', to: 'PENDING_APPROVAL', permission: 'qc.spec.manage' },
    { from: 'PENDING_APPROVAL', to: 'APPROVED', permission: 'qc.spec.approve', esign: ['APPROVED'] },
    { from: 'PENDING_APPROVAL', to: 'DRAFT', permission: 'qc.spec.approve', reasonRequired: true },
    { from: 'APPROVED', to: 'OBSOLETE', permission: 'qc.spec.approve' },
  ],
});

// ---------------------------------------------------------------- reading

const testDto = (t: repo.SpecTestRow): SpecTestDto => ({
  id: t.id,
  seq: t.seq,
  name: t.name,
  method: t.method,
  resultType: t.resultType,
  minValue: t.minValue,
  maxValue: t.maxValue,
  textLimit: t.textLimit,
  unit: t.unit,
  isAssay: t.isAssay,
  isWater: t.isWater,
});

async function toDtos(q: Queryable, companyId: string, rows: repo.SpecRow[]): Promise<SpecDto[]> {
  const itemMap = await qcItems(q, companyId, rows.map((r) => r.itemId));
  const people = rows.flatMap((r) => [r.createdBy, r.updatedBy, r.submittedBy, r.approvedBy]).filter((x): x is string => x !== null);
  const names = await userNames(q, [...new Set(people)]);
  return rows.map((r) => {
    const it = itemMap.get(r.itemId);
    const mine = [r.createdBy, r.submittedBy, r.approvedBy].filter((x): x is string => x !== null);
    return {
      id: r.id,
      itemId: r.itemId,
      itemCode: it?.code ?? '',
      itemName: it?.name ?? '',
      itemType: it?.type ?? '',
      version: r.version,
      reference: r.reference,
      notes: r.notes,
      status: r.status,
      submittedBy: r.submittedBy,
      approvedBy: r.approvedBy,
      approvedAt: r.approvedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdBy,
      updatedAt: r.updatedAt.toISOString(),
      updatedBy: r.updatedBy,
      userNames: Object.fromEntries(mine.map((u) => [u, names.get(u) ?? u])),
    };
  });
}

export async function listSpecs(auth: AuthContext, query: SpecListQuery): Promise<Page<SpecDto>> {
  let itemIds: string[] | undefined;
  if (query.itemId) itemIds = [query.itemId];
  if (query.search) {
    const matching = await qcItemIdsMatching(db, auth.companyId, query.search);
    itemIds = itemIds ? itemIds.filter((i) => matching.includes(i)) : matching;
  }
  const where = repo.specWhere(auth.companyId, { status: query.status, itemIds });
  const rows = await repo.listSpecs(db, where, { offset: (query.page - 1) * query.pageSize, limit: query.pageSize });
  return { items: await toDtos(db, auth.companyId, rows), total: await repo.countSpecs(db, where), page: query.page, pageSize: query.pageSize };
}

export async function getSpec(auth: AuthContext, id: string): Promise<SpecDto> {
  const row = await repo.findSpec(db, auth.companyId, id);
  if (!row) throw new AppError('NOT_FOUND', 'Specification not found');
  const [dto] = await toDtos(db, auth.companyId, [row]);
  return { ...dto!, tests: (await repo.specTestsOf(db, id)).map(testDto) };
}

// ---------------------------------------------------------------- for other QC services

export interface ApprovedSpec {
  id: string;
  version: number;
  tests: SpecTestDto[];
}

/** The APPROVED spec of an item with its tests, or SPEC_NOT_APPROVED (sampling needs one). */
export async function approvedSpec(q: Queryable, companyId: string, itemId: string): Promise<ApprovedSpec> {
  const row = await repo.approvedSpecOf(q, companyId, itemId);
  if (!row) throw new AppError('SPEC_NOT_APPROVED', 'This item has no APPROVED QC specification; QC approves one first', { itemId });
  return { id: row.id, version: row.version, tests: (await repo.specTestsOf(q, row.id)).map(testDto) };
}

// ---------------------------------------------------------------- drafting

async function lockSpec(tx: Tx, auth: AuthContext, id: string): Promise<repo.SpecRow> {
  const row = await repo.findSpec(tx, auth.companyId, id, true);
  if (!row) throw new AppError('NOT_FOUND', 'Specification not found');
  return row;
}

async function lockDraft(tx: Tx, auth: AuthContext, id: string): Promise<repo.SpecRow> {
  const row = await lockSpec(tx, auth, id);
  if (row.status !== 'DRAFT') throw new AppError('RECORD_LOCKED', `Specification v${row.version} is ${row.status}; only a DRAFT can be edited`);
  return row;
}

function assertSpecItem(item: QcItemRef | undefined): QcItemRef {
  if (!item) throw new AppError('VALIDATION_FAILED', 'Item not found', { field: 'itemId' });
  if (!(QcSpecItemTypes as readonly string[]).includes(item.type)) {
    throw new AppError('VALIDATION_FAILED', `A QC specification is for ${QcSpecItemTypes.join(', ')} items, not ${item.type}`, { field: 'itemId' });
  }
  if (item.status === 'INACTIVE') throw new AppError('VALIDATION_FAILED', `Item ${item.code} is inactive`, { field: 'itemId' });
  return item;
}

/** New version of an item's spec; copies the latest version's header and tests. */
export async function createSpec(auth: AuthContext, input: CreateSpecRequest): Promise<SpecDto> {
  const id = await withTransaction(txContext(auth), async (tx) => {
    assertSpecItem((await qcItems(tx, auth.companyId, [input.itemId])).get(input.itemId));
    const versions = await repo.lockSpecsOfItem(tx, auth.companyId, input.itemId);
    const open = versions.find((v) => v.status === 'DRAFT' || v.status === 'PENDING_APPROVAL');
    if (open) throw new AppError('ALREADY_EXISTS', `Version ${open.version} of this specification is still ${open.status}; finish it first`, { specId: open.id });
    const latest = versions[0];
    const spec = await repo.insertSpec(tx, {
      itemId: input.itemId,
      version: (latest?.version ?? 0) + 1,
      reference: input.reference !== undefined ? input.reference : (latest?.reference ?? null),
      notes: input.notes !== undefined ? input.notes : (latest?.notes ?? null),
    });
    await recordInitialStatus(tx, SpecMoves, { entityId: spec.id, to: 'DRAFT', actor: auth });
    if (latest) {
      const tests = await repo.specTestsOf(tx, latest.id);
      await repo.replaceSpecTests(
        tx,
        spec.id,
        tests.map(({ seq, name, method, resultType, minValue, maxValue, textLimit, unit, isAssay, isWater }) => ({
          specId: spec.id, seq, name, method, resultType, minValue, maxValue, textLimit, unit, isAssay, isWater,
        })),
      );
    }
    return spec.id;
  });
  return getSpec(auth, id);
}

export async function updateSpec(auth: AuthContext, id: string, input: UpdateSpecRequest): Promise<SpecDto> {
  await withTransaction(txContext(auth), async (tx) => {
    await lockDraft(tx, auth, id);
    const changes: { reference?: string | null; notes?: string | null } = {};
    if (input.reference !== undefined) changes.reference = input.reference;
    if (input.notes !== undefined) changes.notes = input.notes;
    await repo.updateSpec(tx, id, changes);
  });
  return getSpec(auth, id);
}

/** Replace all tests of a DRAFT spec (numbered 1..n in the order given). */
export async function setSpecTests(auth: AuthContext, id: string, input: SetSpecTestsRequest): Promise<SpecDto> {
  await withTransaction(txContext(auth), async (tx) => {
    await lockDraft(tx, auth, id);
    await repo.replaceSpecTests(
      tx,
      id,
      input.tests.map((t, i) => ({
        specId: id,
        seq: i + 1,
        name: t.name,
        method: t.method ?? null,
        resultType: t.resultType,
        minValue: t.resultType === 'NUMERIC' ? (t.minValue ?? null) : null,
        maxValue: t.resultType === 'NUMERIC' ? (t.maxValue ?? null) : null,
        textLimit: t.resultType === 'TEXT' ? (t.textLimit ?? null) : null,
        unit: t.unit ?? null,
        isAssay: t.isAssay,
        isWater: t.isWater,
      })),
    );
  });
  return getSpec(auth, id);
}

export async function submitSpec(auth: AuthContext, id: string): Promise<SpecDto> {
  await withTransaction(txContext(auth), async (tx) => {
    await lockDraft(tx, auth, id);
    if ((await repo.specTestsOf(tx, id)).length === 0) throw new AppError('VALIDATION_FAILED', 'A specification needs at least one test before it is submitted');
    await transition(tx, SpecMoves, { entityId: id, to: 'PENDING_APPROVAL', actor: auth, alsoSet: { submitted_by: auth.userId } });
  });
  return getSpec(auth, id);
}

function assertApproverDiffers(auth: AuthContext, row: repo.SpecRow): void {
  if (row.createdBy === auth.userId || row.submittedBy === auth.userId) {
    throw new AppError('SEGREGATION_OF_DUTIES', `You drafted or submitted specification v${row.version}; another person approves it`, {
      rule: 'spec drafter / submitter ≠ approver',
    });
  }
}

async function lockPending(tx: Tx, auth: AuthContext, id: string): Promise<repo.SpecRow> {
  const row = await lockSpec(tx, auth, id);
  if (row.status !== 'PENDING_APPROVAL') throw new AppError('INVALID_TRANSITION', `Specification v${row.version} is ${row.status}, not PENDING_APPROVAL`);
  return row;
}

/** QC Manager approves with an e-signature (APPROVED); the previous APPROVED version becomes OBSOLETE. */
export async function approveSpec(auth: AuthContext, id: string, input: ApproveSpecRequest, meta: RequestMeta): Promise<SpecDto> {
  if (input.signature.meaning !== 'APPROVED') throw new AppError('VALIDATION_FAILED', 'Approving a specification needs the meaning APPROVED');
  const pre = await repo.findSpec(db, auth.companyId, id);
  if (!pre) throw new AppError('NOT_FOUND', 'Specification not found');
  if (!auth.permissions.has('qc.spec.approve')) throw new AppError('FORBIDDEN', 'You do not have permission to approve specifications', { permission: 'qc.spec.approve' });
  assertApproverDiffers(auth, pre);
  const proof = await verifySignature(auth, input.signature, meta);
  await withTransaction(txContext(auth, `approve specification: ${input.signature.reason}`), async (tx) => {
    const row = await lockPending(tx, auth, id);
    const versions = await repo.lockSpecsOfItem(tx, auth.companyId, row.itemId);
    assertApproverDiffers(auth, row);
    const signature = await recordSignature(tx, proof, { table: SPEC_TABLE, id }, ['APPROVED']);
    for (const v of versions.filter((x) => x.status === 'APPROVED')) {
      await transition(tx, SpecMoves, { entityId: v.id, to: 'OBSOLETE', actor: auth, reason: `Superseded by v${row.version}` });
    }
    await transition(tx, SpecMoves, {
      entityId: id,
      to: 'APPROVED',
      actor: auth,
      signature,
      alsoSet: { approved_by: auth.userId, approved_at: new Date().toISOString(), approval_esign_id: signature.id },
    });
  });
  return getSpec(auth, id);
}

/** QC Manager returns a submitted spec to DRAFT with a reason. */
export async function rejectSpec(auth: AuthContext, id: string, reason: string): Promise<SpecDto> {
  await withTransaction(txContext(auth, `reject specification: ${reason}`), async (tx) => {
    const row = await lockPending(tx, auth, id);
    assertApproverDiffers(auth, row);
    await transition(tx, SpecMoves, { entityId: id, to: 'DRAFT', actor: auth, reason, alsoSet: { submitted_by: null } });
  });
  return getSpec(auth, id);
}
