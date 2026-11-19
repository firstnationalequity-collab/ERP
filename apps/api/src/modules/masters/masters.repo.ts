// Masters repository: queries only (no business rules). Tables in schema `master` (0008_masters.sql).
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Queryable, Tx } from '../../db/client';
import {
  approvedSources,
  customerAddresses,
  customers,
  itemCategories,
  items,
  locations,
  masterFormulaLines,
  masterFormulas,
  priceListLines,
  priceLists,
  products,
  taxCodes,
  uomConversions,
  uoms,
  vendors,
  warehouses,
} from '../../db/schema/masters';

export type TaxCodeRow = typeof taxCodes.$inferSelect;
export type UomRow = typeof uoms.$inferSelect;
export type CategoryRow = typeof itemCategories.$inferSelect;
export type ItemRow = typeof items.$inferSelect;
export type ConversionRow = typeof uomConversions.$inferSelect;
export type WarehouseRow = typeof warehouses.$inferSelect;
export type LocationRow = typeof locations.$inferSelect;
export type CustomerRow = typeof customers.$inferSelect;
export type AddressRow = typeof customerAddresses.$inferSelect;
export type VendorRow = typeof vendors.$inferSelect;
export type SourceRow = typeof approvedSources.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type FormulaRow = typeof masterFormulas.$inferSelect;
export type FormulaLineRow = typeof masterFormulaLines.$inferSelect;
export type PriceListRow = typeof priceLists.$inferSelect;
export type PriceListLineRow = typeof priceListLines.$inferSelect;

// Generic list helpers live in db/list.ts (shared by every module); re-exported for the masters services.
export { countWhere, likePattern, listWhere, type Paging } from '../../db/list';
import type { Paging } from '../../db/list';
import { likePattern as like } from '../../db/list';

/** Product list search: registration no., or the FG item's code or name. */
export function productSearch(search: string): SQL {
  const p = like(search);
  return sql`(${products.registrationNo} ILIKE ${p} OR ${products.itemId} IN (SELECT i.id FROM master.items i WHERE i.code ILIKE ${p} OR i.name ILIKE ${p}))`;
}

/** Formula list search: the product's item code or name. */
export function formulaSearch(search: string): SQL {
  const p = like(search);
  return sql`${masterFormulas.productId} IN (SELECT pr.id FROM master.products pr JOIN master.items i ON i.id = pr.item_id WHERE i.code ILIKE ${p} OR i.name ILIKE ${p})`;
}

function tableSql(entity: string): SQL {
  const [schema, table] = entity.split('.') as [string, string];
  return sql`${sql.identifier(schema)}.${sql.identifier(table)}`;
}

/** Lock a master row and read its is_active (undefined = not found in this company). */
export async function lockActiveFlag(tx: Tx, entity: string, companyId: string, id: string): Promise<boolean | undefined> {
  const res = await tx.execute<{ is_active: boolean }>(
    sql`SELECT is_active FROM ${tableSql(entity)} WHERE id = ${id} AND company_id = ${companyId} FOR UPDATE`,
  );
  return res.rows[0]?.is_active;
}

export async function setActiveFlag(tx: Tx, entity: string, id: string, active: boolean): Promise<void> {
  await tx.execute(sql`UPDATE ${tableSql(entity)} SET is_active = ${active} WHERE id = ${id}`);
}

/** is_active (or status = 'ACTIVE' for customers/vendors) of a referenced row; undefined = not found. */
export async function referenceState(q: Queryable, entity: string, companyId: string, id: string): Promise<boolean | undefined> {
  const activeExpr = entity === 'master.customers' || entity === 'master.vendors' ? sql`status = 'ACTIVE'` : sql`is_active`;
  const res = await q.execute<{ ok: boolean }>(
    sql`SELECT ${activeExpr} AS ok FROM ${tableSql(entity)} WHERE id = ${id} AND company_id = ${companyId}`,
  );
  return res.rows[0]?.ok;
}

// ---------------------------------------------------------------- tax codes

export async function listTaxCodes(q: Queryable, where: SQL | undefined, p: Paging) {
  return q.select().from(taxCodes).where(where).orderBy(asc(taxCodes.code)).limit(p.limit).offset(p.offset);
}
export async function findTaxCode(q: Queryable, companyId: string, id: string): Promise<TaxCodeRow | undefined> {
  const [row] = await q.select().from(taxCodes).where(and(eq(taxCodes.companyId, companyId), eq(taxCodes.id, id)));
  return row;
}
export async function insertTaxCode(tx: Tx, v: typeof taxCodes.$inferInsert): Promise<TaxCodeRow> {
  const [row] = await tx.insert(taxCodes).values(v).returning();
  if (!row) throw new Error('tax code insert returned no row');
  return row;
}
export async function updateTaxCode(tx: Tx, id: string, v: Partial<typeof taxCodes.$inferInsert>): Promise<void> {
  if (Object.keys(v).length > 0) await tx.update(taxCodes).set(v).where(eq(taxCodes.id, id));
}

// ---------------------------------------------------------------- UoM

export async function listUoms(q: Queryable, where: SQL | undefined, p: Paging) {
  return q.select().from(uoms).where(where).orderBy(asc(uoms.code)).limit(p.limit).offset(p.offset);
}
export async function findUom(q: Queryable, companyId: string, id: string): Promise<UomRow | undefined> {
  const [row] = await q.select().from(uoms).where(and(eq(uoms.companyId, companyId), eq(uoms.id, id)));
  return row;
}
export async function insertUom(tx: Tx, v: typeof uoms.$inferInsert): Promise<UomRow> {
  const [row] = await tx.insert(uoms).values(v).returning();
  if (!row) throw new Error('uom insert returned no row');
  return row;
}
export async function updateUom(tx: Tx, id: string, v: Partial<typeof uoms.$inferInsert>): Promise<void> {
  if (Object.keys(v).length > 0) await tx.update(uoms).set(v).where(eq(uoms.id, id));
}

// ---------------------------------------------------------------- categories

export async function listCategories(q: Queryable, where: SQL | undefined, p: Paging) {
  return q.select().from(itemCategories).where(where).orderBy(asc(itemCategories.code)).limit(p.limit).offset(p.offset);
}
export async function findCategory(q: Queryable, companyId: string, id: string): Promise<CategoryRow | undefined> {
  const [row] = await q.select().from(itemCategories).where(and(eq(itemCategories.companyId, companyId), eq(itemCategories.id, id)));
  return row;
}
export async function insertCategory(tx: Tx, v: typeof itemCategories.$inferInsert): Promise<CategoryRow> {
  const [row] = await tx.insert(itemCategories).values(v).returning();
  if (!row) throw new Error('category insert returned no row');
  return row;
}
export async function updateCategory(tx: Tx, id: string, v: Partial<typeof itemCategories.$inferInsert>): Promise<void> {
  if (Object.keys(v).length > 0) await tx.update(itemCategories).set(v).where(eq(itemCategories.id, id));
}

// ---------------------------------------------------------------- items

export async function listItems(q: Queryable, where: SQL | undefined, p: Paging) {
  return q.select().from(items).where(where).orderBy(asc(items.code)).limit(p.limit).offset(p.offset);
}
export async function findItem(q: Queryable, companyId: string, id: string, lock = false): Promise<ItemRow | undefined> {
  const base = q.select().from(items).where(and(eq(items.companyId, companyId), eq(items.id, id)));
  const [row] = lock ? await base.for('update') : await base;
  return row;
}
export async function itemsByIds(q: Queryable, companyId: string, ids: string[]): Promise<ItemRow[]> {
  if (ids.length === 0) return [];
  return q.select().from(items).where(and(eq(items.companyId, companyId), inArray(items.id, ids)));
}
export async function insertItem(tx: Tx, v: typeof items.$inferInsert): Promise<ItemRow> {
  const [row] = await tx.insert(items).values(v).returning();
  if (!row) throw new Error('item insert returned no row');
  return row;
}
export async function updateItem(tx: Tx, id: string, v: Partial<typeof items.$inferInsert>): Promise<void> {
  if (Object.keys(v).length > 0) await tx.update(items).set(v).where(eq(items.id, id));
}

// ---------------------------------------------------------------- conversions

export async function listConversions(q: Queryable, where: SQL | undefined, p: Paging) {
  return q.select().from(uomConversions).where(where).orderBy(asc(uomConversions.id)).limit(p.limit).offset(p.offset);
}
export async function findConversion(q: Queryable, companyId: string, id: string): Promise<ConversionRow | undefined> {
  const [row] = await q.select().from(uomConversions).where(and(eq(uomConversions.companyId, companyId), eq(uomConversions.id, id)));
  return row;
}
export async function insertConversion(tx: Tx, v: typeof uomConversions.$inferInsert): Promise<ConversionRow> {
  const [row] = await tx.insert(uomConversions).values(v).returning();
  if (!row) throw new Error('conversion insert returned no row');
  return row;
}

// ---------------------------------------------------------------- warehouses and locations

export async function listWarehouses(q: Queryable, where: SQL | undefined, p: Paging) {
  return q.select().from(warehouses).where(where).orderBy(asc(warehouses.code)).limit(p.limit).offset(p.offset);
}
export async function findWarehouse(q: Queryable, companyId: string, id: string): Promise<WarehouseRow | undefined> {
  const [row] = await q.select().from(warehouses).where(and(eq(warehouses.companyId, companyId), eq(warehouses.id, id)));
  return row;
}
export async function insertWarehouse(tx: Tx, v: typeof warehouses.$inferInsert): Promise<WarehouseRow> {
  const [row] = await tx.insert(warehouses).values(v).returning();
  if (!row) throw new Error('warehouse insert returned no row');
  return row;
}
export async function updateWarehouse(tx: Tx, id: string, v: Partial<typeof warehouses.$inferInsert>): Promise<void> {
  if (Object.keys(v).length > 0) await tx.update(warehouses).set(v).where(eq(warehouses.id, id));
}

export async function listLocations(q: Queryable, where: SQL | undefined, p: Paging) {
  return q.select().from(locations).where(where).orderBy(asc(locations.warehouseId), asc(locations.code)).limit(p.limit).offset(p.offset);
}
export async function findLocation(q: Queryable, companyId: string, id: string): Promise<LocationRow | undefined> {
  const [row] = await q.select().from(locations).where(and(eq(locations.companyId, companyId), eq(locations.id, id)));
  return row;
}
export async function insertLocation(tx: Tx, v: typeof locations.$inferInsert): Promise<LocationRow> {
  const [row] = await tx.insert(locations).values(v).returning();
  if (!row) throw new Error('location insert returned no row');
  return row;
}
export async function updateLocation(tx: Tx, id: string, v: Partial<typeof locations.$inferInsert>): Promise<void> {
  if (Object.keys(v).length > 0) await tx.update(locations).set(v).where(eq(locations.id, id));
}

// ---------------------------------------------------------------- customers, addresses, vendors

export async function listCustomers(q: Queryable, where: SQL | undefined, p: Paging) {
  return q.select().from(customers).where(where).orderBy(asc(customers.code)).limit(p.limit).offset(p.offset);
}
export async function findCustomer(q: Queryable, companyId: string, id: string, lock = false): Promise<CustomerRow | undefined> {
  const base = q.select().from(customers).where(and(eq(customers.companyId, companyId), eq(customers.id, id)));
  const [row] = lock ? await base.for('update') : await base;
  return row;
}
export async function insertCustomer(tx: Tx, v: typeof customers.$inferInsert): Promise<CustomerRow> {
  const [row] = await tx.insert(customers).values(v).returning();
  if (!row) throw new Error('customer insert returned no row');
  return row;
}
export async function updateCustomer(tx: Tx, id: string, v: Partial<typeof customers.$inferInsert>): Promise<void> {
  if (Object.keys(v).length > 0) await tx.update(customers).set(v).where(eq(customers.id, id));
}

export async function listAddresses(q: Queryable, companyId: string, customerId: string): Promise<AddressRow[]> {
  return q
    .select()
    .from(customerAddresses)
    .where(and(eq(customerAddresses.companyId, companyId), eq(customerAddresses.customerId, customerId)))
    .orderBy(asc(customerAddresses.type), asc(customerAddresses.id));
}
export async function findAddress(q: Queryable, companyId: string, id: string, lock = false): Promise<AddressRow | undefined> {
  const base = q.select().from(customerAddresses).where(and(eq(customerAddresses.companyId, companyId), eq(customerAddresses.id, id)));
  const [row] = lock ? await base.for('update') : await base;
  return row;
}
export async function insertAddress(tx: Tx, v: typeof customerAddresses.$inferInsert): Promise<AddressRow> {
  const [row] = await tx.insert(customerAddresses).values(v).returning();
  if (!row) throw new Error('address insert returned no row');
  return row;
}
export async function updateAddress(tx: Tx, id: string, v: Partial<typeof customerAddresses.$inferInsert>): Promise<void> {
  if (Object.keys(v).length > 0) await tx.update(customerAddresses).set(v).where(eq(customerAddresses.id, id));
}
/** Clear the default flag of the other active addresses of the same type. */
export async function clearDefaultAddress(tx: Tx, customerId: string, type: string, exceptId?: string): Promise<void> {
  await tx
    .update(customerAddresses)
    .set({ isDefault: false })
    .where(
      and(
        eq(customerAddresses.customerId, customerId),
        sql`${customerAddresses.type} = ${type}`,
        eq(customerAddresses.isDefault, true),
        exceptId ? sql`${customerAddresses.id} <> ${exceptId}` : undefined,
      ),
    );
}

export async function listVendors(q: Queryable, where: SQL | undefined, p: Paging) {
  return q.select().from(vendors).where(where).orderBy(asc(vendors.code)).limit(p.limit).offset(p.offset);
}
export async function findVendor(q: Queryable, companyId: string, id: string, lock = false): Promise<VendorRow | undefined> {
  const base = q.select().from(vendors).where(and(eq(vendors.companyId, companyId), eq(vendors.id, id)));
  const [row] = lock ? await base.for('update') : await base;
  return row;
}
export async function insertVendor(tx: Tx, v: typeof vendors.$inferInsert): Promise<VendorRow> {
  const [row] = await tx.insert(vendors).values(v).returning();
  if (!row) throw new Error('vendor insert returned no row');
  return row;
}
export async function updateVendor(tx: Tx, id: string, v: Partial<typeof vendors.$inferInsert>): Promise<void> {
  if (Object.keys(v).length > 0) await tx.update(vendors).set(v).where(eq(vendors.id, id));
}

// ---------------------------------------------------------------- approved sources

const sourceSelect = {
  s: approvedSources,
  vendorCode: vendors.code,
  vendorName: vendors.name,
  itemCode: items.code,
  itemName: items.name,
};
export type SourceListRow = { s: SourceRow; vendorCode: string; vendorName: string; itemCode: string; itemName: string };

export async function listSources(q: Queryable, where: SQL | undefined, p: Paging): Promise<SourceListRow[]> {
  return q
    .select(sourceSelect)
    .from(approvedSources)
    .innerJoin(vendors, eq(vendors.id, approvedSources.vendorId))
    .innerJoin(items, eq(items.id, approvedSources.itemId))
    .where(where)
    .orderBy(asc(items.code), asc(vendors.code), desc(approvedSources.id))
    .limit(p.limit)
    .offset(p.offset);
}
export async function findSource(q: Queryable, companyId: string, id: string): Promise<SourceListRow | undefined> {
  const [row] = await q
    .select(sourceSelect)
    .from(approvedSources)
    .innerJoin(vendors, eq(vendors.id, approvedSources.vendorId))
    .innerJoin(items, eq(items.id, approvedSources.itemId))
    .where(and(eq(approvedSources.companyId, companyId), eq(approvedSources.id, id)));
  return row;
}
export async function lockSource(tx: Tx, companyId: string, id: string): Promise<SourceRow | undefined> {
  const [row] = await tx
    .select()
    .from(approvedSources)
    .where(and(eq(approvedSources.companyId, companyId), eq(approvedSources.id, id)))
    .for('update');
  return row;
}
export async function insertSource(tx: Tx, v: typeof approvedSources.$inferInsert): Promise<SourceRow> {
  const [row] = await tx.insert(approvedSources).values(v).returning();
  if (!row) throw new Error('approved source insert returned no row');
  return row;
}

// ---------------------------------------------------------------- products

const productSelect = { p: products, itemCode: items.code, itemName: items.name };
export type ProductListRow = { p: ProductRow; itemCode: string; itemName: string };

export async function listProducts(q: Queryable, where: SQL | undefined, p: Paging): Promise<ProductListRow[]> {
  return q
    .select(productSelect)
    .from(products)
    .innerJoin(items, eq(items.id, products.itemId))
    .where(where)
    .orderBy(asc(items.code))
    .limit(p.limit)
    .offset(p.offset);
}
export async function findProduct(q: Queryable, companyId: string, id: string, lock = false): Promise<ProductListRow | undefined> {
  // Lock the product row alone (FOR UPDATE OF a schema-qualified table is not valid SQL), then read with the item.
  if (lock) await q.select({ id: products.id }).from(products).where(and(eq(products.companyId, companyId), eq(products.id, id))).for('update');
  const [row] = await q
    .select(productSelect)
    .from(products)
    .innerJoin(items, eq(items.id, products.itemId))
    .where(and(eq(products.companyId, companyId), eq(products.id, id)));
  return row;
}
export async function insertProduct(tx: Tx, v: typeof products.$inferInsert): Promise<ProductRow> {
  const [row] = await tx.insert(products).values(v).returning();
  if (!row) throw new Error('product insert returned no row');
  return row;
}
export async function updateProduct(tx: Tx, id: string, v: Partial<typeof products.$inferInsert>): Promise<void> {
  if (Object.keys(v).length > 0) await tx.update(products).set(v).where(eq(products.id, id));
}

// ---------------------------------------------------------------- formulas

const formulaSelect = { f: masterFormulas, itemCode: items.code, itemName: items.name };
export type FormulaListRow = { f: FormulaRow; itemCode: string; itemName: string };

export async function listFormulas(q: Queryable, where: SQL | undefined, p: Paging): Promise<FormulaListRow[]> {
  return q
    .select(formulaSelect)
    .from(masterFormulas)
    .innerJoin(products, eq(products.id, masterFormulas.productId))
    .innerJoin(items, eq(items.id, products.itemId))
    .where(where)
    .orderBy(asc(items.code), desc(masterFormulas.version))
    .limit(p.limit)
    .offset(p.offset);
}
export async function findFormula(q: Queryable, companyId: string, id: string): Promise<FormulaListRow | undefined> {
  const [row] = await q
    .select(formulaSelect)
    .from(masterFormulas)
    .innerJoin(products, eq(products.id, masterFormulas.productId))
    .innerJoin(items, eq(items.id, products.itemId))
    .where(and(eq(masterFormulas.companyId, companyId), eq(masterFormulas.id, id)));
  return row;
}
export async function lockFormula(tx: Tx, companyId: string, id: string): Promise<FormulaRow | undefined> {
  const [row] = await tx
    .select()
    .from(masterFormulas)
    .where(and(eq(masterFormulas.companyId, companyId), eq(masterFormulas.id, id)))
    .for('update');
  return row;
}
/** All versions of a product, newest first, locked (serialises version creation and approval). */
export async function lockFormulasOfProduct(tx: Tx, productId: string): Promise<FormulaRow[]> {
  return tx
    .select()
    .from(masterFormulas)
    .where(eq(masterFormulas.productId, productId))
    .orderBy(desc(masterFormulas.version))
    .for('update');
}
export async function insertFormula(tx: Tx, v: typeof masterFormulas.$inferInsert): Promise<FormulaRow> {
  const [row] = await tx.insert(masterFormulas).values(v).returning();
  if (!row) throw new Error('formula insert returned no row');
  return row;
}
export async function updateFormula(tx: Tx, id: string, v: Partial<typeof masterFormulas.$inferInsert>): Promise<void> {
  if (Object.keys(v).length > 0) await tx.update(masterFormulas).set(v).where(eq(masterFormulas.id, id));
}
export async function formulaLines(q: Queryable, formulaId: string) {
  return q
    .select({ l: masterFormulaLines, itemCode: items.code, itemName: items.name })
    .from(masterFormulaLines)
    .innerJoin(items, eq(items.id, masterFormulaLines.itemId))
    .where(eq(masterFormulaLines.formulaId, formulaId))
    .orderBy(asc(masterFormulaLines.lineNo));
}
export async function deleteFormulaLines(tx: Tx, formulaId: string): Promise<void> {
  await tx.delete(masterFormulaLines).where(eq(masterFormulaLines.formulaId, formulaId));
}
export async function insertFormulaLines(tx: Tx, rows: (typeof masterFormulaLines.$inferInsert)[]): Promise<void> {
  if (rows.length > 0) await tx.insert(masterFormulaLines).values(rows);
}

// ---------------------------------------------------------------- price lists

export async function listPriceLists(q: Queryable, where: SQL | undefined, p: Paging) {
  return q.select().from(priceLists).where(where).orderBy(asc(priceLists.code)).limit(p.limit).offset(p.offset);
}
export async function findPriceList(q: Queryable, companyId: string, id: string): Promise<PriceListRow | undefined> {
  const [row] = await q.select().from(priceLists).where(and(eq(priceLists.companyId, companyId), eq(priceLists.id, id)));
  return row;
}
export async function insertPriceList(tx: Tx, v: typeof priceLists.$inferInsert): Promise<PriceListRow> {
  const [row] = await tx.insert(priceLists).values(v).returning();
  if (!row) throw new Error('price list insert returned no row');
  return row;
}
export async function updatePriceList(tx: Tx, id: string, v: Partial<typeof priceLists.$inferInsert>): Promise<void> {
  if (Object.keys(v).length > 0) await tx.update(priceLists).set(v).where(eq(priceLists.id, id));
}
export async function priceListLinesOf(q: Queryable, priceListId: string): Promise<PriceListLineRow[]> {
  return q.select().from(priceListLines).where(eq(priceListLines.priceListId, priceListId)).orderBy(asc(priceListLines.id));
}
export async function findPriceListLine(q: Queryable, companyId: string, id: string): Promise<PriceListLineRow | undefined> {
  const [row] = await q.select().from(priceListLines).where(and(eq(priceListLines.companyId, companyId), eq(priceListLines.id, id)));
  return row;
}
export async function insertPriceListLine(tx: Tx, v: typeof priceListLines.$inferInsert): Promise<PriceListLineRow> {
  const [row] = await tx.insert(priceListLines).values(v).returning();
  if (!row) throw new Error('price list line insert returned no row');
  return row;
}
export async function updatePriceListLine(tx: Tx, id: string, v: Partial<typeof priceListLines.$inferInsert>): Promise<void> {
  if (Object.keys(v).length > 0) await tx.update(priceListLines).set(v).where(eq(priceListLines.id, id));
}
