-- 0035: owner corrections to the M4 defaults (Owner — confirmed 2026-11-27; docs/decisions.md same date).
--   1. Sampling reduces stock. A SAMPLE_ISSUE ledger row (outbound) takes the sample out of the lot, only while the
--      lot is QUARANTINE or UNDER_TEST, posted by a holder of the QC sampling key (qc.result.enter). reason_code is
--      the sample type: TEST (for analysis) or RETENTION (retention / reserve sample). Valued like every outbound
--      movement (lot cost, last-out residual; toll stock zero). Journal event QC_SAMPLE: Dr QC sample expense
--      (placeholder account 6400, Finance to confirm) / Cr inventory. A sample is consumed: a SAMPLE_ISSUE row is
--      never reversed (a wrong quantity is corrected by a stock adjustment).
--   2. Expiry is checked at use, not only by the nightly job (task 5, which only updates statuses):
--      - ISSUE and reservations refuse a lot whose expiry date or retest date is reached (LOT_EXPIRED /
--        LOT_RETEST_DUE), even while its status is still APPROVED;
--      - DISPATCH refuses an FG lot whose expiry date is reached, whatever its status (LOT_EXPIRED).
--      "Reached" = on or before the later of the movement date and the company's today (Asia/Karachi), so a
--      back-dated movement cannot use an expired lot; a reservation has no date and uses today. FEFO already
--      leaves such lots out (0014).

-- ---------------------------------------------------------------- company calendar day
-- The company's business date (CLAUDE.md: display Asia/Karachi; apps/api/src/core/dates.ts companyToday()).
CREATE FUNCTION core.company_today() RETURNS DATE
LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE 'Asia/Karachi')::date
$$;

-- ---------------------------------------------------------------- 1. SAMPLE_ISSUE
ALTER TABLE inv.stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE inv.stock_movements ADD CONSTRAINT stock_movements_movement_type_check CHECK (movement_type IN (
  'RECEIPT', 'ISSUE', 'ISSUE_RETURN', 'OUTPUT', 'DISPATCH', 'SALES_RETURN', 'TRANSFER_OUT',
  'TRANSFER_IN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DESTROY', 'RETURN_TO_VENDOR', 'ROUNDING_SWEEP', 'VALUE_ADJUSTMENT',
  'SAMPLE_ISSUE'));
-- The sample type (packages/shared QcSampleType).
ALTER TABLE inv.stock_movements ADD CONSTRAINT movement_sample_type CHECK (
  movement_type <> 'SAMPLE_ISSUE' OR reason_code IN ('TEST', 'RETENTION'));

-- Posting event QC_SAMPLE and account role QC_SAMPLE_EXPENSE.
CREATE OR REPLACE FUNCTION fin.is_valid_posting_role(p_event TEXT, p_role TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_role = ANY (CASE p_event
    WHEN 'GRN_RECEIPT'          THEN ARRAY['INVENTORY', 'GRNI']
    WHEN 'LANDED_COST'          THEN ARRAY['INVENTORY', 'PRICE_VARIANCE', 'LANDED_COST_CLEARING']
    WHEN 'IMPORT_TAX'           THEN ARRAY['INPUT_TAX', 'ADVANCE_TAX', 'LANDED_COST_CLEARING']
    WHEN 'VENDOR_INVOICE'       THEN ARRAY['GRNI', 'LANDED_COST_CLEARING', 'INPUT_TAX', 'PRICE_VARIANCE', 'EXCHANGE_DIFFERENCE', 'ACCOUNTS_PAYABLE']
    WHEN 'VENDOR_PAYMENT'       THEN ARRAY['ACCOUNTS_PAYABLE', 'BANK', 'WHT_PAYABLE', 'EXCHANGE_DIFFERENCE']
    WHEN 'VENDOR_DEBIT_NOTE'    THEN ARRAY['ACCOUNTS_PAYABLE', 'PRICE_VARIANCE', 'INPUT_TAX']
    WHEN 'MATERIAL_ISSUE'       THEN ARRAY['WIP', 'INVENTORY']
    WHEN 'MATERIAL_RETURN'      THEN ARRAY['INVENTORY', 'WIP']
    WHEN 'CONVERSION_ABSORB'    THEN ARRAY['WIP', 'LABOUR_ABSORBED', 'OVERHEAD_ABSORBED']
    WHEN 'FG_OUTPUT'            THEN ARRAY['INVENTORY', 'WIP']
    WHEN 'FG_COST_ADJUSTMENT'   THEN ARRAY['INVENTORY', 'WIP']
    WHEN 'DISPATCH'             THEN ARRAY['COGS', 'INVENTORY']
    WHEN 'SALES_RETURN_RECEIPT' THEN ARRAY['INVENTORY', 'COGS']
    WHEN 'SALES_INVOICE'        THEN ARRAY['ACCOUNTS_RECEIVABLE', 'SALES_REVENUE', 'OUTPUT_TAX']
    WHEN 'TOLL_INVOICE'         THEN ARRAY['ACCOUNTS_RECEIVABLE', 'CONVERSION_REVENUE', 'OUTPUT_TAX']
    WHEN 'CUSTOMER_RECEIPT'     THEN ARRAY['BANK', 'WHT_RECEIVABLE', 'ACCOUNTS_RECEIVABLE']
    WHEN 'STOCK_ADJUSTMENT'     THEN ARRAY['INVENTORY', 'INVENTORY_LOSS', 'INVENTORY_GAIN']
    WHEN 'LOT_DESTROYED'        THEN ARRAY['REJECTION_WRITE_OFF', 'INVENTORY']
    WHEN 'LOT_RETURNED'         THEN ARRAY['ACCOUNTS_PAYABLE', 'INVENTORY', 'PRICE_VARIANCE', 'INPUT_TAX']
    WHEN 'ROUNDING_DIFFERENCE'  THEN ARRAY['INVENTORY', 'ROUNDING_DIFFERENCE']
    WHEN 'QC_SAMPLE'            THEN ARRAY['QC_SAMPLE_EXPENSE', 'INVENTORY']
    ELSE ARRAY[]::TEXT[]
  END)
$$;

ALTER TABLE fin.posting_rules DROP CONSTRAINT posting_rules_event_check;
ALTER TABLE fin.posting_rules ADD CONSTRAINT posting_rules_event_check CHECK (event IN (
  'GRN_RECEIPT', 'LANDED_COST', 'IMPORT_TAX', 'VENDOR_INVOICE', 'VENDOR_PAYMENT', 'VENDOR_DEBIT_NOTE', 'MATERIAL_ISSUE',
  'MATERIAL_RETURN', 'CONVERSION_ABSORB', 'FG_OUTPUT', 'FG_COST_ADJUSTMENT', 'DISPATCH', 'SALES_RETURN_RECEIPT',
  'SALES_INVOICE', 'TOLL_INVOICE', 'CUSTOMER_RECEIPT', 'STOCK_ADJUSTMENT', 'LOT_DESTROYED', 'LOT_RETURNED',
  'ROUNDING_DIFFERENCE', 'QC_SAMPLE'));
ALTER TABLE fin.journal_entries DROP CONSTRAINT journal_entries_event_check;
ALTER TABLE fin.journal_entries ADD CONSTRAINT journal_entries_event_check CHECK (event IN (
  'GRN_RECEIPT', 'LANDED_COST', 'IMPORT_TAX', 'VENDOR_INVOICE', 'VENDOR_PAYMENT', 'VENDOR_DEBIT_NOTE', 'MATERIAL_ISSUE',
  'MATERIAL_RETURN', 'CONVERSION_ABSORB', 'FG_OUTPUT', 'FG_COST_ADJUSTMENT', 'DISPATCH', 'SALES_RETURN_RECEIPT',
  'SALES_INVOICE', 'TOLL_INVOICE', 'CUSTOMER_RECEIPT', 'STOCK_ADJUSTMENT', 'LOT_DESTROYED', 'LOT_RETURNED',
  'ROUNDING_DIFFERENCE', 'QC_SAMPLE'));
ALTER TABLE fin.posting_rules DROP CONSTRAINT posting_rules_account_role_check;
ALTER TABLE fin.posting_rules ADD CONSTRAINT posting_rules_account_role_check CHECK (account_role IN (
  'INVENTORY', 'GRNI', 'PRICE_VARIANCE', 'LANDED_COST_CLEARING', 'INPUT_TAX', 'ADVANCE_TAX', 'ACCOUNTS_PAYABLE', 'BANK',
  'WHT_PAYABLE', 'EXCHANGE_DIFFERENCE', 'WIP', 'LABOUR_ABSORBED', 'OVERHEAD_ABSORBED', 'COGS', 'ACCOUNTS_RECEIVABLE',
  'SALES_REVENUE', 'CONVERSION_REVENUE', 'OUTPUT_TAX', 'WHT_RECEIVABLE', 'INVENTORY_LOSS',
  'INVENTORY_GAIN', 'REJECTION_WRITE_OFF', 'ROUNDING_DIFFERENCE', 'QC_SAMPLE_EXPENSE'));

-- ---------------------------------------------------------------- 2. movement guard (0028) + sampling + expiry at use
CREATE OR REPLACE FUNCTION inv.guard_stock_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot RECORD;
  orig RECORD;
  loc_id BIGINT := COALESCE(NEW.to_location_id, NEW.from_location_id);
  dispatched NUMERIC;
  returned NUMERIC;
  use_day DATE;
BEGIN
  IF NEW.movement_type IN ('ROUNDING_SWEEP', 'VALUE_ADJUSTMENT') THEN
    RETURN NEW;  -- value-only rows: guard_rounding_sweep / guard_value_adjustment
  END IF;
  -- FOR SHARE: a status change of this lot (e.g. QA HOLD) waits until this posting commits.
  SELECT l.id, l.company_id, l.item_id, l.lot_no, l.status, l.owner_type, l.unit_cost, l.source, l.parent_lot_id, l.batch_closed_at,
         l.expiry_date, l.retest_date INTO lot
    FROM inv.lots l WHERE l.id = NEW.lot_id FOR SHARE;
  IF lot.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: lot % is not in this company', NEW.lot_id USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM master.locations
     WHERE id = loc_id AND company_id = NEW.company_id AND (is_active OR NEW.qty < 0)
  ) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: stock moves into an active location of this company' USING ERRCODE = 'P0001';
  END IF;
  IF lot.status IN ('DESTROYED', 'RETURNED') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: lot % is %; it never moves again', lot.lot_no, lot.status USING ERRCODE = 'P0001';
  END IF;

  IF NEW.reversal_of IS NULL THEN
    IF inv.is_inbound(NEW.movement_type) <> (NEW.qty > 0) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a % movement must % stock', NEW.movement_type,
        CASE WHEN inv.is_inbound(NEW.movement_type) THEN 'add' ELSE 'remove' END USING ERRCODE = 'P0001';
    END IF;
    -- Each source lot takes its own inbound type.
    IF (NEW.movement_type = 'RECEIPT' AND lot.source <> 'GRN')
       OR (NEW.movement_type = 'OUTPUT' AND lot.source <> 'PRODUCTION_OUTPUT')
       OR (NEW.movement_type = 'SALES_RETURN' AND lot.source <> 'SALES_RETURN') THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a % goes into a lot made for it (lot % comes from %)', NEW.movement_type, lot.lot_no, lot.source
        USING ERRCODE = 'P0001';
    END IF;
    -- Owner 2026-11-27: expiry (and, for issue, retest) checked at use, whatever the status the job has set so far.
    use_day := GREATEST(NEW.movement_date, core.company_today());
    IF NEW.movement_type IN ('ISSUE', 'DISPATCH') AND lot.expiry_date IS NOT NULL AND lot.expiry_date <= use_day THEN
      RAISE EXCEPTION 'LOT_EXPIRED: lot % expired on %; it is not %', lot.lot_no, to_char(lot.expiry_date, 'DD-MM-YYYY'),
        CASE NEW.movement_type WHEN 'ISSUE' THEN 'issued' ELSE 'dispatched' END USING ERRCODE = 'P0001';
    END IF;
    IF NEW.movement_type = 'ISSUE' AND lot.retest_date IS NOT NULL AND lot.retest_date <= use_day THEN
      RAISE EXCEPTION 'LOT_RETEST_DUE: lot %''s retest date % is reached; QC re-tests it before it is issued', lot.lot_no,
        to_char(lot.retest_date, 'DD-MM-YYYY') USING ERRCODE = 'P0001';
    END IF;
    -- Rule 2 and the lot status table (architecture §4).
    IF NEW.movement_type = 'ISSUE' AND lot.status <> 'APPROVED' THEN
      RAISE EXCEPTION 'LOT_NOT_APPROVED: lot % is %; only APPROVED lots are issued', lot.lot_no, lot.status USING ERRCODE = 'P0001';
    END IF;
    IF NEW.movement_type = 'DISPATCH' AND lot.status <> 'RELEASED' THEN
      RAISE EXCEPTION 'LOT_NOT_RELEASED: lot % is %; only RELEASED finished goods are dispatched', lot.lot_no, lot.status
        USING ERRCODE = 'P0001';
    END IF;
    -- Owner 2026-11-27: a sample is taken only from a lot under QC, by a holder of the QC sampling key.
    IF NEW.movement_type = 'SAMPLE_ISSUE' THEN
      IF lot.status NOT IN ('QUARANTINE', 'UNDER_TEST') THEN
        RAISE EXCEPTION 'INVALID_TRANSITION: a QC sample is taken from a QUARANTINE or UNDER_TEST lot (lot % is %)', lot.lot_no, lot.status
          USING ERRCODE = 'P0001';
      END IF;
      IF NOT core.user_holds_key(core.current_user_id(), 'qc.result.enter') THEN
        RAISE EXCEPTION 'FORBIDDEN: a QC sample is taken by a holder of qc.result.enter' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    -- Owner 2026-11-18 (Q8): production FG is dispatched only once its batch is closed (cost final).
    IF NEW.movement_type = 'DISPATCH' AND lot.source = 'PRODUCTION_OUTPUT' AND lot.batch_closed_at IS NULL THEN
      RAISE EXCEPTION 'BATCH_NOT_CLOSED: lot %''s batch is not closed; it is dispatched after batch close', lot.lot_no
        USING ERRCODE = 'P0001';
    END IF;
    -- Owner 2026-11-25 (answer 4): a GRN lot of an item without QC is received APPROVED.
    IF NEW.movement_type IN ('RECEIPT', 'OUTPUT') AND lot.status <> inv.initial_lot_status(lot.source, lot.item_id) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: received and produced stock enters its lot in the starting status (QUARANTINE, or APPROVED when the item needs no QC)'
        USING ERRCODE = 'P0001';
    END IF;
    -- Owner 2026-11-18 (Q9): a customer return enters its HOLD return lot at a returns area, never more than dispatched.
    IF NEW.movement_type = 'SALES_RETURN' THEN
      IF lot.status <> 'HOLD' THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: a customer return enters its return lot while it is on HOLD (lot % is %)', lot.lot_no, lot.status
          USING ERRCODE = 'P0001';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM master.locations WHERE id = loc_id AND is_returns_area) THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: customer returns are received into a returns area' USING ERRCODE = 'P0001';
      END IF;
      SELECT COALESCE(-sum(m.qty) FILTER (WHERE m.movement_type = 'DISPATCH'), 0),
             COALESCE(sum(m.qty) FILTER (WHERE m.movement_type = 'SALES_RETURN'), 0)
        INTO dispatched, returned
        FROM inv.stock_movements m JOIN inv.lots f ON f.id = m.lot_id
       WHERE f.id = lot.parent_lot_id OR f.parent_lot_id = lot.parent_lot_id;
      IF returned + NEW.qty > dispatched THEN
        RAISE EXCEPTION 'RETURN_EXCEEDS_DISPATCH: % was dispatched from this lot and % already returned; % more cannot be received',
          dispatched, returned, NEW.qty USING ERRCODE = 'P0001';
      END IF;
    END IF;
    IF NEW.movement_type IN ('DESTROY', 'RETURN_TO_VENDOR') AND lot.status <> 'REJECTED' THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: only a REJECTED lot is destroyed or returned (lot % is %)', lot.lot_no, lot.status
        USING ERRCODE = 'P0001';
    END IF;
    IF lot.status = 'REJECTED' AND NEW.movement_type NOT IN ('DESTROY', 'RETURN_TO_VENDOR') THEN
      RAISE EXCEPTION 'LOT_NOT_APPROVED: lot % is REJECTED; it can only be destroyed or returned', lot.lot_no USING ERRCODE = 'P0001';
    END IF;
    IF NEW.unit_cost <> lot.unit_cost THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a movement is valued at its lot''s unit cost (%)', lot.unit_cost USING ERRCODE = 'P0001';
    END IF;
  ELSE
    -- A reversal mirrors its original: same lot, type and cost; quantity, value and location side swapped.
    SELECT * INTO orig FROM inv.stock_movements WHERE id = NEW.reversal_of;
    IF orig.lot_id IS DISTINCT FROM NEW.lot_id OR orig.movement_type IS DISTINCT FROM NEW.movement_type
       OR orig.qty <> -NEW.qty OR orig.value <> -NEW.value OR orig.unit_cost <> NEW.unit_cost
       OR orig.to_location_id IS DISTINCT FROM NEW.from_location_id
       OR orig.from_location_id IS DISTINCT FROM NEW.to_location_id THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a reversal must mirror the original movement' USING ERRCODE = 'P0001';
    END IF;
    IF orig.reversal_of IS NOT NULL THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a reversal is not reversed again; post a new movement' USING ERRCODE = 'P0001';
    END IF;
    -- The batch-close adjustment is booked on the output; once the batch is closed its output stands.
    IF orig.movement_type = 'OUTPUT' AND lot.batch_closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: lot %''s batch is closed; its output is not reversed', lot.lot_no USING ERRCODE = 'P0001';
    END IF;
    -- Owner 2026-11-27: a sample taken is consumed; it never comes back into the lot.
    IF orig.movement_type = 'SAMPLE_ISSUE' THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: a QC sample is consumed; its movement is not reversed (correct it with a stock adjustment)'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Rule 12: customer-owned stock moves at zero value. Any lot: no cost, no value.
  IF (lot.owner_type = 'CUSTOMER' OR NEW.unit_cost = 0) AND NEW.value <> 0 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: customer-owned or zero-cost stock moves at zero value' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- 3. reservation guard (0014) + expiry at use
CREATE OR REPLACE FUNCTION inv.guard_stock_reservation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APPEND_ONLY: reservations are never deleted; release them to zero' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.lot_id IS DISTINCT FROM OLD.lot_id OR NEW.ref_doc_type IS DISTINCT FROM OLD.ref_doc_type
     OR NEW.ref_doc_id IS DISTINCT FROM OLD.ref_doc_id OR NEW.company_id IS DISTINCT FROM OLD.company_id) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a reservation keeps its lot and document' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.qty > OLD.qty THEN
    SELECT company_id, lot_no, status, expiry_date, retest_date INTO lot FROM inv.lots WHERE id = NEW.lot_id FOR SHARE;
    IF lot.company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: lot % is not in this company', NEW.lot_id USING ERRCODE = 'P0001';
    END IF;
    -- Owner 2026-11-27: expiry and retest checked at use.
    IF lot.expiry_date IS NOT NULL AND lot.expiry_date <= core.company_today() THEN
      RAISE EXCEPTION 'LOT_EXPIRED: lot % expired on %; it is not reserved', lot.lot_no, to_char(lot.expiry_date, 'DD-MM-YYYY') USING ERRCODE = 'P0001';
    END IF;
    IF lot.retest_date IS NOT NULL AND lot.retest_date <= core.company_today() THEN
      RAISE EXCEPTION 'LOT_RETEST_DUE: lot %''s retest date % is reached; it is not reserved', lot.lot_no, to_char(lot.retest_date, 'DD-MM-YYYY')
        USING ERRCODE = 'P0001';
    END IF;
    IF lot.status <> 'APPROVED' THEN  -- rule 2
      RAISE EXCEPTION 'LOT_NOT_APPROVED: lot % is %; only APPROVED lots are reserved', lot.lot_no, lot.status USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
