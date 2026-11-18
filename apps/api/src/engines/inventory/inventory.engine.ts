// engines/inventory — every stock change goes through here (CLAUDE.md "Code layout"; architecture §4–§6).
//
//  - createLot():          a new lot in QUARANTINE, through core/transition (rule 7).
//  - postMovement():       one ledger row (receipt, issue, output, dispatch, adjustment, destroy, return ...),
//                          valued at the lot's cost with the owner's rounding rules (valuation.ts).
//  - transfer():           TRANSFER_OUT + TRANSFER_IN pair, value moves with the stock.
//  - reverseMovements():   correction rows that mirror the originals (rule 4).
//  - reserve() / releaseReservation(): quantity held for a document line; only APPROVED lots (rule 2).
//  - fefoCandidates() / allocateFefo(): usable lots, earliest expiry first.
//
// The engine runs inside the caller's transaction and does not post journals: the calling module service posts
// the journal for the returned movements through engines/posting in the SAME transaction (rule 5); customer-owned
// stock returns value 0 and gets no journal (rule 12). Permissions are checked by the calling route, except lot
// creation, whose first status goes through core/transition. Lots are locked FOR UPDATE, then their balances,
// before anything is written; the database (0014, 0015) re-checks every rule.
import { Decimal } from 'decimal.js';
import {
  InboundMovementTypes,
  LotStatus,
  type PermissionKey,
  type StockMovementType,
} from '@albert/shared';
import type { Queryable, Tx } from '../../db/client';
import type { stockMovements } from '../../db/schema/inv';
import { AppError, fromDbError } from '../../core/errors';
import { defineTransitions, recordInitialStatus, type Actor, type TransitionMap } from '../../core/transition/transition';
import { assertStockLocation, assertTollCustomer, stockItem } from '../../modules/masters/stock-refs.service';
import * as repo from './inventory.repo';
import { money, movementValue, quantity } from './valuation';

// ---------------------------------------------------------------- lots

export const LOT_TABLE = 'inv.lots';

/**
 * Who may create a lot (architecture §4: "(new) → QUARANTINE: GRN posted, or FG output recorded (posting service)").
 * Each source has its own complete map so the key for the move is fixed per source.
 * PRODUCTION_OUTPUT → prod.batch.approve_close: agent default, PENDING OWNER (M6 confirms).
 */
export const LotCreationKeys = {
  GRN: 'purch.grn.post',
  PRODUCTION_OUTPUT: 'prod.batch.approve_close',
} as const satisfies Record<string, PermissionKey>;
export type LotSource = keyof typeof LotCreationKeys;

const lotCreationMaps = Object.fromEntries(
  Object.entries(LotCreationKeys).map(([source, key]) => [
    source,
    defineTransitions<LotStatus>({
      entityTable: LOT_TABLE,
      statuses: LotStatus,
      moves: [{ from: null, to: 'QUARANTINE', permission: key }],
    }),
  ]),
) as Record<LotSource, TransitionMap<LotStatus>>;

export interface NewLot {
  source: LotSource;
  itemId: string;
  lotNo: string;
  mfrBatchNo?: string;
  manufacturer?: string;
  mfgDate?: string;
  expiryDate?: string;
  retestDate?: string;
  assayPct?: string;
  waterPct?: string;
  /** Set for customer-owned (toll) stock: unit cost must be 0 (rule 12). */
  ownerCustomerId?: string;
  /** Lot-actual cost per base unit, 2 decimals. FG lots: fgUnitCost(batchCost, qty). */
  unitCost: string;
}

export type Lot = repo.LotRow;

export async function createLot(tx: Tx, actor: Actor, input: NewLot): Promise<Lot> {
  const map = lotCreationMaps[input.source];
  if (!map) throw new AppError('VALIDATION_FAILED', `Unknown lot source ${String(input.source)}`);
  assertMoney(input.unitCost, 'Unit cost');
  const item = await stockItem(tx, actor.companyId, input.itemId);
  if (item.status !== 'ACTIVE') {
    throw new AppError('VALIDATION_FAILED', `Item ${item.code} is ${item.status}; lots are created only for ACTIVE items`);
  }
  if (input.ownerCustomerId !== undefined) {
    await assertTollCustomer(tx, actor.companyId, input.ownerCustomerId);
    if (!new Decimal(input.unitCost).isZero()) {
      throw new AppError('VALIDATION_FAILED', 'Customer-owned stock carries no value; its unit cost is 0 (rule 12)');
    }
  }
  const lot = await guarded(() =>
    repo.insertLot(tx, {
      itemId: input.itemId,
      lotNo: input.lotNo.trim(),
      mfrBatchNo: input.mfrBatchNo ?? null,
      manufacturer: input.manufacturer ?? null,
      mfgDate: input.mfgDate ?? null,
      expiryDate: input.expiryDate ?? null,
      retestDate: input.retestDate ?? null,
      assayPct: input.assayPct ?? null,
      waterPct: input.waterPct ?? null,
      status: 'QUARANTINE',
      ownerType: input.ownerCustomerId === undefined ? 'OWN' : 'CUSTOMER',
      ownerCustomerId: input.ownerCustomerId ?? null,
      unitCost: money(input.unitCost),
    }),
  );
  await recordInitialStatus(tx, map, { entityId: lot.id, to: 'QUARANTINE', actor });
  return lot;
}

export async function getLot(q: Queryable, companyId: string, lotId: string): Promise<Lot> {
  const lot = await repo.findLot(q, companyId, lotId);
  if (!lot) throw new AppError('NOT_FOUND', `Lot ${lotId} not found`);
  return lot;
}

// ---------------------------------------------------------------- movements

/** A posted ledger row, with what the posting engine needs (item category, value, toll flag). */
export interface PostedMovement {
  id: string;
  movementType: StockMovementType;
  movementDate: string;
  lotId: string;
  lotNo: string;
  itemId: string;
  itemCategoryId: string;
  locationId: string;
  /** Signed: + in, − out. */
  qty: string;
  unitCost: string;
  /** Signed like qty; 0 for customer-owned stock. */
  value: string;
  /** Customer-owned (toll) stock: no journal (rule 12). */
  customerOwned: boolean;
  refDocType: string;
  refDocId: string;
  reversalOf: string | null;
}

export interface DocumentRef {
  /** e.g. GRN, PROD_ORDER, DELIVERY, ADJUSTMENT. */
  refDocType: string;
  refDocId: string;
}

type TransferType = 'TRANSFER_OUT' | 'TRANSFER_IN';

export interface MovementInput extends DocumentRef {
  type: Exclude<StockMovementType, TransferType>;
  lotId: string;
  locationId: string;
  /** Quantity moved, > 0, up to 4 decimals; the engine signs it by type. */
  qty: string;
  /** Business date; must fall in an OPEN period (rule 11). */
  date: string;
  reasonCode?: string;
  /** OUTPUT only: the exact batch cost of this output (owner decision 2026-11-18). */
  value?: string;
  /** Outbound only: consume this document's reservation on the lot (up to qty). */
  consumeReservation?: DocumentRef;
}

const isInbound = (type: StockMovementType) => InboundMovementTypes.includes(type);

export async function postMovement(tx: Tx, actor: Actor, input: MovementInput): Promise<PostedMovement> {
  if ((input.type as StockMovementType) === 'TRANSFER_OUT' || (input.type as StockMovementType) === 'TRANSFER_IN') {
    throw new AppError('VALIDATION_FAILED', 'Transfers are posted with transfer()');
  }
  assertQty(input.qty);
  assertDate(input.date);
  assertDocument(input);
  const inbound = isInbound(input.type);
  if (input.consumeReservation && inbound) {
    throw new AppError('VALIDATION_FAILED', 'Only an outbound movement consumes a reservation');
  }
  const lot = await lockLotOrFail(tx, actor.companyId, input.lotId);
  assertLotAllows(input.type, lot);
  await assertStockLocation(tx, actor.companyId, input.locationId, inbound);
  const qty = inbound ? new Decimal(input.qty) : new Decimal(input.qty).neg();

  if (!inbound) await assertCanTakeOut(tx, lot, input.locationId, qty.neg(), input.consumeReservation);
  const totals = await repo.lotLedgerTotals(tx, lot.id);
  const value = movementValue({
    type: input.type,
    qty,
    unitCost: lot.unitCost,
    customerOwned: lot.ownerType === 'CUSTOMER',
    lotQty: totals.qty,
    lotValue: totals.value,
    outputValue: input.value,
  });
  if (input.consumeReservation) await consume(tx, lot.id, input.consumeReservation, qty.neg());
  return insertRow(tx, actor, lot, {
    movementType: input.type,
    movementDate: input.date,
    lotId: lot.id,
    fromLocationId: inbound ? null : input.locationId,
    toLocationId: inbound ? input.locationId : null,
    qty: quantity(qty),
    unitCost: lot.unitCost,
    value,
    refDocType: input.refDocType,
    refDocId: input.refDocId,
    reasonCode: input.reasonCode ?? null,
  });
}

export interface TransferInput extends DocumentRef {
  lotId: string;
  fromLocationId: string;
  toLocationId: string;
  qty: string;
  date: string;
  reasonCode?: string;
}

/** Moves stock between two locations: TRANSFER_OUT then TRANSFER_IN, same quantity and value. No journal. */
export async function transfer(tx: Tx, actor: Actor, input: TransferInput): Promise<[PostedMovement, PostedMovement]> {
  assertQty(input.qty);
  assertDate(input.date);
  assertDocument(input);
  if (input.fromLocationId === input.toLocationId) {
    throw new AppError('VALIDATION_FAILED', 'A transfer moves stock to a different location');
  }
  const lot = await lockLotOrFail(tx, actor.companyId, input.lotId);
  assertLotAllows('TRANSFER_OUT', lot);
  await assertStockLocation(tx, actor.companyId, input.fromLocationId, false);
  await assertStockLocation(tx, actor.companyId, input.toLocationId, true);
  const qty = new Decimal(input.qty);
  await assertCanTakeOut(tx, lot, input.fromLocationId, qty, undefined, true);
  const common = {
    movementDate: input.date,
    lotId: lot.id,
    unitCost: lot.unitCost,
    refDocType: input.refDocType,
    refDocId: input.refDocId,
    reasonCode: input.reasonCode ?? null,
  };
  const value = (type: TransferType, q: Decimal) =>
    movementValue({ type, qty: q, unitCost: lot.unitCost, customerOwned: lot.ownerType === 'CUSTOMER', lotQty: 0, lotValue: 0 });
  const out = await insertRow(tx, actor, lot, {
    ...common,
    movementType: 'TRANSFER_OUT',
    fromLocationId: input.fromLocationId,
    toLocationId: null,
    qty: quantity(qty.neg()),
    value: value('TRANSFER_OUT', qty.neg()),
  });
  const into = await insertRow(tx, actor, lot, {
    ...common,
    movementType: 'TRANSFER_IN',
    fromLocationId: null,
    toLocationId: input.toLocationId,
    qty: quantity(qty),
    value: value('TRANSFER_IN', qty),
  });
  return [out, into];
}

export interface ReversalInput extends DocumentRef {
  /** The rows to reverse; a transfer's OUT and IN rows are reversed together. */
  movementIds: string[];
  date: string;
  reasonCode?: string;
}

/**
 * Correction (rule 4): one mirror row per original — same lot, type and unit cost; quantity, value and location
 * side swapped. Rows that put stock back are written first. A reversal is never reversed again.
 */
export async function reverseMovements(tx: Tx, actor: Actor, input: ReversalInput): Promise<PostedMovement[]> {
  assertDate(input.date);
  assertDocument(input);
  const ids = [...new Set(input.movementIds)];
  if (ids.length === 0) throw new AppError('VALIDATION_FAILED', 'Name the movements to reverse');
  const originals = await repo.findMovements(tx, actor.companyId, ids);
  if (originals.length !== ids.length) {
    const missing = ids.filter((id) => !originals.some((m) => m.id === id));
    throw new AppError('NOT_FOUND', `Stock movement ${missing.join(', ')} not found`);
  }
  for (const m of originals) {
    if (m.reversalOf) throw new AppError('VALIDATION_FAILED', `Movement ${m.id} is itself a reversal; post a new movement instead`);
  }
  const already = await repo.reversalsOf(tx, ids);
  if (already.length > 0) throw new AppError('INVALID_TRANSITION', `Movement ${already.join(', ')} is already reversed`, { movementIds: already });
  assertTransfersWhole(originals);

  const lots = new Map<string, repo.LotRow>();
  for (const lotId of [...new Set(originals.map((m) => m.lotId))].sort(byNumber)) {
    const lot = await lockLotOrFail(tx, actor.companyId, lotId);
    if (lot.status === 'DESTROYED' || lot.status === 'RETURNED') {
      throw new AppError('INVALID_TRANSITION', `Lot ${lot.lotNo} is ${lot.status}; it never moves again`);
    }
    lots.set(lotId, lot);
  }
  // Put stock back first (reversals of outbound rows), then take it out.
  const ordered = [...originals].sort((a, b) => Number(new Decimal(a.qty).gt(0)) - Number(new Decimal(b.qty).gt(0)) || byNumber(a.id, b.id));
  const posted: PostedMovement[] = [];
  for (const m of ordered) {
    const lot = lots.get(m.lotId)!;
    const qty = new Decimal(m.qty).neg();
    if (qty.lt(0)) {
      const location = m.toLocationId!;
      const pairedIn = m.movementType === 'TRANSFER_IN';
      await assertCanTakeOut(tx, lot, location, qty.neg(), undefined, pairedIn);
    }
    posted.push(
      await insertRow(tx, actor, lot, {
        movementType: m.movementType,
        movementDate: input.date,
        lotId: m.lotId,
        fromLocationId: m.toLocationId,
        toLocationId: m.fromLocationId,
        qty: quantity(qty),
        unitCost: m.unitCost,
        value: money(new Decimal(m.value).neg()),
        refDocType: input.refDocType,
        refDocId: input.refDocId,
        reasonCode: input.reasonCode ?? null,
        reversalOf: m.id,
      }),
    );
  }
  return posted;
}

// ---------------------------------------------------------------- reservations

export type Reservation = repo.ReservationRow;

export interface ReserveInput extends DocumentRef {
  lotId: string;
  /** Quantity to add to this document's reservation on the lot. */
  qty: string;
}

/** Holds stock of an APPROVED lot for a document line (rule 2). Never more than the lot's free stock. */
export async function reserve(tx: Tx, actor: Actor, input: ReserveInput): Promise<Reservation> {
  assertQty(input.qty);
  assertDocument(input);
  const lot = await lockLotOrFail(tx, actor.companyId, input.lotId);
  if (lot.status !== 'APPROVED') {
    throw new AppError('LOT_NOT_APPROVED', `Lot ${lot.lotNo} is ${lot.status}; only APPROVED lots are reserved`, { lotId: lot.id, status: lot.status });
  }
  const onHand = sum((await repo.lockBalances(tx, lot.id)).map((b) => b.qty));
  const reservations = await repo.lockReservations(tx, lot.id);
  const reserved = sum(reservations.map((r) => r.qty));
  const free = onHand.minus(reserved);
  const qty = new Decimal(input.qty);
  if (qty.gt(free)) {
    throw new AppError('INSUFFICIENT_STOCK', `Lot ${lot.lotNo} has ${quantity(free)} free; ${quantity(qty)} requested`, {
      lotId: lot.id,
      onHand: quantity(onHand),
      reserved: quantity(reserved),
      requested: quantity(qty),
    });
  }
  const own = reservations.find((r) => r.refDocType === input.refDocType && r.refDocId === input.refDocId);
  return guarded(() =>
    own
      ? repo.setReservationQty(tx, own.id, quantity(new Decimal(own.qty).plus(qty)))
      : repo.insertReservation(tx, { lotId: lot.id, qty: quantity(qty), refDocType: input.refDocType, refDocId: input.refDocId }),
  );
}

export interface ReleaseInput extends DocumentRef {
  lotId: string;
  /** Quantity to release; omitted = all of this document's reservation on the lot. */
  qty?: string;
}

/** Lowers a document's reservation (cancelled order, changed plan). Always allowed, whatever the lot status. */
export async function releaseReservation(tx: Tx, actor: Actor, input: ReleaseInput): Promise<Reservation> {
  if (input.qty !== undefined) assertQty(input.qty);
  assertDocument(input);
  const lot = await lockLotOrFail(tx, actor.companyId, input.lotId);
  const own = (await repo.lockReservations(tx, lot.id)).find((r) => r.refDocType === input.refDocType && r.refDocId === input.refDocId);
  if (!own) throw new AppError('NOT_FOUND', `${input.refDocType} ${input.refDocId} holds no reservation on lot ${lot.lotNo}`);
  const held = new Decimal(own.qty);
  const release = input.qty === undefined ? held : new Decimal(input.qty);
  if (release.gt(held)) {
    throw new AppError('VALIDATION_FAILED', `Only ${quantity(held)} is reserved; cannot release ${quantity(release)}`);
  }
  return repo.setReservationQty(tx, own.id, quantity(held.minus(release)));
}

export async function reservationsOfDocument(q: Queryable, companyId: string, doc: DocumentRef): Promise<Reservation[]> {
  return repo.reservationsOfDocument(q, companyId, doc.refDocType, doc.refDocId);
}

// ---------------------------------------------------------------- FEFO

export interface FefoQuery {
  itemId: string;
  /** ISSUE: APPROVED material lots; DISPATCH: RELEASED finished goods (rule 2). */
  purpose: 'ISSUE' | 'DISPATCH';
  /** Business date: lots whose expiry or retest date is on or before it are not offered. */
  asOf: string;
  /** Only stock at these locations (e.g. one warehouse's). */
  locationIds?: string[];
  /** undefined = any owner; null = own stock only; id = that toll customer's stock only. */
  ownerCustomerId?: string | null;
  /** This document's own reservations count as available to it. */
  forDocument?: DocumentRef;
}

export interface FefoCandidate {
  lotId: string;
  lotNo: string;
  expiryDate: string | null;
  retestDate: string | null;
  unitCost: string;
  customerOwned: boolean;
  /** Lot stock over all locations. */
  onHand: string;
  reservedForOthers: string;
  reservedForDocument: string;
  /** What this document may take: min(stock at the chosen locations, on hand − reserved for others). */
  available: string;
  locations: { locationId: string; qty: string }[];
}

/** Usable lots of an item, earliest expiry first (no expiry last), then oldest lot; only those with stock available. */
export async function fefoCandidates(q: Queryable, companyId: string, f: FefoQuery): Promise<FefoCandidate[]> {
  assertDate(f.asOf);
  const lots = await repo.fefoLots(q, {
    companyId,
    itemId: f.itemId,
    status: f.purpose === 'ISSUE' ? 'APPROVED' : 'RELEASED',
    asOf: f.asOf,
    ownerCustomerId: f.ownerCustomerId,
  });
  const lotIds = lots.map((l) => l.id);
  const balances = await repo.balancesOfLots(q, lotIds);
  const reservations = await repo.reservationsOfLots(q, lotIds);
  const wanted = f.locationIds ? new Set(f.locationIds) : undefined;
  const result: FefoCandidate[] = [];
  for (const lot of lots) {
    const lotBalances = balances.filter((b) => b.lotId === lot.id).sort((a, b) => byNumber(a.locationId, b.locationId));
    const onHand = sum(lotBalances.map((b) => b.qty));
    const isOwn = (r: repo.ReservationRow) => f.forDocument !== undefined && r.refDocType === f.forDocument.refDocType && r.refDocId === f.forDocument.refDocId;
    const lotReservations = reservations.filter((r) => r.lotId === lot.id);
    const forDocument = sum(lotReservations.filter(isOwn).map((r) => r.qty));
    const forOthers = sum(lotReservations.filter((r) => !isOwn(r)).map((r) => r.qty));
    const locations = lotBalances.filter((b) => !wanted || wanted.has(b.locationId)).map((b) => ({ locationId: b.locationId, qty: quantity(b.qty) }));
    const atLocations = sum(locations.map((l) => l.qty));
    const available = Decimal.max(Decimal.min(atLocations, onHand.minus(forOthers)), 0);
    if (available.isZero()) continue;
    result.push({
      lotId: lot.id,
      lotNo: lot.lotNo,
      expiryDate: lot.expiryDate,
      retestDate: lot.retestDate,
      unitCost: lot.unitCost,
      customerOwned: lot.ownerType === 'CUSTOMER',
      onHand: quantity(onHand),
      reservedForOthers: quantity(forOthers),
      reservedForDocument: quantity(forDocument),
      available: quantity(available),
      locations,
    });
  }
  return result;
}

/** Takes `qty` from the candidates in FEFO order. INSUFFICIENT_STOCK if they do not hold enough. */
export function allocateFefo(candidates: readonly FefoCandidate[], qty: string): { lotId: string; qty: string }[] {
  assertQty(qty);
  let remaining = new Decimal(qty);
  const picks: { lotId: string; qty: string }[] = [];
  for (const c of candidates) {
    if (remaining.isZero()) break;
    const take = Decimal.min(remaining, c.available);
    if (take.gt(0)) {
      picks.push({ lotId: c.lotId, qty: quantity(take) });
      remaining = remaining.minus(take);
    }
  }
  if (remaining.gt(0)) {
    const available = sum(candidates.map((c) => c.available));
    throw new AppError('INSUFFICIENT_STOCK', `Only ${quantity(available)} is available; ${quantity(qty)} requested`, {
      requested: quantity(qty),
      available: quantity(available),
    });
  }
  return picks;
}

// ---------------------------------------------------------------- internals

function sum(values: readonly Decimal.Value[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(v), new Decimal(0));
}

function byNumber(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Turns a database guard error into the AppError it names. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw fromDbError(err) ?? err;
  }
}

function assertQty(qty: string): void {
  if (!/^\d{1,14}(\.\d{1,4})?$/.test(qty) || new Decimal(qty).lte(0)) {
    throw new AppError('VALIDATION_FAILED', `Quantity must be greater than zero with at most 4 decimals (got "${qty}")`);
  }
}

function assertMoney(v: string, label: string): void {
  if (!/^\d{1,16}(\.\d{1,2})?$/.test(v)) {
    throw new AppError('VALIDATION_FAILED', `${label} must be an amount ≥ 0 with at most 2 decimals (got "${v}")`);
  }
}

function assertDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new AppError('VALIDATION_FAILED', `Date must be YYYY-MM-DD (got "${date}")`);
  }
}

function assertDocument(doc: DocumentRef): void {
  if (!/^[A-Z][A-Z_]{1,29}$/.test(doc.refDocType) || !/^[1-9]\d{0,18}$/.test(doc.refDocId)) {
    throw new AppError('VALIDATION_FAILED', 'Every stock change names its document (type in capitals and id)');
  }
}

async function lockLotOrFail(tx: Tx, companyId: string, lotId: string): Promise<repo.LotRow> {
  const lot = await repo.lockLot(tx, companyId, lotId);
  if (!lot) throw new AppError('NOT_FOUND', `Lot ${lotId} not found`);
  return lot;
}

/** The lot status table (architecture §4) and rule 2, checked before the database checks them again. */
function assertLotAllows(type: StockMovementType, lot: repo.LotRow): void {
  const details = { lotId: lot.id, lotNo: lot.lotNo, status: lot.status, movementType: type };
  if (lot.status === 'DESTROYED' || lot.status === 'RETURNED') {
    throw new AppError('INVALID_TRANSITION', `Lot ${lot.lotNo} is ${lot.status}; it never moves again`, details);
  }
  if (type === 'DESTROY' || type === 'RETURN_TO_VENDOR') {
    if (lot.status !== 'REJECTED') {
      throw new AppError('INVALID_TRANSITION', `Only a REJECTED lot is destroyed or returned (lot ${lot.lotNo} is ${lot.status})`, details);
    }
    return;
  }
  if (lot.status === 'REJECTED') {
    throw new AppError('LOT_NOT_APPROVED', `Lot ${lot.lotNo} is REJECTED; it can only be destroyed or returned`, details);
  }
  if (type === 'ISSUE' && lot.status !== 'APPROVED') {
    throw new AppError('LOT_NOT_APPROVED', `Lot ${lot.lotNo} is ${lot.status}; only APPROVED lots are issued`, details);
  }
  if (type === 'DISPATCH' && lot.status !== 'RELEASED') {
    throw new AppError('LOT_NOT_RELEASED', `Lot ${lot.lotNo} is ${lot.status}; only RELEASED finished goods are dispatched`, details);
  }
  if ((type === 'RECEIPT' || type === 'OUTPUT') && lot.status !== 'QUARANTINE') {
    throw new AppError('VALIDATION_FAILED', `Received and produced stock enters a QUARANTINE lot (lot ${lot.lotNo} is ${lot.status})`, details);
  }
}

/**
 * Before stock leaves a location: the location holds it (rule 3), and the lot keeps enough to cover every other
 * document's reservation. `consuming` names the document whose own reservation this movement uses up.
 * A transfer keeps the lot's total, so only the location is checked (`sameLot`).
 */
async function assertCanTakeOut(tx: Tx, lot: repo.LotRow, locationId: string, qty: Decimal, consuming?: DocumentRef, sameLot = false): Promise<void> {
  const balances = await repo.lockBalances(tx, lot.id);
  const atLocation = new Decimal(balances.find((b) => b.locationId === locationId)?.qty ?? 0);
  if (qty.gt(atLocation)) {
    throw new AppError('INSUFFICIENT_STOCK', `Lot ${lot.lotNo} holds ${quantity(atLocation)} at this location; ${quantity(qty)} requested`, {
      lotId: lot.id,
      locationId,
      onHand: quantity(atLocation),
      requested: quantity(qty),
    });
  }
  if (sameLot) return;
  const reservations = await repo.lockReservations(tx, lot.id);
  const reserved = sum(reservations.map((r) => r.qty));
  const own = consuming
    ? new Decimal(reservations.find((r) => r.refDocType === consuming.refDocType && r.refDocId === consuming.refDocId)?.qty ?? 0)
    : new Decimal(0);
  const used = Decimal.min(own, qty);
  const onHand = sum(balances.map((b) => b.qty));
  if (onHand.minus(qty).lt(reserved.minus(used))) {
    throw new AppError('INSUFFICIENT_STOCK', `Lot ${lot.lotNo}: ${quantity(reserved.minus(own))} is reserved for other documents`, {
      lotId: lot.id,
      onHand: quantity(onHand),
      reserved: quantity(reserved),
      requested: quantity(qty),
    });
  }
}

async function consume(tx: Tx, lotId: string, doc: DocumentRef, qty: Decimal): Promise<void> {
  const own = (await repo.lockReservations(tx, lotId)).find((r) => r.refDocType === doc.refDocType && r.refDocId === doc.refDocId);
  if (!own) return;
  const left = Decimal.max(new Decimal(own.qty).minus(qty), 0);
  await repo.setReservationQty(tx, own.id, quantity(left));
}

/** Every reversed transfer row comes with the rest of its transfer (same lot and document), so value stays put. */
function assertTransfersWhole(rows: readonly repo.MovementRow[]): void {
  const net = new Map<string, Decimal>();
  for (const m of rows) {
    if (m.movementType !== 'TRANSFER_OUT' && m.movementType !== 'TRANSFER_IN') continue;
    const key = `${m.lotId}/${m.refDocType}/${m.refDocId}`;
    net.set(key, (net.get(key) ?? new Decimal(0)).plus(m.qty));
  }
  for (const [key, q] of net) {
    if (!q.isZero()) throw new AppError('VALIDATION_FAILED', `Reverse both rows of transfer ${key} together`);
  }
}

async function insertRow(
  tx: Tx,
  actor: Actor,
  lot: repo.LotRow,
  row: Omit<typeof stockMovements.$inferInsert, 'companyId'>,
): Promise<PostedMovement> {
  const item = await stockItem(tx, actor.companyId, lot.itemId);
  const m = await guarded(() => repo.insertMovement(tx, row));
  return {
    id: m.id,
    movementType: m.movementType,
    movementDate: m.movementDate,
    lotId: m.lotId,
    lotNo: lot.lotNo,
    itemId: lot.itemId,
    itemCategoryId: item.categoryId,
    locationId: (m.toLocationId ?? m.fromLocationId)!,
    qty: m.qty,
    unitCost: m.unitCost,
    value: m.value,
    customerOwned: lot.ownerType === 'CUSTOMER',
    refDocType: m.refDocType,
    refDocId: m.refDocId,
    reversalOf: m.reversalOf,
  };
}
