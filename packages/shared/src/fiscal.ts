// Fiscal calendar and document-number patterns (docs/architecture.md §7.1; decision Q16).
// Fiscal year runs July–June: FY 2026-27 = 01-07-2026 .. 30-06-2027, {FY} = "2627".
// Business dates are 'YYYY-MM-DD' strings (DATE columns), never JS Date, to avoid time-zone shifts.

export const FISCAL_YEAR_START_MONTH = 7; // July

import type { NumberSeriesReset } from './enums';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseBusinessDate(date: string): { year: number; month: number; day: number } {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`Invalid date ${date}; expected YYYY-MM-DD`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`Invalid date ${date}`);
  }
  return { year, month, day };
}

export interface FiscalYear {
  /** Calendar year in which the fiscal year starts (2026 for FY 2026-27). */
  startYear: number;
  /** "2026-27" */
  label: string;
  /** "2627" — the {FY} token */
  code: string;
  startDate: string;
  endDate: string;
}

export function fiscalYearStarting(startYear: number): FiscalYear {
  const end = startYear + 1;
  const yy = (n: number) => String(n % 100).padStart(2, '0');
  return {
    startYear,
    label: `${startYear}-${yy(end)}`,
    code: `${yy(startYear)}${yy(end)}`,
    startDate: `${startYear}-07-01`,
    endDate: `${end}-06-30`,
  };
}

export function fiscalYearOf(date: string): FiscalYear {
  const { year, month } = parseBusinessDate(date);
  return fiscalYearStarting(month >= FISCAL_YEAR_START_MONTH ? year : year - 1);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The 12 monthly periods of a fiscal year, July first. */
export function monthlyPeriods(fy: FiscalYear): { periodNo: number; name: string; startDate: string; endDate: string }[] {
  const periods = [];
  for (let i = 0; i < 12; i += 1) {
    const monthIndex = (FISCAL_YEAR_START_MONTH - 1 + i) % 12; // 0-based
    const year = fy.startYear + (FISCAL_YEAR_START_MONTH - 1 + i >= 12 ? 1 : 0);
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    const mm = String(monthIndex + 1).padStart(2, '0');
    periods.push({
      periodNo: i + 1,
      name: `${MONTHS[monthIndex]}-${year}`,
      startDate: `${year}-${mm}-01`,
      endDate: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
    });
  }
  return periods;
}

// ---------------------------------------------------------------- number patterns

const TOKEN_RE = /\{([A-Z]+)(?::(\d+))?\}/g;
const KNOWN_TOKENS = new Set(['PREFIX', 'FY', 'YYYY', 'YY', 'SEQ']);

/** Rules a pattern must meet so numbers can never repeat. Empty list = valid. */
export function numberPatternErrors(pattern: string, reset: NumberSeriesReset): string[] {
  const errors: string[] = [];
  const tokens = [...pattern.matchAll(TOKEN_RE)];
  const names = tokens.map((t) => t[1] ?? '');
  for (const name of names) if (!KNOWN_TOKENS.has(name)) errors.push(`Unknown token {${name}}`);
  const seq = tokens.filter((t) => t[1] === 'SEQ');
  if (seq.length !== 1) errors.push('The pattern must contain exactly one {SEQ:n}');
  for (const t of seq) {
    const width = Number(t[2] ?? 0);
    if (!t[2] || width < 1 || width > 10) errors.push('{SEQ:n} needs a width n from 1 to 10');
  }
  if (reset === 'FISCAL_YEAR' && !names.includes('FY')) {
    errors.push('A series that resets each fiscal year must contain {FY}, or numbers would repeat');
  }
  if (reset === 'CALENDAR_YEAR' && !names.includes('YYYY') && !names.includes('YY')) {
    errors.push('A series that resets each calendar year must contain {YYYY} or {YY}, or numbers would repeat');
  }
  const literal = pattern.replace(TOKEN_RE, '');
  if (!/^[A-Za-z0-9\-/_.]*$/.test(literal)) errors.push('Only letters, digits and - / _ . are allowed outside tokens');
  if (pattern.length > 60) errors.push('Pattern is too long');
  return errors;
}

/** The counter bucket a document date falls in, for the series' reset rule. */
export function numberPeriodKey(reset: NumberSeriesReset, date: string): string {
  if (reset === 'FISCAL_YEAR') return fiscalYearOf(date).code;
  if (reset === 'CALENDAR_YEAR') return String(parseBusinessDate(date).year);
  return 'ALL';
}

export function formatDocNo(pattern: string, values: { prefix: string; date: string; seq: number }): string {
  const { year } = parseBusinessDate(values.date);
  const fy = fiscalYearOf(values.date);
  return pattern.replace(TOKEN_RE, (_m, name: string, width?: string) => {
    switch (name) {
      case 'PREFIX':
        return values.prefix;
      case 'FY':
        return fy.code;
      case 'YYYY':
        return String(year);
      case 'YY':
        return String(year % 100).padStart(2, '0');
      case 'SEQ':
        return String(values.seq).padStart(Number(width ?? 1), '0');
      default:
        throw new Error(`Unknown token {${name}}`);
    }
  });
}

/** Last calendar day of a month: (2028, 2) → "2028-02-29". */
export function lastDayOfMonth(year: number, month: number): string {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || year < 1900 || year > 9999) {
    throw new Error(`Invalid month ${month}-${year}`);
  }
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * An expiry or retest date as printed on a CoA or label (verification list, QA, 27-11-2026). A month and year only
 * ("MM-YYYY") means the last day of that month; a full date may be given as "DD-MM-YYYY" or "YYYY-MM-DD".
 * Returns the business date "YYYY-MM-DD", or null when the text is not a valid date.
 */
export function parseLabelDate(text: string): string | null {
  const t = text.trim().replace(/\//g, '-');
  let iso: string | undefined;
  const monthOnly = /^(\d{1,2})-(\d{4})$/.exec(t);
  if (monthOnly) {
    const month = Number(monthOnly[1]);
    return month >= 1 && month <= 12 ? lastDayOfMonth(Number(monthOnly[2]), month) : null;
  }
  const dmy = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(t);
  if (dmy) iso = `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  else if (DATE_RE.test(t)) iso = t;
  if (!iso) return null;
  try {
    parseBusinessDate(iso);
    return iso;
  } catch {
    return null;
  }
}
