// Landed cost (M3 task 4; 0029). Owner Q21 (2026-11-19, architecture §6 "Landed cost"), Q2/Q3 (2026-11-25).
//
// Charge types (fin.master.manage): a capitalise flag; capitalised types go into the lot cost (by a basis), the
// others name their tax role (INPUT_TAX: import-stage sales tax; ADVANCE_TAX: income tax at import).
//
// A charge (purch.landed_cost.manage) is entered on one GRN, in PKR:
//   - on a DRAFT GRN (with_grn): posted by the GRN posting (purch.grn.post, owner Q2), in the same transaction, on
//     the GRN date. Capitalised: a LANDED_COST value adjustment on each lot right after its receipt, so the lot
//     is received at its full cost; journal Dr Inventory / Cr Landed-cost clearing.
//   - on a POSTED GRN: a later bill, posted on its charge date (open period, rule 11) by POST /:id/post.
//     Capitalised: per GRN line, the share for the quantity the lot still holds goes into the lot (value-only
//     adjustment, reason LANDED_COST); the consumed share goes to price variance; a fully consumed lot gets no row.
//   - not capitalised: IMPORT_TAX journal Dr Input tax / Advance tax, Cr Landed-cost clearing; no lot changes.
// Allocation (owner Q21): VALUE (qty × PO price), WEIGHT (kg per PO line) or GD_AMOUNTS (duties: the GD amount per
// PO line); one PO line received on several GRN lines is split by quantity. Cent rounding: largest remainder.
// Clearing is settled by the CHARGES vendor invoice (owner Q3, task 5). A posted charge never changes.
import { Decimal } from 'decimal.js';
import {
  LandedCostStatus,
  type CreateLandedCostRequest,
  type CreateLandedCostTypeRequest,
  type LandedCostBasis,
  type LandedCostDto,
  type LandedCostListQuery,
  type LandedCostTypeDto,
  type Page,
  type PermissionKey,
  type UpdateLandedCostRequest,
  type UpdateLandedCostTypeRequest,
} from '@albert/shared';
import { db, withTransaction, type Queryable, type Tx } from '../../db/client';
import { AppError } from '../../core/errors';
import { companyToday } from '../../core/dates';
import { txContext, type AuthContext } from '../../core/auth/auth.service';
import { defineTransitions, recordInitialStatus, transition, type Actor, type TransitionMap } from '../../core/transition/transition';
import { nextDocNo } from '../../core/settings/numbering.service';
import { lockLotHolding, lotsByIds, postValueAdjustment, type PostedMovement } from '../../engines/inventory';
import { journalsOfSource, postJournal, postStockJournal, type JournalLineInput } from '../../engines/posting';
import { assertPurchVendor, purchItems, purchVendors } from '../masters/purch-refs.service';
import * as grnRepo from './grns.repo';
import * as repo from './landed-costs.repo';
import { poLinesOf, userNames } from './procurement.repo';

export const LANDED_COST_TABLE = 'purch.landed_costs';
export const LANDED_COST_DOC_TYPE = 'LANDED_COST'; // number series, ledger ref_doc_type, journal source_type
const MANAGE_KEY: PermissionKey = 'purch.landed_cost.manage';

const maps = new Map<PermissionKey, TransitionMap<LandedCostStatus>>();
/**
 * One map per key, so each move names exactly one key (rule 7): purch.landed_cost.manage enters, posts later bills
 * and cancels; purch.grn.post posts (and cancels) the charges entered with a GRN when it posts (or cancels) that GRN
 * (owner Q2); purch.grn.reverse cancels the DRAFT later bills of a GRN it reverses.
 */
export function landedCostMoves(key: PermissionKey): TransitionMap<LandedCostStatus> {
  let map = maps.get(key);
  if (!map) {
    map = defineTransitions<LandedCostStatus>({
      entityTable: LANDED_COST_TABLE,
      statuses: LandedCostStatus,
      moves: [
        ...(key === MANAGE_KEY ? [{ from: null, to: 'DRAFT' as const, permission: key }] : []),
        ...(key === 'purch.grn.reverse' ? [] : [{ from: 'DRAFT' as const, to: 'POSTED' as const, permission: key }]),
        { from: 'DRAFT', to: 'CANCELLED', permission: key, reasonRequired: true },
      ],
    });
    maps.set(key, map);
  }
  return map;
}

// ---------------------------------------------------------------- allocation (pure)

export interface AllocLine {
  id: string;
  poLineId: string;
  qty: string;
  unitPrice: string;
}
export interface AllocInput {
  poLineId: string;
  gdAmount: string | null;
  weightKg: string | null;
}

/** Splits `total` (2 decimals) by the weights, exactly, to the paisa: largest remainder, ties to the earlier one. */
export function splitByWeights(total: Decimal, weights: readonly Decimal[]): Decimal[] {
  const sum = weights.reduce((s, w) => s.plus(w), new Decimal(0));
  if (weights.length === 0 || sum.lte(0)) throw new AppError('VALIDATION_FAILED', 'Nothing to allocate the charge to (all weights are zero)');
  const cents = total.times(100);
  const raw = weights.map((w) => cents.times(w).div(sum));
  const floors = raw.map((r) => r.floor());
  let left = cents.minus(floors.reduce((s, f) => s.plus(f), new Decimal(0))).toNumber();
  const order = raw.map((r, i) => ({ i, frac: r.minus(floors[i]!) })).sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = floors[i]!.plus(1);
    left -= 1;
  }
  return floors.map((f) => f.div(100));
}

/**
 * The charge per GRN line (owner Q21). VALUE: by qty × PO price. WEIGHT / GD_AMOUNTS: first per PO line (weight
 * share / the GD amount itself), then over that PO line's GRN lines by quantity.
 */
export function allocateCharge(amount: string, basis: LandedCostBasis, lines: readonly AllocLine[], inputs: readonly AllocInput[]): Map<string, Decimal> {
  const total = new Decimal(amount);
  const out = new Map<string, Decimal>();
  if (basis === 'VALUE') {
    const shares = splitByWeights(total, lines.map((l) => new Decimal(l.qty).times(l.unitPrice)));
    lines.forEach((l, i) => out.set(l.id, shares[i]!));
    return out;
  }
  const poLines = [...new Set(lines.map((l) => l.poLineId))];
  for (const input of inputs) {
    if (!poLines.includes(input.poLineId)) {
      throw new AppError('VALIDATION_FAILED', 'The charge names a PO line this GRN does not receive', { poLineId: input.poLineId });
    }
  }
  const of = (poLineId: string) => inputs.find((i) => i.poLineId === poLineId);
  let perPoLine: Decimal[];
  if (basis === 'WEIGHT') {
    perPoLine = splitByWeights(total, poLines.map((p) => new Decimal(of(p)?.weightKg ?? 0)));
  } else {
    perPoLine = poLines.map((p) => new Decimal(of(p)?.gdAmount ?? 0));
    const sum = perPoLine.reduce((s, a) => s.plus(a), new Decimal(0));
    if (!sum.equals(total)) {
      throw new AppError('VALIDATION_FAILED', `The GD amounts add up to ${sum.toFixed(2)}, the charge is ${total.toFixed(2)}`, { field: 'inputs' });
    }
  }
  poLines.forEach((p, i) => {
    const mine = lines.filter((l) => l.poLineId === p);
    const share = perPoLine[i]!;
    if (share.isZero()) {
      for (const l of mine) out.set(l.id, new Decimal(0));
      return;
    }
    const split = splitByWeights(share, mine.map((l) => new Decimal(l.qty)));
    mine.forEach((l, j) => out.set(l.id, split[j]!));
  });
  return out;
}

// ---------------------------------------------------------------- charge types

function typeDto(t: repo.LandedCostTypeRow): LandedCostTypeDto {
  return {
    id: t.id,
    code: t.code,
    name: t.name,
    capitalise: t.capitalise,
    taxRole: t.taxRole,
    isDuty: t.isDuty,
    defaultBasis: t.defaultBasis,
    isActive: t.isActive,
  };
}

export async function listLandedCostTypes(auth: AuthContext, activeOnly: boolean): Promise<LandedCostTypeDto[]> {
  return (await repo.listTypes(db, auth.companyId, activeOnly)).map(typeDto);
}

export async function createLandedCostType(auth: AuthContext, input: CreateLandedCostTypeRequest): Promise<LandedCostTypeDto> {
  const id = await withTransaction(txContext(auth, `charge type ${input.code}`), async (tx) => {
    if (await repo.typeCodeTaken(tx, auth.companyId, input.code)) {
      throw new AppError('ALREADY_EXISTS', `Charge type ${input.code} already exists`, { field: 'code' });
    }
    return repo.insertType(tx, {
      code: input.code,
      name: input.name,
      capitalise: input.capitalise,
      taxRole: input.capitalise ? null : (input.taxRole ?? null),
      isDuty: input.capitalise ? input.isDuty : false,
      defaultBasis: input.capitalise ? (input.defaultBasis ?? 'VALUE') : null,
    });
  });
  return typeDto((await repo.findType(db, auth.companyId, id))!);
}

function assertBasisFits(t: repo.LandedCostTypeRow, basis: LandedCostBasis, field: string): void {
  if (basis === 'GD_AMOUNTS' && !t.isDuty) throw new AppError('VALIDATION_FAILED', `${t.code} is not a duty; only duties use GD amounts`, { field });
  if (basis === 'WEIGHT' && t.isDuty) throw new AppError('VALIDATION_FAILED', `${t.code} is a duty: by GD amounts or by value`, { field });
}

export async function updateLandedCostType(auth: AuthContext, id: string, input: UpdateLandedCostTypeRequest): Promise<LandedCostTypeDto> {
  await withTransaction(txContext(auth, 'edit charge type'), async (tx) => {
    const t = await repo.findType(tx, auth.companyId, id, true);
    if (!t) throw new AppError('NOT_FOUND', 'Charge type not found');
    if (input.defaultBasis !== undefined) {
      if (!t.capitalise) throw new AppError('VALIDATION_FAILED', `${t.code} is a tax and is not allocated`, { field: 'defaultBasis' });
      assertBasisFits(t, input.defaultBasis, 'defaultBasis');
    }
    await repo.updateType(tx, id, { ...(input.name ? { name: input.name } : {}), ...(input.defaultBasis ? { defaultBasis: input.defaultBasis } : {}) });
  });
  return typeDto((await repo.findType(db, auth.companyId, id))!);
}

export async function setLandedCostTypeActive(auth: AuthContext, id: string, active: boolean, reason?: string): Promise<LandedCostTypeDto> {
  await withTransaction(txContext(auth, `charge type: ${reason ?? (active ? 'activate' : 'deactivate')}`), async (tx) => {
    const t = await repo.findType(tx, auth.companyId, id, true);
    if (!t) throw new AppError('NOT_FOUND', 'Charge type not found');
    if (t.isActive === active) throw new AppError('INVALID_TRANSITION', `Charge type ${t.code} is already ${active ? 'active' : 'inactive'}`);
    await repo.updateType(tx, id, { isActive: active });
  });
  return typeDto((await repo.findType(db, auth.companyId, id))!);
}

// ---------------------------------------------------------------- reading

async function toDtos(q: Queryable, companyId: string, rows: repo.LandedCostRow[]): Promise<LandedCostDto[]> {
  const ids = rows.map((r) => r.id);
  const grnRows = await Promise.all([...new Set(rows.map((r) => r.grnId))].map((g) => grnRepo.findGrn(q, companyId, g)));
  const grnById = new Map(grnRows.flatMap((g) => (g ? [[g.id, g] as const] : [])));
  const [types, inputs, allocs, vendors, names] = await Promise.all([
    repo.typesByIds(q, companyId, rows.map((r) => r.chargeTypeId)),
    repo.inputsOf(q, ids),
    repo.allocationsOf(q, ids),
    purchVendors(q, companyId, rows.flatMap((r) => (r.vendorId ? [r.vendorId] : []))),
    userNames(q, rows.flatMap((r) => (r.postedBy ? [r.createdBy, r.postedBy] : [r.createdBy]))),
  ]);
  const [poLines, grnLines, lots] = await Promise.all([
    poLinesOf(q, [...new Set([...grnById.values()].map((g) => g.poId))]),
    grnRepo.grnLinesOf(q, [...grnById.keys()]),
    lotsByIds(q, companyId, allocs.map((a) => a.lotId)),
  ]);
  const items = await purchItems(q, companyId, poLines.map((l) => l.itemId));
  const journals = new Map(
    await Promise.all(
      rows.filter((r) => r.status === 'POSTED').map(async (r) => [r.id, await journalsOfSource(q, companyId, LANDED_COST_DOC_TYPE, r.id)] as const),
    ),
  );
  return rows.map((r) => {
    const t = types.get(r.chargeTypeId);
    const g = grnById.get(r.grnId);
    return {
      id: r.id,
      docNo: r.docNo,
      grnId: r.grnId,
      grnDocNo: g?.docNo ?? '',
      grnStatus: g?.status ?? '',
      chargeTypeId: r.chargeTypeId,
      chargeTypeCode: t?.code ?? '',
      chargeTypeName: t?.name ?? '',
      capitalise: t?.capitalise ?? false,
      chargeDate: r.chargeDate,
      amount: r.amount,
      basis: r.basis,
      vendorId: r.vendorId,
      vendorName: r.vendorId ? (vendors.get(r.vendorId)?.name ?? '') : null,
      reference: r.reference,
      notes: r.notes,
      withGrn: r.withGrn,
      status: r.status,
      postingDate: r.postingDate,
      postedByName: r.postedBy ? (names.get(r.postedBy) ?? '') : null,
      postedAt: r.postedAt ? r.postedAt.toISOString() : null,
      journalDocNo: journals.get(r.id)?.[0]?.docNo ?? null,
      createdByName: names.get(r.createdBy) ?? '',
      createdAt: r.createdAt.toISOString(),
      inputs: inputs
        .filter((i) => i.landedCostId === r.id)
        .map((i) => {
          const pl = poLines.find((p) => p.id === i.poLineId);
          return {
            poLineId: i.poLineId,
            poLineNo: pl?.lineNo ?? 0,
            itemCode: pl ? (items.get(pl.itemId)?.code ?? '') : '',
            gdAmount: i.gdAmount,
            weightKg: i.weightKg,
          };
        }),
      allocations: allocs
        .filter((a) => a.landedCostId === r.id)
        .map((a) => {
          const gl = grnLines.find((l) => l.id === a.grnLineId);
          return {
            grnLineId: a.grnLineId,
            lineNo: gl?.lineNo ?? 0,
            itemCode: gl ? (items.get(gl.itemId)?.code ?? '') : '',
            lotId: a.lotId,
            lotNo: lots.get(a.lotId)?.lotNo ?? '',
            amount: a.amount,
            heldQty: a.heldQty,
            heldAmount: a.heldAmount,
            varianceAmount: a.varianceAmount,
          };
        }),
    };
  });
}

export async function listLandedCosts(auth: AuthContext, query: LandedCostListQuery): Promise<Page<LandedCostDto>> {
  const { rows, total } = await repo.listCharges(
    db,
    auth.companyId,
    { status: query.status, search: query.search, grnId: query.grnId },
    { limit: query.pageSize, offset: (query.page - 1) * query.pageSize },
  );
  return { items: await toDtos(db, auth.companyId, rows), total, page: query.page, pageSize: query.pageSize };
}

export async function getLandedCost(auth: AuthContext, id: string): Promise<LandedCostDto> {
  const row = await repo.findCharge(db, auth.companyId, id);
  if (!row) throw new AppError('NOT_FOUND', 'Landed cost not found');
  const [dto] = await toDtos(db, auth.companyId, [row]);
  return dto!;
}

/** For the GRN screen: the charges on these GRNs (all statuses). */
export async function landedCostsOfGrns(q: Queryable, companyId: string, grnIds: string[]): Promise<LandedCostDto[]> {
  return toDtos(q, companyId, await repo.chargesOfGrns(q, grnIds));
}

// ---------------------------------------------------------------- writing

type ChargeFields = UpdateLandedCostRequest;

/** Checks the charge against its GRN and type as they are now; the values and inputs to write. */
async function prepare(
  q: Queryable,
  auth: AuthContext,
  grn: grnRepo.GrnRow,
  input: ChargeFields,
): Promise<{ values: repo.LandedCostValues; inputs: repo.LandedCostInputValues[]; type: repo.LandedCostTypeRow }> {
  if (grn.status !== 'DRAFT' && grn.status !== 'POSTED') {
    throw new AppError('INVALID_TRANSITION', `GRN ${grn.docNo} is ${grn.status}; charges go on a DRAFT or POSTED GRN`, { status: grn.status });
  }
  const type = await repo.findType(q, auth.companyId, input.chargeTypeId);
  if (!type) throw new AppError('VALIDATION_FAILED', 'Charge type does not exist', { field: 'chargeTypeId' });
  if (!type.isActive) throw new AppError('VALIDATION_FAILED', `Charge type ${type.code} is not active`, { field: 'chargeTypeId' });
  if (input.chargeDate > companyToday()) throw new AppError('VALIDATION_FAILED', 'The charge date cannot be in the future', { field: 'chargeDate' });
  if (grn.status === 'POSTED' && input.chargeDate < grn.grnDate) {
    throw new AppError('VALIDATION_FAILED', `A later bill is dated on or after the GRN date (${grn.grnDate.split('-').reverse().join('-')})`, {
      field: 'chargeDate',
    });
  }
  if (input.vendorId) await assertPurchVendor(q, auth.companyId, input.vendorId);

  let basis: LandedCostBasis | null = null;
  if (type.capitalise) {
    basis = input.basis ?? type.defaultBasis ?? 'VALUE';
    assertBasisFits(type, basis, 'basis');
  } else if (input.basis) {
    throw new AppError('VALIDATION_FAILED', `${type.code} is a tax: it is not allocated to lots`, { field: 'basis' });
  }

  const poLineIds = new Set((await poLinesOf(q, [grn.poId])).map((l) => l.id));
  const seen = new Set<string>();
  const inputs: repo.LandedCostInputValues[] = [];
  for (const i of input.inputs) {
    if (!poLineIds.has(i.poLineId)) throw new AppError('VALIDATION_FAILED', 'An input names a line of another PO', { field: 'inputs', poLineId: i.poLineId });
    if (seen.has(i.poLineId)) throw new AppError('VALIDATION_FAILED', 'One input per PO line', { field: 'inputs', poLineId: i.poLineId });
    seen.add(i.poLineId);
    if (basis === 'GD_AMOUNTS') {
      if (!i.gdAmount || i.weightKg) throw new AppError('VALIDATION_FAILED', 'Give the GD amount of each PO line', { field: 'inputs' });
      inputs.push({ poLineId: i.poLineId, gdAmount: new Decimal(i.gdAmount).toFixed(2), weightKg: null });
    } else if (basis === 'WEIGHT') {
      if (!i.weightKg || i.gdAmount) throw new AppError('VALIDATION_FAILED', 'Give the weight (kg) of each PO line', { field: 'inputs' });
      inputs.push({ poLineId: i.poLineId, gdAmount: null, weightKg: new Decimal(i.weightKg).toFixed(4) });
    } else {
      throw new AppError('VALIDATION_FAILED', `Basis ${basis ?? 'none'} takes no inputs per PO line`, { field: 'inputs' });
    }
  }
  if (basis === 'GD_AMOUNTS') {
    const sum = inputs.reduce((s, i) => s.plus(i.gdAmount ?? 0), new Decimal(0));
    if (!sum.equals(input.amount)) {
      throw new AppError('VALIDATION_FAILED', `The GD amounts add up to ${sum.toFixed(2)}, the charge is ${new Decimal(input.amount).toFixed(2)}`, {
        field: 'inputs',
      });
    }
  }
  if (basis === 'WEIGHT' && !inputs.some((i) => new Decimal(i.weightKg ?? 0).gt(0))) {
    throw new AppError('VALIDATION_FAILED', 'Give the weight of at least one PO line', { field: 'inputs' });
  }
  return {
    type,
    inputs,
    values: {
      chargeTypeId: type.id,
      chargeDate: input.chargeDate,
      amount: new Decimal(input.amount).toFixed(2),
      basis,
      vendorId: input.vendorId ?? null,
      reference: input.reference?.trim() || null,
      notes: input.notes?.trim() || null,
    },
  };
}

async function grnOrFail(q: Queryable, companyId: string, grnId: string, lock = false): Promise<grnRepo.GrnRow> {
  const grn = await grnRepo.findGrn(q, companyId, grnId, lock);
  if (!grn) throw new AppError('NOT_FOUND', 'GRN not found');
  return grn;
}

export async function createLandedCost(auth: AuthContext, input: CreateLandedCostRequest): Promise<LandedCostDto> {
  const { grnId, ...fields } = input;
  const id = await withTransaction(txContext(auth, 'enter landed cost'), async (tx) => {
    // Share-lock the GRN: it must not be posted or cancelled while a charge is added to it.
    const grn = await grnOrFail(tx, auth.companyId, grnId, true);
    const { values, inputs } = await prepare(tx, auth, grn, fields);
    const docNo = await nextDocNo(tx, LANDED_COST_DOC_TYPE, values.chargeDate);
    const chargeId = await repo.insertCharge(tx, { ...values, docNo, grnId: grn.id, withGrn: grn.status === 'DRAFT' });
    await recordInitialStatus(tx, landedCostMoves(MANAGE_KEY), { entityId: chargeId, to: 'DRAFT', actor: auth });
    await repo.replaceInputs(tx, chargeId, inputs);
    return chargeId;
  });
  return getLandedCost(auth, id);
}

async function lockDraft(tx: Tx, auth: AuthContext, id: string): Promise<repo.LandedCostRow> {
  const row = await repo.findCharge(tx, auth.companyId, id, true);
  if (!row) throw new AppError('NOT_FOUND', 'Landed cost not found');
  if (row.status !== 'DRAFT') throw new AppError('RECORD_LOCKED', `Landed cost ${row.docNo} is ${row.status} and can no longer change`, { status: row.status });
  return row;
}

export async function updateLandedCost(auth: AuthContext, id: string, input: UpdateLandedCostRequest): Promise<LandedCostDto> {
  await withTransaction(txContext(auth, 'edit landed cost'), async (tx) => {
    const row = await lockDraft(tx, auth, id);
    const grn = await grnOrFail(tx, auth.companyId, row.grnId, true);
    if (row.withGrn && grn.status !== 'DRAFT') {
      throw new AppError('RECORD_LOCKED', `GRN ${grn.docNo} is ${grn.status}; its charges were settled with it`, { status: grn.status });
    }
    const { values, inputs } = await prepare(tx, auth, grn, input);
    await repo.updateCharge(tx, id, values);
    await repo.replaceInputs(tx, id, inputs);
  });
  return getLandedCost(auth, id);
}

export async function cancelLandedCost(auth: AuthContext, id: string, reason: string): Promise<LandedCostDto> {
  await withTransaction(txContext(auth, `cancel landed cost: ${reason}`), async (tx) => {
    const row = await repo.findCharge(tx, auth.companyId, id, true);
    if (!row) throw new AppError('NOT_FOUND', 'Landed cost not found');
    if (row.status !== 'DRAFT') {
      throw new AppError('INVALID_TRANSITION', `Landed cost ${row.docNo} is ${row.status}; only a DRAFT is cancelled`, { status: row.status });
    }
    await transition(tx, landedCostMoves(MANAGE_KEY), { entityId: id, to: 'CANCELLED', actor: auth, reason });
  });
  return getLandedCost(auth, id);
}

/** A later bill (charge on a POSTED GRN), on its charge date. */
export async function postLandedCost(auth: AuthContext, id: string): Promise<LandedCostDto> {
  await withTransaction(txContext(auth, 'post landed cost'), async (tx) => {
    const row = await lockDraft(tx, auth, id);
    const grn = await grnOrFail(tx, auth.companyId, row.grnId, true);
    if (row.withGrn || grn.status !== 'POSTED') {
      throw new AppError('INVALID_TRANSITION', `GRN ${grn.docNo} is ${grn.status}; ${row.withGrn ? 'this charge is posted with the GRN' : 'a later bill posts on a POSTED GRN'}`, {
        status: grn.status,
      });
    }
    await postCharge(tx, auth, MANAGE_KEY, row, grn, row.chargeDate);
  });
  return getLandedCost(auth, id);
}

// ---------------------------------------------------------------- for the GRN service, inside its transaction

/** GRN posting (owner Q2): every DRAFT charge entered with the GRN posts with it, on the GRN date, under purch.grn.post. */
export async function postChargesWithGrn(tx: Tx, actor: Actor, grnId: string): Promise<void> {
  const grn = await grnOrFail(tx, actor.companyId, grnId);
  for (const row of await repo.chargesOfGrns(tx, [grnId], true)) {
    if (row.status !== 'DRAFT' || !row.withGrn) continue;
    await postCharge(tx, actor, 'purch.grn.post', row, grn, grn.grnDate);
  }
}

/** A cancelled or reversed GRN takes its DRAFT charges with it (cancelled under the GRN action's key). */
export async function cancelChargesOfGrn(tx: Tx, actor: Actor, grnId: string, key: 'purch.grn.post' | 'purch.grn.reverse', reason: string): Promise<void> {
  for (const row of await repo.chargesOfGrns(tx, [grnId], true)) {
    if (row.status !== 'DRAFT') continue;
    await transition(tx, landedCostMoves(key), { entityId: row.id, to: 'CANCELLED', actor, reason });
  }
}

/** GRN reversal: refused while a charge is POSTED (its value adjustment is never reversed; 0017, 0029). */
export async function assertNoPostedCharges(q: Queryable, grn: { id: string; docNo: string }): Promise<void> {
  const posted = (await repo.chargesOfGrns(q, [grn.id])).filter((c) => c.status === 'POSTED');
  if (posted.length > 0) {
    throw new AppError('GRN_HAS_LANDED_COST', `GRN ${grn.docNo} has posted landed costs (${posted.map((c) => c.docNo).join(', ')}) and cannot be reversed`, {
      landedCosts: posted.map((c) => ({ id: c.id, docNo: c.docNo })),
    });
  }
}

// ---------------------------------------------------------------- posting

async function postCharge(tx: Tx, actor: Actor, key: PermissionKey, row: repo.LandedCostRow, grn: grnRepo.GrnRow, date: string): Promise<void> {
  const type = await repo.findType(tx, actor.companyId, row.chargeTypeId);
  if (!type) throw new AppError('NOT_FOUND', 'Charge type not found');
  if (!type.isActive) throw new AppError('VALIDATION_FAILED', `Charge type ${type.code} is not active`);
  if (row.vendorId) await assertPurchVendor(tx, actor.companyId, row.vendorId);
  const vendor = row.vendorId ? { vendorId: row.vendorId } : {};
  const narration = `${type.name} ${row.docNo} on GRN ${grn.docNo}${row.reference ? ` (${row.reference})` : ''}`;
  const source = { sourceType: LANDED_COST_DOC_TYPE, sourceId: row.id };

  if (!type.capitalise) {
    // Owner Q21: import-stage sales tax → input tax; income tax at import → advance tax. Not cost.
    await postJournal(tx, actor, {
      event: 'IMPORT_TAX',
      key,
      ...source,
      date,
      narration,
      lines: [
        { role: type.taxRole!, debit: row.amount },
        { role: 'LANDED_COST_CLEARING', credit: row.amount, ...vendor },
      ],
    });
  } else {
    const lines = (await grnRepo.grnLinesOf(tx, [grn.id])).sort((a, b) => (BigInt(a.lotId!) < BigInt(b.lotId!) ? -1 : 1));
    const inputs = await repo.inputsOf(tx, [row.id]);
    const shares = allocateCharge(row.amount, row.basis ?? 'VALUE', lines, inputs);
    const movements: PostedMovement[] = [];
    const allocations: repo.LandedCostAllocationValues[] = [];
    const variance = new Map<string, Decimal>(); // by item category
    for (const l of lines) {
      const amount = shares.get(l.id) ?? new Decimal(0);
      if (amount.isZero()) continue;
      const holding = await lockLotHolding(tx, actor, l.lotId!);
      const heldQty = Decimal.min(Decimal.max(new Decimal(holding.qty), 0), l.qty);
      const held = amount.times(heldQty).div(l.qty).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      const consumed = amount.minus(held);
      if (row.withGrn && !consumed.isZero()) {
        throw new AppError('VALIDATION_FAILED', `Lot ${holding.lotNo} no longer holds its receipt; the charge cannot be posted with the GRN`);
      }
      const movement = held.gt(0)
        ? await postValueAdjustment(tx, actor, { lotId: l.lotId!, value: held.toFixed(2), reason: 'LANDED_COST', date, refDocType: LANDED_COST_DOC_TYPE, refDocId: row.id })
        : null;
      if (movement) movements.push(movement);
      if (consumed.gt(0)) variance.set(holding.itemCategoryId, (variance.get(holding.itemCategoryId) ?? new Decimal(0)).plus(consumed));
      allocations.push({
        landedCostId: row.id,
        grnLineId: l.id,
        lotId: l.lotId!,
        amount: amount.toFixed(2),
        heldQty: heldQty.toFixed(4),
        heldAmount: held.toFixed(2),
        varianceAmount: consumed.toFixed(2),
        movementId: movement?.id ?? null,
      });
    }
    await repo.insertAllocations(tx, allocations);
    // Owner Q21: the consumed share (all of it for a fully consumed lot) → price variance (placeholder account).
    const otherLines: JournalLineInput[] = [...variance.entries()].flatMap(([itemCategoryId, v]) => [
      { role: 'PRICE_VARIANCE' as const, itemCategoryId, debit: v.toFixed(2), narration: 'Share already consumed' },
      { role: 'LANDED_COST_CLEARING' as const, itemCategoryId, credit: v.toFixed(2), ...vendor },
    ]);
    if (movements.length > 0) {
      await postStockJournal(tx, actor, { movements, narration, dimensions: vendor, otherLines, key });
    } else {
      await postJournal(tx, actor, { event: 'LANDED_COST', key, ...source, date, narration, lines: otherLines });
    }
  }
  await transition(tx, landedCostMoves(key), {
    entityId: row.id,
    to: 'POSTED',
    actor,
    alsoSet: { posting_date: date, posted_by: actor.userId, posted_at: new Date().toISOString() },
  });
}
