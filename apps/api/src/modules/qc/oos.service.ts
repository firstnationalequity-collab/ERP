// OOS investigations (owner 2026-11-27, M4 task 4b; architecture §4 "OOS investigations", §7.6; 0040).
//
//  - openOosForReviewed(): called by the review of a sample (samples.service.ts) in its transaction: every failed
//                          result reviewed there gets an OPEN investigation OOS-{FY}-{SEQ:5} linked to the result, its
//                          sample, lot and spec test (the DB refuses, at commit, a reviewed failure without one).
//  - closeOos():           OPEN → CLOSED by a holder of qc.oos.close (QC Manager) with their e-signature (APPROVED;
//                          the reason is the conclusion), never the analyst who entered the failed result
//                          (SEGREGATION_OF_DUTIES). INVALIDATED needs the assignable cause (category + description):
//                          the result is then invalidated (never edited) and may be re-tested; CONFIRMED: the failure
//                          stands (material lot: reject; FG lot: stays on HOLD for QA).
// While an investigation is OPEN: no re-test of that result, no QC approval of the lot (rejection allowed).
import { OosStatus, type CloseOosRequest, type OosDto, type OosListQuery, type OosRefDto, type Page } from '@albert/shared';
import { db, withTransaction, type Queryable, type Tx } from '../../db/client';
import { AppError } from '../../core/errors';
import { txContext, type AuthContext, type RequestMeta } from '../../core/auth/auth.service';
import { defineTransitions, recordInitialStatus, transition } from '../../core/transition/transition';
import { recordSignature, verifySignature } from '../../core/esign/esign.service';
import { userNames } from '../../core/access/access.service';
import { nextDocNo } from '../../core/settings/numbering.service';
import { lotIdsMatching, lotIdsOfItems, lotsByIds } from '../../engines/inventory';
import { qcItemIdsMatching, qcItems } from '../masters/qc-refs.service';
import { limitText } from './spec-text';
import * as specsRepo from './specs.repo';
import * as samplesRepo from './sample-requests.repo';
import * as repo from './oos.repo';

export const OOS_TABLE = 'qc.oos_investigations';
const CLOSE_KEY = 'qc.oos.close';

export const OosMoves = defineTransitions<OosStatus>({
  entityTable: OOS_TABLE,
  statuses: OosStatus,
  moves: [
    // Opened by the review of the failed result (the reviewer's transaction).
    { from: null, to: 'OPEN', permission: 'qc.result.review' },
    { from: 'OPEN', to: 'CLOSED', permission: CLOSE_KEY, esign: ['APPROVED'], reasonRequired: true },
  ],
});

export const oosRef = (o: repo.OosRow): OosRefDto => ({ id: o.id, docNo: o.docNo, status: o.status, outcome: o.outcome });

/** The investigations of these results, by result id. */
export async function oosByResult(q: Queryable, resultIds: string[]): Promise<Map<string, repo.OosRow>> {
  return new Map((await repo.oosOfResults(q, resultIds)).map((o) => [o.resultId, o]));
}

export const isInvalidated = (o: repo.OosRow | undefined) => o?.status === 'CLOSED' && o.outcome === 'INVALIDATED';

/** Open investigations of these lots (the disposition refuses approval while one is open). */
export async function openOosOfLots(q: Queryable, companyId: string, lotIds: string[]): Promise<repo.OosRow[]> {
  return repo.oosOfLots(q, companyId, lotIds, 'OPEN');
}

/** In the review transaction: one OPEN investigation per failed result just reviewed. */
export async function openOosForReviewed(tx: Tx, auth: AuthContext, lotId: string, reviewed: samplesRepo.ResultRow[]): Promise<repo.OosRow[]> {
  const opened: repo.OosRow[] = [];
  for (const r of reviewed.filter((x) => !x.passed)) {
    const row = await repo.insertOos(tx, { docNo: await nextDocNo(tx, 'OOS'), resultId: r.id, sampleRequestId: r.sampleRequestId, lotId, specTestId: r.specTestId });
    await recordInitialStatus(tx, OosMoves, { entityId: row.id, to: 'OPEN', actor: auth, reason: `Failed result ${r.id} reviewed` });
    opened.push(row);
  }
  return opened;
}

// ---------------------------------------------------------------- reading

async function toDtos(q: Queryable, auth: AuthContext, rows: repo.OosRow[]): Promise<OosDto[]> {
  const lots = await lotsByIds(q, auth.companyId, rows.map((r) => r.lotId));
  const items = await qcItems(q, auth.companyId, [...lots.values()].map((l) => l.itemId));
  const resultRows = new Map((await repo.resultsByIds(q, rows.map((r) => r.resultId))).map((r) => [r.id, r]));
  const tests = new Map((await specsRepo.specTestsByIds(q, rows.map((r) => r.specTestId))).map((t) => [t.id, t]));
  const retests = new Map((await repo.retestsOf(q, rows.map((r) => r.resultId))).map((r) => [r.retestOf, r.id]));
  const people = rows.flatMap((r) => [r.openedBy, r.closedBy, resultRows.get(r.resultId)?.enteredBy ?? null]).filter((x): x is string => x !== null);
  const names = await userNames(q, [...new Set(people)]);
  const name = (id: string | null) => (id ? (names.get(id) ?? id) : null);
  return rows.map((o) => {
    const lot = lots.get(o.lotId);
    const item = lot ? items.get(lot.itemId) : undefined;
    const res = resultRows.get(o.resultId);
    const test = tests.get(o.specTestId);
    const enteredBy = res?.enteredBy ?? '';
    return {
      ...oosRef(o),
      resultId: o.resultId,
      sampleRequestId: o.sampleRequestId,
      lotId: o.lotId,
      lotNo: lot?.lotNo ?? '',
      lotStatus: lot?.status ?? '',
      itemCode: item?.code ?? '',
      itemName: item?.name ?? '',
      itemType: item?.type ?? '',
      specTestId: o.specTestId,
      testName: test?.name ?? '',
      limit: test ? limitText(test) : '',
      resultValue: res ? (res.numericValue ?? res.textValue) : null,
      resultRemarks: res?.remarks ?? null,
      enteredBy,
      enteredByName: name(enteredBy) ?? '',
      enteredAt: res?.enteredAt.toISOString() ?? '',
      openedBy: o.openedBy,
      openedByName: name(o.openedBy) ?? '',
      openedAt: o.openedAt.toISOString(),
      causeCategory: o.causeCategory,
      causeDescription: o.causeDescription,
      conclusion: o.conclusion,
      closedBy: o.closedBy,
      closedByName: name(o.closedBy),
      closedAt: o.closedAt?.toISOString() ?? null,
      retestResultId: retests.get(o.resultId) ?? null,
      canClose: o.status === 'OPEN' && auth.permissions.has(CLOSE_KEY) && enteredBy !== auth.userId,
    };
  });
}

export async function listOos(auth: AuthContext, query: OosListQuery): Promise<Page<OosDto>> {
  let filter: { docNo?: string; lotIds?: string[] } = {};
  if (query.lotId) filter = { lotIds: [query.lotId] };
  else if (query.search) {
    const lotIds = [
      ...new Set([
        ...(await lotIdsMatching(db, auth.companyId, query.search)),
        ...(await lotIdsOfItems(db, auth.companyId, await qcItemIdsMatching(db, auth.companyId, query.search))),
      ]),
    ];
    filter = { docNo: query.search, lotIds };
  }
  const where = repo.oosWhere(auth.companyId, { ...filter, status: query.status });
  const rows = await repo.listOos(db, where, { offset: (query.page - 1) * query.pageSize, limit: query.pageSize });
  return { items: await toDtos(db, auth, rows), total: await repo.countOos(db, where), page: query.page, pageSize: query.pageSize };
}

export async function getOos(auth: AuthContext, id: string): Promise<OosDto> {
  const row = await repo.findOos(db, auth.companyId, id);
  if (!row) throw new AppError('NOT_FOUND', 'OOS investigation not found');
  return (await toDtos(db, auth, [row]))[0]!;
}

// ---------------------------------------------------------------- closing

async function lockOpen(tx: Tx, auth: AuthContext, id: string): Promise<repo.OosRow> {
  const row = await repo.findOos(tx, auth.companyId, id, true);
  if (!row) throw new AppError('NOT_FOUND', 'OOS investigation not found');
  if (row.status !== 'OPEN') throw new AppError('INVALID_TRANSITION', `OOS investigation ${row.docNo} is already closed (${row.outcome})`, { status: row.status });
  const [res] = await repo.resultsByIds(tx, [row.resultId]);
  if (res?.enteredBy === auth.userId) {
    throw new AppError('SEGREGATION_OF_DUTIES', 'You entered the failed result; another QC Manager closes its OOS investigation', { rule: 'analyst ≠ OOS closer' });
  }
  return row;
}

export async function closeOos(auth: AuthContext, id: string, input: CloseOosRequest, meta: RequestMeta): Promise<OosDto> {
  if (input.signature.meaning !== 'APPROVED') throw new AppError('VALIDATION_FAILED', 'Closing an OOS investigation is signed with the meaning APPROVED');
  if (!auth.permissions.has(CLOSE_KEY)) throw new AppError('FORBIDDEN', 'You do not have permission to close OOS investigations', { permission: CLOSE_KEY });
  // Refuse before asking for the password, then again under lock.
  await withTransaction(txContext(auth), (tx) => lockOpen(tx, auth, id));
  const proof = await verifySignature(auth, input.signature, meta);
  await withTransaction(txContext(auth, `close OOS investigation ${id} (${input.outcome}): ${input.signature.reason}`), async (tx) => {
    await lockOpen(tx, auth, id);
    const sig = await recordSignature(tx, proof, { table: OOS_TABLE, id }, ['APPROVED']);
    const invalidated = input.outcome === 'INVALIDATED';
    await transition(tx, OosMoves, {
      entityId: id,
      to: 'CLOSED',
      actor: auth,
      signature: sig,
      alsoSet: {
        outcome: input.outcome,
        cause_category: invalidated ? (input.causeCategory ?? null) : null,
        cause_description: input.causeDescription ?? null,
        conclusion: sig.reason,
        close_esign_id: sig.id,
        closed_by: auth.userId,
        closed_at: new Date().toISOString(), // the database stamps now()
      },
    });
  });
  return getOos(auth, id);
}
