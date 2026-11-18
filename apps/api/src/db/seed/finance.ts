// Finance seed (M2 task 4): PLACEHOLDER chart of accounts, default posting rules and PLACEHOLDER tax codes.
// Fiscal periods are NOT seeded: a period's first status must go through core/transition with core.period.manage,
// which SYSTEM does not hold, so the Finance Manager creates FY 2026-27 on the Fiscal periods page. Everything here is marked is_placeholder until Finance confirms it (decisions
// M2 Q3 and Q6; Handoff "Open questions"). Idempotent: each account / rule / tax code is added only when its
// key is missing (deactivated rows count as present), so the seed never re-adds what Finance retired and never
// changes what Finance edited.
import { isNull } from 'drizzle-orm';
import { PostingEventRoles, type AccountRole, type AccountType, type PostingEvent, type TaxKind } from '@albert/shared';
import type { Tx } from '../client';
import { accounts, postingRules } from '../schema/fin';
import { taxCodes } from '../schema/masters';

interface AccountSeed {
  code: string;
  name: string;
  type: AccountType;
  parent?: string;
  header?: boolean;
}

/** PLACEHOLDER chart: just enough structure for the §6 posting events. Finance's real chart replaces it (M11 import). */
export const PLACEHOLDER_ACCOUNTS: readonly AccountSeed[] = [
  { code: '1000', name: 'Assets', type: 'ASSET', header: true },
  { code: '1100', name: 'Cash and bank', type: 'ASSET', parent: '1000', header: true },
  { code: '1110', name: 'Cash in hand', type: 'ASSET', parent: '1100' },
  { code: '1120', name: 'Bank - current account', type: 'ASSET', parent: '1100' },
  { code: '1200', name: 'Receivables and tax assets', type: 'ASSET', parent: '1000', header: true },
  { code: '1210', name: 'Trade receivables', type: 'ASSET', parent: '1200' },
  { code: '1220', name: 'Income tax withheld by customers', type: 'ASSET', parent: '1200' },
  { code: '1230', name: 'Input sales tax', type: 'ASSET', parent: '1200' },
  { code: '1300', name: 'Stock in trade', type: 'ASSET', parent: '1000', header: true },
  { code: '1310', name: 'Stock - all item categories', type: 'ASSET', parent: '1300' },
  { code: '1320', name: 'Work in process', type: 'ASSET', parent: '1300' },
  { code: '2000', name: 'Liabilities', type: 'LIABILITY', header: true },
  { code: '2100', name: 'Trade and other payables', type: 'LIABILITY', parent: '2000', header: true },
  { code: '2110', name: 'Trade payables', type: 'LIABILITY', parent: '2100' },
  { code: '2120', name: 'Goods received not invoiced (GRNI)', type: 'LIABILITY', parent: '2100' },
  { code: '2130', name: 'Landed cost clearing (customs, freight, clearing)', type: 'LIABILITY', parent: '2100' },
  { code: '2200', name: 'Taxes payable', type: 'LIABILITY', parent: '2000', header: true },
  { code: '2210', name: 'Output sales tax', type: 'LIABILITY', parent: '2200' },
  { code: '2220', name: 'Income tax withheld from suppliers', type: 'LIABILITY', parent: '2200' },
  { code: '3000', name: 'Equity', type: 'EQUITY', header: true },
  { code: '3100', name: 'Share capital', type: 'EQUITY', parent: '3000' },
  { code: '3200', name: 'Retained earnings', type: 'EQUITY', parent: '3000' },
  { code: '4000', name: 'Income', type: 'INCOME', header: true },
  { code: '4100', name: 'Sales - own products', type: 'INCOME', parent: '4000' },
  { code: '4200', name: 'Conversion revenue - toll manufacturing', type: 'INCOME', parent: '4000' },
  { code: '4300', name: 'Stock gain on adjustment', type: 'INCOME', parent: '4000' },
  { code: '5000', name: 'Cost of sales', type: 'EXPENSE', header: true },
  { code: '5100', name: 'Cost of goods sold', type: 'EXPENSE', parent: '5000' },
  { code: '5200', name: 'Purchase price variance', type: 'EXPENSE', parent: '5000' },
  { code: '5300', name: 'Labour absorbed', type: 'EXPENSE', parent: '5000' },
  { code: '5310', name: 'Machine overhead absorbed', type: 'EXPENSE', parent: '5000' },
  { code: '6000', name: 'Operating expenses', type: 'EXPENSE', header: true },
  { code: '6100', name: 'Stock loss on adjustment', type: 'EXPENSE', parent: '6000' },
  { code: '6200', name: 'Rejected material write-off', type: 'EXPENSE', parent: '6000' },
];

/** Default account per role (rules with no item category). Finance adds per-category rules, e.g. INVENTORY by category. */
export const PLACEHOLDER_ROLE_ACCOUNTS: Readonly<Record<AccountRole, string>> = {
  INVENTORY: '1310',
  WIP: '1320',
  GRNI: '2120',
  PRICE_VARIANCE: '5200',
  LANDED_COST_CLEARING: '2130',
  INPUT_TAX: '1230',
  ACCOUNTS_PAYABLE: '2110',
  BANK: '1120',
  WHT_PAYABLE: '2220',
  LABOUR_ABSORBED: '5300',
  OVERHEAD_ABSORBED: '5310',
  COGS: '5100',
  ACCOUNTS_RECEIVABLE: '1210',
  SALES_REVENUE: '4100',
  CONVERSION_REVENUE: '4200',
  OUTPUT_TAX: '2210',
  WHT_RECEIVABLE: '1220',
  INVENTORY_LOSS: '6100',
  INVENTORY_GAIN: '4300',
  REJECTION_WRITE_OFF: '6200',
};

/**
 * PLACEHOLDER tax codes (M2 Q6). The WHT rates are unverified: rates differ for filers / non-filers and companies,
 * and Finance will supply them (owner, 18-11-2026). Until Finance clears is_placeholder, posting any WHT is refused
 * (TAX_RATE_NOT_CONFIRMED, migration 0013).
 */
export const PLACEHOLDER_TAX_CODES: readonly { code: string; name: string; kind: TaxKind; rate: string }[] = [
  { code: 'ST-18', name: 'Sales tax - standard rate', kind: 'SALES_TAX', rate: '18' },
  { code: 'WHT-153-1A', name: 'WHT s.153(1)(a) - supply of goods - RATE NOT CONFIRMED', kind: 'WITHHOLDING', rate: '4' },
  { code: 'WHT-153-1B', name: 'WHT s.153(1)(b) - services - RATE NOT CONFIRMED', kind: 'WITHHOLDING', rate: '8' },
];

export interface FinanceSeedReport {
  accountsCreated: string[];
  postingRulesCreated: string[];
  taxCodesCreated: string[];
}

export async function seedFinance(tx: Tx, report: FinanceSeedReport): Promise<void> {
  await seedAccounts(tx, report);
  await seedPostingRules(tx, report);
  await seedTaxCodes(tx, report);
}

async function seedAccounts(tx: Tx, report: FinanceSeedReport): Promise<void> {
  const ids = new Map((await tx.select({ id: accounts.id, code: accounts.code }).from(accounts)).map((a) => [a.code, a.id]));
  for (const a of PLACEHOLDER_ACCOUNTS) {
    if (ids.has(a.code)) continue;
    const parentId = a.parent ? ids.get(a.parent) : undefined;
    if (a.parent && !parentId) throw new Error(`Seed: parent account ${a.parent} missing for ${a.code}`);
    const [row] = await tx
      .insert(accounts)
      .values({ code: a.code, name: a.name, type: a.type, parentId: parentId ?? null, isPostable: !a.header, isPlaceholder: true })
      .returning({ id: accounts.id });
    if (!row) throw new Error('account insert returned no row');
    ids.set(a.code, row.id);
    report.accountsCreated.push(a.code);
  }
}

async function seedPostingRules(tx: Tx, report: FinanceSeedReport): Promise<void> {
  const accountIds = new Map((await tx.select({ id: accounts.id, code: accounts.code }).from(accounts)).map((a) => [a.code, a.id]));
  const existing = new Set(
    (
      await tx
        .select({ event: postingRules.event, role: postingRules.accountRole })
        .from(postingRules)
        .where(isNull(postingRules.itemCategoryId))
    ).map((r) => `${r.event}/${r.role}`),
  );
  for (const [event, roles] of Object.entries(PostingEventRoles) as [PostingEvent, readonly AccountRole[]][]) {
    for (const role of roles) {
      if (existing.has(`${event}/${role}`)) continue;
      const accountId = accountIds.get(PLACEHOLDER_ROLE_ACCOUNTS[role]);
      if (!accountId) throw new Error(`Seed: account ${PLACEHOLDER_ROLE_ACCOUNTS[role]} missing for ${event}/${role}`);
      await tx.insert(postingRules).values({ event, accountRole: role, accountId, isPlaceholder: true });
      report.postingRulesCreated.push(`${event}/${role}`);
    }
  }
}

async function seedTaxCodes(tx: Tx, report: FinanceSeedReport): Promise<void> {
  const existing = new Set((await tx.select({ code: taxCodes.code }).from(taxCodes)).map((t) => t.code));
  for (const t of PLACEHOLDER_TAX_CODES) {
    if (existing.has(t.code)) continue;
    await tx.insert(taxCodes).values({ ...t, isPlaceholder: true });
    report.taxCodesCreated.push(t.code);
  }
}

