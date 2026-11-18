// Items (owner decisions 18-11-2026; DB guards 0011_item_activation.sql).
//  - Created DRAFT by master.item.manage (Warehouse / Purchase Manager); editable freely while DRAFT.
//  - GMP items (type in GmpItemTypes: RM, PM, API, EXCIPIENT, BULK, FG): every status move by master.item.approve
//    (QA Manager). Non-GMP items (SPARE, CONSUMABLE): by master.item.manage.
//  - DRAFT → ACTIVE: not by the creator or the last editor. Non-GMP INACTIVE → ACTIVE: not by the person who
//    deactivated it. Deactivation and reactivation need a reason.
//  - After DRAFT, changing a GMP item's shelf life, retest period, storage zone or controlled flag needs, in the
//    same request, a countersign by another person holding master.item.approve.
//  - Code, type and base UoM never change (DB guard too).
// Only ACTIVE items may be used by other masters and documents (is_active = status ACTIVE).
import { eq } from 'drizzle-orm';
import {
  GmpItemSensitiveFields,
  GmpItemTypes,
  ItemStatus,
  type CreateItemRequest,
  type ItemDto,
  type ItemType,
  type MasterListQuery,
  type Page,
  type PermissionKey,
  type UpdateItemRequest,
} from '@albert/shared';
import { db, withTransaction, type Tx } from '../../db/client';
import { items } from '../../db/schema/masters';
import { AppError } from '../../core/errors';
import { txContext, type AuthContext, type RequestMeta } from '../../core/auth/auth.service';
import { defineTransitions, lastStatusActor, recordInitialStatus, transition } from '../../core/transition/transition';
import * as repo from './masters.repo';
import { applyCountersign, assertReference, found, page, paging, sent, stamped, verifyCountersign } from './common';

// ---------------------------------------------------------------- status maps (rule 7)

function itemMoves(key: PermissionKey) {
  return defineTransitions<ItemStatus>({
    entityTable: 'master.items',
    statuses: ItemStatus,
    moves: [
      { from: null, to: 'DRAFT', permission: 'master.item.manage' },
      { from: 'DRAFT', to: 'ACTIVE', permission: key },
      { from: 'ACTIVE', to: 'INACTIVE', permission: key, reasonRequired: true },
      { from: 'INACTIVE', to: 'ACTIVE', permission: key, reasonRequired: true },
    ],
  });
}
/** GMP items: QA (master.item.approve) moves them. */
export const GmpItemMoves = itemMoves('master.item.approve');
/** Non-GMP items (spares, consumables): the item keepers move them. */
export const OtherItemMoves = itemMoves('master.item.manage');

export function isGmpItemType(type: ItemType): boolean {
  return GmpItemTypes.includes(type);
}

const ITEM_APPROVE_KEY: PermissionKey = 'master.item.approve';

function toDto(row: repo.ItemRow): ItemDto {
  return { ...stamped(row), isActive: row.status === 'ACTIVE' };
}

// ---------------------------------------------------------------- reads

export async function listItems(auth: AuthContext, query: MasterListQuery): Promise<Page<ItemDto>> {
  const status = query.status && (ItemStatus as readonly string[]).includes(query.status) ? (query.status as ItemStatus) : undefined;
  const where = repo.listWhere(
    items.companyId,
    {
      ...query,
      searchCols: [items.code, items.name],
      activeCol: items.isActive,
      extra: [query.type ? eq(items.type, query.type) : undefined, status ? eq(items.status, status) : undefined],
    },
    auth.companyId,
  );
  const rows = await repo.listItems(db, where, paging(query));
  return page(rows.map(toDto), await repo.countWhere(db, items, where), query);
}

export async function getItem(auth: AuthContext, id: string): Promise<ItemDto> {
  return toDto(found(await repo.findItem(db, auth.companyId, id), 'Item'));
}

// ---------------------------------------------------------------- create / edit

async function assertItemTaxCode(tx: Tx, companyId: string, taxCodeId: string): Promise<void> {
  const tc = await repo.findTaxCode(tx, companyId, taxCodeId);
  if (!tc) throw new AppError('VALIDATION_FAILED', 'Tax code does not exist', { field: 'taxCodeId' });
  if (!tc.isActive) throw new AppError('VALIDATION_FAILED', 'Tax code is not active', { field: 'taxCodeId' });
  if (tc.kind !== 'SALES_TAX') throw new AppError('VALIDATION_FAILED', "An item's tax code must be a sales tax code", { field: 'taxCodeId' });
}

export async function createItem(auth: AuthContext, input: CreateItemRequest): Promise<ItemDto> {
  const row = await withTransaction(txContext(auth), async (tx) => {
    await assertReference(tx, 'master.item_categories', auth.companyId, input.categoryId, 'Item category');
    await assertReference(tx, 'master.uoms', auth.companyId, input.baseUomId, 'Base unit of measure');
    if (input.taxCodeId) await assertItemTaxCode(tx, auth.companyId, input.taxCodeId);
    const created = await repo.insertItem(tx, { ...input, status: 'DRAFT' });
    await recordInitialStatus(tx, OtherItemMoves, { entityId: created.id, to: 'DRAFT', actor: auth });
    return created;
  });
  return toDto(row);
}

export async function updateItem(auth: AuthContext, id: string, input: UpdateItemRequest, meta: RequestMeta): Promise<ItemDto> {
  const { countersign, ...fields } = input;
  const proof = await verifyCountersign(auth, countersign, meta);
  await withTransaction(txContext(auth, countersign ? `countersigned: ${countersign.reason}` : undefined), async (tx) => {
    const item = found(await repo.findItem(tx, auth.companyId, id, true), 'Item');
    const changes = sent(fields);
    if (changes.categoryId && changes.categoryId !== item.categoryId) {
      await assertReference(tx, 'master.item_categories', auth.companyId, changes.categoryId, 'Item category');
    }
    if (changes.taxCodeId && changes.taxCodeId !== item.taxCodeId) await assertItemTaxCode(tx, auth.companyId, changes.taxCodeId);
    const shelf = changes.shelfLifeDays !== undefined ? changes.shelfLifeDays : item.shelfLifeDays;
    const retest = changes.retestDays !== undefined ? changes.retestDays : item.retestDays;
    if (shelf != null && retest != null && retest > shelf) {
      throw new AppError('VALIDATION_FAILED', 'Retest period cannot exceed shelf life', { field: 'retestDays' });
    }
    const sensitive =
      item.status !== 'DRAFT' && isGmpItemType(item.type)
        ? GmpItemSensitiveFields.filter((f) => f in changes && (changes[f] ?? null) !== (item[f] ?? null))
        : [];
    await repo.updateItem(tx, id, changes);
    if (sensitive.length > 0) {
      await applyCountersign(tx, proof, { table: 'master.items', id }, ITEM_APPROVE_KEY,
        `Changing ${sensitive.join(', ')} of a GMP item needs a QA countersign (${ITEM_APPROVE_KEY})`, [...sensitive]);
    }
  });
  return getItem(auth, id);
}

// ---------------------------------------------------------------- status actions

/** DRAFT → ACTIVE, ACTIVE → INACTIVE, INACTIVE → ACTIVE; the map (and its keys) follow the item type. */
export async function changeItemStatus(
  auth: AuthContext,
  id: string,
  to: 'ACTIVE' | 'INACTIVE',
  reason: string | undefined,
): Promise<ItemDto> {
  await withTransaction(txContext(auth, reason ? `Item: ${reason}` : undefined), async (tx) => {
    const item = found(await repo.findItem(tx, auth.companyId, id, true), 'Item');
    const gmp = isGmpItemType(item.type);
    if (item.status === 'DRAFT' && to === 'ACTIVE' && (item.createdBy === auth.userId || item.updatedBy === auth.userId)) {
      throw new AppError('SEGREGATION_OF_DUTIES', 'You created or last edited this item; another person must activate it');
    }
    if (!gmp && item.status === 'INACTIVE' && to === 'ACTIVE') {
      if ((await lastStatusActor(tx, 'master.items', id, 'INACTIVE')) === auth.userId) {
        throw new AppError('SEGREGATION_OF_DUTIES', 'You deactivated this item; another person must reactivate it');
      }
    }
    await transition(tx, gmp ? GmpItemMoves : OtherItemMoves, { entityId: id, to, actor: auth, reason });
  });
  return getItem(auth, id);
}
