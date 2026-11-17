// Fiscal periods (rule 11; docs/architecture.md §5, §7.1). Monthly, fiscal year July–June.
// Status OPEN ⇄ CLOSED only through core/transition, with a reason. Posting services call
// assertPeriodOpen inside their transaction; posting tables also attach core.require_open_period.
import { FiscalPeriodStatus, fiscalYearStarting, monthlyPeriods, type FiscalPeriodDto } from '@albert/shared';
import { db, withTransaction, type Tx } from '../../db/client';
import { AppError } from '../errors';
import { txContext, type AuthContext } from '../auth/auth.service';
import { defineTransitions, recordInitialStatus, transition } from '../transition/transition';
import * as repo from './settings.repo';

export const FiscalPeriodMoves = defineTransitions<FiscalPeriodStatus>({
  entityTable: 'core.fiscal_periods',
  statuses: FiscalPeriodStatus,
  moves: [
    { from: null, to: 'OPEN', permission: 'core.period.manage' },
    { from: 'OPEN', to: 'CLOSED', permission: 'core.period.close', reasonRequired: true },
    { from: 'CLOSED', to: 'OPEN', permission: 'core.period.close', reasonRequired: true },
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

async function move(auth: AuthContext, id: string, to: FiscalPeriodStatus, reason: string): Promise<FiscalPeriodDto> {
  await withTransaction(txContext(auth, reason), async (tx) => {
    const period = await repo.findPeriod(tx, auth.companyId, id);
    if (!period) throw new AppError('NOT_FOUND', 'Fiscal period not found');
    // M8 adds: closing refuses while DRAFT documents are dated in the period (architecture §7.10).
    await transition(tx, FiscalPeriodMoves, { entityId: id, to, actor: auth, reason });
  });
  const row = await repo.findPeriod(db, auth.companyId, id);
  if (!row) throw new AppError('NOT_FOUND', 'Fiscal period not found');
  return toDto(row);
}

export const closePeriod = (auth: AuthContext, id: string, reason: string) => move(auth, id, 'CLOSED', reason);
export const reopenPeriod = (auth: AuthContext, id: string, reason: string) => move(auth, id, 'OPEN', reason);
