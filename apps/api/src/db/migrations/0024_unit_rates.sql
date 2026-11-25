-- 0024_unit_rates: M3 task 2b (owner 2026-11-25, answer 5; supersedes the 2-decimal unit-cost part of the
-- 2026-11-18 rounding decision). Unit prices and unit costs are RATES: NUMERIC(18,6). Amounts stay NUMERIC(18,2)
-- (line totals, movement values, journal lines). A movement's value = round(qty × unit cost, 2) half-up; the
-- last-out residual, the "never more than the lot holds" cap and the rounding sweep are unchanged.
--   * inv.lots.unit_cost, inv.stock_movements.unit_cost, purch.po_lines.unit_price, master.price_list_lines.unit_price
--     → NUMERIC(18,6) (widening: existing values are kept exactly).
--   * The derived unit costs round to 6 decimals: an FG output lot (value ÷ qty) and a lot after a value
--     adjustment ((value + adjustment) ÷ qty).
-- lot_cost_change names unit_cost in its WHEN clause, so it is dropped and created again around the type change.

DROP TRIGGER lot_cost_change ON inv.lots;

ALTER TABLE inv.lots ALTER COLUMN unit_cost TYPE NUMERIC(18,6);
ALTER TABLE inv.stock_movements ALTER COLUMN unit_cost TYPE NUMERIC(18,6);
ALTER TABLE purch.po_lines ALTER COLUMN unit_price TYPE NUMERIC(18,6);
ALTER TABLE master.price_list_lines ALTER COLUMN unit_price TYPE NUMERIC(18,6);

CREATE OR REPLACE FUNCTION inv.check_lot_cost_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cost NUMERIC(18,6);
  adjusted NUMERIC(18,6);
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

CREATE OR REPLACE FUNCTION inv.guard_value_adjustment() RETURNS trigger
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
  IF NEW.unit_cost <> lot.unit_cost OR lot.unit_cost <> round((lot_value + NEW.value) / lot_qty, 6) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: after an adjustment of %, lot %''s unit cost is % (value ÷ quantity), set on the lot and the row',
      NEW.value, lot.lot_no, round((lot_value + NEW.value) / lot_qty, 6) USING ERRCODE = 'P0001';
  END IF;
  IF NEW.reason_code = 'BATCH_CLOSE' AND (lot.source <> 'PRODUCTION_OUTPUT' OR lot.batch_closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: the batch-close adjustment applies once, to a production lot whose batch is not closed (lot %)',
      lot.lot_no USING ERRCODE = 'P0001';
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
    IF round(NEW.value / NEW.qty, 6) <> NEW.unit_cost THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: finished goods are booked at the given output value (%); the lot''s unit cost (%) must be that value ÷ quantity, rounded to 6 decimals',
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
