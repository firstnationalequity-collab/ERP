// Finance masters (M2 task 4): chart of accounts, cost centres, posting rules. Writes need fin.master.manage,
// reads fin.view or master.view (checked in the routes). Never deleted: deactivated with a reason.
// Rules (service first, database backstop in 0012_finance_masters.sql):
//  - account code and type never change; a parent is an active header account of the same type, never itself;
//  - a header (not postable) takes no journal lines; an account with lines never becomes a header;
//  - an account used by an active posting rule, with active sub-accounts, or with a balance cannot be deactivated (DB 0012, 0021);
//  - a posting rule's role must be one its event uses; one rule per (event, role, item category);
//    its account is an active postable account; event, role and category never change;
//  - the placeholder flag can only be cleared (Finance confirms), never set again.
// Item categories are checked through the masters service, never its tables.
import type {
  AccountDto,
  CostCenterDto,
  CreateAccountRequest,
  CreateCostCenterRequest,
  CreatePostingRuleRequest,
  FinListQuery,
  Page,
  PostingRuleDto,
  UpdateAccountRequest,
  UpdateCostCenterRequest,
  UpdatePostingRuleRequest,
} from '@albert/shared';
import { PostingEventRoles } from '@albert/shared';
import { eq } from 'drizzle-orm';
import { db, withTransaction, type Queryable, type Tx } from '../../db/client';
import { countWhere, listWhere } from '../../db/list';
import { accounts, costCenters, postingRules } from '../../db/schema/fin';
import { AppError } from '../../core/errors';
import { txContext, type AuthContext } from '../../core/auth/auth.service';
import { getCategory } from '../masters/catalog.service';
import * as repo from './finance.repo';

const LABELS: Record<repo.ActiveFlagTable, string> = { accounts: 'Account', 'cost-centers': 'Cost centre', 'posting-rules': 'Posting rule' };

function stamped<R extends { companyId: string; createdAt: Date; updatedAt: Date }>(
  row: R,
): Omit<R, 'companyId' | 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string } {
  const { companyId: _companyId, createdAt, updatedAt, ...rest } = row;
  return { ...rest, createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() };
}

function found<T>(row: T | undefined, what: string): T {
  if (!row) throw new AppError('NOT_FOUND', `${what} not found`);
  return row;
}

const paging = (q: FinListQuery) => ({ limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
const page = <T>(items: T[], total: number, q: FinListQuery): Page<T> => ({ items, total, page: q.page, pageSize: q.pageSize });

/** Only the keys the request actually sent (undefined = leave unchanged; null = clear). */
function sent<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ---------------------------------------------------------------- activate / deactivate

export async function setFinanceMasterActive(
  auth: AuthContext,
  resource: repo.ActiveFlagTable,
  id: string,
  active: boolean,
  reason: string | undefined,
): Promise<void> {
  const label = LABELS[resource];
  await withTransaction(txContext(auth, `${label}: ${reason ?? (active ? 'activate' : 'deactivate')}`), async (tx) => {
    const current = await repo.lockActiveFlag(tx, resource, auth.companyId, id);
    if (current === undefined) throw new AppError('NOT_FOUND', `${label} not found`);
    if (current === active) throw new AppError('INVALID_TRANSITION', `${label} is already ${active ? 'active' : 'inactive'}`);
    if (resource === 'posting-rules' && active) {
      const rule = found(await repo.findPostingRule(tx, auth.companyId, id), label);
      await assertPostableAccount(tx, auth.companyId, rule.accountId);
    }
    await repo.setActiveFlag(tx, resource, id, active);
  });
}

// ---------------------------------------------------------------- accounts

export async function listAccounts(auth: AuthContext, query: FinListQuery): Promise<Page<AccountDto>> {
  const where = listWhere(
    accounts.companyId,
    {
      ...query,
      searchCols: [accounts.code, accounts.name],
      activeCol: accounts.isActive,
      extra: [query.accountType ? eq(accounts.type, query.accountType) : undefined],
    },
    auth.companyId,
  );
  const rows = await repo.listAccounts(db, where, paging(query));
  return page(rows.map(stamped), await countWhere(db, accounts, where), query);
}

export async function getAccount(auth: AuthContext, id: string): Promise<AccountDto> {
  return stamped(found(await repo.findAccount(db, auth.companyId, id), 'Account'));
}

/** A parent must be an active header account of the same type, and not the account itself or one of its children. */
async function assertParent(q: Queryable, companyId: string, parentId: string, type: string, selfId?: string): Promise<void> {
  if (parentId === selfId) throw new AppError('VALIDATION_FAILED', 'An account cannot be placed under itself', { field: 'parentId' });
  const parent = await repo.findAccount(q, companyId, parentId);
  if (!parent) throw new AppError('VALIDATION_FAILED', 'Parent account does not exist', { field: 'parentId' });
  if (parent.type !== type) throw new AppError('VALIDATION_FAILED', 'The parent account must have the same type', { field: 'parentId' });
  if (parent.isPostable) throw new AppError('VALIDATION_FAILED', 'The parent account must be a header (not postable)', { field: 'parentId' });
  if (!parent.isActive) throw new AppError('VALIDATION_FAILED', 'The parent account is not active', { field: 'parentId' });
  // Cycles are refused by the database guard as well; it walks the whole chain.
}

export async function createAccount(auth: AuthContext, input: CreateAccountRequest): Promise<AccountDto> {
  const row = await withTransaction(txContext(auth), async (tx) => {
    if (input.parentId) await assertParent(tx, auth.companyId, input.parentId, input.type);
    return repo.insertAccount(tx, {
      code: input.code,
      name: input.name,
      type: input.type,
      parentId: input.parentId ?? null,
      isPostable: input.isPostable,
    });
  });
  return stamped(row);
}

export async function updateAccount(auth: AuthContext, id: string, input: UpdateAccountRequest): Promise<AccountDto> {
  await withTransaction(txContext(auth), async (tx) => {
    const current = found(await repo.findAccount(tx, auth.companyId, id), 'Account');
    if (input.parentId) await assertParent(tx, auth.companyId, input.parentId, current.type, id);
    await repo.updateAccount(tx, id, sent(input));
  });
  return getAccount(auth, id);
}

// ---------------------------------------------------------------- cost centres

export async function listCostCenters(auth: AuthContext, query: FinListQuery): Promise<Page<CostCenterDto>> {
  const where = listWhere(costCenters.companyId, { ...query, searchCols: [costCenters.code, costCenters.name], activeCol: costCenters.isActive }, auth.companyId);
  const rows = await repo.listCostCenters(db, where, paging(query));
  return page(rows.map(stamped), await countWhere(db, costCenters, where), query);
}
export async function getCostCenter(auth: AuthContext, id: string): Promise<CostCenterDto> {
  return stamped(found(await repo.findCostCenter(db, auth.companyId, id), 'Cost centre'));
}
export async function createCostCenter(auth: AuthContext, input: CreateCostCenterRequest): Promise<CostCenterDto> {
  return stamped(await withTransaction(txContext(auth), (tx) => repo.insertCostCenter(tx, input)));
}
export async function updateCostCenter(auth: AuthContext, id: string, input: UpdateCostCenterRequest): Promise<CostCenterDto> {
  await withTransaction(txContext(auth), async (tx) => {
    found(await repo.findCostCenter(tx, auth.companyId, id), 'Cost centre');
    await repo.updateCostCenter(tx, id, input);
  });
  return getCostCenter(auth, id);
}

// ---------------------------------------------------------------- posting rules

async function assertPostableAccount(q: Queryable, companyId: string, accountId: string): Promise<void> {
  const account = await repo.findAccount(q, companyId, accountId);
  if (!account) throw new AppError('VALIDATION_FAILED', 'Account does not exist', { field: 'accountId' });
  if (!account.isPostable) throw new AppError('VALIDATION_FAILED', `Account ${account.code} is a header and takes no postings`, { field: 'accountId' });
  if (!account.isActive) throw new AppError('VALIDATION_FAILED', `Account ${account.code} is not active`, { field: 'accountId' });
}

export async function listPostingRules(auth: AuthContext, query: FinListQuery): Promise<Page<PostingRuleDto>> {
  const where = listWhere(
    postingRules.companyId,
    {
      ...query,
      searchCols: [postingRules.event, postingRules.accountRole, accounts.code, accounts.name],
      activeCol: postingRules.isActive,
      extra: [query.event ? eq(postingRules.event, query.event) : undefined],
    },
    auth.companyId,
  );
  const rows = await repo.listPostingRules(db, where, paging(query));
  return page(rows.map(stamped), await repo.countPostingRules(db, where), query);
}
export async function getPostingRule(auth: AuthContext, id: string): Promise<PostingRuleDto> {
  return stamped(found(await repo.findPostingRule(db, auth.companyId, id), 'Posting rule'));
}

export async function createPostingRule(auth: AuthContext, input: CreatePostingRuleRequest): Promise<PostingRuleDto> {
  if (!PostingEventRoles[input.event].includes(input.accountRole)) {
    throw new AppError('VALIDATION_FAILED', `${input.event} does not use the account role ${input.accountRole}`, { field: 'accountRole' });
  }
  if (input.itemCategoryId) {
    const category = await getCategory(auth, input.itemCategoryId).catch((err: unknown) => {
      if (err instanceof AppError && err.code === 'NOT_FOUND') {
        throw new AppError('VALIDATION_FAILED', 'Item category does not exist', { field: 'itemCategoryId' });
      }
      throw err;
    });
    if (!category.isActive) throw new AppError('VALIDATION_FAILED', 'Item category is not active', { field: 'itemCategoryId' });
  }
  const id = await withTransaction(txContext(auth), async (tx: Tx) => {
    await assertPostableAccount(tx, auth.companyId, input.accountId);
    return repo.insertPostingRule(tx, {
      event: input.event,
      accountRole: input.accountRole,
      itemCategoryId: input.itemCategoryId ?? null,
      accountId: input.accountId,
    });
  });
  return getPostingRule(auth, id);
}

export async function updatePostingRule(auth: AuthContext, id: string, input: UpdatePostingRuleRequest): Promise<PostingRuleDto> {
  await withTransaction(txContext(auth), async (tx) => {
    const rule = found(await repo.findPostingRule(tx, auth.companyId, id), 'Posting rule');
    if (input.accountId && rule.isActive) await assertPostableAccount(tx, auth.companyId, input.accountId);
    await repo.updatePostingRule(tx, id, sent(input));
  });
  return getPostingRule(auth, id);
}
