// Valuation rules (owner decision 2026-11-18, Option A) as pure functions; the database computes the same
// (0015_movement_valuation.sql, tested in inventory-db.test.ts).
import { describe, expect, it } from 'vitest';
import { fgUnitCost, money, movementValue, nominalValue, roundMoney, roundRate, unitRate } from '../valuation';

const own = { customerOwned: false, lotQty: '0', lotValue: '0' };

describe('rounding', () => {
  it('rounds half-up (away from zero) to 2 decimals, as PostgreSQL round()', () => {
    expect([roundMoney('0.005').toFixed(2), roundMoney('-0.005').toFixed(2), roundMoney('0.0049').toFixed(2)]).toEqual(['0.01', '-0.01', '0.00']);
    expect(nominalValue('-1.2345', '3.33').toFixed(2)).toBe('4.11');
    expect(money('-0.001')).toBe('0.00');
  });

  it('unit rates round half-up to 6 decimals (owner 2026-11-25)', () => {
    expect([roundRate('0.0350004').toFixed(6), roundRate('0.0350005').toFixed(6), roundRate('-0.0000005').toFixed(6)]).toEqual(['0.035000', '0.035001', '-0.000001']);
    expect([unitRate('0.035'), unitRate('12.5'), unitRate('0')]).toEqual(['0.035000', '12.500000', '0.000000']);
  });

  it('FG unit cost = batch cost ÷ qty, rounded to 6 decimals; zero quantity refused', () => {
    expect(fgUnitCost('1000.00', '3')).toBe('333.333333');
    expect(fgUnitCost('2000.00', '3')).toBe('666.666667');
    expect(() => fgUnitCost('1', '0')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});

describe('movementValue', () => {
  it('inbound: qty × unit cost', () => {
    expect(movementValue({ ...own, type: 'RECEIPT', qty: '0.5', unitCost: '0.01' })).toBe('0.01');
  });

  it('outbound: nominal, capped at what the lot holds; the movement that empties the lot takes the residual', () => {
    expect(movementValue({ ...own, type: 'ISSUE', qty: '-0.5', unitCost: '0.03', lotQty: '1', lotValue: '0.03' })).toBe('-0.02');
    expect(movementValue({ ...own, type: 'ISSUE', qty: '-0.5', unitCost: '0.03', lotQty: '0.5', lotValue: '0.01' })).toBe('-0.01');
    expect(movementValue({ ...own, type: 'ISSUE', qty: '-0.2', unitCost: '0.03', lotQty: '0.25', lotValue: '0' })).toBe('0.00');
    expect(movementValue({ ...own, type: 'DISPATCH', qty: '-2', unitCost: '333.33', lotQty: '2', lotValue: '666.67' })).toBe('-666.67');
  });

  it('a 0.035 PKR label: amounts round to 2 decimals per movement; the last one takes the residual', () => {
    const label = { ...own, unitCost: '0.035000' };
    expect(movementValue({ ...label, type: 'RECEIPT', qty: '10000' })).toBe('350.00');
    expect(movementValue({ ...label, type: 'RECEIPT', qty: '1' })).toBe('0.04'); // 0.035 → 0.04 half-up
    expect(movementValue({ ...label, type: 'ISSUE', qty: '-3', lotQty: '10000', lotValue: '350.00' })).toBe('-0.11'); // 0.105
    expect(movementValue({ ...label, type: 'ISSUE', qty: '-7', lotQty: '9997', lotValue: '349.89' })).toBe('-0.25'); // 0.245
    expect(movementValue({ ...label, type: 'ISSUE', qty: '-9990', lotQty: '9990', lotValue: '349.64' })).toBe('-349.64'); // residual
    // Before 2026-11-25 the cost would have had to be 0.04 (or 0.03): 400.00 / 300.00 for the same 10,000 labels.
  });

  it('transfers move nominal value both ways, whatever the lot holds', () => {
    expect(movementValue({ ...own, type: 'TRANSFER_OUT', qty: '-1', unitCost: '0.03', lotQty: '1', lotValue: '0.01' })).toBe('-0.03');
    expect(movementValue({ ...own, type: 'TRANSFER_IN', qty: '1', unitCost: '0.03' })).toBe('0.03');
  });

  it('OUTPUT takes the exact batch cost, consistent with the lot unit cost; only OUTPUT takes a value', () => {
    expect(movementValue({ ...own, type: 'OUTPUT', qty: '3', unitCost: '333.333333', outputValue: '1000.00' })).toBe('1000.00');
    for (const outputValue of [undefined, '1000.01', '-1', '1000.001']) {
      expect(() => movementValue({ ...own, type: 'OUTPUT', qty: '3', unitCost: '333.333333', outputValue })).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    }
    expect(() => movementValue({ ...own, type: 'RECEIPT', qty: '1', unitCost: '1', outputValue: '1' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it('customer-owned or zero-cost stock: always 0 (rule 12)', () => {
    expect(movementValue({ ...own, customerOwned: true, type: 'RECEIPT', qty: '10', unitCost: '0' })).toBe('0.00');
    expect(movementValue({ ...own, customerOwned: true, type: 'OUTPUT', qty: '10', unitCost: '0' })).toBe('0.00');
    expect(() => movementValue({ ...own, customerOwned: true, type: 'OUTPUT', qty: '10', unitCost: '0', outputValue: '5' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });
});
