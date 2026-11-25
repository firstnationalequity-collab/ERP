// QC sample requests — M3 stub (owner 2026-11-25, Q1; decisions.md "QC sample request on GRN"). A request is
// created OPEN with every lot a GRN receives, in the GRN's transaction; M4 builds the sample queue and the
// sampling moves on it. Exported for other modules: they never write qc tables themselves.
import { SampleRequestStatus, type PermissionKey } from '@albert/shared';
import type { Queryable, Tx } from '../../db/client';
import { AppError } from '../../core/errors';
import { defineTransitions, recordInitialStatus, transition, type Actor, type TransitionMap } from '../../core/transition/transition';
import * as repo from './sample-requests.repo';

export const SAMPLE_REQUEST_TABLE = 'qc.sample_requests';

/** Which document creates the request, and under which key (the key that created the lot). */
export const SampleRequestSources = {
  GRN: 'purch.grn.post',
} as const satisfies Record<string, PermissionKey>;
export type SampleRequestSource = keyof typeof SampleRequestSources;

const creationMaps = Object.fromEntries(
  Object.entries(SampleRequestSources).map(([source, key]) => [
    source,
    defineTransitions<SampleRequestStatus>({
      entityTable: SAMPLE_REQUEST_TABLE,
      statuses: SampleRequestStatus,
      moves: [{ from: null, to: 'OPEN', permission: key }],
    }),
  ]),
) as Record<SampleRequestSource, TransitionMap<SampleRequestStatus>>;

export interface SampleRequestRef {
  id: string;
  lotId: string;
  status: SampleRequestStatus;
  requestedAt: string;
}

/**
 * OPEN → CANCELLED when the GRN that raised the request is reversed before any sample was taken (owner 2026-11-25,
 * answer 5; 0028 checks the GRN is REVERSED at commit). M4 adds the sampling moves.
 */
export const SampleRequestCancelMoves = defineTransitions<SampleRequestStatus>({
  entityTable: SAMPLE_REQUEST_TABLE,
  statuses: SampleRequestStatus,
  moves: [{ from: 'OPEN', to: 'CANCELLED', permission: 'purch.grn.reverse', reasonRequired: true }],
});

const toRef = (r: repo.SampleRequestRow): SampleRequestRef => ({ id: r.id, lotId: r.lotId, status: r.status, requestedAt: r.requestedAt.toISOString() });

/** Inside the caller's transaction: an OPEN sample request for a lot just received. */
export async function requestSample(tx: Tx, actor: Actor, input: { lotId: string; source: SampleRequestSource; refDocId: string }): Promise<SampleRequestRef> {
  const row = await repo.insertSampleRequest(tx, { lotId: input.lotId, refDocType: input.source, refDocId: input.refDocId });
  await recordInitialStatus(tx, creationMaps[input.source], { entityId: row.id, to: 'OPEN', actor });
  return toRef(row);
}

/**
 * Inside the caller's transaction: cancel the OPEN requests a GRN raised for these lots. Refuses with
 * GRN_LOTS_IN_USE when a request has moved past OPEN (sampling started). Returns how many were cancelled.
 */
export async function cancelGrnSampleRequests(tx: Tx, actor: Actor, input: { grnId: string; lotIds: string[]; reason: string }): Promise<number> {
  const rows = (await repo.byLots(tx, actor.companyId, input.lotIds, true)).filter((r) => r.refDocType === 'GRN' && r.refDocId === input.grnId);
  for (const r of rows) {
    if (r.status !== 'OPEN') {
      throw new AppError('GRN_LOTS_IN_USE', `Sample request ${r.id} is ${r.status}: sampling has started; reject the lot through QC and return it to the vendor`, {
        sampleRequestId: r.id,
        status: r.status,
      });
    }
  }
  for (const r of rows) await transition(tx, SampleRequestCancelMoves, { entityId: r.id, to: 'CANCELLED', actor, reason: input.reason });
  return rows.length;
}

/** For other modules' screens: the sample requests of these lots. */
export async function sampleRequestsOfLots(q: Queryable, companyId: string, lotIds: string[]): Promise<SampleRequestRef[]> {
  return (await repo.byLots(q, companyId, lotIds)).map(toRef);
}
