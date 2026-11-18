-- 0019_dispatch_active_customer (M2, owner 2026-11-18, change to the 0018 default "the customer only has to exist"):
-- a DISPATCH goes only to an ACTIVE customer; a dispatch to a DRAFT or INACTIVE customer is refused
-- (CUSTOMER_NOT_ACTIVE). A SALES_RETURN still only needs the customer to exist in the company (it may be inactive,
-- owner confirmed). A reversal row keeps the customer of the row it reverses whatever that customer's status now is
-- (undoing a wrong dispatch must stay possible). The engine checks the same first (stock-refs.service
-- assertCustomerFor) for a clear error.
CREATE OR REPLACE FUNCTION inv.guard_movement_customer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  orig RECORD;
  parent_id BIGINT;
  dispatched NUMERIC;
  returned NUMERIC;
  cust_status TEXT;
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
  SELECT c.status INTO cust_status FROM master.customers c WHERE c.id = NEW.customer_id AND c.company_id = NEW.company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: customer % is not in this company', NEW.customer_id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.movement_type = 'DISPATCH' AND cust_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'CUSTOMER_NOT_ACTIVE: customer % is %; goods are dispatched only to an ACTIVE customer', NEW.customer_id, cust_status
      USING ERRCODE = 'P0001';
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
