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

export const allowBulkFgPurchase = (q: Queryable, companyId: string) => getSetting<boolean>(q, companyId, ALLOW_BULK_FG_PURCHASE);
