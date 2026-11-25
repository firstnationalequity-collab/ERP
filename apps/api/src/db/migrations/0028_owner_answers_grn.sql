-- 0028_owner_answers_grn: owner answers 2026-11-25 to the task-3 questions (docs/decisions.md, same date).
--   1. Exchange rates NUMERIC(9,4) → NUMERIC(18,6) (CLAUDE.md rule 10): fin.exchange_rates.rate,
--      purch.purchase_orders.exchange_rate, core.approvals.exchange_rate.
--   2. (Lot number ML{YY}-{SEQ:5} stays the default; nothing to migrate.)
--   3. GRN shelf life: setting purch.grn.min_shelf_life_pct (default 0 = off). When set, a line whose remaining shelf
--      life on the GRN date ((expiry − GRN date) ÷ (expiry − mfg), or ÷ the item's shelf life when no mfg date) is
--      below that percent is refused (SHELF_LIFE_TOO_SHORT). Expired / retest passed / mfg after GRN: 0027 already.
--   4. master.items.qc_required (true for RM, PM, API, EXCIPIENT; false for the others). After DRAFT a change needs
--      a QA countersign (master.item.approve, another person), for every item type. A GRN lot of an item with
--      qc_required = false is created APPROVED and gets no QC sample request; otherwise QUARANTINE + request.
--   5. GRN cancel and reverse: DRAFT → CANCELLED (reason; purch.grn.post). POSTED → REVERSED (purch.grn.reverse,
--      e-signature + reason) only while every lot is untouched: no movement but the receipt (and its reversal and
--      rounding sweeps), no status change, no reservation, no sample request other than OPEN → CANCELLED. The
--      receipt movements are mirrored, the sample requests CANCELLED, the PO received quantities reduced and the
--      PO status restored, all in one transaction; the lot record stays, at zero stock.

-- ---------------------------------------------------------------- 1. exchange rates NUMERIC(18,6)
ALTER TABLE fin.exchange_rates ALTER COLUMN rate TYPE NUMERIC(18,6);
ALTER TABLE purch.purchase_orders ALTER COLUMN exchange_rate TYPE NUMERIC(18,6);
ALTER TABLE core.approvals ALTER COLUMN exchange_rate TYPE NUMERIC(18,6);

-- ---------------------------------------------------------------- 3. remaining shelf life at receipt
CREATE FUNCTION purch.min_shelf_life_pct(p_company BIGINT) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT (s.value #>> '{}')::numeric FROM core.settings s
                    WHERE s.company_id = p_company AND s.key = 'purch.grn.min_shelf_life_pct'), 0);
$$;

CREATE FUNCTION purch.assert_grn_line_shelf_life(p_company BIGINT, p_grn_date DATE, l purch.grn_lines) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  pct NUMERIC := purch.min_shelf_life_pct(p_company);
  total INTEGER;
  it RECORD;
BEGIN
  IF pct = 0 OR l.expiry_date IS NULL THEN
    RETURN;
  END IF;
  SELECT code, shelf_life_days INTO it FROM master.items WHERE id = l.item_id;
  total := CASE WHEN l.mfg_date IS NOT NULL THEN l.expiry_date - l.mfg_date ELSE it.shelf_life_days END;
  IF total IS NULL OR total <= 0 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: %: give the mfg date so the remaining shelf life can be checked', it.code USING ERRCODE = 'P0001';
  END IF;
  IF (l.expiry_date - p_grn_date) * 100 < pct * total THEN
    RAISE EXCEPTION 'SHELF_LIFE_TOO_SHORT: % has % of % days of shelf life left (minimum % %%)', it.code, l.expiry_date - p_grn_date, total, pct
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- ---------------------------------------------------------------- 4. items: qc_required
ALTER TABLE master.items ADD COLUMN qc_required BOOLEAN;
UPDATE master.items SET qc_required = type IN ('RM', 'PM', 'API', 'EXCIPIENT');
ALTER TABLE master.items ALTER COLUMN qc_required SET NOT NULL;

CREATE FUNCTION master.qc_required_default(item_type TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT item_type IN ('RM', 'PM', 'API', 'EXCIPIENT')
$$;

-- 0011's insert guard, plus: qc_required defaults by type when not given.
CREATE OR REPLACE FUNCTION master.guard_item_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a new item starts as DRAFT' USING ERRCODE = 'P0001';
  END IF;
  NEW.qc_required := coalesce(NEW.qc_required, master.qc_required_default(NEW.type));
  RETURN NEW;
END;
$$;

-- 0011's countersign rule, plus: qc_required of ANY item type after DRAFT (owner 2026-11-25, answer 4).
CREATE OR REPLACE FUNCTION master.require_item_countersign() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  gmp_change BOOLEAN;
  qc_change BOOLEAN;
BEGIN
  IF OLD.status = 'DRAFT' THEN
    RETURN NULL;
  END IF;
  gmp_change := master.is_gmp_item_type(NEW.type)
    AND (NEW.shelf_life_days, NEW.retest_days, NEW.storage_zone, NEW.is_controlled)
        IS DISTINCT FROM (OLD.shelf_life_days, OLD.retest_days, OLD.storage_zone, OLD.is_controlled);
  qc_change := NEW.qc_required IS DISTINCT FROM OLD.qc_required;
  IF (gmp_change OR qc_change)
     AND NOT EXISTS (
       SELECT 1 FROM core.e_signatures s
        WHERE s.record_table = 'master.items' AND s.record_id = NEW.id::text
          AND s.meaning = 'APPROVED' AND s.tx_id = txid_current()
          AND s.user_id <> NEW.updated_by
          AND core.user_holds_key(s.user_id, 'master.item.approve')
     ) THEN
    RAISE EXCEPTION 'COUNTERSIGN_REQUIRED: changing % of this item needs a QA countersign by another person',
      CASE WHEN qc_change THEN 'whether it needs QC' ELSE 'shelf life, retest period, storage zone or controlled flag' END
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------- 4. lots: starting status
-- GRN lots of an item without QC start APPROVED; every other GRN or production lot QUARANTINE; returns HOLD.
CREATE FUNCTION inv.initial_lot_status(p_source TEXT, p_item BIGINT) RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN p_source = 'SALES_RETURN' THEN 'HOLD'
    WHEN p_source = 'GRN' AND NOT (SELECT qc_required FROM master.items WHERE id = p_item) THEN 'APPROVED'
    ELSE 'QUARANTINE'
  END
$$;

-- 0017's lot guard and movement guard, with the starting status from inv.initial_lot_status.
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
    ELSIF NEW.status <> inv.initial_lot_status(NEW.source, NEW.item_id) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: this lot is created in %', inv.initial_lot_status(NEW.source, NEW.item_id) USING ERRCODE = 'P0001';
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
  SELECT l.id, l.company_id, l.item_id, l.lot_no, l.status, l.owner_type, l.unit_cost, l.source, l.parent_lot_id, l.batch_closed_at INTO lot
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
  END IF;

  -- Rule 12: customer-owned stock moves at zero value. Any lot: no cost, no value.
  IF (lot.owner_type = 'CUSTOMER' OR NEW.unit_cost = 0) AND NEW.value <> 0 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: customer-owned or zero-cost stock moves at zero value' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- 5. QC sample requests: CANCELLED
ALTER TABLE qc.sample_requests DROP CONSTRAINT sample_requests_status_check;
ALTER TABLE qc.sample_requests ADD CONSTRAINT sample_requests_status_check CHECK (status = ANY (ARRAY['OPEN', 'CANCELLED']));

-- OPEN → CANCELLED only (M4 adds the sampling moves), and only when its GRN is REVERSED (checked at commit).
CREATE FUNCTION qc.guard_sample_request_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'OPEN' THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: a sample request starts OPEN' USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'OPEN' AND NEW.status = 'CANCELLED') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: sample request % cannot move % → %', NEW.id, OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_sample_request_status BEFORE INSERT OR UPDATE ON qc.sample_requests
  FOR EACH ROW EXECUTE FUNCTION qc.guard_sample_request_status();

CREATE FUNCTION qc.check_sample_request_cancelled() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ref_doc_type = 'GRN' AND NOT EXISTS (SELECT 1 FROM purch.grns g WHERE g.id = NEW.ref_doc_id AND g.status = 'REVERSED') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: sample request % is cancelled only by reversing its GRN', NEW.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_sample_request_cancelled AFTER UPDATE OF status ON qc.sample_requests
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'CANCELLED')
  EXECUTE FUNCTION qc.check_sample_request_cancelled();

-- ---------------------------------------------------------------- 5. GRN: CANCELLED, REVERSED
ALTER TABLE purch.grns DROP CONSTRAINT grns_status_check;
ALTER TABLE purch.grns ADD CONSTRAINT grns_status_check CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED', 'REVERSED'));
-- 0027: "a non-DRAFT GRN carries its rate and poster". A CANCELLED draft was never posted: it carries none.
DO $$
DECLARE
  c TEXT;
BEGIN
  SELECT conname INTO STRICT c FROM pg_constraint
   WHERE conrelid = 'purch.grns'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%posted_by IS NOT NULL%';
  EXECUTE format('ALTER TABLE purch.grns DROP CONSTRAINT %I', c);
END;
$$;
ALTER TABLE purch.grns ADD CONSTRAINT grns_posted_stamps CHECK (
  status IN ('DRAFT', 'CANCELLED')
  OR (exchange_rate IS NOT NULL AND exchange_rate_date IS NOT NULL AND posted_by IS NOT NULL AND posted_at IS NOT NULL)
);

-- Is this GRN lot untouched (owner 2026-11-25, answer 5)? Only its receipt (and that receipt's reversal and rounding
-- sweeps) ever moved it, its status never changed, nothing was reserved, and no sample request went past OPEN
-- (CANCELLED by the reversal itself is allowed).
CREATE FUNCTION purch.grn_lot_untouched(p_grn BIGINT, p_lot BIGINT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
           SELECT 1 FROM inv.stock_movements m
            WHERE m.lot_id = p_lot AND m.movement_type <> 'ROUNDING_SWEEP'
              AND NOT (m.movement_type = 'RECEIPT' AND m.ref_doc_type = 'GRN' AND m.ref_doc_id = p_grn))
     AND (SELECT count(*) FROM core.status_history h WHERE h.entity_table = 'inv.lots' AND h.entity_id = p_lot::text) = 1
     AND NOT EXISTS (SELECT 1 FROM inv.stock_reservations r WHERE r.lot_id = p_lot)
     AND NOT EXISTS (SELECT 1 FROM qc.sample_requests s WHERE s.lot_id = p_lot AND s.status NOT IN ('OPEN', 'CANCELLED'))
$$;

-- 0027's header guard, plus: a sample request exactly when the item needs QC; shelf life at posting;
-- DRAFT → CANCELLED; POSTED → REVERSED only with every receipt mirrored, every sample request cancelled and every
-- lot otherwise untouched.
CREATE OR REPLACE FUNCTION purch.guard_grns() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  po RECORD;
  line purch.grn_lines;
  lot RECORD;
  receipt_id BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: a GRN starts as DRAFT' USING ERRCODE = 'P0001';
    END IF;
  ELSIF OLD.status <> 'DRAFT'
     AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'updated_by'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'RECORD_LOCKED: GRN % is % and can no longer be edited', OLD.doc_no, OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status = OLD.status AND OLD.status <> 'DRAFT' THEN
    RETURN NEW;
  END IF;

  SELECT doc_no, vendor_id, currency, po_date, status INTO po FROM purch.purchase_orders WHERE id = NEW.po_id;
  IF NEW.vendor_id <> po.vendor_id OR NEW.currency <> po.currency THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a GRN takes the vendor and currency of PO %', po.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.grn_date < po.po_date THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: the GRN date is before the date of PO %', po.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'DRAFT' AND po.status NOT IN ('APPROVED', 'PARTIALLY_RECEIVED') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: PO % is % and receives nothing', po.doc_no, po.status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'POSTED' THEN
    IF po.status NOT IN ('APPROVED', 'PARTIALLY_RECEIVED') THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: PO % is % and receives nothing', po.doc_no, po.status USING ERRCODE = 'P0001';
    END IF;
    PERFORM purch.assert_vendor_active(NEW.vendor_id);
    IF NOT EXISTS (SELECT 1 FROM purch.grn_lines WHERE grn_id = NEW.id) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: GRN % has no lines', NEW.doc_no USING ERRCODE = 'P0001';
    END IF;
    FOR line IN SELECT * FROM purch.grn_lines WHERE grn_id = NEW.id LOOP
      PERFORM purch.assert_grn_line_source(NEW.vendor_id, line);
      PERFORM purch.assert_grn_line_shelf_life(NEW.company_id, NEW.grn_date, line);
      IF line.unit_cost IS DISTINCT FROM round(line.unit_price * NEW.exchange_rate, 6) THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: GRN % line % unit cost must be the PO price × the GRN rate', NEW.doc_no, line.line_no
          USING ERRCODE = 'P0001';
      END IF;
      SELECT item_id, unit_cost, source, status INTO lot FROM inv.lots WHERE id = line.lot_id;
      IF NOT FOUND OR lot.item_id <> line.item_id OR lot.unit_cost <> line.unit_cost OR lot.source <> 'GRN' THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: GRN % line % has no matching GRN lot', NEW.doc_no, line.line_no USING ERRCODE = 'P0001';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM inv.stock_movements m
                      WHERE m.lot_id = line.lot_id AND m.movement_type = 'RECEIPT' AND m.ref_doc_type = 'GRN'
                        AND m.ref_doc_id = NEW.id AND m.qty = line.qty AND m.to_location_id = NEW.location_id
                        AND m.movement_date = NEW.grn_date) THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: GRN % line % has no matching receipt movement', NEW.doc_no, line.line_no USING ERRCODE = 'P0001';
      END IF;
      -- Owner 2026-11-25 (answer 4): a sample request exactly when the item needs QC.
      IF (SELECT qc_required FROM master.items WHERE id = line.item_id)
         <> EXISTS (SELECT 1 FROM qc.sample_requests r WHERE r.lot_id = line.lot_id AND r.ref_doc_type = 'GRN' AND r.ref_doc_id = NEW.id) THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: GRN % line %: a QC sample request is raised exactly when the item needs QC', NEW.doc_no, line.line_no
          USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  ELSIF OLD.status = 'DRAFT' AND NEW.status = 'CANCELLED' THEN
    NULL;  -- nothing was posted; the lines stay as the record of what was keyed
  ELSIF OLD.status = 'POSTED' AND NEW.status = 'REVERSED' THEN
    FOR line IN SELECT * FROM purch.grn_lines WHERE grn_id = NEW.id LOOP
      SELECT m.id INTO receipt_id FROM inv.stock_movements m
       WHERE m.lot_id = line.lot_id AND m.movement_type = 'RECEIPT' AND m.ref_doc_type = 'GRN' AND m.ref_doc_id = NEW.id
         AND m.reversal_of IS NULL;
      IF NOT EXISTS (SELECT 1 FROM inv.stock_movements m WHERE m.reversal_of = receipt_id) THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: GRN % line %: the receipt is not reversed', NEW.doc_no, line.line_no USING ERRCODE = 'P0001';
      END IF;
      IF EXISTS (SELECT 1 FROM qc.sample_requests r WHERE r.lot_id = line.lot_id AND r.status = 'OPEN') THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: GRN % line %: cancel the lot''s sample request', NEW.doc_no, line.line_no USING ERRCODE = 'P0001';
      END IF;
      IF NOT purch.grn_lot_untouched(NEW.id, line.lot_id) THEN
        RAISE EXCEPTION 'GRN_LOTS_IN_USE: GRN % line %: the lot was sampled, moved, reserved or its status changed', NEW.doc_no, line.line_no
          USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  ELSE
    RAISE EXCEPTION 'INVALID_TRANSITION: GRN % cannot move % → %', NEW.doc_no, OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- A reversed GRN has given back its PO quantities (0027's check, run for REVERSED too).
CREATE CONSTRAINT TRIGGER check_grn_reversed_received AFTER UPDATE OF status ON purch.grns
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'REVERSED' AND OLD.status = 'POSTED')
  EXECUTE FUNCTION purch.check_grn_posted_received();

-- 0027's line guard, plus the remaining shelf life (answer 3).
CREATE OR REPLACE FUNCTION purch.guard_grn_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  g RECORD;
  pl RECORD;
  it RECORD;
BEGIN
  SELECT company_id, doc_no, status, po_id, grn_date INTO g FROM purch.grns
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.grn_id ELSE NEW.grn_id END;
  IF g.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'RECORD_LOCKED: GRN % is % and its lines can no longer change', g.doc_no, g.status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.grn_id <> OLD.grn_id THEN
    RAISE EXCEPTION 'FORBIDDEN: a line never moves to another GRN' USING ERRCODE = 'P0001';
  END IF;
  SELECT po_id, item_id, unit_price INTO pl FROM purch.po_lines WHERE id = NEW.po_line_id;
  IF pl.po_id <> g.po_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: GRN % receives only lines of its own PO', g.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.item_id <> pl.item_id OR NEW.unit_price <> pl.unit_price THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a GRN line takes the item and price of its PO line' USING ERRCODE = 'P0001';
  END IF;
  SELECT code, type INTO it FROM master.items WHERE id = NEW.item_id;
  IF it.type = 'API' AND (NEW.mfr_batch_no IS NULL OR NEW.mfg_date IS NULL OR NEW.expiry_date IS NULL OR NEW.retest_date IS NULL) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: % is an API: manufacturer batch, mfg, expiry and retest dates are required', it.code
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.mfg_date > g.grn_date OR NEW.expiry_date <= g.grn_date OR NEW.retest_date <= g.grn_date THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: % line dates: mfg on or before the GRN date, expiry and retest after it', it.code
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM purch.assert_grn_line_shelf_life(g.company_id, g.grn_date, NEW);
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- 5. PO: receipts given back by a reversal
-- 0027's receipt guard: an increase only on an APPROVED / PARTIALLY_RECEIVED PO within the tolerance; a decrease
-- (a GRN reversal) on a PARTIALLY_RECEIVED or RECEIVED PO. check_po_line_received still ties the quantity to the
-- POSTED GRN lines at commit.
CREATE OR REPLACE FUNCTION purch.guard_po_line_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  po RECORD;
BEGIN
  IF NEW.received_qty = OLD.received_qty THEN
    RETURN NEW;
  END IF;
  SELECT doc_no, status, company_id INTO po FROM purch.purchase_orders WHERE id = NEW.po_id;
  IF po.status = 'DRAFT' THEN
    RETURN NEW;  -- 0025 guard_po_lines refuses receipts on a DRAFT
  END IF;
  IF NEW.received_qty < OLD.received_qty THEN
    IF po.status NOT IN ('PARTIALLY_RECEIVED', 'RECEIVED') THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: PO % is % and gives back no receipt', po.doc_no, po.status USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF po.status NOT IN ('APPROVED', 'PARTIALLY_RECEIVED') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: PO % is % and receives nothing', po.doc_no, po.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.received_qty > round(NEW.qty * (1 + purch.over_receipt_pct(po.company_id) / 100), 4) THEN
    RAISE EXCEPTION 'OVER_RECEIPT: PO % line % would receive % of % ordered (tolerance % %%)', po.doc_no, NEW.line_no,
      NEW.received_qty, NEW.qty, purch.over_receipt_pct(po.company_id) USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- 0023's PO guard: the vendor / item / AVL checks belong to submit and approval (from DRAFT or PENDING_APPROVAL),
-- not to a GRN reversal putting a received PO back to APPROVED.
CREATE OR REPLACE FUNCTION purch.guard_purchase_orders() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  line RECORD;
  lines_total NUMERIC(18,2);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: a purchase order starts as DRAFT' USING ERRCODE = 'P0001';
    END IF;
    PERFORM purch.assert_vendor_active(NEW.vendor_id);
    RETURN NEW;
  END IF;

  -- After DRAFT only the status changes (submit also stamps the rate and the submitter, from DRAFT).
  IF OLD.status <> 'DRAFT'
     AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'updated_by'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'RECORD_LOCKED: purchase order % is % and can no longer be edited', OLD.doc_no, OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.vendor_id <> OLD.vendor_id THEN
    PERFORM purch.assert_vendor_active(NEW.vendor_id);  -- a DRAFT may change vendor; lines are re-checked at submit
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('PENDING_APPROVAL', 'APPROVED')
     AND OLD.status IN ('DRAFT', 'PENDING_APPROVAL') THEN
    PERFORM purch.assert_vendor_active(NEW.vendor_id);
    IF NOT EXISTS (SELECT 1 FROM purch.po_lines WHERE po_id = NEW.id) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: purchase order % has no lines', NEW.doc_no USING ERRCODE = 'P0001';
    END IF;
    SELECT coalesce(sum(line_amount), 0) INTO lines_total FROM purch.po_lines WHERE po_id = NEW.id;
    IF lines_total <> NEW.total_amount THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: purchase order % total % does not equal its lines %', NEW.doc_no, NEW.total_amount, lines_total
        USING ERRCODE = 'P0001';
    END IF;
    FOR line IN SELECT item_id FROM purch.po_lines WHERE po_id = NEW.id LOOP
      PERFORM purch.assert_item_purchasable(line.item_id);
      PERFORM purch.assert_avl_approved(NEW.vendor_id, line.item_id);
    END LOOP;
  END IF;

  IF NEW.status = 'CANCELLED' AND OLD.status <> 'CANCELLED'
     AND EXISTS (SELECT 1 FROM purch.po_lines WHERE po_id = NEW.id AND received_qty > 0) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: purchase order % has receipts and cannot be cancelled', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
