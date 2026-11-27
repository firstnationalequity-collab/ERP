// Development-only sample data (`pnpm db:seed:demo-data`). Same guard as db:seed:dev (NODE_ENV must be
// "development", the database name must not look like production), and it runs db:seed:dev first.
//
// Every record is written through the normal services, signed in as the demo user whose role does that work
// (Warehouse Manager drafts items, QA Manager activates them and approves sources and the formula, Purchase
// Officer drafts vendors and POs, Purchase Manager activates vendors and approves the PO, and so on), so status
// history, approvals, e-signatures, segregation checks and the audit trail are the real ones. Inputs go through
// the same Zod schemas as the API.
//
// Idempotent: each record is looked up by its code (POs by their note) and only what is missing is done. A run
// that stopped half-way resumes (e.g. a source still PENDING gets its evidence and approval). A run on a later day
// adds that day's USD rate and nothing else.
//
// All names, NTNs and sites are fictional and start with "Demo"; codes start with "DM-". The USD rate is a demo
// value, not an SBP rate (source says so).
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  CreateApprovedSourceRequest,
  CreateCategoryRequest,
  CreateCustomerRequest,
  CreateFormulaRequest,
  CreateItemRequest,
  CreateLocationRequest,
  CreatePoRequest,
  CreateProductRequest,
  CreateUomRequest,
  CreateVendorRequest,
  CreateWarehouseRequest,
  SetExchangeRateRequest,
  SetFormulaLinesRequest,
  type ESignRequest,
  type ItemType,
} from '@albert/shared';
import { db } from '../client';
import {
  approvedSources,
  customers,
  itemCategories,
  items,
  locations,
  masterFormulas,
  products,
  uoms,
  vendors,
  warehouses,
} from '../schema/masters';
import { exchangeRates } from '../schema/fin';
import { purchaseOrders } from '../schema/purch';
import { authenticateToken, login, logout, type AuthContext, type RequestMeta } from '../../core/auth/auth.service';
import { companyToday } from '../../core/dates';
import { approve, latestApprovalIds } from '../../core/approvals/approvals.service';
import { countForDocument, upload } from '../../core/attachments/attachments.service';
import * as catalog from '../../modules/masters/catalog.service';
import * as itemsSvc from '../../modules/masters/items.service';
import * as parties from '../../modules/masters/parties.service';
import * as avl from '../../modules/masters/avl.service';
import * as productsSvc from '../../modules/masters/products.service';
import * as formulas from '../../modules/masters/formulas.service';
import * as rates from '../../modules/finance/rates.service';
import * as orders from '../../modules/procurement/orders.service';
import { assertDevTarget, demoUsername, runDevSeed, type DevSeedOptions } from './dev';

const COMMAND = 'db:seed:demo-data';
const META: RequestMeta = { ip: null, userAgent: COMMAND };

// ---------------------------------------------------------------- the data

const UOMS = [
  { code: 'KG', name: 'Kilogram' },
  { code: 'NOS', name: 'Numbers (pieces)' },
  { code: 'TAB', name: 'Tablet' },
  { code: 'CAP', name: 'Capsule' },
] as const;
type UomCode = (typeof UOMS)[number]['code'];

const CATEGORIES = [
  { code: 'DM-API', name: 'Active ingredients (demo)' },
  { code: 'DM-EXCIPIENT', name: 'Excipients (demo)' },
  { code: 'DM-PACKING', name: 'Packing materials (demo)' },
  { code: 'DM-FG', name: 'Finished goods (demo)' },
] as const;
type CategoryCode = (typeof CATEGORIES)[number]['code'];

interface DemoItem {
  code: string;
  name: string;
  type: ItemType;
  category: CategoryCode;
  uom: UomCode;
  shelfLifeDays: number | null;
  retestDays: number | null;
}
const ITEMS: DemoItem[] = [
  { code: 'DM-API-001', name: 'Paracetamol BP', type: 'API', category: 'DM-API', uom: 'KG', shelfLifeDays: 1825, retestDays: 730 },
  { code: 'DM-API-002', name: 'Amoxicillin Trihydrate BP', type: 'API', category: 'DM-API', uom: 'KG', shelfLifeDays: 1095, retestDays: 365 },
  { code: 'DM-EXC-001', name: 'Microcrystalline Cellulose PH-101', type: 'EXCIPIENT', category: 'DM-EXCIPIENT', uom: 'KG', shelfLifeDays: 1825, retestDays: 730 },
  { code: 'DM-EXC-002', name: 'Maize Starch BP', type: 'EXCIPIENT', category: 'DM-EXCIPIENT', uom: 'KG', shelfLifeDays: 1095, retestDays: 365 },
  { code: 'DM-EXC-003', name: 'Magnesium Stearate BP', type: 'EXCIPIENT', category: 'DM-EXCIPIENT', uom: 'KG', shelfLifeDays: 1825, retestDays: 730 },
  { code: 'DM-PM-001', name: 'PVC Film 250 micron, clear', type: 'PM', category: 'DM-PACKING', uom: 'KG', shelfLifeDays: null, retestDays: null },
  { code: 'DM-PM-002', name: 'Aluminium Blister Foil 20 micron, printed', type: 'PM', category: 'DM-PACKING', uom: 'KG', shelfLifeDays: null, retestDays: null },
  { code: 'DM-PM-003', name: 'Printed Carton, Paracetamol 500 mg 10x10', type: 'PM', category: 'DM-PACKING', uom: 'NOS', shelfLifeDays: null, retestDays: null },
  { code: 'DM-FG-001', name: 'Paracetamol 500 mg Tablets', type: 'FG', category: 'DM-FG', uom: 'TAB', shelfLifeDays: 1095, retestDays: null },
  { code: 'DM-FG-002', name: 'Amoxicillin 250 mg Capsules', type: 'FG', category: 'DM-FG', uom: 'CAP', shelfLifeDays: 730, retestDays: null },
];

const VENDORS = [
  { code: 'DM-V-CHEM', name: 'Demo Chemicals (Pvt) Ltd', ntn: '9900001', country: 'PK', currency: 'PKR', isForeign: false, paymentTermsDays: 30 },
  { code: 'DM-V-PACK', name: 'Demo Packaging (Pvt) Ltd', ntn: '9900002', country: 'PK', currency: 'PKR', isForeign: false, paymentTermsDays: 45 },
  { code: 'DM-V-IMP', name: 'Demo Fine Chemicals Co., Ltd.', ntn: null, country: 'CN', currency: 'USD', isForeign: true, paymentTermsDays: 60 },
] as const;
type VendorCode = (typeof VENDORS)[number]['code'];

/** Approved sources: every API, excipient and packing item has one vendor. */
const SOURCES: { vendor: VendorCode; item: string; manufacturer: string; site: string }[] = [
  { vendor: 'DM-V-IMP', item: 'DM-API-001', manufacturer: 'Demo Fine Chemicals Co., Ltd.', site: 'Plant 2, Demo Industrial Park, CN' },
  { vendor: 'DM-V-IMP', item: 'DM-API-002', manufacturer: 'Demo Fine Chemicals Co., Ltd.', site: 'Plant 3, Demo Industrial Park, CN' },
  { vendor: 'DM-V-CHEM', item: 'DM-EXC-001', manufacturer: 'Demo Cellulose Works', site: 'Demo site A, Lahore' },
  { vendor: 'DM-V-CHEM', item: 'DM-EXC-002', manufacturer: 'Demo Starch Mills', site: 'Demo site B, Faisalabad' },
  { vendor: 'DM-V-CHEM', item: 'DM-EXC-003', manufacturer: 'Demo Chemicals (Pvt) Ltd', site: 'Demo site C, Karachi' },
  { vendor: 'DM-V-PACK', item: 'DM-PM-001', manufacturer: 'Demo Packaging (Pvt) Ltd', site: 'Demo film plant, Karachi' },
  { vendor: 'DM-V-PACK', item: 'DM-PM-002', manufacturer: 'Demo Packaging (Pvt) Ltd', site: 'Demo foil plant, Karachi' },
  { vendor: 'DM-V-PACK', item: 'DM-PM-003', manufacturer: 'Demo Packaging (Pvt) Ltd', site: 'Demo print shop, Karachi' },
];

const CUSTOMERS = [
  { code: 'DM-C-001', name: 'Demo Medical Distributors', ntn: '9900101', creditLimit: '2000000.00', paymentTermsDays: 30 },
  { code: 'DM-C-002', name: 'Demo General Hospital', ntn: '9900102', creditLimit: '500000.00', paymentTermsDays: 45 },
] as const;

const WAREHOUSE = { code: 'DM-WH', name: 'Demo main store', address: 'Plant site (demo)' } as const;
const LOCATIONS = [
  { code: 'QUAR', name: 'Quarantine', isReturnsArea: false },
  { code: 'APPR', name: 'Approved store', isReturnsArea: false },
  { code: 'REJ', name: 'Rejected store', isReturnsArea: false },
  { code: 'RET', name: 'Customer returns', isReturnsArea: true },
] as const;

/** Master formula of DM-FG-001: 100,000 tablets of 600 mg. */
const FORMULA = {
  product: 'DM-FG-001',
  batchSize: '100000',
  batchUom: 'TAB' as UomCode,
  lines: [
    { item: 'DM-API-001', qty: '50', isApi: true, isFiller: false },
    { item: 'DM-EXC-002', qty: '6', isApi: false, isFiller: false },
    { item: 'DM-EXC-001', qty: '3.5', isApi: false, isFiller: true },
    { item: 'DM-EXC-003', qty: '0.5', isApi: false, isFiller: false },
  ],
};

export const DEMO_USD_RATE = '281.250000';
export const DEMO_RATE_SOURCE = 'Demo value (not an SBP rate)';

/** PO notes double as the idempotency marker. */
export const DEMO_PO_APPROVED_NOTE = 'Demo data: local excipients PO (approved)';
export const DEMO_PO_WAITING_NOTE = 'Demo data: import API PO (waiting approval)';

// ---------------------------------------------------------------- running it

export interface DemoDataReport {
  /** What this run created or moved on, e.g. "item DM-API-001". Empty on a repeat run. */
  done: string[];
  /** Records found in a state the seed will not touch (e.g. a source QA blocked). */
  skipped: string[];
}

interface Session {
  auth: AuthContext;
  refreshToken: string;
}

export async function runDemoDataSeed(opts: DevSeedOptions): Promise<DemoDataReport> {
  assertDevTarget(opts.nodeEnv, opts.databaseUrl, COMMAND);
  await runDevSeed(opts); // normal seed, demo users and FY periods (idempotent)
  const password = opts.demoPassword ?? '';
  const report: DemoDataReport = { done: [], skipped: [] };
  const sessions = new Map<string, Session>();
  const as = async (roleCode: string): Promise<AuthContext> => {
    const open = sessions.get(roleCode);
    if (open) return open.auth;
    const tokens = await login({ username: demoUsername(roleCode), password }, META);
    const session = { auth: await authenticateToken(tokens.accessToken), refreshToken: tokens.refreshToken };
    sessions.set(roleCode, session);
    return session.auth;
  };
  const sign = (reason: string): ESignRequest => ({ password, meaning: 'APPROVED', reason });
  const ctx: Ctx = { as, sign, report };
  try {
    const uomIds = await ensureUoms(ctx);
    const itemIds = await ensureItems(ctx, uomIds);
    const vendorIds = await ensureVendors(ctx);
    await ensureSources(ctx, vendorIds, itemIds);
    await ensureCustomers(ctx);
    await ensureWarehouse(ctx);
    await ensureFormula(ctx, itemIds, uomIds);
    await ensureUsdRate(ctx);
    await ensurePos(ctx, vendorIds, itemIds);
  } finally {
    for (const s of sessions.values()) await logout(s.refreshToken, META);
  }
  return report;
}

interface Ctx {
  as(roleCode: string): Promise<AuthContext>;
  sign(reason: string): ESignRequest;
  report: DemoDataReport;
}



/** Approve the document's open approval as `roleCode` (e-signature with the demo password). */
async function approveDocument(ctx: Ctx, roleCode: string, docTable: string, docId: string, reason: string): Promise<void> {
  const auth = await ctx.as(roleCode);
  const approvalId = (await latestApprovalIds(db, auth.companyId, docTable, [docId])).get(docId);
  if (!approvalId) throw new Error(`${COMMAND}: no approval found for ${docTable} ${docId}`);
  await approve(auth, approvalId, { signature: ctx.sign(reason) }, META);
}

// ---------------------------------------------------------------- UoM, categories, items

async function ensureUoms(ctx: Ctx): Promise<Map<string, string>> {
  const wm = await ctx.as('WAREHOUSE_MANAGER');
  const codes = UOMS.map((u) => u.code);
  const have = new Map(
    (await db.select({ id: uoms.id, code: uoms.code }).from(uoms).where(and(eq(uoms.companyId, wm.companyId), inArray(uoms.code, codes)))).map(
      (u) => [u.code, u.id],
    ),
  );
  for (const u of UOMS) {
    if (have.has(u.code)) continue;
    const created = await catalog.createUom(wm, CreateUomRequest.parse(u));
    have.set(u.code, created.id);
    ctx.report.done.push(`UoM ${u.code}`);
  }
  return have;
}

async function ensureCategories(ctx: Ctx): Promise<Map<string, string>> {
  const wm = await ctx.as('WAREHOUSE_MANAGER');
  const have = new Map(
    (
      await db
        .select({ id: itemCategories.id, code: itemCategories.code })
        .from(itemCategories)
        .where(and(eq(itemCategories.companyId, wm.companyId), inArray(itemCategories.code, CATEGORIES.map((c) => c.code))))
    ).map((c) => [c.code, c.id]),
  );
  for (const c of CATEGORIES) {
    if (have.has(c.code)) continue;
    const created = await catalog.createCategory(wm, CreateCategoryRequest.parse(c));
    have.set(c.code, created.id);
    ctx.report.done.push(`category ${c.code}`);
  }
  return have;
}

/** Warehouse Manager drafts each item; the QA Manager activates it (GMP items, master.item.approve). */
async function ensureItems(ctx: Ctx, uomIds: Map<string, string>): Promise<Map<string, string>> {
  const categoryIds = await ensureCategories(ctx);
  const wm = await ctx.as('WAREHOUSE_MANAGER');
  const found = await db
    .select({ id: items.id, code: items.code, type: items.type, status: items.status })
    .from(items)
    .where(and(eq(items.companyId, wm.companyId), inArray(items.code, ITEMS.map((i) => i.code))));
  const byCode = new Map(found.map((i) => [i.code, i]));
  const ids = new Map<string, string>();
  for (const it of ITEMS) {
    let row = byCode.get(it.code);
    if (row && row.type !== it.type) throw new Error(`${COMMAND}: item ${it.code} exists as ${row.type}, expected ${it.type}`);
    if (!row) {
      const created = await itemsSvc.createItem(
        wm,
        CreateItemRequest.parse({
          code: it.code,
          name: it.name,
          type: it.type,
          baseUomId: need(uomIds, it.uom, 'UoM'),
          categoryId: need(categoryIds, it.category, 'category'),
          shelfLifeDays: it.shelfLifeDays,
          retestDays: it.retestDays,
          storageZone: 'AMBIENT',
        }),
      );
      row = { id: created.id, code: created.code, type: created.type, status: created.status };
      ctx.report.done.push(`item ${it.code}`);
    }
    if (row.status === 'DRAFT') {
      await itemsSvc.changeItemStatus(await ctx.as('QA_MANAGER'), row.id, 'ACTIVE', undefined);
      ctx.report.done.push(`item ${it.code} activated`);
    } else if (row.status === 'INACTIVE') {
      ctx.report.skipped.push(`item ${it.code} is INACTIVE`);
    }
    ids.set(it.code, row.id);
  }
  return ids;
}

// ---------------------------------------------------------------- vendors and approved sources

/** Purchase Officer drafts; the Purchase Manager activates (master.vendor.approve). */
async function ensureVendors(ctx: Ctx): Promise<Map<string, string>> {
  const po = await ctx.as('PURCHASE_OFFICER');
  const found = await db
    .select({ id: vendors.id, code: vendors.code, status: vendors.status })
    .from(vendors)
    .where(and(eq(vendors.companyId, po.companyId), inArray(vendors.code, VENDORS.map((v) => v.code))));
  const byCode = new Map(found.map((v) => [v.code, v]));
  const ids = new Map<string, string>();
  for (const v of VENDORS) {
    let row = byCode.get(v.code);
    if (!row) {
      const created = await parties.createVendor(
        po,
        CreateVendorRequest.parse({
          code: v.code,
          name: v.name,
          ntn: v.ntn,
          isForeign: v.isForeign,
          country: v.country,
          currency: v.currency,
          paymentTermsDays: v.paymentTermsDays,
        }),
      );
      row = { id: created.id, code: created.code, status: created.status };
      ctx.report.done.push(`vendor ${v.code}`);
    }
    if (row.status === 'DRAFT') {
      await parties.changePartyStatus(await ctx.as('PURCHASE_MANAGER'), 'vendor', row.id, 'ACTIVE', undefined);
      ctx.report.done.push(`vendor ${v.code} activated`);
    } else if (row.status === 'INACTIVE') {
      ctx.report.skipped.push(`vendor ${v.code} is INACTIVE`);
    }
    ids.set(v.code, row.id);
  }
  return ids;
}

/**
 * Purchase Officer proposes the source and attaches the evidence (a text file marked as demo); the QA Manager
 * approves the AVL approval with an e-signature. A REJECTED or BLOCKED source is QA's decision: left alone.
 */
async function ensureSources(ctx: Ctx, vendorIds: Map<string, string>, itemIds: Map<string, string>): Promise<void> {
  const po = await ctx.as('PURCHASE_OFFICER');
  for (const s of SOURCES) {
    const vendorId = need(vendorIds, s.vendor, 'vendor');
    const itemId = need(itemIds, s.item, 'item');
    const existing = await db
      .select({ id: approvedSources.id, status: approvedSources.status })
      .from(approvedSources)
      .where(and(eq(approvedSources.companyId, po.companyId), eq(approvedSources.vendorId, vendorId), eq(approvedSources.itemId, itemId)))
      .orderBy(asc(approvedSources.id));
    const label = `approved source ${s.item} / ${s.vendor}`;
    const live = existing.find((x) => x.status === 'PENDING' || x.status === 'APPROVED');
    if (!live && existing.length > 0) {
      ctx.report.skipped.push(`${label} is ${existing[existing.length - 1]!.status} (QA decision, not changed)`);
      continue;
    }
    let source = live;
    if (!source) {
      const created = await avl.proposeSource(
        po,
        CreateApprovedSourceRequest.parse({
          vendorId,
          itemId,
          manufacturer: s.manufacturer,
          manufacturingSite: s.site,
          notes: 'Demo data (development only)',
        }),
      );
      source = { id: created.id, status: created.status };
      ctx.report.done.push(label);
    }
    if (source.status === 'APPROVED') continue;
    if ((await countForDocument(db, po.companyId, avl.SOURCE_TABLE, source.id)) === 0) {
      await upload(po, {
        recordTable: avl.SOURCE_TABLE,
        recordId: source.id,
        fileName: `demo-evidence-${s.item}.txt`,
        contentType: 'text/plain',
        bytes: Buffer.from(
          `DEMO DATA - development only. Not a real supplier questionnaire, audit report or CoA.\n` +
            `Source: ${s.item} from ${s.vendor}, made by ${s.manufacturer}, ${s.site}.\n`,
        ),
        description: 'Demo evidence (development only)',
      });
    }
    await approveDocument(ctx, 'QA_MANAGER', avl.SOURCE_TABLE, source.id, 'Demo data: evidence reviewed');
    ctx.report.done.push(`${label} approved`);
  }
}

// ---------------------------------------------------------------- customers, warehouse

/** Sales Executive drafts; the Sales Manager activates (master.customer.approve). */
async function ensureCustomers(ctx: Ctx): Promise<void> {
  const se = await ctx.as('SALES_EXECUTIVE');
  const found = await db
    .select({ id: customers.id, code: customers.code, status: customers.status })
    .from(customers)
    .where(and(eq(customers.companyId, se.companyId), inArray(customers.code, CUSTOMERS.map((c) => c.code))));
  const byCode = new Map(found.map((c) => [c.code, c]));
  for (const c of CUSTOMERS) {
    let row = byCode.get(c.code);
    if (!row) {
      const created = await parties.createCustomer(se, CreateCustomerRequest.parse(c));
      row = { id: created.id, code: created.code, status: created.status };
      ctx.report.done.push(`customer ${c.code}`);
    }
    if (row.status === 'DRAFT') {
      await parties.changePartyStatus(await ctx.as('SALES_MANAGER'), 'customer', row.id, 'ACTIVE', undefined);
      ctx.report.done.push(`customer ${c.code} activated`);
    }
  }
}

/** Warehouse Manager (master.location.manage): one warehouse with quarantine, approved, rejected and returns locations. */
async function ensureWarehouse(ctx: Ctx): Promise<void> {
  const wm = await ctx.as('WAREHOUSE_MANAGER');
  let [wh] = await db
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(and(eq(warehouses.companyId, wm.companyId), eq(warehouses.code, WAREHOUSE.code)));
  if (!wh) {
    wh = { id: (await catalog.createWarehouse(wm, CreateWarehouseRequest.parse(WAREHOUSE))).id };
    ctx.report.done.push(`warehouse ${WAREHOUSE.code}`);
  }
  const have = new Set(
    (await db.select({ code: locations.code }).from(locations).where(eq(locations.warehouseId, wh.id))).map((l) => l.code),
  );
  for (const l of LOCATIONS) {
    if (have.has(l.code)) continue;
    await catalog.createLocation(wm, CreateLocationRequest.parse({ warehouseId: wh.id, storageZone: 'AMBIENT', ...l }));
    ctx.report.done.push(`location ${WAREHOUSE.code}/${l.code}`);
  }
}

// ---------------------------------------------------------------- product and master formula

/**
 * Sales Manager creates the product (no regulated fields, so no countersign); the Production Manager drafts and
 * submits the formula; the QA Manager approves it. Once the product has an APPROVED version nothing more is done.
 */
async function ensureFormula(ctx: Ctx, itemIds: Map<string, string>, uomIds: Map<string, string>): Promise<void> {
  const { companyId } = await ctx.as('SALES_MANAGER');
  const fgId = need(itemIds, FORMULA.product, 'item');
  let [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.companyId, companyId), eq(products.itemId, fgId)));
  if (!product) {
    product = { id: (await productsSvc.createProduct(await ctx.as('SALES_MANAGER'), CreateProductRequest.parse({ itemId: fgId }), META)).id };
    ctx.report.done.push(`product ${FORMULA.product}`);
  }
  const versions = await db
    .select({ id: masterFormulas.id, status: masterFormulas.status })
    .from(masterFormulas)
    .where(eq(masterFormulas.productId, product.id))
    .orderBy(asc(masterFormulas.version));
  if (versions.some((v) => v.status === 'APPROVED')) return;

  const pm = await ctx.as('PRODUCTION_MANAGER');
  let formula = versions.find((v) => v.status === 'DRAFT' || v.status === 'PENDING_APPROVAL');
  if (!formula) {
    const created = await formulas.createFormula(
      pm,
      CreateFormulaRequest.parse({
        productId: product.id,
        batchSize: FORMULA.batchSize,
        batchUomId: need(uomIds, FORMULA.batchUom, 'UoM'),
        notes: 'Demo data (development only)',
      }),
    );
    formula = { id: created.id, status: created.status };
    ctx.report.done.push(`master formula ${FORMULA.product}`);
  }
  if (formula.status === 'DRAFT') {
    const kg = need(uomIds, 'KG', 'UoM');
    await formulas.setFormulaLines(
      pm,
      formula.id,
      SetFormulaLinesRequest.parse({
        lines: FORMULA.lines.map((l) => ({
          itemId: need(itemIds, l.item, 'item'),
          qtyPerBatch: l.qty,
          uomId: kg,
          isApi: l.isApi,
          isFiller: l.isFiller,
          assayBasis: l.isApi ? 'AS_IS' : null,
        })),
      }),
    );
    await formulas.submitFormula(pm, formula.id);
  }
  await approveDocument(ctx, 'QA_MANAGER', formulas.FORMULA_TABLE, formula.id, 'Demo data: formula reviewed');
  ctx.report.done.push(`master formula ${FORMULA.product} approved`);
}

// ---------------------------------------------------------------- exchange rate and purchase orders

/** Finance Manager (fin.rate.manage) enters today's USD rate unless one exists (an existing rate is never corrected). */
async function ensureUsdRate(ctx: Ctx): Promise<void> {
  const fm = await ctx.as('FINANCE_MANAGER');
  const today = companyToday();
  const [have] = await db
    .select({ id: exchangeRates.id })
    .from(exchangeRates)
    .where(and(eq(exchangeRates.companyId, fm.companyId), eq(exchangeRates.currency, 'USD'), eq(exchangeRates.rateDate, today)));
  if (have) return;
  await rates.setRate(fm, SetExchangeRateRequest.parse({ currency: 'USD', rateDate: today, rate: DEMO_USD_RATE, source: DEMO_RATE_SOURCE }));
  ctx.report.done.push(`USD rate ${today}`);
}

/**
 * Purchase Officer drafts and submits both POs. The local PO (PKR 280,250, Purchase Manager band) is approved by
 * the Purchase Manager; the import PO (USD 3,100, Finance Manager band) is left waiting in the approvals inbox.
 */
async function ensurePos(ctx: Ctx, vendorIds: Map<string, string>, itemIds: Map<string, string>): Promise<void> {
  const officer = await ctx.as('PURCHASE_OFFICER');
  const today = companyToday();
  const plan = [
    {
      note: DEMO_PO_APPROVED_NOTE,
      approve: true,
      body: {
        poDate: today,
        vendorId: need(vendorIds, 'DM-V-CHEM', 'vendor'),
        poType: 'LOCAL',
        currency: 'PKR',
        lines: [
          { itemId: need(itemIds, 'DM-EXC-001', 'item'), qty: '200', unitPrice: '950' },
          { itemId: need(itemIds, 'DM-EXC-002', 'item'), qty: '300', unitPrice: '180' },
          { itemId: need(itemIds, 'DM-EXC-003', 'item'), qty: '25', unitPrice: '1450' },
        ],
      },
    },
    {
      note: DEMO_PO_WAITING_NOTE,
      approve: false,
      body: {
        poDate: today,
        vendorId: need(vendorIds, 'DM-V-IMP', 'vendor'),
        poType: 'IMPORT',
        currency: 'USD',
        incoterm: 'CIF',
        lines: [{ itemId: need(itemIds, 'DM-API-001', 'item'), qty: '500', unitPrice: '6.20' }],
      },
    },
  ];
  for (const p of plan) {
    const [found] = await db
      .select({ id: purchaseOrders.id, docNo: purchaseOrders.docNo, status: purchaseOrders.status })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.companyId, officer.companyId), eq(purchaseOrders.notes, p.note)))
      .orderBy(asc(purchaseOrders.id));
    let po = found;
    if (!po) {
      const created = await orders.createPo(officer, CreatePoRequest.parse({ ...p.body, notes: p.note }));
      po = { id: created.id, docNo: created.docNo, status: created.status };
      ctx.report.done.push(`purchase order ${po.docNo}`);
    }
    if (po.status === 'DRAFT') {
      po = { ...po, status: (await orders.submitPo(officer, po.id)).status };
      ctx.report.done.push(`purchase order ${po.docNo} submitted`);
    }
    if (p.approve && po.status === 'PENDING_APPROVAL') {
      await approveDocument(ctx, 'PURCHASE_MANAGER', orders.PO_TABLE, po.id, 'Demo data: order checked');
      ctx.report.done.push(`purchase order ${po.docNo} approved`);
    }
  }
}

function need(map: Map<string, string>, key: string, what: string): string {
  const v = map.get(key);
  if (!v) throw new Error(`${COMMAND}: ${what} ${key} missing`);
  return v;
}
