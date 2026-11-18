-- 0018_return_per_customer (M2, owner 2026-11-18, change to agent default (b) of the Q9 build):
--
-- A customer return never exceeds what was dispatched to THAT customer from the original lot, minus that
-- customer's earlier returns. "The original lot" counts stock dispatched from its return lots too (a re-released
-- return lot is the same batch; 0017 already numbers its returns from the original lot).
--
-- * inv.stock_movements gains customer_id: required on DISPATCH and SALES_RETURN, never on any other type.
--   A reversal row carries the customer of the row it reverses, so sums per customer net out.
-- * The check runs in the DB (this trigger) and in engines/inventory (RETURN_EXCEEDS_DISPATCH, 422).
-- * The original lot is locked FOR UPDATE while a return is checked, so two returns (or a return and a dispatch)
--   of the same lot family are checked one after the other.
-- Rows written before 0018 have no customer; they stay as they are (the ledger is append-only).

ALTER TABLE inv.stock_movements
  ADD COLUMN customer_id BIGINT REFERENCES master.customers (id) ON DELETE RESTRICT,
  ADD CONSTRAINT movement_customer_only_dispatch_return
    CHECK (customer_id IS NULL OR movement_type IN ('DISPATCH', 'SALES_RETURN'));
COMMENT ON COLUMN inv.stock_movements.customer_id IS
  'DISPATCH: the customer the goods went to; SALES_RETURN: the customer returning them (0018)';
CREATE INDEX stock_movements_customer_idx ON inv.stock_movements (customer_id) WHERE customer_id IS NOT NULL;

CREATE OR REPLACE FUNCTION inv.guard_movement_customer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  orig RECORD;
  parent_id BIGINT;
  dispatched NUMERIC;
  returned NUMERIC;
BEGIN
  IF NEW.movement_type NOT IN ('DISPATCH', 'SALES_RETURN') THEN
    RETURN NEW;  -- the CHECK keeps customer_id empty on other types
  END IF;

  IF NEW.reversal_of IS NOT NULL THEN
    SELECT customer_id INTO orig FROM inv.stock_movements WHERE id = NEW.reversal_of;
    IF NEW.customer_id IS DISTINCT FROM orig.customer_id THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a reversal carries the customer of the movement it reverses' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.customer_id IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a % names the customer', NEW.movement_type USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM master.customers c WHERE c.id = NEW.customer_id AND c.company_id = NEW.company_id) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: customer % is not in this company', NEW.customer_id USING ERRCODE = 'P0001';
  END IF;

  IF NEW.movement_type = 'SALES_RETURN' THEN
    SELECT l.parent_lot_id INTO parent_id FROM inv.lots l WHERE l.id = NEW.lot_id;
    IF parent_id IS NULL THEN
      RETURN NEW;  -- guard_stock_movement refuses a return into a lot that is not a return lot
    END IF;
    PERFORM 1 FROM inv.lots WHERE id = parent_id FOR UPDATE;
    SELECT COALESCE(-sum(m.qty) FILTER (WHERE m.movement_type = 'DISPATCH'), 0),
           COALESCE(sum(m.qty) FILTER (WHERE m.movement_type = 'SALES_RETURN'), 0)
      INTO dispatched, returned
      FROM inv.stock_movements m JOIN inv.lots f ON f.id = m.lot_id
     WHERE (f.id = parent_id OR f.parent_lot_id = parent_id) AND m.customer_id = NEW.customer_id;
    IF returned + NEW.qty > dispatched THEN
      RAISE EXCEPTION 'RETURN_EXCEEDS_DISPATCH: % was dispatched to this customer from this lot and % already returned; % more cannot be received',
        dispatched, returned, NEW.qty USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER guard_movement_customer BEFORE INSERT ON inv.stock_movements
  FOR EACH ROW EXECUTE FUNCTION inv.guard_movement_customer();
