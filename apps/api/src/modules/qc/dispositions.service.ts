// QC lot disposition (architecture §4 lot table, §7.6; build-plan M4 task 3; 0037).
//
// The QC Manager (qc.lot.change_status) decides a material lot with their own e-signature on the lot:
//  - approveLot(): UNDER_TEST → APPROVED. Every test of the pinned spec has a result, every result is reviewed, the
//                  latest result of every test passed, and the lot is not past expiry. Writes the latest assay and
//                  water results onto the lot (4 decimals) and, when given, the next retest date (required when the
//                  retest date is reached). Closes the sample request (SAMPLED → CLOSED).
//  - rejectLot():  UNDER_TEST → REJECTED when every result is reviewed and the latest result of a test failed (closes
//                  the request); HOLD → REJECTED for a material lot QA put on hold. Reason = the signature's reason.
// Never an FG lot (FG_LOT_QA_DECIDES): QC does not approve or reject finished goods; QA decides (build-plan M4). The
// decider entered none of the sample's results (SEGREGATION_OF_DUTIES). The database (0037) re-checks every rule.
import { Decimal } from 'decimal.js';
import type {
  ApproveLotRequest,
  DispositionDto,
  DispositionListQuery,
  DispositionLotDto,
  DispositionTestDto,
  Page,
  RejectLotRequest,
} from '@albert/shared';
import { db, withTransaction, type Queryable, type Tx } from '../../db/client';
import { AppError } from '../../core/errors';
import { companyToday } from '../../core/dates';
import { txContext, type AuthContext, type RequestMeta } from '../../core/auth/auth.service';
import { transition } from '../../core/transition/transition';
import { recordSignature, verifySignature, type SignatureProof } from '../../core/esign/esign.service';
import { userNames } from '../../core/access/access.service';
import {
  getLot,
  LOT_TABLE,
  lockLotForDecision,
  lotIdsByStatus,
  lotIdsMatching,
  lotIdsOfItems,
  lotsByIds,
  recordLotQcValues,
  type Lot,
} from '../../engines/inventory';
import { qcItemIdsMatching, qcItems, type QcItemRef } from '../masters/qc-refs.service';
import { QcLotMoves, SamplingMoves } from './samples.service';
import * as specsRepo from './specs.repo';
import * as samplesRepo from './sample-requests.repo';
import * as repo from './dispositions.repo';

export const DISPOSITION_KEY = 'qc.lot.change_status' as const;

// ---------------------------------------------------------------- assessment

interface Assessment {
  lot: Lot;
  item: QcItemRef | undefined;
  isFg: boolean;
  request: samplesRepo.SampleRequestRow | null;
  specVersion: number | null;
  tests: DispositionTestDto[];
  /** Names of tests without a result / whose latest result failed; analysts of the sample's results. */
  missing: string[];
  failed: string[];
  unreviewed: number;
  analysts: Set<string>;
  /** Latest assay / water results, rounded to the lot's 4 decimals (half away from zero, as the database rounds). */
  assay: string | null;
  water: string | null;
}

const pct4 = (v: string) => new Decimal(v).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);

function limitText(t: specsRepo.SpecTestRow): string {
  if (t.resultType === 'TEXT') return t.textLimit ?? '';
  const unit = t.unit ? ` ${t.unit}` : '';
  const n = (v: string) => new Decimal(v).toString();
  if (t.minValue !== null && t.maxValue !== null) return `${n(t.minValue)} – ${n(t.maxValue)}${unit}`;
  if (t.minValue !== null) return `≥ ${n(t.minValue)}${unit}`;
  if (t.maxValue !== null) return `≤ ${n(t.maxValue)}${unit}`;
  return 'Report';
}

/** The lots' decision state, read in batches (list) or under lock (`lock` locks the requests; the caller locks the lot). */
async function assessLots(q: Queryable, companyId: string, lots: Lot[], lock = false): Promise<Map<string, Assessment>> {
  const items = await qcItems(q, companyId, lots.map((l) => l.itemId));
  const requests = await samplesRepo.byLots(q, companyId, lots.map((l) => l.id), lock);
  // The SAMPLED request a decision would close, else the last closed one (for the record).
  const requestOf = new Map<string, samplesRepo.SampleRequestRow>();
  for (const r of requests) {
    const cur = requestOf.get(r.lotId);
    if (r.status === 'SAMPLED' || (r.status === 'CLOSED' && cur?.status !== 'SAMPLED')) requestOf.set(r.lotId, r);
  }
  const chosen = [...requestOf.values()];
  const results = await samplesRepo.resultsOf(q, chosen.map((r) => r.id));
  const specIds = [...new Set(chosen.flatMap((r) => (r.specId ? [r.specId] : [])))];
  const specs = new Map((await specsRepo.specsByIds(q, companyId, specIds)).map((s) => [s.id, s]));
  const testsOf = new Map(await Promise.all(specIds.map(async (id) => [id, await specsRepo.specTestsOf(q, id)] as const)));

  const out = new Map<string, Assessment>();
  for (const lot of lots) {
    const item = items.get(lot.itemId);
    const request = requestOf.get(lot.id) ?? null;
    const mine = request ? results.filter((r) => r.sampleRequestId === request.id) : [];
    const latest = new Map<string, samplesRepo.ResultWithReview>();
    for (const r of mine) {
      const cur = latest.get(r.specTestId);
      if (!cur || BigInt(r.id) > BigInt(cur.id)) latest.set(r.specTestId, r);
    }
    const specTests = request?.specId ? (testsOf.get(request.specId) ?? []) : [];
    const tests: DispositionTestDto[] = specTests.map((t) => {
      const r = latest.get(t.id);
      return {
        specTestId: t.id,
        name: t.name,
        resultType: t.resultType,
        limit: limitText(t),
        isAssay: t.isAssay,
        isWater: t.isWater,
        resultId: r?.id ?? null,
        value: r ? (r.numericValue ?? r.textValue) : null,
        passed: r ? r.passed : null,
        reviewed: r ? r.reviewedBy !== null : false,
      };
    });
    const valueOf = (flag: 'isAssay' | 'isWater') => {
      const t = specTests.find((x) => x[flag]);
      const v = t ? latest.get(t.id)?.numericValue : null;
      return v ? pct4(v) : null;
    };
    out.set(lot.id, {
      lot,
      item,
      isFg: item?.type === 'FG',
      request,
      specVersion: request?.specId ? (specs.get(request.specId)?.version ?? null) : null,
      tests,
      missing: tests.filter((t) => t.resultId === null).map((t) => t.name),
      failed: tests.filter((t) => t.passed === false).map((t) => t.name),
      unreviewed: mine.filter((r) => r.reviewedBy === null).length,
      analysts: new Set(mine.map((r) => r.enteredBy)),
      assay: valueOf('isAssay'),
      water: valueOf('isWater'),
    });
  }
  return out;
}

type Decision = 'APPROVED' | 'REJECTED';

const reached = (date: string | null, today: string) => date !== null && date <= today;

/**
 * Every refusal of a decision, in the order the user should fix them. Throws the first one. `retestDate` 'PREVIEW'
 * (queue screens) skips the retest-date checks: the approval form asks for the next retest date.
 */
function assertDecision(a: Assessment, decision: Decision, actorId: string, retestDate: string | null | 'PREVIEW', today: string): void {
  const { lot } = a;
  const details = { lotId: lot.id, lotNo: lot.lotNo, status: lot.status };
  if (a.isFg) throw new AppError('FG_LOT_QA_DECIDES', `Lot ${lot.lotNo} is a finished-goods lot: QA decides it, not QC`, details);
  if (decision === 'APPROVED' && lot.status === 'HOLD') {
    throw new AppError('INVALID_TRANSITION', `Lot ${lot.lotNo} is on HOLD: only QA lifts a hold (QC may reject the lot)`, details);
  }
  const allowed = decision === 'APPROVED' ? ['UNDER_TEST'] : ['UNDER_TEST', 'HOLD'];
  if (!allowed.includes(lot.status)) {
    throw new AppError('INVALID_TRANSITION', `Lot ${lot.lotNo} is ${lot.status}; QC ${decision === 'APPROVED' ? 'approves' : 'rejects'} a lot that is ${allowed.join(' or ')}`, details);
  }
  if (lot.status === 'UNDER_TEST') {
    if (a.request?.status !== 'SAMPLED') throw new AppError('INVALID_TRANSITION', `Lot ${lot.lotNo} has no sample waiting for a decision`, details);
    if (a.analysts.has(actorId)) {
      throw new AppError('SEGREGATION_OF_DUTIES', 'You entered results of this sample; another QC Manager decides the lot', { ...details, rule: 'analyst ≠ decider' });
    }
    if (a.unreviewed > 0) throw new AppError('QC_RESULTS_NOT_REVIEWED', `${a.unreviewed} result(s) of this sample are not reviewed yet`, details);
    if (decision === 'REJECTED' && a.failed.length === 0) {
      throw new AppError('QC_RESULTS_PASSED', `No latest result of lot ${lot.lotNo} failed; a lot is rejected on a failed test`, details);
    }
  }
  if (decision === 'REJECTED') return;
  if (a.missing.length > 0) throw new AppError('QC_RESULTS_INCOMPLETE', `No result yet for: ${a.missing.join(', ')}`, { ...details, tests: a.missing });
  if (a.failed.length > 0) throw new AppError('QC_TEST_FAILED', `Failed: ${a.failed.join(', ')}; the lot is not approved`, { ...details, tests: a.failed });
  if (reached(lot.expiryDate, today)) throw new AppError('LOT_EXPIRED', `Lot ${lot.lotNo} expired on ${lot.expiryDate}; it is not approved`, details);
  if (retestDate !== 'PREVIEW') {
    if (retestDate !== null && (retestDate <= today || (lot.expiryDate !== null && retestDate > lot.expiryDate))) {
      throw new AppError('VALIDATION_FAILED', 'The new retest date is after today and not after the expiry date', { ...details, field: 'retestDate' });
    }
    if (reached(retestDate ?? lot.retestDate, today)) {
      throw new AppError('LOT_RETEST_DUE', `Lot ${lot.lotNo} has reached its retest date; give the next retest date`, { ...details, field: 'retestDate' });
    }
  }
  if (a.assay !== null && (new Decimal(a.assay).lte(0) || new Decimal(a.assay).gt('99999.9999'))) {
    throw new AppError('VALIDATION_FAILED', `The assay result ${a.assay} cannot be written onto the lot (above 0 and at most 99999.9999)`, details);
  }
  if (a.water !== null && (new Decimal(a.water).lt(0) || new Decimal(a.water).gte(100))) {
    throw new AppError('VALIDATION_FAILED', `The water result ${a.water} cannot be written onto the lot (0 to below 100)`, details);
  }
}

function blockersOf(a: Assessment, actorId: string, today: string): { canApprove: boolean; canReject: boolean; blockers: string[] } {
  const test = (decision: Decision) => {
    try {
      assertDecision(a, decision, actorId, 'PREVIEW', today);
      return null;
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      return err.message;
    }
  };
  const approve = test('APPROVED');
  const reject = test('REJECTED');
  return { canApprove: approve === null, canReject: reject === null, blockers: [...new Set([approve, reject].filter((x): x is string => x !== null))] };
}

// ---------------------------------------------------------------- reading

function lotDto(a: Assessment, actorId: string, today: string): DispositionLotDto {
  const { lot, item, request } = a;
  return {
    lotId: lot.id,
    lotNo: lot.lotNo,
    lotStatus: lot.status,
    itemId: lot.itemId,
    itemCode: item?.code ?? '',
    itemName: item?.name ?? '',
    itemType: item?.type ?? '',
    expiryDate: lot.expiryDate,
    retestDate: lot.retestDate,
    assayPct: lot.assayPct,
    waterPct: lot.waterPct,
    sampleRequestId: request?.id ?? null,
    sampleStatus: request?.status ?? null,
    specId: request?.specId ?? null,
    specVersion: a.specVersion,
    missingCount: a.missing.length,
    unreviewedCount: a.unreviewed,
    failedCount: a.failed.length,
    ...blockersOf(a, actorId, today),
    retestDateRequired: lot.status === 'UNDER_TEST' && reached(lot.retestDate, today),
  };
}

/** The decision queue: material lots UNDER_TEST (sampled) and material lots on HOLD. FG lots are QA's. */
export async function listDispositionLots(auth: AuthContext, query: DispositionListQuery): Promise<Page<DispositionLotDto>> {
  let ids = await lotIdsByStatus(db, auth.companyId, query.status ? [query.status] : ['UNDER_TEST', 'HOLD'], 2000);
  if (query.search) {
    const hit = new Set([
      ...(await lotIdsMatching(db, auth.companyId, query.search)),
      ...(await lotIdsOfItems(db, auth.companyId, await qcItemIdsMatching(db, auth.companyId, query.search))),
    ]);
    ids = ids.filter((id) => hit.has(id));
  }
  const lots = [...(await lotsByIds(db, auth.companyId, ids)).values()].sort((x, y) => (BigInt(x.id) < BigInt(y.id) ? -1 : 1));
  const items = await qcItems(db, auth.companyId, lots.map((l) => l.itemId));
  const material = lots.filter((l) => items.get(l.itemId)?.type !== 'FG');
  const page = material.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
  const assessed = await assessLots(db, auth.companyId, page);
  const today = companyToday();
  return { items: page.map((l) => lotDto(assessed.get(l.id)!, auth.userId, today)), total: material.length, page: query.page, pageSize: query.pageSize };
}

export async function getDispositionLot(auth: AuthContext, lotId: string): Promise<DispositionLotDto> {
  const lot = await getLot(db, auth.companyId, lotId);
  const a = (await assessLots(db, auth.companyId, [lot])).get(lot.id)!;
  const rows = await repo.dispositionsOfLots(db, auth.companyId, [lot.id]);
  const names = await userNames(db, [...new Set(rows.map((r) => r.decidedBy))]);
  const history: DispositionDto[] = rows.map((r) => ({
    id: r.id,
    fromStatus: r.fromStatus,
    decision: r.decision,
    assayPct: r.assayPct,
    waterPct: r.waterPct,
    retestDate: r.retestDate,
    reason: r.reason,
    decidedBy: r.decidedBy,
    decidedByName: names.get(r.decidedBy) ?? r.decidedBy,
    decidedAt: r.decidedAt.toISOString(),
    sampleRequestId: r.sampleRequestId,
  }));
  return { ...lotDto(a, auth.userId, companyToday()), tests: a.tests, approvalAssayPct: a.assay, approvalWaterPct: a.water, history };
}

// ---------------------------------------------------------------- deciding

async function decide(
  auth: AuthContext,
  lotId: string,
  decision: Decision,
  signature: ApproveLotRequest['signature'],
  retestDate: string | null,
  meta: RequestMeta,
): Promise<DispositionLotDto> {
  if (signature.meaning !== decision) throw new AppError('VALIDATION_FAILED', `This decision is signed with the meaning ${decision}`);
  if (!auth.permissions.has(DISPOSITION_KEY)) {
    throw new AppError('FORBIDDEN', 'You do not have permission to approve or reject lots', { permission: DISPOSITION_KEY });
  }
  const check = async (tx: Tx) => {
    const lot = await lockLotForDecision(tx, auth.companyId, lotId);
    const a = (await assessLots(tx, auth.companyId, [lot], true)).get(lot.id)!;
    assertDecision(a, decision, auth.userId, retestDate, companyToday());
    return a;
  };
  // Refuse before asking for the password, then again under lock.
  await withTransaction(txContext(auth), check);
  const proof: SignatureProof = await verifySignature(auth, signature, meta);
  await withTransaction(txContext(auth, `QC ${decision === 'APPROVED' ? 'approval' : 'rejection'} of lot ${lotId}: ${signature.reason}`), async (tx) => {
    const a = await check(tx);
    const sig = await recordSignature(tx, proof, { table: LOT_TABLE, id: a.lot.id }, [decision]);
    const fromTest = a.lot.status === 'UNDER_TEST';
    const values = decision === 'APPROVED' ? { assayPct: a.assay, waterPct: a.water, retestDate } : { assayPct: null, waterPct: null, retestDate: null };
    await repo.insertDisposition(tx, {
      lotId: a.lot.id,
      sampleRequestId: fromTest ? a.request!.id : null,
      fromStatus: fromTest ? 'UNDER_TEST' : 'HOLD',
      decision,
      ...values,
      reason: sig.reason,
      esignId: sig.id,
    });
    await transition(tx, QcLotMoves, { entityId: a.lot.id, to: decision, actor: auth, signature: sig });
    if (decision === 'APPROVED') await recordLotQcValues(tx, a.lot.id, values);
    if (fromTest) await transition(tx, SamplingMoves, { entityId: a.request!.id, to: 'CLOSED', actor: auth, reason: `Lot ${decision} (${sig.reason})`.slice(0, 500) });
  });
  return getDispositionLot(auth, lotId);
}

export async function approveLot(auth: AuthContext, lotId: string, input: ApproveLotRequest, meta: RequestMeta): Promise<DispositionLotDto> {
  return decide(auth, lotId, 'APPROVED', input.signature, input.retestDate ?? null, meta);
}

export async function rejectLot(auth: AuthContext, lotId: string, input: RejectLotRequest, meta: RequestMeta): Promise<DispositionLotDto> {
  return decide(auth, lotId, 'REJECTED', input.signature, null, meta);
}
