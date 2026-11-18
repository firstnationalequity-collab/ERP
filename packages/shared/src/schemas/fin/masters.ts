// Finance masters API (/api/v1/fin/*): chart of accounts, cost centres, posting rules. M2 task 4.
// Rules mirror apps/api/src/db/migrations/0012_finance_masters.sql. Tax codes stay under /api/v1/master/tax-codes.
import { z } from 'zod';
import { AccountRole, AccountType, PostingEvent, PostingEventRoles } from '../../enums';

const id = z.string().regex(/^\d+$/, 'Invalid id');
const name = z.string().trim().min(1, 'Name is required').max(200);
const accountCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9A-Z][0-9A-Z.-]{0,19}$/, 'Account code: up to 20 digits, capital letters, . or -');
const costCenterCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/, 'Code: capital letters, digits and - _ only, starting with a letter or digit');

interface Stamped {
  id: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export const FinListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  search: z.string().trim().max(100).optional(),
  active: z.enum(['active', 'inactive', 'all']).default('all'),
  /** Accounts: filter by type. */
  accountType: z.enum(AccountType).optional(),
  /** Posting rules: filter by event. */
  event: z.enum(PostingEvent).optional(),
});
export type FinListQuery = z.infer<typeof FinListQuery>;

// ---------------------------------------------------------------- accounts

export const CreateAccountRequest = z
  .object({
    code: accountCode,
    name,
    type: z.enum(AccountType),
    parentId: id.nullable().optional(),
    /** false = header account: groups sub-accounts and takes no journal lines. */
    isPostable: z.boolean().default(true),
  })
  .strict();
export type CreateAccountRequest = z.infer<typeof CreateAccountRequest>;

/** Code and type never change. A placeholder flag can only be cleared (Finance confirms the account). */
export const UpdateAccountRequest = z
  .object({
    name: name.optional(),
    parentId: id.nullable().optional(),
    isPostable: z.boolean().optional(),
    isPlaceholder: z.literal(false).optional(),
  })
  .strict();
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequest>;

export interface AccountDto extends Stamped {
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  isPostable: boolean;
  isPlaceholder: boolean;
  isActive: boolean;
}

// ---------------------------------------------------------------- cost centres

export const CreateCostCenterRequest = z.object({ code: costCenterCode, name }).strict();
export type CreateCostCenterRequest = z.infer<typeof CreateCostCenterRequest>;
export const UpdateCostCenterRequest = z.object({ name }).strict();
export type UpdateCostCenterRequest = z.infer<typeof UpdateCostCenterRequest>;

export interface CostCenterDto extends Stamped {
  code: string;
  name: string;
  isActive: boolean;
}

// ---------------------------------------------------------------- posting rules

export const CreatePostingRuleRequest = z
  .object({
    event: z.enum(PostingEvent),
    accountRole: z.enum(AccountRole),
    /** null / omitted = the default for every item category. */
    itemCategoryId: id.nullable().optional(),
    accountId: id,
  })
  .strict()
  .refine((r) => PostingEventRoles[r.event].includes(r.accountRole), {
    message: 'This account role is not used by the event',
    path: ['accountRole'],
  });
export type CreatePostingRuleRequest = z.infer<typeof CreatePostingRuleRequest>;

/** Event, role and category never change; point the rule at another account instead. */
export const UpdatePostingRuleRequest = z
  .object({ accountId: id.optional(), isPlaceholder: z.literal(false).optional() })
  .strict();
export type UpdatePostingRuleRequest = z.infer<typeof UpdatePostingRuleRequest>;

export interface PostingRuleDto extends Stamped {
  event: PostingEvent;
  accountRole: AccountRole;
  itemCategoryId: string | null;
  accountId: string;
  accountCode: string;
  accountName: string;
  isPlaceholder: boolean;
  isActive: boolean;
}
