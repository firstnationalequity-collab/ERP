-- 0016_rounding_sweep (owner, 18-11-2026: "Any lot with zero quantity must have zero value"):
--
-- A reversal mirrors its original exactly (0014) and is never re-valued, and an outbound movement never takes
-- more than the lot still holds (0015), so in rare rounding cases a lot reaches zero quantity with a few paisa
-- (plus or minus) still on it. The posting engine (engines/posting) sweeps that leftover in the same transaction:
--
-- * Ledger: a value-only ROUNDING_SWEEP row (qty 0, no location, value = minus the lot's remaining value),
--   written through engines/inventory, only on a lot whose ledger quantity is 0 and value is not 0. It moves no
--   stock (balances and reservations are untouched) and is never reversed.
-- * GL: posting event ROUNDING_DIFFERENCE with roles INVENTORY and ROUNDING_DIFFERENCE (a PLACEHOLDER account,
--   Finance to confirm), so the inventory GL still equals the sum of ledger values.
-- * At commit, every lot a movement touched that holds no stock must hold no value.

-- ---------------------------------------------------------------- ledger: the ROUNDING_SWEEP row

ALTER TABLE inv.stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE inv.stock_movements ADD CONSTRAINT stock_movements_movement_type_check CHECK (movement_type IN (
  'RECEIPT', 'ISSUE', 'ISSUE_RETURN', 'OUTPUT', 'DISPATCH', 'SALES_RETURN', 'TRANSFER_OUT',
  'TRANSFER_IN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DESTROY', 'RETURN_TO_VENDOR', 'ROUNDING_SWEEP'));

ALTER TABLE inv.stock_movements DROP CONSTRAINT movement_one_location;
ALTER TABLE inv.stock_movements ADD CONSTRAINT movement_one_location CHECK (
  CASE WHEN movement_type = 'ROUNDING_SWEEP'
    THEN qty = 0 AND from_location_id IS NULL AND to_location_id IS NULL AND value <> 0 AND reversal_of IS NULL
    ELSE qty <> 0 AND (from_location_id IS NULL) <> (to_location_id IS NULL) AND (to_location_id IS NOT NULL) = (qty > 0)
  END);

ALTER TABLE inv.stock_movements DROP CONSTRAINT movement_value_sign;
ALTER TABLE inv.stock_movements ADD CONSTRAINT movement_value_sign CHECK (
  movement_type = 'ROUNDING_SWEEP' OR value = 0 OR (value > 0) = (qty > 0));

CREATE FUNCTION inv.guard_rounding_sweep() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot RECORD;
  lot_qty NUMERIC;
  lot_value NUMERIC;
BEGIN
  -- FOR UPDATE: serialised with every other movement of the lot, so "empty" and "value left" are exact.
  SELECT l.company_id, l.lot_no, l.unit_cost INTO lot FROM inv.lots l WHERE l.id = NEW.lot_id FOR UPDATE;
  IF lot.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: lot % is not in this company', NEW.lot_id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.reversal_of IS NOT NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a rounding sweep is never reversed' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.unit_cost <> lot.unit_cost THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a movement carries its lot''s unit cost (%)', lot.unit_cost USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(sum(qty), 0), COALESCE(sum(value), 0) INTO lot_qty, lot_value
    FROM inv.stock_movements WHERE lot_id = NEW.lot_id;
  IF lot_qty <> 0 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: only an empty lot is swept (lot % holds %)', lot.lot_no, lot_qty USING ERRCODE = 'P0001';
  END IF;
  IF lot_value = 0 OR NEW.value <> -lot_value THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a rounding sweep takes exactly the value left on empty lot % (%)', lot.lot_no, lot_value
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
-- Fires first (trigger order is by name); guard_stock_movement and guard_stock_movement_value let sweep rows through.
CREATE TRIGGER guard_rounding_sweep BEFORE INSERT ON inv.stock_movements
  FOR EACH ROW WHEN (NEW.movement_type = 'ROUNDING_SWEEP') EXECUTE FUNCTION inv.guard_rounding_sweep();

-- A sweep moves no stock: no balance row changes.
DROP TRIGGER apply_stock_movement ON inv.stock_movements;
CREATE TRIGGER apply_stock_movement AFTER INSERT ON inv.stock_movements
  FOR EACH ROW WHEN (NEW.movement_type <> 'ROUNDING_SWEEP') EXECUTE FUNCTION inv.apply_stock_movement();

-- The 0014 and 0015 guards, unchanged except that a sweep row is left to guard_rounding_sweep.

CREATE OR REPLACE FUNCTION inv.guard_stock_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot RECORD;
  orig RECORD;
  loc_id BIGINT := COALESCE(NEW.to_location_id, NEW.from_location_id);
BEGIN
  IF NEW.movement_type = 'ROUNDING_SWEEP' THEN
    RETURN NEW;  -- value-only row, checked by guard_rounding_sweep
  END IF;
  -- FOR SHARE: a status change of this lot (e.g. QA HOLD) waits until this posting commits.
  SELECT l.id, l.company_id, l.lot_no, l.status, l.owner_type, l.unit_cost INTO lot
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
    -- Rule 2 and the lot status table (architecture §4).
    IF NEW.movement_type = 'ISSUE' AND lot.status <> 'APPROVED' THEN
      RAISE EXCEPTION 'LOT_NOT_APPROVED: lot % is %; only APPROVED lots are issued', lot.lot_no, lot.status USING ERRCODE = 'P0001';
    END IF;
    IF NEW.movement_type = 'DISPATCH' AND lot.status <> 'RELEASED' THEN
      RAISE EXCEPTION 'LOT_NOT_RELEASED: lot % is %; only RELEASED finished goods are dispatched', lot.lot_no, lot.status
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.movement_type IN ('RECEIPT', 'OUTPUT') AND lot.status <> 'QUARANTINE' THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: received and produced stock enters a QUARANTINE lot' USING ERRCODE = 'P0001';
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
  END IF;

  -- Rule 12: customer-owned stock moves at zero value. Any lot: no cost, no value.
  IF (lot.owner_type = 'CUSTOMER' OR NEW.unit_cost = 0) AND NEW.value <> 0 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: customer-owned or zero-cost stock moves at zero value' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION inv.guard_stock_movement_value() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot RECORD;
  lot_qty NUMERIC;
  lot_value NUMERIC;
  held NUMERIC;
  nominal NUMERIC(18,2);
  expected NUMERIC(18,2);
BEGIN
  IF NEW.movement_type = 'ROUNDING_SWEEP' THEN
    RETURN NEW;  -- value-only row, checked by guard_rounding_sweep
  END IF;
  IF NEW.reversal_of IS NOT NULL THEN
    RETURN NEW;  -- mirrors its original (guard_stock_movement)
  END IF;
  IF NEW.value <> 0 AND (NEW.value > 0) <> (NEW.qty > 0) THEN
    RETURN NEW;  -- the movement_value_sign CHECK reports it
  END IF;
  -- Serialise movements of one lot, so "the lot's value so far" and "empties the lot" are exact.
  SELECT l.owner_type, l.unit_cost INTO lot FROM inv.lots l WHERE l.id = NEW.lot_id FOR UPDATE;
  IF lot.owner_type = 'CUSTOMER' OR NEW.unit_cost = 0 THEN
    RETURN NEW;  -- zero value, checked by guard_stock_movement (rule 12)
  END IF;

  nominal := round(abs(NEW.qty) * NEW.unit_cost, 2);
  IF NEW.movement_type = 'OUTPUT' THEN
    IF round(NEW.value / NEW.qty, 2) <> NEW.unit_cost THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: finished goods are booked at the batch cost (%); the lot''s unit cost (%) must be that cost ÷ quantity, rounded to 2 decimals',
        NEW.value, NEW.unit_cost USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  ELSIF NEW.movement_type IN ('TRANSFER_OUT', 'TRANSFER_IN') THEN
    expected := sign(NEW.qty) * nominal;
  ELSIF NEW.qty > 0 THEN
    expected := nominal;
  ELSE
    SELECT COALESCE(sum(qty), 0), COALESCE(sum(value), 0) INTO lot_qty, lot_value
      FROM inv.stock_movements WHERE lot_id = NEW.lot_id;
    held := GREATEST(lot_value, 0);
    IF lot_qty + NEW.qty = 0 THEN
      expected := -held;                    -- last-out: the residual
    ELSE
      expected := -LEAST(nominal, held);    -- never more than the lot still holds
    END IF;
  END IF;

  IF NEW.value <> expected THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a % of % at unit cost % is valued %, not %', NEW.movement_type, NEW.qty, NEW.unit_cost,
      expected, NEW.value USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- at commit: an empty lot holds no value

CREATE FUNCTION inv.check_empty_lot_has_no_value() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot_qty NUMERIC;
  lot_value NUMERIC;
BEGIN
  SELECT COALESCE(sum(qty), 0), COALESCE(sum(value), 0) INTO lot_qty, lot_value
    FROM inv.stock_movements WHERE lot_id = NEW.lot_id;
  IF lot_qty = 0 AND lot_value <> 0 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: lot % holds no stock but % of value; the posting engine sweeps it to the rounding difference account in the same transaction',
      NEW.lot_id, lot_value USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER empty_lot_has_no_value AFTER INSERT ON inv.stock_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inv.check_empty_lot_has_no_value();

-- ---------------------------------------------------------------- GL: event and account role ROUNDING_DIFFERENCE

-- = PostingEventRoles in packages/shared (tested equal): 0012 plus ROUNDING_DIFFERENCE.
CREATE OR REPLACE FUNCTION fin.is_valid_posting_role(p_event TEXT, p_role TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_role = ANY (CASE p_event
    WHEN 'GRN_RECEIPT'         THEN ARRAY['INVENTORY', 'GRNI']
    WHEN 'LANDED_COST'         THEN ARRAY['INVENTORY', 'PRICE_VARIANCE', 'LANDED_COST_CLEARING']
    WHEN 'VENDOR_INVOICE'      THEN ARRAY['GRNI', 'INPUT_TAX', 'PRICE_VARIANCE', 'ACCOUNTS_PAYABLE']
    WHEN 'VENDOR_PAYMENT'      THEN ARRAY['ACCOUNTS_PAYABLE', 'BANK', 'WHT_PAYABLE']
    WHEN 'MATERIAL_ISSUE'      THEN ARRAY['WIP', 'INVENTORY']
    WHEN 'MATERIAL_RETURN'     THEN ARRAY['INVENTORY', 'WIP']
    WHEN 'CONVERSION_ABSORB'   THEN ARRAY['WIP', 'LABOUR_ABSORBED', 'OVERHEAD_ABSORBED']
    WHEN 'FG_OUTPUT'           THEN ARRAY['INVENTORY', 'WIP']
    WHEN 'DISPATCH'            THEN ARRAY['COGS', 'INVENTORY']
    WHEN 'SALES_INVOICE'       THEN ARRAY['ACCOUNTS_RECEIVABLE', 'SALES_REVENUE', 'OUTPUT_TAX']
    WHEN 'TOLL_INVOICE'        THEN ARRAY['ACCOUNTS_RECEIVABLE', 'CONVERSION_REVENUE', 'OUTPUT_TAX']
    WHEN 'CUSTOMER_RECEIPT'    THEN ARRAY['BANK', 'WHT_RECEIVABLE', 'ACCOUNTS_RECEIVABLE']
    WHEN 'STOCK_ADJUSTMENT'    THEN ARRAY['INVENTORY', 'INVENTORY_LOSS', 'INVENTORY_GAIN']
    WHEN 'LOT_DESTROYED'       THEN ARRAY['REJECTION_WRITE_OFF', 'INVENTORY']
    WHEN 'LOT_RETURNED'        THEN ARRAY['ACCOUNTS_PAYABLE', 'INVENTORY']
    WHEN 'ROUNDING_DIFFERENCE' THEN ARRAY['INVENTORY', 'ROUNDING_DIFFERENCE']
    ELSE ARRAY[]::TEXT[]
  END)
$$;

ALTER TABLE fin.posting_rules DROP CONSTRAINT posting_rules_event_check;
ALTER TABLE fin.posting_rules ADD CONSTRAINT posting_rules_event_check CHECK (event IN (
  'GRN_RECEIPT', 'LANDED_COST', 'VENDOR_INVOICE', 'VENDOR_PAYMENT', 'MATERIAL_ISSUE', 'MATERIAL_RETURN',
  'CONVERSION_ABSORB', 'FG_OUTPUT', 'DISPATCH', 'SALES_INVOICE', 'TOLL_INVOICE', 'CUSTOMER_RECEIPT',
  'STOCK_ADJUSTMENT', 'LOT_DESTROYED', 'LOT_RETURNED', 'ROUNDING_DIFFERENCE'));
ALTER TABLE fin.posting_rules DROP CONSTRAINT posting_rules_account_role_check;
ALTER TABLE fin.posting_rules ADD CONSTRAINT posting_rules_account_role_check CHECK (account_role IN (
  'INVENTORY', 'GRNI', 'PRICE_VARIANCE', 'LANDED_COST_CLEARING', 'INPUT_TAX', 'ACCOUNTS_PAYABLE', 'BANK',
  'WHT_PAYABLE', 'WIP', 'LABOUR_ABSORBED', 'OVERHEAD_ABSORBED', 'COGS', 'ACCOUNTS_RECEIVABLE',
  'SALES_REVENUE', 'CONVERSION_REVENUE', 'OUTPUT_TAX', 'WHT_RECEIVABLE', 'INVENTORY_LOSS',
  'INVENTORY_GAIN', 'REJECTION_WRITE_OFF', 'ROUNDING_DIFFERENCE'));
ALTER TABLE fin.journal_entries DROP CONSTRAINT journal_entries_event_check;
ALTER TABLE fin.journal_entries ADD CONSTRAINT journal_entries_event_check CHECK (event IN (
  'GRN_RECEIPT', 'LANDED_COST', 'VENDOR_INVOICE', 'VENDOR_PAYMENT', 'MATERIAL_ISSUE', 'MATERIAL_RETURN',
  'CONVERSION_ABSORB', 'FG_OUTPUT', 'DISPATCH', 'SALES_INVOICE', 'TOLL_INVOICE', 'CUSTOMER_RECEIPT',
  'STOCK_ADJUSTMENT', 'LOT_DESTROYED', 'LOT_RETURNED', 'ROUNDING_DIFFERENCE'));
