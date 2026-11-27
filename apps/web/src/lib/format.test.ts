import { describe, expect, it } from 'vitest';
import { decimalSign, formatDate, formatDateTime, formatDecimal, formatPKR, formatRate } from './format';

describe('display formats (DD-MM-YYYY, Asia/Karachi, PKR)', () => {
  it('shows business dates as DD-MM-YYYY without shifting the day', () => {
    expect(formatDate('2026-07-01')).toBe('01-07-2026');
    expect(formatDate(null)).toBe('');
  });

  it('shows timestamps in Karachi time (UTC+5)', () => {
    expect(formatDateTime('2026-06-30T19:30:00Z')).toBe('01-07-2026 00:30');
  });

  it('groups thousands and fixes decimals using strings only (no float error)', () => {
    expect(formatDecimal('5000000.01')).toBe('5,000,000.01');
    expect(formatDecimal('0.1')).toBe('0.10');
    expect(formatDecimal('999.995')).toBe('1,000.00');
    expect(formatDecimal('12345678901234.5678', 4)).toBe('12,345,678,901,234.5678');
    expect(formatDecimal('-1500')).toBe('-1,500.00');
    expect(formatPKR('561000.0000')).toBe('PKR 561,000.00');
  });
});

describe('unit rates (owner 2026-11-25: 6 decimals)', () => {
  it('shows 2 to 6 decimals, dropping trailing zeros', () => {
    expect(formatRate('0.035000')).toBe('0.035');
    expect(formatRate('1250.500000')).toBe('1,250.50');
    expect(formatRate('333.333333')).toBe('333.333333');
    expect(formatRate('12')).toBe('12.00');
    expect(formatRate(null)).toBe('');
  });
});

describe('decimalSign (rule 10: no JS numbers for amounts or quantities)', () => {
  it('reads the sign from the digits', () => {
    expect(decimalSign('0.0000')).toBe(0);
    expect(decimalSign('-0.00')).toBe(0);
    expect(decimalSign('0')).toBe(0);
    expect(decimalSign('0.0001')).toBe(1);
    expect(decimalSign('-0.01')).toBe(-1);
    expect(decimalSign('12345678901234567.89')).toBe(1);
    expect(decimalSign(' 5 ')).toBe(1);
  });
  it('refuses what is not a decimal', () => {
    expect(() => decimalSign('')).toThrow();
    expect(() => decimalSign('1e5')).toThrow();
    expect(() => decimalSign('abc')).toThrow();
  });
});
