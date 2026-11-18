-- 0015_movement_valuation (M2 task 6): how a stock movement is valued (owner decision 2026-11-18, "Rounding of
-- stock values", Option A). The inventory engine (engines/inventory/valuation.ts) computes the same values; these
-- guards hold them even if a service forgets.
--
-- * Value = qty × the lot's unit cost, rounded half-up to 2 decimals (PostgreSQL round(numeric) rounds half away
--   from zero, = decimal.js ROUND_HALF_UP).
-- * Last-out: the outbound movement that empties the lot (all locations) takes the residual value, i.e. minus the
--   sum of the lot's ledger values so far, so the lot ends at exactly zero.
-- * An outbound movement never takes more value than the lot still holds (agent default, PENDING OWNER: with
--   rounding, many small issues could otherwise drive a lot's value below zero while stock remains).
-- * OUTPUT (finished goods) carries the exact batch cost; the lot's unit cost must be that cost ÷ quantity, rounded.
-- * Transfers move value with the stock: TRANSFER_OUT and TRANSFER_IN at qty × unit cost, and at commit every
--   transfer document moves the same quantity and value out of and into each lot (no stock or value disappears
--   without a journal, since transfers do not post to the GL).
-- * Customer-owned and zero-cost stock: value 0 (0014). Reversal rows mirror their original (0014).

CREATE FUNCTION inv.guard_stock_movement_value() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot RECORD;
  lot_qty NUMERIC;
  lot_value NUMERIC;
  held NUMERIC;
  nominal NUMERIC(18,2);
  expected NUMERIC(18,2);
BEGIN
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
-- Fires after guard_stock_movement (trigger order is by name), so its clearer errors come first.
CREATE TRIGGER guard_stock_movement_value BEFORE INSERT ON inv.stock_movements
  FOR EACH ROW EXECUTE FUNCTION inv.guard_stock_movement_value();

CREATE FUNCTION inv.check_transfer_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  net_qty NUMERIC;
  net_value NUMERIC;
BEGIN
  SELECT COALESCE(sum(qty), 0), COALESCE(sum(value), 0) INTO net_qty, net_value
    FROM inv.stock_movements
   WHERE lot_id = NEW.lot_id AND ref_doc_type = NEW.ref_doc_type AND ref_doc_id = NEW.ref_doc_id
     AND movement_type IN ('TRANSFER_OUT', 'TRANSFER_IN');
  IF net_qty <> 0 OR net_value <> 0 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: transfer %/% of lot % moves % (value %) out without moving it in, or the reverse',
      NEW.ref_doc_type, NEW.ref_doc_id, NEW.lot_id, net_qty, net_value USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER transfer_balanced AFTER INSERT ON inv.stock_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.movement_type IN ('TRANSFER_OUT', 'TRANSFER_IN'))
  EXECUTE FUNCTION inv.check_transfer_balanced();
