import { describe, expect, it } from 'vitest';
import { fiscalYearOf, formatDocNo, lastDayOfMonth, parseLabelDate, monthlyPeriods, numberPatternErrors, numberPeriodKey } from './fiscal';

describe('fiscal year (July–June)', () => {
  it('puts 30-06-2027 in FY 2026-27 and 01-07-2027 in FY 2027-28', () => {
    expect(fiscalYearOf('2027-06-30')).toMatchObject({ label: '2026-27', code: '2627', startDate: '2026-07-01', endDate: '2027-06-30' });
    expect(fiscalYearOf('2027-07-01')).toMatchObject({ label: '2027-28', code: '2728' });
    expect(fiscalYearOf('2099-12-31').code).toBe('9900');
  });

  it('builds 12 contiguous monthly periods from July, with leap-year February', () => {
    const periods = monthlyPeriods(fiscalYearOf('2027-11-17'));
    expect(periods).toHaveLength(12);
    expect(periods[0]).toEqual({ periodNo: 1, name: 'Jul-2027', startDate: '2027-07-01', endDate: '2027-07-31' });
    expect(periods[7]).toEqual({ periodNo: 8, name: 'Feb-2028', startDate: '2028-02-01', endDate: '2028-02-29' });
    expect(periods[11]).toEqual({ periodNo: 12, name: 'Jun-2028', startDate: '2028-06-01', endDate: '2028-06-30' });
  });

  it('refuses impossible dates', () => {
    expect(() => fiscalYearOf('2026-02-30')).toThrow();
    expect(() => fiscalYearOf('17-11-2026')).toThrow();
  });
});

describe('document numbers (Q16)', () => {
  it('formats the documented defaults', () => {
    expect(formatDocNo('{PREFIX}-{FY}-{SEQ:5}', { prefix: 'PO', date: '2026-11-17', seq: 42 })).toBe('PO-2627-00042');
    expect(formatDocNo('AP{YY}-{SEQ:4}', { prefix: 'AP', date: '2026-11-17', seq: 1 })).toBe('AP26-0001');
    expect(formatDocNo('{PREFIX}/{YYYY}/{SEQ:3}', { prefix: 'JV', date: '2027-01-05', seq: 1234 })).toBe('JV/2027/1234');
  });

  it('chooses the counter bucket from the reset rule', () => {
    expect(numberPeriodKey('FISCAL_YEAR', '2027-06-30')).toBe('2627');
    expect(numberPeriodKey('FISCAL_YEAR', '2027-07-01')).toBe('2728');
    expect(numberPeriodKey('CALENDAR_YEAR', '2026-12-31')).toBe('2026');
    expect(numberPeriodKey('NEVER', '2026-12-31')).toBe('ALL');
  });

  it('accepts valid patterns and refuses ones that would repeat numbers', () => {
    expect(numberPatternErrors('{PREFIX}-{FY}-{SEQ:5}', 'FISCAL_YEAR')).toEqual([]);
    expect(numberPatternErrors('AP{YY}-{SEQ:4}', 'CALENDAR_YEAR')).toEqual([]);
    expect(numberPatternErrors('{PREFIX}-{SEQ:6}', 'NEVER')).toEqual([]);
    expect(numberPatternErrors('{PREFIX}-{SEQ:5}', 'FISCAL_YEAR')).toContain(
      'A series that resets each fiscal year must contain {FY}, or numbers would repeat',
    );
    expect(numberPatternErrors('{PREFIX}-{FY}-{SEQ:5}', 'CALENDAR_YEAR')[0]).toMatch(/calendar year/);
    expect(numberPatternErrors('{PREFIX}-{FY}', 'FISCAL_YEAR')).toContain('The pattern must contain exactly one {SEQ:n}');
    expect(numberPatternErrors('{PREFIX}-{FY}-{SEQ}', 'FISCAL_YEAR')).toContain('{SEQ:n} needs a width n from 1 to 10');
    expect(numberPatternErrors('{PREFIX}-{MONTH}-{FY}-{SEQ:5}', 'FISCAL_YEAR')).toContain('Unknown token {MONTH}');
    expect(numberPatternErrors('PO {FY} {SEQ:5}', 'FISCAL_YEAR')[0]).toMatch(/Only letters/);
  });
});

describe('label dates (expiry / retest as printed on a CoA)', () => {
  it('stores a month-and-year date as the last day of that month', () => {
    expect(parseLabelDate('06-2028')).toBe('2028-06-30');
    expect(parseLabelDate('2-2028')).toBe('2028-02-29');
    expect(parseLabelDate('02-2027')).toBe('2027-02-28');
    expect(parseLabelDate('12/2027')).toBe('2027-12-31');
    expect(lastDayOfMonth(2026, 11)).toBe('2026-11-30');
  });

  it('keeps a full date as given', () => {
    expect(parseLabelDate('15-06-2028')).toBe('2028-06-15');
    expect(parseLabelDate('2028-06-15')).toBe('2028-06-15');
  });

  it('refuses impossible months and dates', () => {
    expect(parseLabelDate('13-2028')).toBeNull();
    expect(parseLabelDate('00-2028')).toBeNull();
    expect(parseLabelDate('31-02-2028')).toBeNull();
    expect(parseLabelDate('June 2028')).toBeNull();
  });
});
