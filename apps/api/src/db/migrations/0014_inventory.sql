-- 0014_inventory (M2 task 5): lots, the stock ledger, balances and reservations (architecture §4, §5, §6;
-- CLAUDE.md rules 1, 2, 3, 4, 7, 10, 11, 12). The inventory engine (task 6) is the only writer; these guards
-- hold the rules even if a service forgets them.
--
-- * inv.lots: one row per lot; status only through core/transition (rule 7); created QUARANTINE; item, lot no.
--   and owner never change; customer-owned (toll) lots carry zero value (rule 12); RELEASED only for FG;
--   DESTROYED / RETURNED only once the lot holds no stock. Lot-actual costing: unit_cost lives on the lot
--   (no item-level cost table; decision M2 Q2).
-- * inv.stock_movements: the immutable ledger (append-only, rule 4). One location per row: inbound types add
--   (to_location, qty > 0), outbound remove (from_location, qty < 0); a transfer is TRANSFER_OUT + TRANSFER_IN.
--   ISSUE only from APPROVED lots, DISPATCH only from RELEASED lots (rule 2); a REJECTED lot only leaves by
--   DESTROY / RETURN_TO_VENDOR; nothing moves a DESTROYED / RETURNED lot. Valued at the lot's unit cost; toll
--   movements at zero. A correction is a reversal row mirroring the original. Dated in an OPEN period (rule 11).
-- * inv.stock_balances: (lot, location) quantity, kept by the ledger trigger in the same statement; never
--   negative (rule 3: CHECK + INSUFFICIENT_STOCK); at commit every changed balance must equal its ledger sum.
-- * inv.stock_reservations: quantity held for a document line (production order, ...); reserve only APPROVED
--   lots (rule 2); at commit a lot's reservations never exceed its stock. No status column: open = qty > 0.

-- ---------------------------------------------------------------- lots

CREATE TABLE inv.lots (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id        BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  item_id           BIGINT        NOT NULL REFERENCES master.items (id) ON DELETE RESTRICT,
  lot_no            TEXT          NOT NULL CHECK (length(lot_no) BETWEEN 1 AND 40 AND lot_no = trim(lot_no)),
  mfr_batch_no      TEXT          CHECK (mfr_batch_no IS NULL OR length(trim(mfr_batch_no)) > 0),
  manufacturer      TEXT          CHECK (manufacturer IS NULL OR length(trim(manufacturer)) > 0),
  mfg_date          DATE,
  expiry_date       DATE,
  retest_date       DATE,
  assay_pct         NUMERIC(9,4)  CHECK (assay_pct > 0),                       -- divisor of the potency adjustment
  water_pct         NUMERIC(9,4)  CHECK (water_pct >= 0 AND water_pct < 100),  -- dried basis = assay × (100 − water) ÷ 100
  status            TEXT          NOT NULL CHECK (status IN (
                      'QUARANTINE', 'UNDER_TEST', 'APPROVED', 'REJECTED', 'HOLD', 'RETEST_DUE', 'EXPIRED', 'RELEASED',
                      'DESTROYED', 'RETURNED')),
  owner_type        TEXT          NOT NULL DEFAULT 'OWN' CHECK (owner_type IN ('OWN', 'CUSTOMER')),
  owner_customer_id BIGINT        REFERENCES master.customers (id) ON DELETE RESTRICT,
  unit_cost         NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),  -- lot-actual cost per base unit
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by        BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by        BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, item_id, lot_no),
  CONSTRAINT lot_owner_customer CHECK ((owner_type = 'CUSTOMER') = (owner_customer_id IS NOT NULL)),
  CONSTRAINT lot_toll_zero_value CHECK (owner_type = 'OWN' OR unit_cost = 0),
  CONSTRAINT lot_dates CHECK (
    (expiry_date IS NULL OR mfg_date IS NULL OR expiry_date > mfg_date)
    AND (retest_date IS NULL OR expiry_date IS NULL OR retest_date <= expiry_date))
);
CREATE INDEX lots_item_expiry_idx ON inv.lots (item_id, expiry_date);  -- FEFO
CREATE INDEX lots_status_idx ON inv.lots (company_id, status);

CREATE FUNCTION inv.guard_lot() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  item RECORD;
  on_hand NUMERIC(18,4);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'QUARANTINE' THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a lot is created in QUARANTINE' USING ERRCODE = 'P0001';
    END IF;
    SELECT company_id, status INTO item FROM master.items WHERE id = NEW.item_id;
    IF item.company_id IS DISTINCT FROM NEW.company_id OR item.status IS DISTINCT FROM 'ACTIVE' THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a lot needs an ACTIVE item' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.owner_type = 'CUSTOMER' AND NOT EXISTS (
      SELECT 1 FROM master.customers c
       WHERE c.id = NEW.owner_customer_id AND c.company_id = NEW.company_id AND c.status = 'ACTIVE' AND c.is_toll_customer
    ) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: customer-owned stock belongs to an ACTIVE toll customer' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.lot_no IS DISTINCT FROM OLD.lot_no OR NEW.owner_type IS DISTINCT FROM OLD.owner_type
     OR NEW.owner_customer_id IS DISTINCT FROM OLD.owner_customer_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a lot''s item, number and owner never change' USING ERRCODE = 'P0001';
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
CREATE TRIGGER guard_lot BEFORE INSERT OR UPDATE ON inv.lots FOR EACH ROW EXECUTE FUNCTION inv.guard_lot();

SELECT core.enable_audit('inv.lots');
SELECT core.enable_touch('inv.lots');
SELECT core.forbid_delete('inv.lots');
SELECT core.require_transition('inv.lots');

-- ---------------------------------------------------------------- stock ledger

/** Movement types that add stock. = InboundMovementTypes in packages/shared (tested equal). */
CREATE FUNCTION inv.is_inbound(movement_type TEXT) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT movement_type IN ('RECEIPT', 'ISSUE_RETURN', 'OUTPUT', 'SALES_RETURN', 'TRANSFER_IN', 'ADJUSTMENT_IN')
$$;

CREATE TABLE inv.stock_movements (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id       BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  movement_type    TEXT          NOT NULL CHECK (movement_type IN (
                     'RECEIPT', 'ISSUE', 'ISSUE_RETURN', 'OUTPUT', 'DISPATCH', 'SALES_RETURN', 'TRANSFER_OUT',
                     'TRANSFER_IN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DESTROY', 'RETURN_TO_VENDOR')),
  movement_date    DATE          NOT NULL,
  lot_id           BIGINT        NOT NULL REFERENCES inv.lots (id) ON DELETE RESTRICT,
  from_location_id BIGINT        REFERENCES master.locations (id) ON DELETE RESTRICT,
  to_location_id   BIGINT        REFERENCES master.locations (id) ON DELETE RESTRICT,
  qty              NUMERIC(18,4) NOT NULL,  -- signed: + into to_location, − out of from_location
  unit_cost        NUMERIC(18,2) NOT NULL CHECK (unit_cost >= 0),
  value            NUMERIC(18,2) NOT NULL,  -- signed like qty; 0 for customer-owned stock
  ref_doc_type     TEXT          NOT NULL CHECK (ref_doc_type ~ '^[A-Z][A-Z_]{1,29}$'),  -- GRN, PROD_ORDER, DELIVERY, ...
  ref_doc_id       BIGINT        NOT NULL,
  reason_code      TEXT          CHECK (reason_code IS NULL OR length(trim(reason_code)) > 0),
  reversal_of      BIGINT        UNIQUE REFERENCES inv.stock_movements (id) ON DELETE RESTRICT,
  posted_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by       BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at       TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by       BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  CONSTRAINT movement_one_location CHECK (
    qty <> 0 AND (from_location_id IS NULL) <> (to_location_id IS NULL) AND (to_location_id IS NOT NULL) = (qty > 0)),
  CONSTRAINT movement_value_sign CHECK (value = 0 OR (value > 0) = (qty > 0)),
  CONSTRAINT movement_not_own_reversal CHECK (reversal_of IS NULL OR reversal_of <> id)
);
CREATE INDEX stock_movements_lot_idx ON inv.stock_movements (lot_id, id);
CREATE INDEX stock_movements_ref_idx ON inv.stock_movements (ref_doc_type, ref_doc_id);
CREATE INDEX stock_movements_date_idx ON inv.stock_movements (company_id, movement_date);

CREATE FUNCTION inv.guard_stock_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot RECORD;
  orig RECORD;
  loc_id BIGINT := COALESCE(NEW.to_location_id, NEW.from_location_id);
BEGIN
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
CREATE TRIGGER guard_stock_movement BEFORE INSERT ON inv.stock_movements
  FOR EACH ROW EXECUTE FUNCTION inv.guard_stock_movement();

SELECT core.make_append_only('inv.stock_movements');
SELECT core.enable_audit('inv.stock_movements');
SELECT core.require_open_period('inv.stock_movements', 'movement_date');

-- ---------------------------------------------------------------- balances

CREATE TABLE inv.stock_balances (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  lot_id      BIGINT        NOT NULL REFERENCES inv.lots (id) ON DELETE RESTRICT,
  location_id BIGINT        NOT NULL REFERENCES master.locations (id) ON DELETE RESTRICT,
  qty         NUMERIC(18,4) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by  BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by  BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (lot_id, location_id),
  CONSTRAINT stock_balance_not_negative CHECK (qty >= 0)  -- rule 3
);
CREATE INDEX stock_balances_location_idx ON inv.stock_balances (location_id);

-- Every ledger row updates its (lot, location) balance in the same statement.
CREATE FUNCTION inv.apply_stock_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  loc_id BIGINT := COALESCE(NEW.to_location_id, NEW.from_location_id);
  current_qty NUMERIC(18,4);
BEGIN
  INSERT INTO inv.stock_balances (company_id, lot_id, location_id) VALUES (NEW.company_id, NEW.lot_id, loc_id)
    ON CONFLICT (lot_id, location_id) DO NOTHING;
  SELECT qty INTO current_qty FROM inv.stock_balances WHERE lot_id = NEW.lot_id AND location_id = loc_id FOR UPDATE;
  IF current_qty + NEW.qty < 0 THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK: lot % holds % at this location; % requested', NEW.lot_id, current_qty, -NEW.qty
      USING ERRCODE = 'P0001';
  END IF;
  UPDATE inv.stock_balances SET qty = qty + NEW.qty WHERE lot_id = NEW.lot_id AND location_id = loc_id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER apply_stock_movement AFTER INSERT ON inv.stock_movements
  FOR EACH ROW EXECUTE FUNCTION inv.apply_stock_movement();

-- At commit, a changed balance equals the sum of its ledger rows: balances are never written around the ledger.
CREATE FUNCTION inv.check_balance_matches_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  ledger NUMERIC(18,4);
  balance NUMERIC(18,4);
BEGIN
  SELECT qty INTO balance FROM inv.stock_balances WHERE id = NEW.id;
  SELECT COALESCE(sum(qty), 0) INTO ledger FROM inv.stock_movements
   WHERE lot_id = NEW.lot_id AND COALESCE(to_location_id, from_location_id) = NEW.location_id;
  IF balance IS DISTINCT FROM ledger THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: stock balances change only through the stock ledger (lot %, location %)',
      NEW.lot_id, NEW.location_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER balance_matches_ledger AFTER INSERT OR UPDATE ON inv.stock_balances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inv.check_balance_matches_ledger();

CREATE FUNCTION inv.guard_stock_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APPEND_ONLY: stock balances are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.lot_id IS DISTINCT FROM OLD.lot_id OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a balance row keeps its lot and location' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_stock_balance BEFORE UPDATE OR DELETE ON inv.stock_balances
  FOR EACH ROW EXECUTE FUNCTION inv.guard_stock_balance();

SELECT core.enable_audit('inv.stock_balances');
SELECT core.enable_touch('inv.stock_balances');

-- ---------------------------------------------------------------- reservations

CREATE TABLE inv.stock_reservations (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  lot_id       BIGINT        NOT NULL REFERENCES inv.lots (id) ON DELETE RESTRICT,
  qty          NUMERIC(18,4) NOT NULL CHECK (qty >= 0),  -- still held; 0 = released or consumed
  ref_doc_type TEXT          NOT NULL CHECK (ref_doc_type ~ '^[A-Z][A-Z_]{1,29}$'),  -- PROD_ORDER, ...
  ref_doc_id   BIGINT        NOT NULL,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by   BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by   BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (lot_id, ref_doc_type, ref_doc_id)
);
CREATE INDEX stock_reservations_ref_idx ON inv.stock_reservations (ref_doc_type, ref_doc_id);

CREATE FUNCTION inv.guard_stock_reservation() RETURNS trigger
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
    SELECT company_id, lot_no, status INTO lot FROM inv.lots WHERE id = NEW.lot_id FOR SHARE;
    IF lot.company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: lot % is not in this company', NEW.lot_id USING ERRCODE = 'P0001';
    END IF;
    IF lot.status <> 'APPROVED' THEN  -- rule 2
      RAISE EXCEPTION 'LOT_NOT_APPROVED: lot % is %; only APPROVED lots are reserved', lot.lot_no, lot.status USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_stock_reservation BEFORE INSERT OR UPDATE OR DELETE ON inv.stock_reservations
  FOR EACH ROW EXECUTE FUNCTION inv.guard_stock_reservation();

-- At commit, a lot's open reservations never exceed the stock it holds (checked after reserving and after
-- every movement, so stock held for one order cannot be issued to another).
CREATE FUNCTION inv.check_reservations_covered() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  reserved NUMERIC(18,4);
  on_hand NUMERIC(18,4);
BEGIN
  SELECT COALESCE(sum(qty), 0) INTO reserved FROM inv.stock_reservations WHERE lot_id = NEW.lot_id;
  IF reserved = 0 THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(qty), 0) INTO on_hand FROM inv.stock_balances WHERE lot_id = NEW.lot_id;
  IF reserved > on_hand THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK: lot % has % reserved but holds %', NEW.lot_id, reserved, on_hand USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER reservations_covered AFTER INSERT OR UPDATE ON inv.stock_reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inv.check_reservations_covered();
CREATE CONSTRAINT TRIGGER reservations_covered AFTER INSERT ON inv.stock_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION inv.check_reservations_covered();

SELECT core.enable_audit('inv.stock_reservations');
SELECT core.enable_touch('inv.stock_reservations');
