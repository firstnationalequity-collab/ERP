// Procurement settings (core.settings; registered once at start-up).
import { z } from 'zod';
import type { Queryable } from '../../db/client';
import { getSetting, registerSetting } from '../../core/settings/app-settings.service';

/**
 * Owner 2026-11-25 (answer 6): BULK and FG items are made here and not bought, unless this is switched on.
 * Mirrored in the database by purch.assert_item_purchasable (0025).
 */
export const ALLOW_BULK_FG_PURCHASE = 'purch.allow_bulk_fg_purchase';
registerSetting({
  key: ALLOW_BULK_FG_PURCHASE,
  description: 'Allow BULK and FG items on requisitions and purchase orders (normally made here, not bought)',
  schema: z.boolean(),
  defaultValue: false,
});

/** Architecture §7.5: a GRN may receive up to the ordered quantity + this percent. Mirrored by SQL purch.over_receipt_pct (0027). */
export const OVER_RECEIPT_PCT = 'purch.grn.over_receipt_pct';
registerSetting({
  key: OVER_RECEIPT_PCT,
  description: 'Over-receipt tolerance on a GRN, percent of the ordered quantity (0–10)',
  schema: z.number().min(0).max(10),
  defaultValue: 2,
});
export const overReceiptPct = (q: Queryable, companyId: string) => getSetting<number>(q, companyId, OVER_RECEIPT_PCT);

/**
 * Owner 2026-11-25 (answer 3): minimum remaining shelf life at receipt, percent of the total (0 = off). Remaining =
 * expiry − GRN date; total = expiry − mfg, or the item's shelf life when there is no mfg date. Mirrored by SQL
 * purch.min_shelf_life_pct (0028).
 */
export const MIN_SHELF_LIFE_PCT = 'purch.grn.min_shelf_life_pct';
registerSetting({
  key: MIN_SHELF_LIFE_PCT,
  description: 'Minimum remaining shelf life at receipt, percent of the total shelf life (0 = no check)',
  schema: z.number().min(0).max(100),
  defaultValue: 0,
});
export const minShelfLifePct = (q: Queryable, companyId: string) => getSetting<number>(q, companyId, MIN_SHELF_LIFE_PCT);

export const allowBulkFgPurchase =(q: Queryable, companyId: string) => getSetting<boolean>(q, companyId, ALLOW_BULK_FG_PURCHASE);

/**
 * Architecture §7.5: the 3-way match tolerance on price and quantity is a setting (M3 task 5, 0031). Outside it, the
 * invoice goes to MATCH_EXCEPTION (owner Q5). Defaults: agent default — PENDING OWNER. Mirrored by SQL
 * purch.invoice_price_tolerance_pct / purch.invoice_qty_tolerance_pct (0031).
 */
export const INVOICE_PRICE_TOLERANCE_PCT = 'purch.invoice.price_tolerance_pct';
registerSetting({
  key: INVOICE_PRICE_TOLERANCE_PCT,
  description: 'Vendor invoice match: allowed difference of the invoice unit price from the PO price, percent (0–20)',
  schema: z.number().min(0).max(20),
  defaultValue: 2,
});
export const INVOICE_QTY_TOLERANCE_PCT = 'purch.invoice.qty_tolerance_pct';
registerSetting({
  key: INVOICE_QTY_TOLERANCE_PCT,
  description: 'Vendor invoice match: quantity that may be invoiced beyond the quantity received, percent (0–10)',
  schema: z.number().min(0).max(10),
  defaultValue: 0,
});
export const invoiceTolerances = async (q: Queryable, companyId: string) => ({
  pricePct: await getSetting<number>(q, companyId, INVOICE_PRICE_TOLERANCE_PCT),
  qtyPct: await getSetting<number>(q, companyId, INVOICE_QTY_TOLERANCE_PCT),
});

/**
 * Owner 2026-11-26 (answer 4): a vendor's filer status (ATL) checked more than this many days before a payment is
 * approved (or never) is a warning the approver must acknowledge. Mirrored by SQL purch.vendor_filer_check_max_days (0032).
 */
export const FILER_CHECK_MAX_DAYS = 'purch.vendor.filer_check_max_days';
registerSetting({
  key: FILER_CHECK_MAX_DAYS,
  description: "Vendor payments: days after which a vendor's filer (ATL) check is stale and the approver must acknowledge it (1–365)",
  schema: z.number().int().min(1).max(365),
  defaultValue: 30,
});
export const filerCheckMaxDays = (q: Queryable, companyId: string) => getSetting<number>(q, companyId, FILER_CHECK_MAX_DAYS);
