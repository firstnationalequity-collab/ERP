-- 0017_value_adjustment_returns (M2, owner decisions 2026-11-18 Q8 and Q9; architecture §4, §6):
--
-- Q8 — FG lot valuation, Option A:
-- * An FG lot is created in QUARANTINE when output is recorded at packing, at the actual cost of the materials
--   issued to the batch so far (provisional). At batch close a value-only adjustment adds conversion cost and the
--   true-up, in the same transaction as the close journal; the lot's batch is then marked closed.
-- * VALUE_ADJUSTMENT is a general ledger movement type (qty 0, no location, value ≠ 0) so M3 landed cost reuses
--   it. It raises or lowers the lot's value and resets the lot's unit cost to value ÷ quantity (rounded half-up);
--   it never takes the lot's value below zero, is refused on a lot with zero quantity and on customer-owned stock
--   (rule 12). Its purpose (reason_code) decides its GL event: BATCH_CLOSE → FG_COST_ADJUSTMENT. Not reversible
--   in M2 (batch close is final; M3 defines landed-cost corrections).
-- * New rule: an FG lot made by production is never dispatched until its batch is closed (BATCH_NOT_CLOSED).
--
-- Q9 — customer sales return (SALES_RETURN_RECEIPT):
-- * Returned stock goes into a NEW return lot linked to the original lot (lot no. = original + "-R" + sequence),
--   created in HOLD at a returns location, at the original lot's unit cost. Never back into the released lot.
--   A return never exceeds what was dispatched from the original lot and its return lots.
-- * GL: Dr FG inventory / Cr COGS (FG unit cost × qty, the usual rounding). Toll stock: zero value, no GL.
--
-- Lots now record their source (GRN, PRODUCTION_OUTPUT, SALES_RETURN); RECEIPT, OUTPUT and SALES_RETURN movements
-- go only into lots of the matching source. A lot's unit cost changes only by a VALUE_ADJUSTMENT (checked at commit).

-- ---------------------------------------------------------------- locations: returns areas

ALTER TABLE master.locations ADD COLUMN is_returns_area BOOLEAN NOT NULL DEFAULT false;
COMMENT ON COLUMN master.locations.is_returns_area IS 'Customer returns are received only into a returns area (0017)';

-- ---------------------------------------------------------------- lots: source, parent, batch closed

ALTER TABLE inv.lots
  ADD COLUMN source          TEXT,
  ADD COLUMN parent_lot_id   BIGINT REFERENCES inv.lots (id) ON DELETE RESTRICT,
  ADD COLUMN batch_closed_at TIMESTAMPTZ;

-- Lots so far were made by the engine from a GRN or a production output (no production module yet: dev/test data).
UPDATE inv.lots l SET source = CASE
  WHEN EXISTS (SELECT 1 FROM inv.stock_movements m WHERE m.lot_id = l.id AND m.movement_type = 'OUTPUT') THEN 'PRODUCTION_OUTPUT'
  ELSE 'GRN' END;

ALTER TABLE inv.lots
  ALTER COLUMN source SET NOT NULL,
  ADD CONSTRAINT lots_source_check CHECK (source IN ('GRN', 'PRODUCTION_OUTPUT', 'SALES_RETURN')),
  ADD CONSTRAINT lot_return_parent CHECK ((source = 'SALES_RETURN') = (parent_lot_id IS NOT NULL)),
  ADD CONSTRAINT lot_batch_closed_only_production CHECK (batch_closed_at IS NULL OR source = 'PRODUCTION_OUTPUT');
CREATE INDEX lots_parent_idx ON inv.lots (parent_lot_id) WHERE parent_lot_id IS NOT NULL;

CREATE OR REPLACE FUNCTION inv.guard_lot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  item RECORD;
  parent RECORD;
  on_hand NUMERIC(18,4);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.source = 'SALES_RETURN' THEN
      IF NEW.status <> 'HOLD' THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: a customer-return lot is created in HOLD' USING ERRCODE = 'P0001';
      END IF;
    ELSIF NEW.status <> 'QUARANTINE' THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a lot is created in QUARANTINE' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.batch_closed_at IS NOT NULL THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a lot''s batch is closed by the batch close, not at creation' USING ERRCODE = 'P0001';
    END IF;
    SELECT company_id, status, type INTO item FROM master.items WHERE id = NEW.item_id;
    IF item.company_id IS DISTINCT FROM NEW.company_id OR item.status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a lot needs an ACTIVE item' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.source IN ('PRODUCTION_OUTPUT', 'SALES_RETURN') AND item.type <> 'FG' THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: production output and customer returns are finished-goods lots' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.owner_type = 'CUSTOMER' AND NOT EXISTS (
      SELECT 1 FROM master.customers c
       WHERE c.id = NEW.owner_customer_id AND c.company_id = NEW.company_id AND c.status = 'ACTIVE' AND c.is_toll_customer
    ) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: customer-owned stock belongs to an ACTIVE toll customer' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.source = 'SALES_RETURN' THEN
      SELECT p.company_id, p.item_id, p.lot_no, p.source, p.owner_type, p.owner_customer_id, p.unit_cost INTO parent
        FROM inv.lots p WHERE p.id = NEW.parent_lot_id;
      IF parent.company_id IS DISTINCT FROM NEW.company_id OR parent.item_id IS DISTINCT FROM NEW.item_id
         OR parent.owner_type IS DISTINCT FROM NEW.owner_type OR parent.owner_customer_id IS DISTINCT FROM NEW.owner_customer_id THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: a return lot has its original lot''s item and owner' USING ERRCODE = 'P0001';
      END IF;
      IF parent.source = 'SALES_RETURN' THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: a return lot links to the original lot, not to another return lot' USING ERRCODE = 'P0001';
      END IF;
      IF NEW.unit_cost <> parent.unit_cost THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: a return lot carries its original lot''s unit cost (%)', parent.unit_cost USING ERRCODE = 'P0001';
      END IF;
      IF left(NEW.lot_no, length(parent.lot_no) + 2) <> parent.lot_no || '-R'
         OR substr(NEW.lot_no, length(parent.lot_no) + 3) !~ '^[1-9][0-9]*$' THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: a return lot is numbered %-R<n>', parent.lot_no USING ERRCODE = 'P0001';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.lot_no IS DISTINCT FROM OLD.lot_no OR NEW.owner_type IS DISTINCT FROM OLD.owner_type
     OR NEW.owner_customer_id IS DISTINCT FROM OLD.owner_customer_id
     OR NEW.source IS DISTINCT FROM OLD.source OR NEW.parent_lot_id IS DISTINCT FROM OLD.parent_lot_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a lot''s item, number, owner, source and original lot never change' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.batch_closed_at IS NOT NULL AND NEW.batch_closed_at IS DISTINCT FROM OLD.batch_closed_at THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: lot %: its batch is closed; that never changes', NEW.lot_no USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'RELEASED' AND NOT EXISTS (SELECT 1 FROM master.items WHERE id = NEW.item_id AND type = 'FG') THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: only a finished-goods lot is RELEASED' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status IN ('DESTROYED', 'RETURNED') THEN
      SELECT COALESCE(sum(qty), 0) INTO on_hand FROM inv.stock_balances WHERE lot_id = NEW.id;
      IF on_hand <> 0 THEN
        RAISE EXCEPTION 'INVALID_TRANSITION: lot % still holds %; move the stock out first', NEW.lot_no, on_hand
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- At commit: a lot's unit cost changed only together with a VALUE_ADJUSTMENT that set it (its latest one), and
-- equals value ÷ quantity at that point (guard_value_adjustment). Nothing else rewrites a lot's cost.
CREATE FUNCTION inv.check_lot_cost_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cost NUMERIC(18,2);
  adjusted NUMERIC(18,2);
BEGIN
  SELECT unit_cost INTO cost FROM inv.lots WHERE id = NEW.id;
  SELECT m.unit_cost INTO adjusted FROM inv.stock_movements m
   WHERE m.lot_id = NEW.id AND m.movement_type = 'VALUE_ADJUSTMENT' ORDER BY m.id DESC LIMIT 1;
  IF adjusted IS DISTINCT FROM cost THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: lot %''s unit cost changes only by a value adjustment of the stock ledger', NEW.lot_no
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER lot_cost_change AFTER UPDATE ON inv.lots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.unit_cost IS DISTINCT FROM NEW.unit_cost)
  EXECUTE FUNCTION inv.check_lot_cost_change();

-- ---------------------------------------------------------------- ledger: VALUE_ADJUSTMENT

ALTER TABLE inv.stock_movements DROP CONSTRAINT stock_movements_movement_type_check;
ALTER TABLE inv.stock_movements ADD CONSTRAINT stock_movements_movement_type_check CHECK (movement_type IN (
  'RECEIPT', 'ISSUE', 'ISSUE_RETURN', 'OUTPUT', 'DISPATCH', 'SALES_RETURN', 'TRANSFER_OUT',
  'TRANSFER_IN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DESTROY', 'RETURN_TO_VENDOR', 'ROUNDING_SWEEP', 'VALUE_ADJUSTMENT'));

ALTER TABLE inv.stock_movements DROP CONSTRAINT movement_one_location;
ALTER TABLE inv.stock_movements ADD CONSTRAINT movement_one_location CHECK (
  CASE WHEN movement_type IN ('ROUNDING_SWEEP', 'VALUE_ADJUSTMENT')
    THEN qty = 0 AND from_location_id IS NULL AND to_location_id IS NULL AND value <> 0 AND reversal_of IS NULL
    ELSE qty <> 0 AND (from_location_id IS NULL) <> (to_location_id IS NULL) AND (to_location_id IS NOT NULL) = (qty > 0)
  END);

ALTER TABLE inv.stock_movements DROP CONSTRAINT movement_value_sign;
ALTER TABLE inv.stock_movements ADD CONSTRAINT movement_value_sign CHECK (
  movement_type IN ('ROUNDING_SWEEP', 'VALUE_ADJUSTMENT') OR value = 0 OR (value > 0) = (qty > 0));

-- = ValueAdjustmentReason in packages/shared (tested equal). M3 adds LANDED_COST.
-- (IS NOT NULL: a CHECK passes on NULL, and a value adjustment must name its reason.)
ALTER TABLE inv.stock_movements ADD CONSTRAINT movement_value_adjustment_reason CHECK (
  movement_type <> 'VALUE_ADJUSTMENT' OR (reason_code IS NOT NULL AND reason_code IN ('BATCH_CLOSE')));

CREATE FUNCTION inv.guard_value_adjustment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot RECORD;
  lot_qty NUMERIC;
  lot_value NUMERIC;
BEGIN
  -- FOR UPDATE: serialised with every other movement of the lot, so quantity and value are exact.
  SELECT l.company_id, l.lot_no, l.status, l.owner_type, l.unit_cost, l.source, l.batch_closed_at INTO lot
    FROM inv.lots l WHERE l.id = NEW.lot_id FOR UPDATE;
  IF lot.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: lot % is not in this company', NEW.lot_id USING ERRCODE = 'P0001';
  END IF;
  IF lot.owner_type = 'CUSTOMER' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: customer-owned stock carries no value (rule 12); lot % is not adjusted', lot.lot_no
      USING ERRCODE = 'P0001';
  END IF;
  IF lot.status IN ('DESTROYED', 'RETURNED') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: lot % is %; it never moves again', lot.lot_no, lot.status USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(sum(qty), 0), COALESCE(sum(value), 0) INTO lot_qty, lot_value
    FROM inv.stock_movements WHERE lot_id = NEW.lot_id;
  IF lot_qty <= 0 THEN
    RAISE EXCEPTION 'LOT_EMPTY: lot % holds no stock; its value is not adjusted', lot.lot_no USING ERRCODE = 'P0001';
  END IF;
  IF lot_value + NEW.value < 0 THEN
    RAISE EXCEPTION 'LOT_VALUE_NEGATIVE: lot % holds %; an adjustment of % would take it below zero', lot.lot_no, lot_value, NEW.value
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.unit_cost <> lot.unit_cost OR lot.unit_cost <> round((lot_value + NEW.value) / lot_qty, 2) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: after an adjustment of %, lot %''s unit cost is % (value ÷ quantity), set on the lot and the row',
      NEW.value, lot.lot_no, round((lot_value + NEW.value) / lot_qty, 2) USING ERRCODE = 'P0001';
  END IF;
  IF NEW.reason_code = 'BATCH_CLOSE' AND (lot.source <> 'PRODUCTION_OUTPUT' OR lot.batch_closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: the batch-close adjustment applies once, to a production lot whose batch is not closed (lot %)',
      lot.lot_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
-- Name sorts after guard_stock_movement* (trigger order is by name); those let a VALUE_ADJUSTMENT row through.
CREATE TRIGGER guard_value_adjustment BEFORE INSERT ON inv.stock_movements
  FOR EACH ROW WHEN (NEW.movement_type = 'VALUE_ADJUSTMENT') EXECUTE FUNCTION inv.guard_value_adjustment();

-- Value-only rows move no stock: no balance row changes.
DROP TRIGGER apply_stock_movement ON inv.stock_movements;
CREATE TRIGGER apply_stock_movement AFTER INSERT ON inv.stock_movements
  FOR EACH ROW WHEN (NEW.movement_type NOT IN ('ROUNDING_SWEEP', 'VALUE_ADJUSTMENT')) EXECUTE FUNCTION inv.apply_stock_movement();

-- ---------------------------------------------------------------- movement guards (0016 plus Q8 / Q9)

CREATE OR REPLACE FUNCTION inv.guard_stock_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot RECORD;
  orig RECORD;
  loc_id BIGINT := COALESCE(NEW.to_location_id, NEW.from_location_id);
  dispatched NUMERIC;
  returned NUMERIC;
BEGIN
  IF NEW.movement_type IN ('ROUNDING_SWEEP', 'VALUE_ADJUSTMENT') THEN
    RETURN NEW;  -- value-only rows: guard_rounding_sweep / guard_value_adjustment
  END IF;
  -- FOR SHARE: a status change of this lot (e.g. QA HOLD) waits until this posting commits.
  SELECT l.id, l.company_id, l.lot_no, l.status, l.owner_type, l.unit_cost, l.source, l.parent_lot_id, l.batch_closed_at INTO lot
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
    -- Rule 2 and the lot status table (architecture §4).
    IF NEW.movement_type = 'ISSUE' AND lot.status <> 'APPROVED' THEN
      RAISE EXCEPTION 'LOT_NOT_APPROVED: lot % is %; only APPROVED lots are issued', lot.lot_no, lot.status USING ERRCODE = 'P0001';
    END IF;
    IF NEW.movement_type = 'DISPATCH' AND lot.status <> 'RELEASED' THEN
      RAISE EXCEPTION 'LOT_NOT_RELEASED: lot % is %; only RELEASED finished goods are dispatched', lot.lot_no, lot.status
        USING ERRCODE = 'P0001';
    END IF;
    -- Owner 2026-11-18 (Q8): production FG is dispatched only once its batch is closed (cost final).
    IF NEW.movement_type = 'DISPATCH' AND lot.source = 'PRODUCTION_OUTPUT' AND lot.batch_closed_at IS NULL THEN
      RAISE EXCEPTION 'BATCH_NOT_CLOSED: lot %''s batch is not closed; it is dispatched after batch close', lot.lot_no
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.movement_type IN ('RECEIPT', 'OUTPUT') AND lot.status <> 'QUARANTINE' THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: received and produced stock enters a QUARANTINE lot' USING ERRCODE = 'P0001';
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
  IF NEW.movement_type IN ('ROUNDING_SWEEP', 'VALUE_ADJUSTMENT') THEN
    RETURN NEW;  -- value-only rows: guard_rounding_sweep / guard_value_adjustment
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
    -- Owner 2026-11-18 (Q8): the provisional value (materials issued so far); unit cost = value ÷ quantity.
    IF round(NEW.value / NEW.qty, 2) <> NEW.unit_cost THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: finished goods are booked at the given output value (%); the lot''s unit cost (%) must be that value ÷ quantity, rounded to 2 decimals',
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

-- ---------------------------------------------------------------- GL: events FG_COST_ADJUSTMENT, SALES_RETURN_RECEIPT

-- = PostingEventRoles in packages/shared (tested equal): 0016 plus the two events.
CREATE OR REPLACE FUNCTION fin.is_valid_posting_role(p_event TEXT, p_role TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_role = ANY (CASE p_event
    WHEN 'GRN_RECEIPT'          THEN ARRAY['INVENTORY', 'GRNI']
    WHEN 'LANDED_COST'          THEN ARRAY['INVENTORY', 'PRICE_VARIANCE', 'LANDED_COST_CLEARING']
    WHEN 'VENDOR_INVOICE'       THEN ARRAY['GRNI', 'INPUT_TAX', 'PRICE_VARIANCE', 'ACCOUNTS_PAYABLE']
    WHEN 'VENDOR_PAYMENT'       THEN ARRAY['ACCOUNTS_PAYABLE', 'BANK', 'WHT_PAYABLE']
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
    WHEN 'LOT_RETURNED'         THEN ARRAY['ACCOUNTS_PAYABLE', 'INVENTORY']
    WHEN 'ROUNDING_DIFFERENCE'  THEN ARRAY['INVENTORY', 'ROUNDING_DIFFERENCE']
    ELSE ARRAY[]::TEXT[]
  END)
$$;

ALTER TABLE fin.posting_rules DROP CONSTRAINT posting_rules_event_check;
ALTER TABLE fin.posting_rules ADD CONSTRAINT posting_rules_event_check CHECK (event IN (
  'GRN_RECEIPT', 'LANDED_COST', 'VENDOR_INVOICE', 'VENDOR_PAYMENT', 'MATERIAL_ISSUE', 'MATERIAL_RETURN',
  'CONVERSION_ABSORB', 'FG_OUTPUT', 'FG_COST_ADJUSTMENT', 'DISPATCH', 'SALES_RETURN_RECEIPT', 'SALES_INVOICE',
  'TOLL_INVOICE', 'CUSTOMER_RECEIPT', 'STOCK_ADJUSTMENT', 'LOT_DESTROYED', 'LOT_RETURNED', 'ROUNDING_DIFFERENCE'));
ALTER TABLE fin.journal_entries DROP CONSTRAINT journal_entries_event_check;
ALTER TABLE fin.journal_entries ADD CONSTRAINT journal_entries_event_check CHECK (event IN (
  'GRN_RECEIPT', 'LANDED_COST', 'VENDOR_INVOICE', 'VENDOR_PAYMENT', 'MATERIAL_ISSUE', 'MATERIAL_RETURN',
  'CONVERSION_ABSORB', 'FG_OUTPUT', 'FG_COST_ADJUSTMENT', 'DISPATCH', 'SALES_RETURN_RECEIPT', 'SALES_INVOICE',
  'TOLL_INVOICE', 'CUSTOMER_RECEIPT', 'STOCK_ADJUSTMENT', 'LOT_DESTROYED', 'LOT_RETURNED', 'ROUNDING_DIFFERENCE'));
