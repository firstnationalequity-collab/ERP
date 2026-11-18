// Drizzle description of the `master` schema. Source of truth: src/db/migrations/0008_masters.sql (+ 0011 item status).
import { sql } from 'drizzle-orm';
import { boolean, date, integer, numeric, pgSchema, text } from 'drizzle-orm/pg-core';
import type {
  AddressType,
  ApprovedSourceStatus,
  AssayBasis,
  FormulaStatus,
  ItemStatus,
  ItemType,
  PartyStatus,
  StorageZone,
  TaxKind,
} from '@albert/shared';
import { auditColumns, bigintString, companyId, identityId } from './columns';

export const master = pgSchema('master');

export const taxCodes = master.table('tax_codes', {
  id: identityId(),
  companyId: companyId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  kind: text('kind').$type<TaxKind>().notNull(),
  rate: numeric('rate', { precision: 9, scale: 4 }).notNull(),
  isPlaceholder: boolean('is_placeholder').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const uoms = master.table('uoms', {
  id: identityId(),
  companyId: companyId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const itemCategories = master.table('item_categories', {
  id: identityId(),
  companyId: companyId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const items = master.table('items', {
  id: identityId(),
  companyId: companyId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  type: text('type').$type<ItemType>().notNull(),
  categoryId: bigintString('category_id').notNull(),
  baseUomId: bigintString('base_uom_id').notNull(),
  taxCodeId: bigintString('tax_code_id'),
  shelfLifeDays: integer('shelf_life_days'),
  retestDays: integer('retest_days'),
  isControlled: boolean('is_controlled').notNull().default(false),
  storageZone: text('storage_zone').$type<StorageZone>().notNull().default('AMBIENT'),
  /** Changed only through core/transition (0011). */
  status: text('status').$type<ItemStatus>().notNull(),
  /** Generated: status = 'ACTIVE'. Never written. */
  isActive: boolean('is_active').generatedAlwaysAs(sql`status = 'ACTIVE'`),
  ...auditColumns(),
});

export const uomConversions = master.table('uom_conversions', {
  id: identityId(),
  companyId: companyId(),
  itemId: bigintString('item_id'),
  fromUomId: bigintString('from_uom_id').notNull(),
  toUomId: bigintString('to_uom_id').notNull(),
  factor: numeric('factor', { precision: 18, scale: 6 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const warehouses = master.table('warehouses', {
  id: identityId(),
  companyId: companyId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  address: text('address'),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const locations = master.table('locations', {
  id: identityId(),
  companyId: companyId(),
  warehouseId: bigintString('warehouse_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  storageZone: text('storage_zone').$type<StorageZone>().notNull().default('AMBIENT'),
  isReturnsArea: boolean('is_returns_area').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const customers = master.table('customers', {
  id: identityId(),
  companyId: companyId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  ntn: text('ntn'),
  cnic: text('cnic'),
  strn: text('strn'),
  creditLimit: numeric('credit_limit', { precision: 18, scale: 2 }).notNull().default('0'),
  paymentTermsDays: integer('payment_terms_days').notNull().default(0),
  isTollCustomer: boolean('is_toll_customer').notNull().default(false),
  status: text('status').$type<PartyStatus>().notNull(),
  ...auditColumns(),
});

export const customerAddresses = master.table('customer_addresses', {
  id: identityId(),
  companyId: companyId(),
  customerId: bigintString('customer_id').notNull(),
  type: text('type').$type<AddressType>().notNull(),
  line1: text('line1').notNull(),
  line2: text('line2'),
  city: text('city').notNull(),
  province: text('province'),
  isDefault: boolean('is_default').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const vendors = master.table('vendors', {
  id: identityId(),
  companyId: companyId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  ntn: text('ntn'),
  cnic: text('cnic'),
  strn: text('strn'),
  isForeign: boolean('is_foreign').notNull().default(false),
  country: text('country').notNull().default('PK'),
  currency: text('currency').notNull().default('PKR'),
  bankName: text('bank_name'),
  bankAccount: text('bank_account'),
  paymentTermsDays: integer('payment_terms_days').notNull().default(0),
  status: text('status').$type<PartyStatus>().notNull(),
  ...auditColumns(),
});

export const approvedSources = master.table('approved_sources', {
  id: identityId(),
  companyId: companyId(),
  vendorId: bigintString('vendor_id').notNull(),
  itemId: bigintString('item_id').notNull(),
  manufacturer: text('manufacturer').notNull(),
  manufacturingSite: text('manufacturing_site').notNull(),
  notes: text('notes'),
  status: text('status').$type<ApprovedSourceStatus>().notNull(),
  ...auditColumns(),
});

export const products = master.table('products', {
  id: identityId(),
  companyId: companyId(),
  itemId: bigintString('item_id').notNull(),
  customerId: bigintString('customer_id'),
  registrationNo: text('registration_no'),
  artworkVersion: text('artwork_version'),
  qualityAgreementSignedOn: date('quality_agreement_signed_on', { mode: 'string' }),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const masterFormulas = master.table('master_formulas', {
  id: identityId(),
  companyId: companyId(),
  productId: bigintString('product_id').notNull(),
  version: integer('version').notNull(),
  batchSize: numeric('batch_size', { precision: 18, scale: 4 }).notNull(),
  batchUomId: bigintString('batch_uom_id').notNull(),
  notes: text('notes'),
  status: text('status').$type<FormulaStatus>().notNull(),
  ...auditColumns(),
});

export const masterFormulaLines = master.table('master_formula_lines', {
  id: identityId(),
  companyId: companyId(),
  formulaId: bigintString('formula_id').notNull(),
  lineNo: integer('line_no').notNull(),
  itemId: bigintString('item_id').notNull(),
  qtyPerBatch: numeric('qty_per_batch', { precision: 18, scale: 4 }).notNull(),
  uomId: bigintString('uom_id').notNull(),
  isApi: boolean('is_api').notNull().default(false),
  isFiller: boolean('is_filler').notNull().default(false),
  assayBasis: text('assay_basis').$type<AssayBasis>(),
  ...auditColumns(),
});

export const priceLists = master.table('price_lists', {
  id: identityId(),
  companyId: companyId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  customerId: bigintString('customer_id'),
  currency: text('currency').notNull().default('PKR'),
  validFrom: date('valid_from', { mode: 'string' }).notNull(),
  validTo: date('valid_to', { mode: 'string' }),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});

export const priceListLines = master.table('price_list_lines', {
  id: identityId(),
  companyId: companyId(),
  priceListId: bigintString('price_list_id').notNull(),
  itemId: bigintString('item_id').notNull(),
  uomId: bigintString('uom_id').notNull(),
  unitPrice: numeric('unit_price', { precision: 18, scale: 2 }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  ...auditColumns(),
});
