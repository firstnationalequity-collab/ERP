// Stock valuation: lot-actual cost (architecture §6) with the owner's rounding rules (decision 2026-11-18,
// "Rounding of stock values", Option A; unit costs are 6-decimal rates since owner 2026-11-25, 0024).
// Pure functions on decimal strings; never JS floats (rule 10).
// The database computes the same values (0015_movement_valuation.sql) and refuses any other.
//
//  - unit cost = a rate with 6 decimals; value = qty × lot unit cost, rounded half-up to 2 decimals;
//  - last-out: the outbound movement that empties the lot takes the residual (minus the lot's value so far);
//  - an outbound movement never takes more value than the lot still holds (agent default, PENDING OWNER);
//  - OUTPUT (finished goods): the exact batch cost; the lot's unit cost = batch cost ÷ qty, rounded to 6 decimals;
//  - transfers: out and in at qty × unit cost (net zero for the lot);
//  - customer-owned (toll) or zero-cost stock: 0 (rule 12).
import { Decimal } from 'decimal.js';
import type { StockMovementType } from '@albert/shared';
import { AppError } from '../../core/errors';

const Dec = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type Value = Decimal.Value;

/** Money to 2 decimals, half-up (half away from zero, as PostgreSQL round()). */
export function roundMoney(v: Value): Decimal {
  return new Dec(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/** NUMERIC(18,2) text, without a "-0.00". */
export function money(v: Value): string {
  const d = roundMoney(v);
  return d.isZero() ? '0.00' : d.toFixed(2);
}

/** A unit rate (unit cost or unit price) to 6 decimals, half-up. */
export function roundRate(v: Value): Decimal {
  return new Dec(v).toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
}

/** NUMERIC(18,6) text of a unit rate. */
export function unitRate(v: Value): string {
  const d = roundRate(v);
  return d.isZero() ? '0.000000' : d.toFixed(6);
}

/** NUMERIC(18,4) text. */
export function quantity(v: Value): string {
  const d = new Dec(v);
  return d.isZero() ? '0.0000' : d.toFixed(4);
}

/** |qty| × unit cost, rounded half-up to 2 decimals. */
export function nominalValue(qty: Value, unitCost: Value): Decimal {
  return roundMoney(new Dec(qty).abs().times(unitCost));
}

/** Unit cost of a finished-goods lot: the batch cost ÷ the output quantity, rounded half-up to 6 decimals. */
export function fgUnitCost(batchCost: Value, qty: Value): string {
  const q = new Dec(qty);
  if (q.lte(0)) throw new AppError('VALIDATION_FAILED', 'Output quantity must be greater than zero');
  return unitRate(new Dec(batchCost).div(q));
}

export interface ValuationInput {
  type: StockMovementType;
  /** Signed: + into stock, − out of stock. */
  qty: Value;
  /** The lot's unit cost. */
  unitCost: Value;
  /** Customer-owned (toll) stock: always zero value. */
  customerOwned: boolean;
  /** The lot's ledger totals before this movement (all locations). */
  lotQty: Value;
  lotValue: Value;
  /** OUTPUT only: the exact batch cost booked for this output. */
  outputValue?: Value;
}

/** The signed value of one (non-reversal) ledger row. */
export function movementValue(i: ValuationInput): string {
  const qty = new Dec(i.qty);
  const unitCost = new Dec(i.unitCost);
  if (i.customerOwned || unitCost.isZero()) {
    if (i.outputValue !== undefined && !new Dec(i.outputValue).isZero()) {
      throw new AppError('VALIDATION_FAILED', 'Customer-owned or zero-cost stock carries no value (rule 12)');
    }
    return '0.00';
  }

  if (i.type === 'OUTPUT') {
    if (i.outputValue === undefined) {
      throw new AppError('VALIDATION_FAILED', 'Finished-goods output is booked at the batch cost; give its value');
    }
    const value = new Dec(i.outputValue);
    if (value.decimalPlaces() > 2 || value.lt(0)) {
      throw new AppError('VALIDATION_FAILED', 'The batch cost is an amount ≥ 0 with at most 2 decimals');
    }
    if (!roundRate(value.div(qty)).equals(unitCost)) {
      throw new AppError('VALIDATION_FAILED', `The lot's unit cost (${unitRate(unitCost)}) must be the batch cost ÷ quantity (${fgUnitCost(value, qty)})`);
    }
    return money(value);
  }
  if (i.outputValue !== undefined) {
    throw new AppError('VALIDATION_FAILED', 'Only finished-goods output takes a given value; other movements are valued at the lot cost');
  }

  const nominal = nominalValue(qty, unitCost);
  if (i.type === 'TRANSFER_OUT' || i.type === 'TRANSFER_IN' || qty.gt(0)) {
    return money(qty.gt(0) ? nominal : nominal.neg());
  }
  const held = Decimal.max(new Dec(i.lotValue), 0);
  const empties = new Dec(i.lotQty).plus(qty).isZero();
  return money((empties ? held : Decimal.min(nominal, held)).neg());
}
