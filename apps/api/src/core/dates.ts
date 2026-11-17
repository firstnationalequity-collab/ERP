// Business dates are 'YYYY-MM-DD' in the company time zone (Asia/Karachi), never the server's or UTC's
// calendar day: a document made at 02:00 PKT on 1 July belongs to the new fiscal year.
import { env } from '../config/env';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: env.COMPANY_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's business date in the company time zone, as 'YYYY-MM-DD'. */
export function companyToday(now: Date = new Date()): string {
  return formatter.format(now);
}
