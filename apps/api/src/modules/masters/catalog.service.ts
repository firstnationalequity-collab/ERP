// Simple masters: tax codes (fin.master.manage), UoM / categories / items / conversions (master.item.manage),
// warehouses / locations (master.location.manage), price lists (master.price.manage). Reads: master.view.
// Masters are never deleted; they are deactivated (DB: core.forbid_delete). Permission keys are checked in
// the routes; references to other masters must exist and be active.
import { eq } from 'drizzle-orm';
import type {
  CategoryDto,
  ConversionDto,
  CreateCategoryRequest,
  CreateConversionRequest,
  CreateItemRequest,
  CreateLocationRequest,
  CreatePriceListLineRequest,
  CreatePriceListRequest,
  CreateTaxCodeRequest,
  CreateUomRequest,
  CreateWarehouseRequest,
  ItemDto,
  LocationDto,
  MasterListQuery,
  Page,
  PriceListDto,
  PriceListLineDto,
  TaxCodeDto,
  UomDto,
  UpdateItemRequest,
  UpdateLocationRequest,
  UpdateNameRequest,
  UpdatePriceListLineRequest,
  UpdatePriceListRequest,
  UpdateTaxCodeRequest,
  UpdateWarehouseRequest,
  WarehouseDto,
} from '@albert/shared';
import { db, withTransaction, type Tx } from '../../db/client';
import {
  itemCategories,
  items,
  locations,
  priceLists,
  taxCodes,
  uomConversions,
  uoms,
  warehouses,
} from '../../db/schema/masters';
import { AppError } from '../../core/errors';
import { txContext, type AuthContext } from '../../core/auth/auth.service';
import * as repo from './masters.repo';
import { assertReference, found, page, paging, sent, setActive, stamped } from './common';

/** Masters with an is_active flag, by URL resource name. */
export const ACTIVE_FLAG_MASTERS = {
  'tax-codes': { entity: 'master.tax_codes', label: 'Tax code' },
  uoms: { entity: 'master.uoms', label: 'Unit of measure' },
  'item-categories': { entity: 'master.item_categories', label: 'Item category' },
  items: { entity: 'master.items', label: 'Item' },
  'uom-conversions': { entity: 'master.uom_conversions', label: 'Unit conversion' },
  warehouses: { entity: 'master.warehouses', label: 'Warehouse' },
  locations: { entity: 'master.locations', label: 'Location' },
  'customer-addresses': { entity: 'master.customer_addresses', label: 'Customer address' },
  products: { entity: 'master.products', label: 'Product' },
  'price-lists': { entity: 'master.price_lists', label: 'Price list' },
  'price-list-lines': { entity: 'master.price_list_lines', label: 'Price list line' },
} as const;
export type ActiveFlagResource = keyof typeof ACTIVE_FLAG_MASTERS;

/** Activate or deactivate (deactivation needs a reason, stored in the audit log). */
export async function setMasterActive(
  auth: AuthContext,
  resource: ActiveFlagResource,
  id: string,
  active: boolean,
  reason: string | undefined,
): Promise<void> {
  const { entity, label } = ACTIVE_FLAG_MASTERS[resource];
  const auditReason = reason ?? (active ? 'activate' : 'deactivate');
  await withTransaction(txContext(auth, `${label}: ${auditReason}`), (tx) => setActive(tx, entity, auth.companyId, id, active, label));
}

// ---------------------------------------------------------------- tax codes

export async function listTaxCodes(auth: AuthContext, query: MasterListQuery): Promise<Page<TaxCodeDto>> {
  const where = repo.listWhere(taxCodes.companyId, { ...query, searchCols: [taxCodes.code, taxCodes.name], activeCol: taxCodes.isActive }, auth.companyId);
  const rows = await repo.listTaxCodes(db, where, paging(query));
  return page(rows.map(stamped), await repo.countWhere(db, taxCodes, where), query);
}
export async function getTaxCode(auth: AuthContext, id: string): Promise<TaxCodeDto> {
  return stamped(found(await repo.findTaxCode(db, auth.companyId, id), 'Tax code'));
}
export async function createTaxCode(auth: AuthContext, input: CreateTaxCodeRequest): Promise<TaxCodeDto> {
  const row = await withTransaction(txContext(auth), (tx) => repo.insertTaxCode(tx, input));
  return stamped(row);
}
export async function updateTaxCode(auth: AuthContext, id: string, input: UpdateTaxCodeRequest): Promise<TaxCodeDto> {
  await withTransaction(txContext(auth), async (tx) => {
    found(await repo.findTaxCode(tx, auth.companyId, id), 'Tax code');
    await repo.updateTaxCode(tx, id, sent(input));
  });
  return getTaxCode(auth, id);
}

// ---------------------------------------------------------------- UoM and categories

export async function listUoms(auth: AuthContext, query: MasterListQuery): Promise<Page<UomDto>> {
  const where = repo.listWhere(uoms.companyId, { ...query, searchCols: [uoms.code, uoms.name], activeCol: uoms.isActive }, auth.companyId);
  const rows = await repo.listUoms(db, where, paging(query));
  return page(rows.map(stamped), await repo.countWhere(db, uoms, where), query);
}
export async function getUom(auth: AuthContext, id: string): Promise<UomDto> {
  return stamped(found(await repo.findUom(db, auth.companyId, id), 'Unit of measure'));
}
export async function createUom(auth: AuthContext, input: CreateUomRequest): Promise<UomDto> {
  return stamped(await withTransaction(txContext(auth), (tx) => repo.insertUom(tx, input)));
}
export async function updateUom(auth: AuthContext, id: string, input: UpdateNameRequest): Promise<UomDto> {
  await withTransaction(txContext(auth), async (tx) => {
    found(await repo.findUom(tx, auth.companyId, id), 'Unit of measure');
    await repo.updateUom(tx, id, input);
  });
  return getUom(auth, id);
}

export async function listCategories(auth: AuthContext, query: MasterListQuery): Promise<Page<CategoryDto>> {
  const where = repo.listWhere(
    itemCategories.companyId,
    { ...query, searchCols: [itemCategories.code, itemCategories.name], activeCol: itemCategories.isActive },
    auth.companyId,
  );
  const rows = await repo.listCategories(db, where, paging(query));
  return page(rows.map(stamped), await repo.countWhere(db, itemCategories, where), query);
}
export async function getCategory(auth: AuthContext, id: string): Promise<CategoryDto> {
  return stamped(found(await repo.findCategory(db, auth.companyId, id), 'Item category'));
}
export async function createCategory(auth: AuthContext, input: CreateCategoryRequest): Promise<CategoryDto> {
  return stamped(await withTransaction(txContext(auth), (tx) => repo.insertCategory(tx, input)));
}
export async function updateCategory(auth: AuthContext, id: string, input: UpdateNameRequest): Promise<CategoryDto> {
  await withTransaction(txContext(auth), async (tx) => {
    found(await repo.findCategory(tx, auth.companyId, id), 'Item category');
    await repo.updateCategory(tx, id, input);
  });
  return getCategory(auth, id);
}

// ---------------------------------------------------------------- items

async function assertItemTaxCode(tx: Tx, companyId: string, taxCodeId: string): Promise<void> {
  const tc = await repo.findTaxCode(tx, companyId, taxCodeId);
  if (!tc) throw new AppError('VALIDATION_FAILED', 'Tax code does not exist', { field: 'taxCodeId' });
  if (!tc.isActive) throw new AppError('VALIDATION_FAILED', 'Tax code is not active', { field: 'taxCodeId' });
  if (tc.kind !== 'SALES_TAX') throw new AppError('VALIDATION_FAILED', "An item's tax code must be a sales tax code", { field: 'taxCodeId' });
}

export async function listItems(auth: AuthContext, query: MasterListQuery): Promise<Page<ItemDto>> {
  const where = repo.listWhere(
    items.companyId,
    { ...query, searchCols: [items.code, items.name], activeCol: items.isActive, extra: [query.type ? eq(items.type, query.type) : undefined] },
    auth.companyId,
  );
  const rows = await repo.listItems(db, where, paging(query));
  return page(rows.map(stamped), await repo.countWhere(db, items, where), query);
}
export async function getItem(auth: AuthContext, id: string): Promise<ItemDto> {
  return stamped(found(await repo.findItem(db, auth.companyId, id), 'Item'));
}
export async function createItem(auth: AuthContext, input: CreateItemRequest): Promise<ItemDto> {
  const row = await withTransaction(txContext(auth), async (tx) => {
    await assertReference(tx, 'master.item_categories', auth.companyId, input.categoryId, 'Item category');
    await assertReference(tx, 'master.uoms', auth.companyId, input.baseUomId, 'Base unit of measure');
    if (input.taxCodeId) await assertItemTaxCode(tx, auth.companyId, input.taxCodeId);
    return repo.insertItem(tx, input);
  });
  return stamped(row);
}
export async function updateItem(auth: AuthContext, id: string, input: UpdateItemRequest): Promise<ItemDto> {
  await withTransaction(txContext(auth), async (tx) => {
    const item = found(await repo.findItem(tx, auth.companyId, id), 'Item');
    const changes = sent(input);
    if (changes.categoryId && changes.categoryId !== item.categoryId) {
      await assertReference(tx, 'master.item_categories', auth.companyId, changes.categoryId, 'Item category');
    }
    if (changes.taxCodeId && changes.taxCodeId !== item.taxCodeId) await assertItemTaxCode(tx, auth.companyId, changes.taxCodeId);
    const shelf = changes.shelfLifeDays !== undefined ? changes.shelfLifeDays : item.shelfLifeDays;
    const retest = changes.retestDays !== undefined ? changes.retestDays : item.retestDays;
    if (shelf != null && retest != null && retest > shelf) {
      throw new AppError('VALIDATION_FAILED', 'Retest period cannot exceed shelf life', { field: 'retestDays' });
    }
    await repo.updateItem(tx, id, changes);
  });
  return getItem(auth, id);
}

// ---------------------------------------------------------------- unit conversions

export async function listConversions(auth: AuthContext, query: MasterListQuery): Promise<Page<ConversionDto>> {
  const where = repo.listWhere(
    uomConversions.companyId,
    { ...query, search: undefined, searchCols: [], activeCol: uomConversions.isActive, extra: [query.itemId ? eq(uomConversions.itemId, query.itemId) : undefined] },
    auth.companyId,
  );
  const rows = await repo.listConversions(db, where, paging(query));
  return page(rows.map(stamped), await repo.countWhere(db, uomConversions, where), query);
}
export async function getConversion(auth: AuthContext, id: string): Promise<ConversionDto> {
  return stamped(found(await repo.findConversion(db, auth.companyId, id), 'Unit conversion'));
}
/** Conversions are never edited (documents may have used the factor): deactivate and add a new one. */
export async function createConversion(auth: AuthContext, input: CreateConversionRequest): Promise<ConversionDto> {
  const row = await withTransaction(txContext(auth), async (tx) => {
    if (input.itemId) await assertReference(tx, 'master.items', auth.companyId, input.itemId, 'Item');
    await assertReference(tx, 'master.uoms', auth.companyId, input.fromUomId, 'From unit');
    await assertReference(tx, 'master.uoms', auth.companyId, input.toUomId, 'To unit');
    return repo.insertConversion(tx, { ...input, itemId: input.itemId ?? null });
  });
  return stamped(row);
}

// ---------------------------------------------------------------- warehouses and locations

export async function listWarehouses(auth: AuthContext, query: MasterListQuery): Promise<Page<WarehouseDto>> {
  const where = repo.listWhere(warehouses.companyId, { ...query, searchCols: [warehouses.code, warehouses.name], activeCol: warehouses.isActive }, auth.companyId);
  const rows = await repo.listWarehouses(db, where, paging(query));
  return page(rows.map(stamped), await repo.countWhere(db, warehouses, where), query);
}
export async function getWarehouse(auth: AuthContext, id: string): Promise<WarehouseDto> {
  return stamped(found(await repo.findWarehouse(db, auth.companyId, id), 'Warehouse'));
}
export async function createWarehouse(auth: AuthContext, input: CreateWarehouseRequest): Promise<WarehouseDto> {
  return stamped(await withTransaction(txContext(auth), (tx) => repo.insertWarehouse(tx, input)));
}
export async function updateWarehouse(auth: AuthContext, id: string, input: UpdateWarehouseRequest): Promise<WarehouseDto> {
  await withTransaction(txContext(auth), async (tx) => {
    found(await repo.findWarehouse(tx, auth.companyId, id), 'Warehouse');
    await repo.updateWarehouse(tx, id, sent(input));
  });
  return getWarehouse(auth, id);
}

export async function listLocations(auth: AuthContext, query: MasterListQuery): Promise<Page<LocationDto>> {
  const where = repo.listWhere(
    locations.companyId,
    {
      ...query,
      searchCols: [locations.code, locations.name],
      activeCol: locations.isActive,
      extra: [query.warehouseId ? eq(locations.warehouseId, query.warehouseId) : undefined],
    },
    auth.companyId,
  );
  const rows = await repo.listLocations(db, where, paging(query));
  return page(rows.map(stamped), await repo.countWhere(db, locations, where), query);
}
export async function getLocation(auth: AuthContext, id: string): Promise<LocationDto> {
  return stamped(found(await repo.findLocation(db, auth.companyId, id), 'Location'));
}
export async function createLocation(auth: AuthContext, input: CreateLocationRequest): Promise<LocationDto> {
  const row = await withTransaction(txContext(auth), async (tx) => {
    await assertReference(tx, 'master.warehouses', auth.companyId, input.warehouseId, 'Warehouse');
    return repo.insertLocation(tx, input);
  });
  return stamped(row);
}
export async function updateLocation(auth: AuthContext, id: string, input: UpdateLocationRequest): Promise<LocationDto> {
  await withTransaction(txContext(auth), async (tx) => {
    found(await repo.findLocation(tx, auth.companyId, id), 'Location');
    await repo.updateLocation(tx, id, sent(input));
  });
  return getLocation(auth, id);
}

// ---------------------------------------------------------------- price lists

function priceListLineDto(row: repo.PriceListLineRow): PriceListLineDto {
  return stamped(row);
}

export async function listPriceLists(auth: AuthContext, query: MasterListQuery): Promise<Page<PriceListDto>> {
  const where = repo.listWhere(
    priceLists.companyId,
    {
      ...query,
      searchCols: [priceLists.code, priceLists.name],
      activeCol: priceLists.isActive,
      extra: [query.customerId ? eq(priceLists.customerId, query.customerId) : undefined],
    },
    auth.companyId,
  );
  const rows = await repo.listPriceLists(db, where, paging(query));
  return page(rows.map(stamped), await repo.countWhere(db, priceLists, where), query);
}
export async function getPriceList(auth: AuthContext, id: string): Promise<PriceListDto> {
  const row = found(await repo.findPriceList(db, auth.companyId, id), 'Price list');
  return { ...stamped(row), lines: (await repo.priceListLinesOf(db, id)).map(priceListLineDto) };
}
export async function createPriceList(auth: AuthContext, input: CreatePriceListRequest): Promise<PriceListDto> {
  const row = await withTransaction(txContext(auth), async (tx) => {
    if (input.customerId) await assertReference(tx, 'master.customers', auth.companyId, input.customerId, 'Customer');
    return repo.insertPriceList(tx, { ...input, customerId: input.customerId ?? null, validTo: input.validTo ?? null });
  });
  return getPriceList(auth, row.id);
}
export async function updatePriceList(auth: AuthContext, id: string, input: UpdatePriceListRequest): Promise<PriceListDto> {
  await withTransaction(txContext(auth), async (tx) => {
    const list = found(await repo.findPriceList(tx, auth.companyId, id), 'Price list');
    const changes = sent(input);
    if (changes.customerId && changes.customerId !== list.customerId) {
      await assertReference(tx, 'master.customers', auth.companyId, changes.customerId, 'Customer');
    }
    const from = changes.validFrom ?? list.validFrom;
    const to = changes.validTo !== undefined ? changes.validTo : list.validTo;
    if (to !== null && to < from) throw new AppError('VALIDATION_FAILED', 'Valid-to cannot be before valid-from', { field: 'validTo' });
    await repo.updatePriceList(tx, id, changes);
  });
  return getPriceList(auth, id);
}
export async function addPriceListLine(auth: AuthContext, priceListId: string, input: CreatePriceListLineRequest): Promise<PriceListLineDto> {
  const row = await withTransaction(txContext(auth), async (tx) => {
    const list = found(await repo.findPriceList(tx, auth.companyId, priceListId), 'Price list');
    if (!list.isActive) throw new AppError('VALIDATION_FAILED', 'The price list is not active');
    await assertReference(tx, 'master.items', auth.companyId, input.itemId, 'Item');
    await assertReference(tx, 'master.uoms', auth.companyId, input.uomId, 'Unit of measure');
    return repo.insertPriceListLine(tx, { priceListId, ...input });
  });
  return priceListLineDto(row);
}
export async function updatePriceListLine(auth: AuthContext, lineId: string, input: UpdatePriceListLineRequest): Promise<PriceListLineDto> {
  await withTransaction(txContext(auth), async (tx) => {
    const line = found(await repo.findPriceListLine(tx, auth.companyId, lineId), 'Price list line');
    if (!line.isActive) throw new AppError('VALIDATION_FAILED', 'The price list line is not active');
    await repo.updatePriceListLine(tx, lineId, input);
  });
  return priceListLineDto(found(await repo.findPriceListLine(db, auth.companyId, lineId), 'Price list line'));
}
