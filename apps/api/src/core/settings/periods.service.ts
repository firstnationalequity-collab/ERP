// Fiscal periods (rule 11; docs/architecture.md §5, §7.1). Monthly, fiscal year July–June.
// Status OPEN ⇄ CLOSED only through core/transition, with a reason; reopening also needs an e-signature,
// and periods close / reopen in order (owner Q2, Q3; 0022). Posting services call
// assertPeriodOpen inside their transaction; posting tables also attach core.require_open_period.
import {
  FiscalPeriodStatus,
  fiscalYearStarting,
  monthlyPeriods,
  type FiscalPeriodDto,
  type PeriodReopenRequest,
} from '@albert/shared';
import { db, withTransaction, type Tx } from '../../db/client';
import { AppError } from '../errors';
import { txContext, type AuthContext, type RequestMeta } from '../auth/auth.service';
import { recordSignature, verifySignature } from '../esign/esign.service';
import { defineTransitions, recordInitialStatus, transition } from '../transition/transition';
import * as repo from './settings.repo';

export const FiscalPeriodMoves = defineTransitions<FiscalPeriodStatus>({
  entityTable: 'core.fiscal_periods',
  statuses: FiscalPeriodStatus,
  moves: [
    { from: null, to: 'OPEN', permission: 'core.period.manage' },
    { from: 'OPEN', to: 'CLOSED', permission: 'core.period.close', reasonRequired: true },
    // Owner Q2 (2026-11-19): Finance Manager e-signature + reason (the signature's reason).
    { from: 'CLOSED', to: 'OPEN', permission: 'core.period.close', esign: ['APPROVED'], reasonRequired: true },
  ],
});

function toDto(row: repo.FiscalPeriodRow): FiscalPeriodDto {
  return {
    id: row.id,
    fiscalYear: row.fiscalYear,
    periodNo: row.periodNo,
    name: row.name,
    startDate: row.startDate,
    endDate: row.endDate,
    status: row.status,
  };
}

/** Rule 11, for posting services: refuse a posting date outside an OPEN period. Use inside the posting tx. */
export async function assertPeriodOpen(tx: Tx, postingDate: string): Promise<void> {
  await repo.assertPeriodOpen(tx, postingDate);
}

export async function listPeriods(auth: AuthContext, fiscalYear?: string): Promise<FiscalPeriodDto[]> {
  return (await repo.listPeriods(db, auth.companyId, fiscalYear)).map(toDto);
}

/** Create the 12 monthly periods of the fiscal year starting 1 July `startYear`, all OPEN. */
export async function createFiscalYear(auth: AuthContext, startYear: number): Promise<FiscalPeriodDto[]> {
  const fy = fiscalYearStarting(startYear);
  await withTransaction(txContext(auth, `create fiscal year ${fy.label}`), async (tx) => {
    for (const p of monthlyPeriods(fy)) {
      const id = await repo.insertPeriod(tx, { fiscalYear: fy.label, ...p });
      await recordInitialStatus(tx, FiscalPeriodMoves, { entityId: id, to: 'OPEN', actor: auth });
    }
  });
  return listPeriods(auth, fy.label);
}

/**
 * Owner Q3 (2026-11-19): the CLOSED periods are always the earliest ones, so only the earliest OPEN period
 * closes and only the latest CLOSED period reopens. Checked here for a clear message; 0022 re-checks it.
 */
async function assertInOrder(tx: Tx, companyId: string, period: repo.FiscalPeriodRow, to: FiscalPeriodStatus): Promise<void> {
  if (period.status === to) return; // core/transition reports the invalid move
  const all = await repo.listPeriods(tx, companyId);
  const blocker =
    to === 'CLOSED'
      ? all.find((p) => p.status === 'OPEN' && p.startDate < period.startDate)
      : [...all].reverse().find((p) => p.status === 'CLOSED' && p.startDate > period.startDate);
  if (blocker) {
    throw new AppError(
      'PERIOD_OUT_OF_ORDER',
      to === 'CLOSED'
        ? `${blocker.name} is still open; periods close in order`
        : `${blocker.name} is closed; reopen the latest closed period first`,
      { blocking: blocker.name },
    );
  }
}

async function periodDto(auth: AuthContext, id: string): Promise<FiscalPeriodDto> {
  const row = await repo.findPeriod(db, auth.companyId, id);
  if (!row) throw new AppError('NOT_FOUND', 'Fiscal period not found');
  return toDto(row);
}

async function loadPeriod(tx: Tx, companyId: string, id: string): Promise<repo.FiscalPeriodRow> {
  const period = await repo.findPeriod(tx, companyId, id);
  if (!period) throw new AppError('NOT_FOUND', 'Fiscal period not found');
  return period;
}

export async function closePeriod(auth: AuthContext, id: string, reason: string): Promise<FiscalPeriodDto> {
  await withTransaction(txContext(auth, reason), async (tx) => {
    const period = await loadPeriod(tx, auth.companyId, id);
    await assertInOrder(tx, auth.companyId, period, 'CLOSED');
    // M8 adds: closing refuses while DRAFT documents are dated in the period (architecture §7.10).
    await transition(tx, FiscalPeriodMoves, { entityId: id, to: 'CLOSED', actor: auth, reason });
  });
  return periodDto(auth, id);
}

/** Owner Q2 (2026-11-19): reopening changes reported figures, so it needs the Finance Manager's e-signature and a reason. */
export async function reopenPeriod(auth: AuthContext, id: string, input: PeriodReopenRequest, meta: RequestMeta): Promise<FiscalPeriodDto> {
  if (input.signature.meaning !== 'APPROVED') throw new AppError('VALIDATION_FAILED', 'Reopening a period needs the meaning APPROVED');
  const proof = await verifySignature(auth, input.signature, meta);
  await withTransaction(txContext(auth, `reopen period: ${input.signature.reason}`), async (tx) => {
    const period = await loadPeriod(tx, auth.companyId, id);
    await assertInOrder(tx, auth.companyId, period, 'OPEN');
    const signature = await recordSignature(tx, proof, { table: FiscalPeriodMoves.entityTable, id }, ['APPROVED']);
    await transition(tx, FiscalPeriodMoves, { entityId: id, to: 'OPEN', actor: auth, signature });
  });
  return periodDto(auth, id);
}
