// Valuation rules (owner decision 2026-11-18, Option A) as pure functions; the database computes the same
// (0015_movement_valuation.sql, tested in inventory-db.test.ts).
import { describe, expect, it } from 'vitest';
import { fgUnitCost, money, movementValue, nominalValue, roundMoney } from '../valuation';

const own = { customerOwned: false, lotQty: '0', lotValue: '0' };

describe('rounding', () => {
  it('rounds half-up (away from zero) to 2 decimals, as PostgreSQL round()', () => {
    expect([roundMoney('0.005').toFixed(2), roundMoney('-0.005').toFixed(2), roundMoney('0.0049').toFixed(2)]).toEqual(['0.01', '-0.01', '0.00']);
    expect(nominalValue('-1.2345', '3.33').toFixed(2)).toBe('4.11');
    expect(money('-0.001')).toBe('0.00');
  });

  it('FG unit cost = batch cost ÷ qty, rounded; zero quantity refused', () => {
    expect(fgUnitCost('1000.00', '3')).toBe('333.33');
    expect(fgUnitCost('2000.00', '3')).toBe('666.67');
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

  it('transfers move nominal value both ways, whatever the lot holds', () => {
    expect(movementValue({ ...own, type: 'TRANSFER_OUT', qty: '-1', unitCost: '0.03', lotQty: '1', lotValue: '0.01' })).toBe('-0.03');
    expect(movementValue({ ...own, type: 'TRANSFER_IN', qty: '1', unitCost: '0.03' })).toBe('0.03');
  });

  it('OUTPUT takes the exact batch cost, consistent with the lot unit cost; only OUTPUT takes a value', () => {
    expect(movementValue({ ...own, type: 'OUTPUT', qty: '3', unitCost: '333.33', outputValue: '1000.00' })).toBe('1000.00');
    for (const outputValue of [undefined, '1000.02', '-1', '1000.001']) {
      expect(() => movementValue({ ...own, type: 'OUTPUT', qty: '3', unitCost: '333.33', outputValue })).toThrow(
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
