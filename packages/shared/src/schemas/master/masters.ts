// Masters API (/api/v1/master/*): requests (Zod) and responses (DTOs). M2 task 3.
// Rules mirror apps/api/src/db/migrations/0008_masters.sql and 0009_party_guards.sql.
// Money and quantities travel as decimal strings, never JS numbers (rule 10).
import { z } from 'zod';
import {
  AddressType,
  ApprovedSourceStatus,
  AssayBasis,
  FormulaStatus,
  ItemType,
  type ItemStatus,
  PartyStatus,
  StorageZone,
  TaxKind,
} from '../../enums';
import { ESignRequest, WitnessSignRequest } from '../core/esign';
import type { AttachmentDto } from '../core/attachments';

const id = z.string().regex(/^\d+$/, 'Invalid id');
const name = z.string().trim().min(1, 'Name is required').max(200);
const optText = (max: number) => z.string().trim().max(max).nullable().optional();
const reason = z.string().trim().min(3, 'Give a reason (at least 3 characters)').max(500);

/** Non-negative decimal string with at most `intDigits` digits before and `scale` after the point. */
export const decimalString = (intDigits: number, scale: number, label = 'Value') =>
  z
    .string()
    .trim()
    .regex(new RegExp(`^\\d{1,${intDigits}}(\\.\\d{1,${scale}})?$`), `${label}: up to ${intDigits} digits and ${scale} decimals`);
const positive = (s: z.ZodString, label: string) => s.refine((v) => /[1-9]/.test(v), `${label} must be above zero`);

/**
 * Unit price or unit cost: a rate NUMERIC(18,6), ≥ 0 (owner 2026-11-25: amounts 2 decimals, unit rates 6),
 * e.g. a printed label at 0.035 PKR.
 */
export const unitRate = (label: string) => decimalString(12, 6, label);

/** Money NUMERIC(18,2); quantity NUMERIC(18,4); rate NUMERIC(9,4); conversion factor NUMERIC(18,6). */
const money = (label: string) => decimalString(16, 2, label);
const qty = (label: string) => positive(decimalString(14, 4, label), label);
const factor = positive(decimalString(12, 6, 'Factor'), 'Factor');
/** 0–100 with up to 4 decimals, checked on the text (no floats). */
const percentRate = z
  .string()
  .trim()
  .regex(/^(100(\.0{1,4})?|\d{1,2}(\.\d{1,4})?)$/, 'Rate: 0 to 100 with up to 4 decimals');

const code = (re: RegExp, max: number) =>
  z
    .string()
    .trim()
    .toUpperCase()
    .max(max)
    .regex(re, 'Code: capital letters, digits and - _ only, starting with a letter or digit');
const code20 = code(/^[A-Z0-9][A-Z0-9_-]*$/, 20);
const code30 = code(/^[A-Z0-9][A-Z0-9_-]*$/, 30);
const ntn = z.string().trim().regex(/^[0-9]{7}-?[0-9]?$/, 'NTN: 7 digits, optional check digit (1234567-8)');
const cnic = z.string().trim().regex(/^[0-9]{5}-?[0-9]{7}-?[0-9]$/, 'CNIC: 13 digits (12345-1234567-1)');
const strn = z.string().trim().toUpperCase().regex(/^[0-9A-Z-]{5,20}$/, 'STRN: 5–20 letters, digits or -');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const days = z.number().int().positive().max(36500);
const termsDays = z.number().int().min(0).max(365);

/** Body of activate / deactivate actions on masters. A reason is required to deactivate. */
export const MasterActionRequest = z.object({ reason: reason.optional() }).strict();
export type MasterActionRequest = z.infer<typeof MasterActionRequest>;
export const DeactivateRequest = z.object({ reason }).strict();
export type DeactivateRequest = z.infer<typeof DeactivateRequest>;

export const MasterListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(100).optional(),
  /** active | inactive | all (default all). For customers/vendors/AVL/formulas use `status`. */
  active: z.enum(['active', 'inactive', 'all']).default('all'),
  status: z.string().trim().max(30).optional(),
  type: z.enum(ItemType).optional(),
  /** Filters by parent: warehouseId (locations), productId (formulas), vendorId / itemId (AVL), customerId. */
  warehouseId: id.optional(),
  productId: id.optional(),
  vendorId: id.optional(),
  itemId: id.optional(),
  customerId: id.optional(),
});
export type MasterListQuery = z.infer<typeof MasterListQuery>;

interface Stamped {
  id: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

// ---------------------------------------------------------------- tax codes (fin.master.manage)

export const CreateTaxCodeRequest = z
  .object({ code: code30, name, kind: z.enum(TaxKind), rate: percentRate, isPlaceholder: z.boolean().default(false) })
  .strict();
export type CreateTaxCodeRequest = z.infer<typeof CreateTaxCodeRequest>;
export const UpdateTaxCodeRequest = z.object({ name: name.optional(), rate: percentRate.optional(), isPlaceholder: z.boolean().optional() }).strict();
export type UpdateTaxCodeRequest = z.infer<typeof UpdateTaxCodeRequest>;
export interface TaxCodeDto extends Stamped {
  code: string;
  name: string;
  kind: TaxKind;
  rate: string;
  isPlaceholder: boolean;
  isActive: boolean;
}

// ---------------------------------------------------------------- UoM, categories, items, conversions (master.item.manage)

export const CreateUomRequest = z.object({ code: z.string().trim().regex(/^[A-Za-z0-9]{1,10}$/, 'UoM code: 1–10 letters or digits'), name }).strict();
export type CreateUomRequest = z.infer<typeof CreateUomRequest>;
export const UpdateNameRequest = z.object({ name }).strict();
export type UpdateNameRequest = z.infer<typeof UpdateNameRequest>;
export interface UomDto extends Stamped {
  code: string;
  name: string;
  isActive: boolean;
}

export const CreateCategoryRequest = z.object({ code: code30, name }).strict();
export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequest>;
export interface CategoryDto extends Stamped {
  code: string;
  name: string;
  isActive: boolean;
}

const itemFields = {
  name,
  categoryId: id,
  taxCodeId: id.nullable().optional(),
  shelfLifeDays: days.nullable().optional(),
  retestDays: days.nullable().optional(),
  isControlled: z.boolean().optional(),
  storageZone: z.enum(StorageZone).optional(),
};
const retestWithinShelfLife = (v: { shelfLifeDays?: number | null; retestDays?: number | null }) =>
  v.retestDays == null || v.shelfLifeDays == null || v.retestDays <= v.shelfLifeDays;
/** Code, type and base UoM are fixed once created (stock and documents depend on them). */
export const CreateItemRequest = z
  .object({ code: code(/^[A-Z0-9][A-Z0-9_./-]*$/, 40), type: z.enum(ItemType), baseUomId: id, ...itemFields })
  .strict()
  .refine(retestWithinShelfLife, { message: 'Retest period cannot exceed shelf life', path: ['retestDays'] });
export type CreateItemRequest = z.infer<typeof CreateItemRequest>;
/**
 * Fields of a GMP item whose change after DRAFT needs a countersign by a holder of master.item.approve who is
 * not the editor (owner decision 18-11-2026; DB guard 0011). Name, category and tax code stay free.
 */
export const GmpItemSensitiveFields = ['shelfLifeDays', 'retestDays', 'storageZone', 'isControlled'] as const;
export const UpdateItemRequest = z
  .object({ ...itemFields, name: name.optional(), categoryId: id.optional(), countersign: WitnessSignRequest.optional() })
  .strict();
export type UpdateItemRequest = z.infer<typeof UpdateItemRequest>;
export interface ItemDto extends Stamped {
  code: string;
  name: string;
  type: ItemType;
  categoryId: string;
  baseUomId: string;
  taxCodeId: string | null;
  shelfLifeDays: number | null;
  retestDays: number | null;
  isControlled: boolean;
  storageZone: StorageZone;
  status: ItemStatus;
  /** True only when status is ACTIVE (generated column). */
  isActive: boolean;
}

/** 1 from-UoM = factor × to-UoM; itemId null = applies to every item. Never edited: deactivate and add a new one. */
export const CreateConversionRequest = z
  .object({ itemId: id.nullable().optional(), fromUomId: id, toUomId: id, factor })
  .strict()
  .refine((v) => v.fromUomId !== v.toUomId, { message: 'From and to UoM must differ', path: ['toUomId'] });
export type CreateConversionRequest = z.infer<typeof CreateConversionRequest>;
export interface ConversionDto extends Stamped {
  itemId: string | null;
  fromUomId: string;
  toUomId: string;
  factor: string;
  isActive: boolean;
}

// ---------------------------------------------------------------- warehouses and locations (master.location.manage)

export const CreateWarehouseRequest = z.object({ code: code20, name, address: optText(500) }).strict();
export type CreateWarehouseRequest = z.infer<typeof CreateWarehouseRequest>;
export const UpdateWarehouseRequest = z.object({ name: name.optional(), address: optText(500) }).strict();
export type UpdateWarehouseRequest = z.infer<typeof UpdateWarehouseRequest>;
export interface WarehouseDto extends Stamped {
  code: string;
  name: string;
  address: string | null;
  isActive: boolean;
}

export const CreateLocationRequest = z
  .object({ warehouseId: id, code: code(/^[A-Z0-9][A-Z0-9_./-]*$/, 30), name, storageZone: z.enum(StorageZone).default('AMBIENT'), isReturnsArea: z.boolean().default(false) })
  .strict();
export type CreateLocationRequest = z.infer<typeof CreateLocationRequest>;
export const UpdateLocationRequest = z
  .object({ name: name.optional(), storageZone: z.enum(StorageZone).optional(), isReturnsArea: z.boolean().optional() })
  .strict();
export type UpdateLocationRequest = z.infer<typeof UpdateLocationRequest>;
export interface LocationDto extends Stamped {
  warehouseId: string;
  code: string;
  name: string;
  storageZone: StorageZone;
  /** Customer returns are received only into a returns area (owner 2026-11-18, Q9; 0017). */
  isReturnsArea: boolean;
  isActive: boolean;
}

// ---------------------------------------------------------------- customers and vendors

/**
 * Fields whose change on an ACTIVE/INACTIVE record needs a countersign by a holder of the approve key
 * who is not the editor (decision 18-11-2026; DB guard 0009). DRAFT edits need none.
 */
export const CustomerSensitiveFields = ['ntn', 'cnic', 'strn', 'creditLimit', 'isTollCustomer'] as const;
export const VendorSensitiveFields = ['ntn', 'cnic', 'strn', 'isForeign', 'country', 'currency', 'bankName', 'bankAccount'] as const;

const customerFields = {
  name,
  ntn: ntn.nullable().optional(),
  cnic: cnic.nullable().optional(),
  strn: strn.nullable().optional(),
  creditLimit: money('Credit limit').optional(),
  paymentTermsDays: termsDays.optional(),
  isTollCustomer: z.boolean().optional(),
};
export const CreateCustomerRequest = z
  .object({ code: code20, ...customerFields })
  .strict()
  .refine((v) => !!v.ntn || !!v.cnic, { message: 'NTN or CNIC is required', path: ['ntn'] });
export type CreateCustomerRequest = z.infer<typeof CreateCustomerRequest>;
export const UpdateCustomerRequest = z
  .object({ ...customerFields, name: name.optional(), countersign: WitnessSignRequest.optional() })
  .strict();
export type UpdateCustomerRequest = z.infer<typeof UpdateCustomerRequest>;
export interface CustomerDto extends Stamped {
  code: string;
  name: string;
  ntn: string | null;
  cnic: string | null;
  strn: string | null;
  creditLimit: string;
  paymentTermsDays: number;
  isTollCustomer: boolean;
  status: PartyStatus;
}

const addressFields = {
  type: z.enum(AddressType),
  line1: z.string().trim().min(1, 'Address line 1 is required').max(200),
  line2: optText(200),
  city: z.string().trim().min(1, 'City is required').max(100),
  province: optText(100),
  isDefault: z.boolean().default(false),
};
export const CreateAddressRequest = z.object(addressFields).strict();
export type CreateAddressRequest = z.infer<typeof CreateAddressRequest>;
export const UpdateAddressRequest = z
  .object({ ...addressFields, type: addressFields.type.optional(), line1: addressFields.line1.optional(), city: addressFields.city.optional(), isDefault: z.boolean().optional() })
  .strict();
export type UpdateAddressRequest = z.infer<typeof UpdateAddressRequest>;
export interface AddressDto extends Stamped {
  customerId: string;
  type: AddressType;
  line1: string;
  line2: string | null;
  city: string;
  province: string | null;
  isDefault: boolean;
  isActive: boolean;
}

const vendorFields = {
  name,
  ntn: ntn.nullable().optional(),
  cnic: cnic.nullable().optional(),
  strn: strn.nullable().optional(),
  isForeign: z.boolean().optional(),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Country: 2-letter ISO code').optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Currency: 3-letter ISO code').optional(),
  bankName: optText(100),
  bankAccount: optText(50),
  paymentTermsDays: termsDays.optional(),
};
export const CreateVendorRequest = z
  .object({ code: code20, ...vendorFields })
  .strict()
  .refine((v) => v.isForeign === true || !!v.ntn || !!v.cnic, { message: 'NTN or CNIC is required for a local vendor', path: ['ntn'] })
  .refine((v) => v.isForeign !== true || (v.country !== undefined && v.country !== 'PK'), {
    message: 'A foreign vendor needs its country (not PK)',
    path: ['country'],
  });
export type CreateVendorRequest = z.infer<typeof CreateVendorRequest>;
export const UpdateVendorRequest = z
  .object({ ...vendorFields, name: name.optional(), countersign: WitnessSignRequest.optional() })
  .strict();
export type UpdateVendorRequest = z.infer<typeof UpdateVendorRequest>;
export interface VendorDto extends Stamped {
  code: string;
  name: string;
  ntn: string | null;
  cnic: string | null;
  strn: string | null;
  isForeign: boolean;
  country: string;
  currency: string;
  bankName: string | null;
  bankAccount: string | null;
  paymentTermsDays: number;
  status: PartyStatus;
}

// ---------------------------------------------------------------- approved sources (AVL)

/** Purchase Officer proposes; the AVL approval (QA Manager e-signature) decides. Attach evidence before QA signs. */
export const CreateApprovedSourceRequest = z
  .object({
    vendorId: id,
    itemId: id,
    manufacturer: z.string().trim().min(1, 'Manufacturer is required').max(200),
    manufacturingSite: z.string().trim().min(1, 'Manufacturing site is required').max(300),
    notes: optText(1000),
  })
  .strict();
export type CreateApprovedSourceRequest = z.infer<typeof CreateApprovedSourceRequest>;
/** QA Manager blocks an approved source: e-signature with meaning REJECTED and a reason. */
export const BlockSourceRequest = z.object({ signature: ESignRequest }).strict();
export type BlockSourceRequest = z.infer<typeof BlockSourceRequest>;
export interface ApprovedSourceDto extends Stamped {
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  manufacturer: string;
  manufacturingSite: string;
  notes: string | null;
  status: ApprovedSourceStatus;
  /** The open or last AVL approval, if any. */
  approvalId: string | null;
  attachments?: AttachmentDto[];
}

// ---------------------------------------------------------------- products (master.product.manage)

/** Changing these needs a countersign by a holder of qa.product.countersign who is not the editor. */
export const ProductRegulatedFields = ['registrationNo', 'artworkVersion', 'qualityAgreementSignedOn'] as const;
const productFields = {
  customerId: id.nullable().optional(),
  registrationNo: optText(50),
  artworkVersion: optText(50),
  qualityAgreementSignedOn: date.nullable().optional(),
  countersign: WitnessSignRequest.optional(),
};
export const CreateProductRequest = z.object({ itemId: id, ...productFields }).strict();
export type CreateProductRequest = z.infer<typeof CreateProductRequest>;
export const UpdateProductRequest = z.object(productFields).strict();
export type UpdateProductRequest = z.infer<typeof UpdateProductRequest>;
export interface ProductDto extends Stamped {
  itemId: string;
  itemCode: string;
  itemName: string;
  customerId: string | null;
  registrationNo: string | null;
  artworkVersion: string | null;
  qualityAgreementSignedOn: string | null;
  isActive: boolean;
}

// ---------------------------------------------------------------- master formulas

export const FormulaLineInput = z
  .object({
    itemId: id,
    qtyPerBatch: qty('Quantity per batch'),
    uomId: id,
    isApi: z.boolean().default(false),
    isFiller: z.boolean().default(false),
    assayBasis: z.enum(AssayBasis).nullable().optional(),
  })
  .strict()
  .refine((l) => !(l.isApi && l.isFiller), { message: 'A line cannot be both API and filler', path: ['isFiller'] })
  .refine((l) => l.isApi === (l.assayBasis != null), { message: 'API lines need an assay basis; other lines none', path: ['assayBasis'] });
export type FormulaLineInput = z.infer<typeof FormulaLineInput>;

/** New version for a product. Without lines/batch data, the latest version's are copied. */
export const CreateFormulaRequest = z
  .object({
    productId: id,
    batchSize: qty('Batch size').optional(),
    batchUomId: id.optional(),
    notes: optText(1000),
  })
  .strict();
export type CreateFormulaRequest = z.infer<typeof CreateFormulaRequest>;
export const UpdateFormulaRequest = z
  .object({ batchSize: qty('Batch size').optional(), batchUomId: id.optional(), notes: optText(1000) })
  .strict();
export type UpdateFormulaRequest = z.infer<typeof UpdateFormulaRequest>;
export const SetFormulaLinesRequest = z.object({ lines: z.array(FormulaLineInput).max(200) }).strict();
export type SetFormulaLinesRequest = z.infer<typeof SetFormulaLinesRequest>;

export interface FormulaLineDto {
  id: string;
  lineNo: number;
  itemId: string;
  itemCode: string;
  itemName: string;
  qtyPerBatch: string;
  uomId: string;
  isApi: boolean;
  isFiller: boolean;
  assayBasis: AssayBasis | null;
}
export interface FormulaDto extends Stamped {
  productId: string;
  productItemCode: string;
  productItemName: string;
  version: number;
  batchSize: string;
  batchUomId: string;
  notes: string | null;
  status: FormulaStatus;
  approvalId: string | null;
  lines?: FormulaLineDto[];
}

// ---------------------------------------------------------------- price lists (master.price.manage)

const priceListFields = {
  name,
  customerId: id.nullable().optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Currency: 3-letter ISO code').optional(),
  validFrom: date,
  validTo: date.nullable().optional(),
};
const validRange = (v: { validFrom?: string; validTo?: string | null }) => !v.validFrom || !v.validTo || v.validTo >= v.validFrom;
export const CreatePriceListRequest = z
  .object({ code: code30, ...priceListFields })
  .strict()
  .refine(validRange, { message: 'Valid-to cannot be before valid-from', path: ['validTo'] });
export type CreatePriceListRequest = z.infer<typeof CreatePriceListRequest>;
export const UpdatePriceListRequest = z
  .object({ ...priceListFields, name: name.optional(), validFrom: date.optional() })
  .strict()
  .refine(validRange, { message: 'Valid-to cannot be before valid-from', path: ['validTo'] });
export type UpdatePriceListRequest = z.infer<typeof UpdatePriceListRequest>;
export interface PriceListDto extends Stamped {
  code: string;
  name: string;
  customerId: string | null;
  currency: string;
  validFrom: string;
  validTo: string | null;
  isActive: boolean;
  lines?: PriceListLineDto[];
}

export const CreatePriceListLineRequest = z.object({ itemId: id, uomId: id, unitPrice: unitRate('Unit price') }).strict();
export type CreatePriceListLineRequest = z.infer<typeof CreatePriceListLineRequest>;
export const UpdatePriceListLineRequest = z.object({ unitPrice: unitRate('Unit price') }).strict();
export type UpdatePriceListLineRequest = z.infer<typeof UpdatePriceListLineRequest>;
export interface PriceListLineDto extends Stamped {
  priceListId: string;
  itemId: string;
  uomId: string;
  unitPrice: string;
  isActive: boolean;
}
