import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatDecimal, formatPKR } from './format';

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
