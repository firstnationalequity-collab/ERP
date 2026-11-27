// QC sample queue, sampling, results and review (architecture §4 lot table, §7.6; build-plan M4 task 2; 0035, 0036).
//
//  - takeSample():   OPEN → SAMPLED (qc.result.enter). ONE transaction: lot QUARANTINE / RETEST_DUE → UNDER_TEST,
//                    SAMPLE_ISSUE movements for the test quantity and any retention quantity (owner 2026-11-27:
//                    sampling reduces stock) with their QC_SAMPLE journal (rule 5; toll stock: none, rule 12), and
//                    the request pins the item's APPROVED spec version (SPEC_NOT_APPROVED without one).
//  - enterResults(): insert-only rows, one per spec test; NUMERIC pass is computed from the pinned limits, TEXT pass
//                    is the analyst's complies judgement. A failed result on an FG lot moves the lot UNDER_TEST →
//                    HOLD in the same transaction under qc.result.enter (owner 2026-11-18; QA decides from there).
//  - reviewResults(): qc.result.review, e-signature REVIEWED on the sample; the reviewer is never the analyst who
//                    entered a result (SEGREGATION_OF_DUTIES, service + DB).
// The database (0035, 0036) re-checks every rule.
import { Decimal } from 'decimal.js';
import {
  LotStatus,
  SampleRequestStatus,
  type EnterResultsRequest,
  type Page,
  type ResultDto,
  type ReviewResultsRequest,
  type SampleListQuery,
  type SampleRequestDto,
  type TakeSampleRequest,
} from '@albert/shared';
import { db, withTransaction, type Queryable, type Tx } from '../../db/client';
import { AppError } from '../../core/errors';
import { companyToday } from '../../core/dates';
import { txContext, type AuthContext, type RequestMeta } from '../../core/auth/auth.service';
import { defineTransitions, transition } from '../../core/transition/transition';
import { recordSignature, verifySignature } from '../../core/esign/esign.service';
import { userNames } from '../../core/access/access.service';
import { getLot, LOT_TABLE, lotIdsMatching, lotIdsOfItems, lotsByIds, lotStock, postMovement, type Lot, type PostedMovement } from '../../engines/inventory';
import { postStockJournal } from '../../engines/posting';
import { qcItemIdsMatching, qcItems, qcLocations } from '../masters/qc-refs.service';
import { SAMPLE_REQUEST_TABLE } from './sample-requests.service';
import { approvedSpec, specTestDto } from './specs.service';
import * as specsRepo from './specs.repo';
import * as repo from './sample-requests.repo';

const ENTER_KEY = 'qc.result.enter';
const REVIEW_KEY = 'qc.result.review';
const DECIDE_KEY = 'qc.lot.change_status';

/** OPEN → SAMPLED: the analyst takes the sample. */
export const SamplingMoves = defineTransitions<SampleRequestStatus>({
  entityTable: SAMPLE_REQUEST_TABLE,
  statuses: SampleRequestStatus,
  moves: [
    { from: 'OPEN', to: 'SAMPLED', permission: ENTER_KEY },
    // M4 task 3 (0037): the QC Manager's disposition of the lot closes its request.
    { from: 'SAMPLED', to: 'CLOSED', permission: DECIDE_KEY, reasonRequired: true },
  ],
});

/**
 * The lot moves QC makes with sampling and results (architecture §4): QUARANTINE / RETEST_DUE → UNDER_TEST when the
 * sample is taken; UNDER_TEST → HOLD automatically with a failed result on an FG lot (owner 2026-11-18). QC Manager
 * disposition (UNDER_TEST → APPROVED / REJECTED, material HOLD → REJECTED) is dispositions.service.ts (task 3).
 */
export const QcLotMoves = defineTransitions<LotStatus>({
  entityTable: LOT_TABLE,
  statuses: LotStatus,
  moves: [
    { from: 'QUARANTINE', to: 'UNDER_TEST', permission: ENTER_KEY, reasonRequired: true },
    { from: 'RETEST_DUE', to: 'UNDER_TEST', permission: ENTER_KEY, reasonRequired: true },
    { from: 'UNDER_TEST', to: 'HOLD', permission: ENTER_KEY, reasonRequired: true },
    // M4 task 3 (0037; dispositions.service.ts): QC Manager disposition of a material lot, e-signature on the lot.
    { from: 'UNDER_TEST', to: 'APPROVED', permission: DECIDE_KEY, esign: ['APPROVED'], reasonRequired: true },
    { from: 'UNDER_TEST', to: 'REJECTED', permission: DECIDE_KEY, esign: ['REJECTED'], reasonRequired: true },
    { from: 'HOLD', to: 'REJECTED', permission: DECIDE_KEY, esign: ['REJECTED'], reasonRequired: true },
  ],
});

// ---------------------------------------------------------------- reading

const iso = (d: Date | null) => d?.toISOString() ?? null;

const resultDto = (r: repo.ResultWithReview): ResultDto => ({
  id: r.id,
  specTestId: r.specTestId,
  resultType: r.resultType,
  numericValue: r.numericValue,
  textValue: r.textValue,
  passed: r.passed,
  remarks: r.remarks,
  enteredBy: r.enteredBy,
  enteredAt: r.enteredAt.toISOString(),
  reviewedBy: r.reviewedBy,
  reviewedAt: iso(r.reviewedAt),
});

async function toDtos(q: Queryable, companyId: string, rows: repo.SampleRequestRow[]): Promise<SampleRequestDto[]> {
  const lots = await lotsByIds(q, companyId, rows.map((r) => r.lotId));
  const items = await qcItems(q, companyId, [...lots.values()].map((l) => l.itemId));
  const specs = new Map((await specsRepo.specsByIds(q, companyId, rows.flatMap((r) => (r.specId ? [r.specId] : [])))).map((s) => [s.id, s]));
  const results = await repo.resultsOf(q, rows.map((r) => r.id));
  const people = [...rows.map((r) => r.sampledBy), ...results.flatMap((r) => [r.enteredBy, r.reviewedBy])].filter((x): x is string => x !== null);
  const names = await userNames(q, [...new Set(people)]);
  return rows.map((r) => {
    const lot = lots.get(r.lotId);
    const item = lot ? items.get(lot.itemId) : undefined;
    const mine = results.filter((x) => x.sampleRequestId === r.id);
    const who = [r.sampledBy, ...mine.flatMap((x) => [x.enteredBy, x.reviewedBy])].filter((x): x is string => x !== null);
    return {
      id: r.id,
      status: r.status,
      refDocType: r.refDocType,
      refDocId: r.refDocId,
      requestedAt: r.requestedAt.toISOString(),
      lotId: r.lotId,
      lotNo: lot?.lotNo ?? '',
      lotStatus: lot?.status ?? 'QUARANTINE',
      itemId: lot?.itemId ?? '',
      itemCode: item?.code ?? '',
      itemName: item?.name ?? '',
      itemType: item?.type ?? '',
      expiryDate: lot?.expiryDate ?? null,
      retestDate: lot?.retestDate ?? null,
      specId: r.specId,
      specVersion: r.specId ? (specs.get(r.specId)?.version ?? null) : null,
      sampledBy: r.sampledBy,
      sampledAt: iso(r.sampledAt),
      sampleLocationId: r.sampleLocationId,
      testQty: r.testQty,
      retentionQty: r.retentionQty,
      sampleNotes: r.sampleNotes,
      resultCount: mine.length,
      failedCount: mine.filter((x) => !x.passed).length,
      unreviewedCount: mine.filter((x) => x.reviewedBy === null).length,
      userNames: Object.fromEntries([...new Set(who)].map((u) => [u, names.get(u) ?? u])),
    };
  });
}

export async function listSamples(auth: AuthContext, query: SampleListQuery): Promise<Page<SampleRequestDto>> {
  let lotIds: string[] | undefined;
  if (query.search) {
    // Lot number, or the item's code / name.
    const byLot = await lotIdsMatching(db, auth.companyId, query.search);
    const byItem = await lotIdsOfItems(db, auth.companyId, await qcItemIdsMatching(db, auth.companyId, query.search));
    lotIds = [...new Set([...byLot, ...byItem])];
  }
  const where = repo.requestWhere(auth.companyId, { status: query.status, lotIds, toReview: query.toReview });
  const rows = await repo.listRequests(db, where, { offset: (query.page - 1) * query.pageSize, limit: query.pageSize });
  return { items: await toDtos(db, auth.companyId, rows), total: await repo.countRequests(db, where), page: query.page, pageSize: query.pageSize };
}

export async function getSample(auth: AuthContext, id: string): Promise<SampleRequestDto> {
  const row = await repo.findRequest(db, auth.companyId, id);
  if (!row) throw new AppError('NOT_FOUND', 'Sample request not found');
  const [dto] = await toDtos(db, auth.companyId, [row]);
  // The pinned spec once sampled; while OPEN, the item's current APPROVED spec (if any) so the analyst sees the tests.
  let tests: SampleRequestDto['tests'] = [];
  if (row.specId) {
    tests = (await specsRepo.specTestsOf(db, row.specId)).map(specTestDto);
  } else if (dto!.itemId) {
    try {
      tests = (await approvedSpec(db, auth.companyId, dto!.itemId)).tests;
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'SPEC_NOT_APPROVED')) throw err;
    }
  }
  const stock = row.status === 'OPEN' ? await lotStock(db, auth.companyId, row.lotId) : [];
  const where = await qcLocations(db, auth.companyId, stock.map((s) => s.locationId));
  return {
    ...dto!,
    tests,
    results: (await repo.resultsOf(db, [id])).map(resultDto),
    locations: stock.map((s) => ({ locationId: s.locationId, locationCode: where.get(s.locationId)?.code ?? s.locationId, qty: s.qty })),
  };
}

// ---------------------------------------------------------------- sampling

async function lockRequest(tx: Tx, auth: AuthContext, id: string, status: SampleRequestStatus): Promise<repo.SampleRequestRow> {
  const row = await repo.findRequest(tx, auth.companyId, id, true);
  if (!row) throw new AppError('NOT_FOUND', 'Sample request not found');
  if (row.status !== status) throw new AppError('INVALID_TRANSITION', `Sample request ${id} is ${row.status}, not ${status}`, { status: row.status });
  return row;
}

/**
 * The analyst takes the sample (owner 2026-11-27: sampling reduces stock). Dated today in the company time zone,
 * which must fall in an OPEN period (rule 11).
 */
export async function takeSample(auth: AuthContext, id: string, input: TakeSampleRequest): Promise<SampleRequestDto> {
  await withTransaction(txContext(auth, `take QC sample ${id}`), async (tx) => {
    const req = await lockRequest(tx, auth, id, 'OPEN');
    const lot = await getLot(tx, auth.companyId, req.lotId);
    if (lot.status !== 'QUARANTINE' && lot.status !== 'RETEST_DUE') {
      throw new AppError('INVALID_TRANSITION', `Lot ${lot.lotNo} is ${lot.status}; a sample is taken from a QUARANTINE or RETEST_DUE lot`, { status: lot.status });
    }
    const spec = await approvedSpec(tx, auth.companyId, lot.itemId);
    await transition(tx, QcLotMoves, { entityId: lot.id, to: 'UNDER_TEST', actor: auth, reason: `QC sample taken (sample request ${id})` });
    const date = companyToday();
    const take = (qty: string, reasonCode: 'TEST' | 'RETENTION') =>
      postMovement(tx, auth, { type: 'SAMPLE_ISSUE', lotId: lot.id, locationId: input.locationId, qty, date, reasonCode, refDocType: 'QC_SAMPLE', refDocId: id });
    const movements: PostedMovement[] = [await take(input.testQty, 'TEST')];
    if (input.retentionQty) movements.push(await take(input.retentionQty, 'RETENTION'));
    await postStockJournal(tx, auth, { movements, narration: `QC sample of lot ${lot.lotNo} (sample request ${id})` });
    await transition(tx, SamplingMoves, {
      entityId: id,
      to: 'SAMPLED',
      actor: auth,
      alsoSet: {
        spec_id: spec.id,
        sampled_by: auth.userId,
        sampled_at: new Date().toISOString(),
        sample_location_id: input.locationId,
        test_qty: input.testQty,
        retention_qty: input.retentionQty ?? '0',
        sample_notes: input.notes ?? null,
      },
    });
  });
  return getSample(auth, id);
}

// ---------------------------------------------------------------- results

/** min ≤ value ≤ max (either limit may be absent), on decimal strings (rule 10). */
export function withinLimits(value: string, min: string | null, max: string | null): boolean {
  const v = new Decimal(value);
  return (min === null || v.gte(min)) && (max === null || v.lte(max));
}

/** Results may be entered while the lot is UNDER_TEST, or on HOLD after an FG failure (the remaining tests). */
function assertLotTakesResults(lot: Lot, isFg: boolean): void {
  if (lot.status === 'UNDER_TEST' || (isFg && lot.status === 'HOLD')) return;
  throw new AppError('INVALID_TRANSITION', `Lot ${lot.lotNo} is ${lot.status}; results are entered while it is under test`, { status: lot.status });
}

export async function enterResults(auth: AuthContext, id: string, input: EnterResultsRequest): Promise<SampleRequestDto> {
  await withTransaction(txContext(auth, `enter QC results for sample ${id}`), async (tx) => {
    const req = await lockRequest(tx, auth, id, 'SAMPLED');
    const lot = await getLot(tx, auth.companyId, req.lotId);
    const item = (await qcItems(tx, auth.companyId, [lot.itemId])).get(lot.itemId);
    const isFg = item?.type === 'FG';
    assertLotTakesResults(lot, isFg);
    const tests = new Map((await specsRepo.specTestsOf(tx, req.specId!)).map((t) => [t.id, t]));
    const entered = new Set((await repo.resultsOf(tx, [id])).map((r) => r.specTestId));
    const seen = new Set<string>();
    const rows: repo.NewResult[] = input.results.map((r, i) => {
      const at = { index: i, specTestId: r.specTestId };
      const t = tests.get(r.specTestId);
      if (!t) throw new AppError('VALIDATION_FAILED', `Result ${i + 1}: the test is not in the specification version this sample is tested against`, at);
      if (seen.has(r.specTestId)) throw new AppError('VALIDATION_FAILED', `Result ${i + 1}: ${t.name} is given twice`, at);
      seen.add(r.specTestId);
      if (entered.has(r.specTestId)) {
        throw new AppError('ALREADY_EXISTS', `${t.name} already has a result; a result is never changed (a re-test is a new row)`, at);
      }
      if (t.resultType === 'NUMERIC') {
        if (!r.numericValue) throw new AppError('VALIDATION_FAILED', `${t.name}: enter the numeric result`, at);
        if (r.textValue || (r.complies !== undefined && r.complies !== null)) {
          throw new AppError('VALIDATION_FAILED', `${t.name} is numeric: pass / fail is computed from the limits`, at);
        }
        return {
          sampleRequestId: id,
          specTestId: t.id,
          resultType: 'NUMERIC',
          numericValue: r.numericValue,
          textValue: null,
          passed: withinLimits(r.numericValue, t.minValue, t.maxValue),
          remarks: r.remarks ?? null,
        };
      }
      if (!r.textValue) throw new AppError('VALIDATION_FAILED', `${t.name}: record what was observed`, at);
      if (typeof r.complies !== 'boolean') throw new AppError('VALIDATION_FAILED', `${t.name}: say whether it complies with "${t.textLimit}"`, at);
      if (r.numericValue) throw new AppError('VALIDATION_FAILED', `${t.name} is a text test`, at);
      return { sampleRequestId: id, specTestId: t.id, resultType: 'TEXT', numericValue: null, textValue: r.textValue, passed: r.complies, remarks: r.remarks ?? null };
    });
    await repo.insertResults(tx, rows);
    const failed = rows.filter((r) => !r.passed).map((r) => tests.get(r.specTestId)!.name);
    // Owner 2026-11-18: QC never rejects an FG lot; a failure puts it on HOLD for QA's investigation.
    if (isFg && failed.length > 0 && lot.status === 'UNDER_TEST') {
      await transition(tx, QcLotMoves, { entityId: lot.id, to: 'HOLD', actor: auth, reason: `QC result failed: ${failed.join(', ')} (sample request ${id})`.slice(0, 500) });
    }
  });
  return getSample(auth, id);
}

// ---------------------------------------------------------------- review

function assertNotOwn(auth: AuthContext, rows: { enteredBy: string }[]): void {
  if (rows.some((r) => r.enteredBy === auth.userId)) {
    throw new AppError('SEGREGATION_OF_DUTIES', 'You entered some of these results; another person reviews them', { rule: 'analyst ≠ reviewer' });
  }
}

function pick(rows: repo.ResultRow[], ids: string[] | undefined): repo.ResultRow[] {
  if (!ids) return rows;
  const wanted = new Set(ids);
  const picked = rows.filter((r) => wanted.has(r.id));
  if (picked.length !== wanted.size) throw new AppError('VALIDATION_FAILED', 'Some of these results are not on this sample or are already reviewed');
  return picked;
}

/** QC Manager reviews the sample's results with one REVIEWED e-signature. */
export async function reviewResults(auth: AuthContext, id: string, input: ReviewResultsRequest, meta: RequestMeta): Promise<SampleRequestDto> {
  if (input.signature.meaning !== 'REVIEWED') throw new AppError('VALIDATION_FAILED', 'Reviewing results needs the meaning REVIEWED');
  if (!auth.permissions.has(REVIEW_KEY)) throw new AppError('FORBIDDEN', 'You do not have permission to review QC results', { permission: REVIEW_KEY });
  // Refuse before asking for the password, then again under lock.
  const pre = await withTransaction(txContext(auth), async (tx) => {
    await lockRequest(tx, auth, id, 'SAMPLED');
    return pick(await repo.unreviewedResults(tx, id), input.resultIds);
  });
  if (pre.length === 0) throw new AppError('VALIDATION_FAILED', 'Nothing on this sample is waiting for review');
  assertNotOwn(auth, pre);
  const proof = await verifySignature(auth, input.signature, meta);
  await withTransaction(txContext(auth, `review QC results of sample ${id}: ${input.signature.reason}`), async (tx) => {
    await lockRequest(tx, auth, id, 'SAMPLED');
    const targets = pick(await repo.unreviewedResults(tx, id), input.resultIds);
    if (targets.length === 0) throw new AppError('VALIDATION_FAILED', 'Nothing on this sample is waiting for review');
    assertNotOwn(auth, targets);
    const signature = await recordSignature(tx, proof, { table: SAMPLE_REQUEST_TABLE, id }, ['REVIEWED']);
    await repo.insertReviews(tx, targets.map((r) => ({ resultId: r.id, esignId: signature.id })));
  });
  return getSample(auth, id);
}
