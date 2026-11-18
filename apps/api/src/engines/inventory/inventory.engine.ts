// engines/inventory — every stock change goes through here (CLAUDE.md "Code layout"; architecture §4–§6).
//
//  - createLot():          a new lot in QUARANTINE, through core/transition (rule 7).
//  - createReturnLot():    a customer-return lot in HOLD, linked to the original lot, "<lot>-R<n>" (owner Q9).
//  - postValueAdjustment(): value-only VALUE_ADJUSTMENT row; resets the lot's unit cost (owner Q8; 0017).
//  - closeBatchCost():     at batch close, the adjustment that brings an FG lot to the batch cost; marks the
//                          batch closed so the lot may be dispatched (owner Q8; 0017).
//  - postMovement():       one ledger row (receipt, issue, output, dispatch, adjustment, destroy, return ...),
//                          valued at the lot's cost with the owner's rounding rules (valuation.ts).
//  - transfer():           TRANSFER_OUT + TRANSFER_IN pair, value moves with the stock.
//  - reverseMovements():   correction rows that mirror the originals (rule 4).
//  - reserve() / releaseReservation(): quantity held for a document line; only APPROVED lots (rule 2).
//  - fefoCandidates() / allocateFefo(): usable lots, earliest expiry first.
//  - sweepEmptyLot():      value-only ROUNDING_SWEEP row for an empty lot still holding paisa; called only by
//                          engines/posting, which posts its journal (owner 18-11-2026; 0016).
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
  ValueAdjustmentReason,
  type LotSource,
  type PermissionKey,
  type StockMovementType,
} from '@albert/shared';
import type { Queryable, Tx } from '../../db/client';
import type { stockMovements } from '../../db/schema/inv';
import { AppError, fromDbError } from '../../core/errors';
import { defineTransitions, recordInitialStatus, type Actor, type TransitionMap } from '../../core/transition/transition';
import {
  assertCustomerFor,
  assertReturnsArea,
  assertStockLocation,
  assertTollCustomer,
  stockItem,
} from '../../modules/masters/stock-refs.service';
import * as repo from './inventory.repo';
import { money, movementValue, quantity } from './valuation';

// ---------------------------------------------------------------- lots

export const LOT_TABLE = 'inv.lots';

/**
 * Who may create a lot, and in which status (architecture §4: "(new) → QUARANTINE: GRN posted, or FG output
 * recorded"; owner 2026-11-18). Each source has its own complete map so the key for the move is fixed per source.
 *  - GRN → purch.grn.post (Storekeeper).
 *  - PRODUCTION_OUTPUT → prod.output.verify: the checker's verification of a signed output/yield entry creates
 *    the lot (owner 2026-11-18, doer + checker Option A); the doer's prod.stage.sign alone creates nothing. The
 *    output record and its doer ≠ checker check are M6's production module; this key is the engine's half.
 *  - SALES_RETURN → fg.delivery.manage ("returns receipt"), created in HOLD (owner Q9).
 */
export const LotCreationKeys = {
  GRN: 'purch.grn.post',
  PRODUCTION_OUTPUT: 'prod.output.verify',
  SALES_RETURN: 'fg.delivery.manage',
} as const satisfies Record<LotSource, PermissionKey>;

const initialLotStatus = (source: LotSource): LotStatus => (source === 'SALES_RETURN' ? 'HOLD' : 'QUARANTINE');

const lotCreationMaps = Object.fromEntries(
  Object.entries(LotCreationKeys).map(([source, key]) => [
    source,
    defineTransitions<LotStatus>({
      entityTable: LOT_TABLE,
      statuses: LotStatus,
      moves: [{ from: null, to: initialLotStatus(source as LotSource), permission: key }],
    }),
  ]),
) as Record<LotSource, TransitionMap<LotStatus>>;

/** Batch close (architecture §4, Production Manager e-signature): the key that closes an FG lot's cost. */
export const BATCH_CLOSE_KEY: PermissionKey = 'prod.batch.approve_close';

export interface NewLot {
  /** SALES_RETURN lots are made by createReturnLot(). */
  source: Exclude<LotSource, 'SALES_RETURN'>;
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
  /** Lot-actual cost per base unit, 2 decimals. FG lots: fgUnitCost(provisional output value, qty) (owner Q8). */
  unitCost: string;
}

export type Lot = repo.LotRow;

export async function createLot(tx: Tx, actor: Actor, input: NewLot): Promise<Lot> {
  if ((input.source as LotSource) === 'SALES_RETURN') {
    throw new AppError('VALIDATION_FAILED', 'A customer-return lot is created with createReturnLot()');
  }
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
      source: input.source,
    }),
  );
  await recordInitialStatus(tx, map, { entityId: lot.id, to: 'QUARANTINE', actor });
  return lot;
}

export interface NewReturnLot {
  /** The lot the goods were dispatched from (if a return lot is named, its original lot is used). */
  originalLotId: string;
}

/**
 * A customer return never goes back into the released lot (owner 2026-11-18, Q9): a new lot linked to the
 * original, numbered "<original>-R<n>", with the original's item, owner, dates, assay and unit cost, created in
 * HOLD; only QA moves it on. The SALES_RETURN movement then receives the goods into it at a returns area.
 */
export async function createReturnLot(tx: Tx, actor: Actor, input: NewReturnLot): Promise<Lot> {
  // Permission first, so nothing is written for an actor without the key.
  if (!actor.permissions.has(LotCreationKeys.SALES_RETURN)) {
    throw new AppError('FORBIDDEN', `Receiving a customer return needs ${LotCreationKeys.SALES_RETURN}`, { permission: LotCreationKeys.SALES_RETURN });
  }
  const named = await lockLotOrFail(tx, actor.companyId, input.originalLotId);
  const original = named.parentLotId ? await lockLotOrFail(tx, actor.companyId, named.parentLotId) : named;
  const item = await stockItem(tx, actor.companyId, original.itemId);
  if (item.type !== 'FG') {
    throw new AppError('VALIDATION_FAILED', `Lot ${original.lotNo} is not finished goods; customer returns are finished-goods lots`);
  }
  const prefix = `${original.lotNo}-R`;
  const used = (await repo.returnLotsOf(tx, original.id)).map((l) => Number(l.lotNo.slice(prefix.length))).filter(Number.isInteger);
  const lotNo = `${prefix}${Math.max(0, ...used) + 1}`;
  if (lotNo.length > 40) throw new AppError('VALIDATION_FAILED', `Return lot number ${lotNo} is longer than 40 characters`);
  const lot = await guarded(() =>
    repo.insertLot(tx, {
      itemId: original.itemId,
      lotNo,
      mfrBatchNo: original.mfrBatchNo,
      manufacturer: original.manufacturer,
      mfgDate: original.mfgDate,
      expiryDate: original.expiryDate,
      retestDate: original.retestDate,
      assayPct: original.assayPct,
      waterPct: original.waterPct,
      status: 'HOLD',
      ownerType: original.ownerType,
      ownerCustomerId: original.ownerCustomerId,
      unitCost: original.unitCost,
      source: 'SALES_RETURN',
      parentLotId: original.id,
    }),
  );
  await recordInitialStatus(tx, lotCreationMaps.SALES_RETURN, { entityId: lot.id, to: 'HOLD', actor });
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
  /** null only for a value-only row (ROUNDING_SWEEP, VALUE_ADJUSTMENT): no stock moved. */
  locationId: string | null;
  /** Signed: + in, − out. */
  qty: string;
  unitCost: string;
  /** Signed like qty; 0 for customer-owned stock. */
  value: string;
  /** Customer-owned (toll) stock: no journal (rule 12). */
  customerOwned: boolean;
  refDocType: string;
  refDocId: string;
  /** VALUE_ADJUSTMENT: its ValueAdjustmentReason, which decides the GL event. */
  reasonCode: string | null;
  reversalOf: string | null;
}

export interface DocumentRef {
  /** e.g. GRN, PROD_ORDER, DELIVERY, ADJUSTMENT. */
  refDocType: string;
  refDocId: string;
}

type TransferType = 'TRANSFER_OUT' | 'TRANSFER_IN';

export interface MovementInput extends DocumentRef {
  type: Exclude<StockMovementType, TransferType | 'ROUNDING_SWEEP' | 'VALUE_ADJUSTMENT'>;
  lotId: string;
  locationId: string;
  /** Quantity moved, > 0, up to 4 decimals; the engine signs it by type. */
  qty: string;
  /** Business date; must fall in an OPEN period (rule 11). */
  date: string;
  reasonCode?: string;
  /** OUTPUT only: the provisional value = cost of the materials issued to the batch so far (owner Q8, 2026-11-18). */
  value?: string;
  /** Outbound only: consume this document's reservation on the lot (up to qty). */
  consumeReservation?: DocumentRef;
  /** DISPATCH and SALES_RETURN only, required there: the customer the goods go to / come back from (0018). */
  customerId?: string;
}

const CustomerMovementTypes: readonly StockMovementType[] = ['DISPATCH', 'SALES_RETURN'];

const isInbound = (type: StockMovementType) => InboundMovementTypes.includes(type);

export async function postMovement(tx: Tx, actor: Actor, input: MovementInput): Promise<PostedMovement> {
  const requested = input.type as StockMovementType;
  if (requested === 'TRANSFER_OUT' || requested === 'TRANSFER_IN') {
    throw new AppError('VALIDATION_FAILED', 'Transfers are posted with transfer()');
  }
  if (requested === 'ROUNDING_SWEEP') {
    throw new AppError('VALIDATION_FAILED', 'A rounding sweep is written only by the posting engine (sweepEmptyLot)');
  }
  if (requested === 'VALUE_ADJUSTMENT') {
    throw new AppError('VALIDATION_FAILED', 'A value-only adjustment is posted with postValueAdjustment()');
  }
  assertQty(input.qty);
  assertDate(input.date);
  assertDocument(input);
  const inbound = isInbound(input.type);
  if (input.consumeReservation && inbound) {
    throw new AppError('VALIDATION_FAILED', 'Only an outbound movement consumes a reservation');
  }
  const needsCustomer = CustomerMovementTypes.includes(input.type);
  if (needsCustomer !== (input.customerId !== undefined)) {
    throw new AppError(
      'VALIDATION_FAILED',
      needsCustomer ? `A ${input.type} names the customer` : `Only a dispatch or a customer return names a customer`,
    );
  }
  const lot = await lockLotOrFail(tx, actor.companyId, input.lotId);
  assertLotAllows(input.type, lot);
  await assertStockLocation(tx, actor.companyId, input.locationId, inbound);
  if (input.customerId !== undefined) {
    await assertCustomerFor(tx, actor.companyId, input.customerId, input.type === 'DISPATCH' ? 'DISPATCH' : 'SALES_RETURN');
  }
  const qty = inbound ? new Decimal(input.qty) : new Decimal(input.qty).neg();
  if (input.type === 'SALES_RETURN' && input.customerId !== undefined) {
    await assertReturnable(tx, actor, lot, input.locationId, qty, input.customerId);
  }

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
    customerId: input.customerId ?? null,
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
    if (m.movementType === 'ROUNDING_SWEEP') throw new AppError('VALIDATION_FAILED', `Movement ${m.id} is a rounding sweep; it is never reversed`);
    if (m.movementType === 'VALUE_ADJUSTMENT') {
      throw new AppError('VALIDATION_FAILED', `Movement ${m.id} is a value adjustment; it is not reversed (batch close is final; M3 defines landed-cost corrections)`);
    }
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
    if (lot.batchClosedAt && originals.some((m) => m.lotId === lotId && m.movementType === 'OUTPUT')) {
      throw new AppError('INVALID_TRANSITION', `Lot ${lot.lotNo}'s batch is closed; its output is not reversed`);
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
        customerId: m.customerId,
      }),
    );
  }
  return posted;
}

/** The document each movement was posted for (engines/posting checks a reversal against its journal). */
export async function movementDocuments(q: Queryable, companyId: string, ids: string[]): Promise<Map<string, DocumentRef>> {
  const rows = await repo.findMovements(q, companyId, [...new Set(ids)]);
  return new Map(rows.map((m) => [m.id, { refDocType: m.refDocType, refDocId: m.refDocId }]));
}

export interface ValueAdjustmentInput extends DocumentRef {
  lotId: string;
  /** Signed amount, 2 decimals, not zero: + raises the lot's value, − lowers it. */
  value: string;
  /** Why: decides the GL event (engines/posting ValueAdjustmentPosting). */
  reason: ValueAdjustmentReason;
  /** Business date; must fall in an OPEN period (rule 11). */
  date: string;
}

/**
 * Value-only adjustment (owner 2026-11-18, Q8): a VALUE_ADJUSTMENT row (qty 0, no location) carrying the amount,
 * and the lot's unit cost reset to its new value ÷ quantity (rounded half-up). Own stock only (rule 12); refused on
 * a lot with zero quantity (LOT_EMPTY) and when it would take the lot's value below zero (LOT_VALUE_NEGATIVE).
 * The caller posts its journal with postStockJournal in the same transaction (rule 5).
 */
export async function postValueAdjustment(tx: Tx, actor: Actor, input: ValueAdjustmentInput): Promise<PostedMovement> {
  assertDate(input.date);
  assertDocument(input);
  if (!ValueAdjustmentReason.includes(input.reason)) {
    throw new AppError('VALIDATION_FAILED', `Unknown value adjustment reason ${String(input.reason)}`);
  }
  if (!/^-?\d{1,16}(\.\d{1,2})?$/.test(input.value) || new Decimal(input.value).isZero()) {
    throw new AppError('VALIDATION_FAILED', `An adjustment is a non-zero amount with at most 2 decimals (got "${input.value}")`);
  }
  const lot = await lockLotOrFail(tx, actor.companyId, input.lotId);
  const details = { lotId: lot.id, lotNo: lot.lotNo };
  if (lot.ownerType === 'CUSTOMER') {
    throw new AppError('VALIDATION_FAILED', `Lot ${lot.lotNo} is customer-owned and carries no value (rule 12)`, details);
  }
  if (lot.status === 'DESTROYED' || lot.status === 'RETURNED') {
    throw new AppError('INVALID_TRANSITION', `Lot ${lot.lotNo} is ${lot.status}; it never moves again`, details);
  }
  if (input.reason === 'BATCH_CLOSE' && (lot.source !== 'PRODUCTION_OUTPUT' || lot.batchClosedAt)) {
    throw new AppError('INVALID_TRANSITION', `The batch-close adjustment applies once, to a production lot whose batch is not closed (lot ${lot.lotNo})`, details);
  }
  const totals = await repo.lotLedgerTotals(tx, lot.id);
  const lotQty = new Decimal(totals.qty);
  const adjustment = new Decimal(input.value);
  const newValue = new Decimal(totals.value).plus(adjustment);
  if (lotQty.lte(0)) {
    throw new AppError('LOT_EMPTY', `Lot ${lot.lotNo} holds no stock; its value is not adjusted`, details);
  }
  if (newValue.lt(0)) {
    throw new AppError('LOT_VALUE_NEGATIVE', `Lot ${lot.lotNo} holds ${money(totals.value)}; an adjustment of ${money(adjustment)} would take it below zero`, {
      ...details,
      lotValue: money(totals.value),
      adjustment: money(adjustment),
    });
  }
  const unitCost = money(newValue.div(lotQty));
  if (unitCost !== money(lot.unitCost)) await repo.setLotUnitCost(tx, lot.id, unitCost);
  return insertRow(tx, actor, { ...lot, unitCost }, {
    movementType: 'VALUE_ADJUSTMENT',
    movementDate: input.date,
    lotId: lot.id,
    fromLocationId: null,
    toLocationId: null,
    qty: quantity(0),
    unitCost,
    value: money(adjustment),
    refDocType: input.refDocType,
    refDocId: input.refDocId,
    reasonCode: input.reason,
  });
}

export interface BatchCloseCostInput extends DocumentRef {
  /** The FG lot made by the batch's output. */
  lotId: string;
  /** Actual batch cost (architecture §6): materials net of returns + conversion, 2 decimals. */
  batchCost: string;
  date: string;
}

export interface BatchCloseCost {
  lot: Lot;
  /** The adjustment row (null when the output was already booked at exactly the batch cost). */
  adjustment: PostedMovement | null;
}

/**
 * Batch close (owner 2026-11-18, Q8): the FG lot was booked at output at a provisional value; this adds the
 * difference to the actual batch cost (conversion + true-up) as a value-only adjustment on the stock still held
 * (samples issued before close keep their provisional value) and marks the batch closed, after which the lot may
 * be dispatched. The caller posts the conversion journal and this adjustment's journal (postStockJournal) in the
 * same transaction. Needs the batch-close key.
 */
export async function closeBatchCost(tx: Tx, actor: Actor, input: BatchCloseCostInput): Promise<BatchCloseCost> {
  if (!actor.permissions.has(BATCH_CLOSE_KEY)) {
    throw new AppError('FORBIDDEN', `Closing a batch needs ${BATCH_CLOSE_KEY}`, { permission: BATCH_CLOSE_KEY });
  }
  assertMoney(input.batchCost, 'Batch cost');
  assertDate(input.date);
  assertDocument(input);
  const lot = await lockLotOrFail(tx, actor.companyId, input.lotId);
  if (lot.source !== 'PRODUCTION_OUTPUT') {
    throw new AppError('VALIDATION_FAILED', `Lot ${lot.lotNo} was not made by production`, { lotId: lot.id });
  }
  if (lot.batchClosedAt) throw new AppError('INVALID_TRANSITION', `Lot ${lot.lotNo}'s batch is already closed`, { lotId: lot.id });
  const difference = new Decimal(input.batchCost).minus(await repo.outputValue(tx, lot.id));
  const adjustment = difference.isZero()
    ? null
    : await postValueAdjustment(tx, actor, {
        lotId: lot.id,
        value: money(difference),
        reason: 'BATCH_CLOSE',
        date: input.date,
        refDocType: input.refDocType,
        refDocId: input.refDocId,
      });
  const closed = await guarded(() => repo.markBatchClosed(tx, lot.id));
  return { lot: closed, adjustment };
}

export interface SweepInput extends DocumentRef {
  lotId: string;
  /** Business date; must fall in an OPEN period (rule 11). */
  date: string;
}

/**
 * A lot with zero quantity holds zero value (owner, 18-11-2026; DB guard 0016). Called by engines/posting in the
 * same transaction after it posts movements: if the lot is empty but still carries value (a reversal mirrors its
 * original exactly, so rounding can leave a few paisa, plus or minus), writes a value-only ROUNDING_SWEEP row
 * that takes it out. Returns null when the lot holds stock or no value (always for customer-owned stock).
 */
export async function sweepEmptyLot(tx: Tx, actor: Actor, input: SweepInput): Promise<PostedMovement | null> {
  assertDate(input.date);
  assertDocument(input);
  const lot = await lockLotOrFail(tx, actor.companyId, input.lotId);
  if (lot.ownerType === 'CUSTOMER') return null;
  const totals = await repo.lotLedgerTotals(tx, lot.id);
  if (!new Decimal(totals.qty).isZero() || new Decimal(totals.value).isZero()) return null;
  return insertRow(tx, actor, lot, {
    movementType: 'ROUNDING_SWEEP',
    movementDate: input.date,
    lotId: lot.id,
    fromLocationId: null,
    toLocationId: null,
    qty: quantity(0),
    unitCost: lot.unitCost,
    value: money(new Decimal(totals.value).neg()),
    refDocType: input.refDocType,
    refDocId: input.refDocId,
    reasonCode: 'ROUNDING',
  });
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

const InboundSource: Partial<Record<StockMovementType, LotSource>> = { RECEIPT: 'GRN', OUTPUT: 'PRODUCTION_OUTPUT', SALES_RETURN: 'SALES_RETURN' };

/** The lot status table (architecture §4) and rule 2, checked before the database checks them again. */
function assertLotAllows(type: StockMovementType, lot: repo.LotRow): void {
  const details = { lotId: lot.id, lotNo: lot.lotNo, status: lot.status, movementType: type };
  if (lot.status === 'DESTROYED' || lot.status === 'RETURNED') {
    throw new AppError('INVALID_TRANSITION', `Lot ${lot.lotNo} is ${lot.status}; it never moves again`, details);
  }
  const source = InboundSource[type];
  if (source && lot.source !== source) {
    throw new AppError('VALIDATION_FAILED', `A ${type} goes into a lot made for it (lot ${lot.lotNo} comes from ${lot.source})`, details);
  }
  if (type === 'SALES_RETURN' && lot.status !== 'HOLD') {
    throw new AppError('VALIDATION_FAILED', `A customer return enters its return lot while it is on HOLD (lot ${lot.lotNo} is ${lot.status})`, details);
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
  if (type === 'DISPATCH' && lot.source === 'PRODUCTION_OUTPUT' && !lot.batchClosedAt) {
    throw new AppError('BATCH_NOT_CLOSED', `Lot ${lot.lotNo}'s batch is not closed; it is dispatched after batch close`, details);
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

/**
 * A customer return: into a returns area, never more than was dispatched to THAT customer from the original lot
 * (and its re-released return lots), minus that customer's earlier returns (owner 2026-11-18; 0018). The original
 * lot is locked so concurrent returns and dispatches of the family are checked one after the other.
 */
async function assertReturnable(
  tx: Tx,
  actor: Actor,
  lot: repo.LotRow,
  locationId: string,
  qty: Decimal,
  customerId: string,
): Promise<void> {
  await assertReturnsArea(tx, actor.companyId, locationId);
  if (!lot.parentLotId) throw new AppError('VALIDATION_FAILED', `Lot ${lot.lotNo} is not a return lot`);
  await lockLotOrFail(tx, actor.companyId, lot.parentLotId);
  const { dispatched, returned } = await repo.dispatchedAndReturned(tx, lot.parentLotId, customerId);
  if (new Decimal(returned).plus(qty).gt(dispatched)) {
    throw new AppError(
      'RETURN_EXCEEDS_DISPATCH',
      `${quantity(dispatched)} was dispatched to this customer from this lot and ${quantity(returned)} already returned; ${quantity(qty)} more cannot be received`,
      { lotId: lot.id, customerId, dispatched: quantity(dispatched), returned: quantity(returned), requested: quantity(qty) },
    );
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
    locationId: m.toLocationId ?? m.fromLocationId,
    qty: m.qty,
    unitCost: m.unitCost,
    value: m.value,
    customerOwned: lot.ownerType === 'CUSTOMER',
    refDocType: m.refDocType,
    refDocId: m.refDocId,
    reasonCode: m.reasonCode,
    reversalOf: m.reversalOf,
  };
}
