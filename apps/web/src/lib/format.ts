// Display rules (CLAUDE.md): dates DD-MM-YYYY, times in Asia/Karachi, currency PKR with thousand
// separators. Money/quantities arrive as decimal strings and are formatted as strings — never JS floats.
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

export const COMPANY_TZ = 'Asia/Karachi';

/** ISO timestamp (UTC) → "17-11-2026 14:05" in Karachi time. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return dayjs(iso).tz(COMPANY_TZ).format('DD-MM-YYYY HH:mm');
}

/** Business date "2026-11-17" → "17-11-2026" (no time-zone shift: it is already a date). */
export function formatDate(date: string | null | undefined): string {
  if (!date) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : date;
}

/** "DD-MM-YYYY" or a dayjs date → business date "YYYY-MM-DD" (for API filters). */
export function toBusinessDate(d: dayjs.Dayjs): string {
  return d.format('YYYY-MM-DD');
}

/** Today in Karachi as "YYYY-MM-DD". */
export function companyToday(): string {
  return dayjs().tz(COMPANY_TZ).format('YYYY-MM-DD');
}

/**
 * Decimal string → grouped string with fixed decimals, by string manipulation only.
 * "1234567.5" → "1,234,567.50". Rounds half-up on the last kept digit.
 */
export function formatDecimal(value: string | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || value === '') return '';
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return value;
  const sign = m[1] ?? '';
  let intPart = m[2] ?? '0';
  let frac = m[3] ?? '';
  if (frac.length > decimals) {
    const roundUp = Number(frac[decimals]) >= 5;
    frac = frac.slice(0, decimals);
    if (roundUp) {
      // Add one unit in the last kept place, carrying through the digits.
      const digits = (intPart + frac).split('').map(Number);
      let i = digits.length - 1;
      while (i >= 0) {
        if (digits[i]! < 9) {
          digits[i]! += 1;
          break;
        }
        digits[i] = 0;
        i -= 1;
      }
      let all = digits.join('');
      if (i < 0) all = `1${all}`;
      intPart = all.slice(0, all.length - decimals) || '0';
      frac = all.slice(all.length - decimals);
    }
  }
  frac = frac.padEnd(decimals, '0');
  const grouped = intPart.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decimals > 0 ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`;
}

export function formatPKR(value: string | null | undefined): string {
  const s = formatDecimal(value, 2);
  return s ? `PKR ${s}` : '';
}
