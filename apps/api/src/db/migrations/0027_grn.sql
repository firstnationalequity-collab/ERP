-- 0027_grn: M3 task 3 (docs/build-plan.md M3; architecture §4 "Lot status", "Purchase order", §6 "GRN posted", §7.5).
--   1. qc.sample_requests: minimal QC sample request (owner 2026-11-25, Q1), created OPEN with each GRN lot; M4 extends it.
--   2. purch.grns + grn_lines: DRAFT → POSTED (posting document). Posting creates one lot per line in QUARANTINE,
--      a RECEIPT movement at PO unit price × the GRN-date exchange rate (owner 2026-11-25: no charges in task 3),
--      the GRN_RECEIPT journal, a sample request per lot, and the PO's received quantities and status.
--   3. PO receipt rules: received_qty only on an APPROVED / PARTIALLY_RECEIVED PO, never above the ordered quantity
--      plus the over-receipt tolerance (setting purch.grn.over_receipt_pct, default 2), always equal to the posted GRN
--      lines at commit; PARTIALLY_RECEIVED / RECEIVED must match the received quantities.
-- The database re-checks what the service checks; segregation (receiver ≠ PO creator / approver) lives in the service.

-- ---------------------------------------------------------------- 1. QC sample requests (owner Q1; M4 extends)
CREATE TABLE qc.sample_requests (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  lot_id        BIGINT      NOT NULL REFERENCES inv.lots (id) ON DELETE RESTRICT,
  ref_doc_type  TEXT        NOT NULL CHECK (ref_doc_type IN ('GRN')),  -- M6 adds production output
  ref_doc_id    BIGINT      NOT NULL,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT        NOT NULL CHECK (status = ANY (ARRAY['OPEN'])),  -- M4 adds the sampling moves (IN-list form)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX sample_requests_open_per_lot_uq ON qc.sample_requests (lot_id) WHERE status = 'OPEN';
CREATE INDEX sample_requests_ref_idx ON qc.sample_requests (ref_doc_type, ref_doc_id);
SELECT core.enable_audit('qc.sample_requests');
SELECT core.enable_touch('qc.sample_requests');
SELECT core.forbid_delete('qc.sample_requests');
SELECT core.require_transition('qc.sample_requests');

-- ---------------------------------------------------------------- 2. GRN
CREATE TABLE purch.grns (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id          BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  doc_no              TEXT          NOT NULL,
  grn_date            DATE          NOT NULL,
  po_id               BIGINT        NOT NULL REFERENCES purch.purchase_orders (id) ON DELETE RESTRICT,
  vendor_id           BIGINT        NOT NULL REFERENCES master.vendors (id) ON DELETE RESTRICT,  -- the PO's vendor
  currency            TEXT          NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),                    -- the PO's currency
  location_id         BIGINT        NOT NULL REFERENCES master.locations (id) ON DELETE RESTRICT, -- where the goods are put
  delivery_note_no    TEXT          CHECK (delivery_note_no IS NULL OR length(delivery_note_no) BETWEEN 1 AND 60),
  notes               TEXT          CHECK (notes IS NULL OR length(notes) <= 1000),
  -- PKR per 1 unit of currency: Finance's latest rate on/before grn_date (owner answer 3), copied at posting.
  -- NUMERIC(18,6) per CLAUDE.md rule 10 (2026-11-25); the rate table itself is still NUMERIC(9,4) (reported).
  exchange_rate       NUMERIC(18,6) CHECK (exchange_rate > 0),
  exchange_rate_date  DATE,
  status              TEXT          NOT NULL CHECK (status IN ('DRAFT', 'POSTED', 'REVERSED')),
  posted_by           BIGINT        REFERENCES core.users (id) ON DELETE RESTRICT,
  posted_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by          BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by          BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, doc_no),
  CHECK (currency <> 'PKR' OR exchange_rate IS NULL OR exchange_rate = 1),
  CHECK (exchange_rate_date IS NULL OR exchange_rate_date <= grn_date),
  CHECK (status = 'DRAFT' OR (exchange_rate IS NOT NULL AND exchange_rate_date IS NOT NULL AND posted_by IS NOT NULL AND posted_at IS NOT NULL))
);
CREATE INDEX grns_po_idx ON purch.grns (po_id, status);
SELECT core.enable_audit('purch.grns');
SELECT core.enable_touch('purch.grns');
SELECT core.forbid_delete('purch.grns');
SELECT core.require_transition('purch.grns');

CREATE TABLE purch.grn_lines (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id          BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  grn_id              BIGINT        NOT NULL REFERENCES purch.grns (id) ON DELETE RESTRICT,
  line_no             INTEGER       NOT NULL CHECK (line_no BETWEEN 1 AND 999),
  po_line_id          BIGINT        NOT NULL REFERENCES purch.po_lines (id) ON DELETE RESTRICT,
  item_id             BIGINT        NOT NULL REFERENCES master.items (id) ON DELETE RESTRICT,  -- the PO line's item
  qty                 NUMERIC(18,4) NOT NULL CHECK (qty > 0),                                  -- base UoM
  containers          INTEGER       NOT NULL DEFAULT 1 CHECK (containers BETWEEN 1 AND 999),   -- one label each
  unit_price          NUMERIC(18,6) NOT NULL CHECK (unit_price >= 0),  -- the PO line's price, PO currency
  unit_cost           NUMERIC(18,6) CHECK (unit_cost >= 0),            -- PKR = round(unit_price × rate, 6), at posting
  approved_source_id  BIGINT        REFERENCES master.approved_sources (id) ON DELETE RESTRICT,  -- GMP materials
  manufacturer        TEXT          CHECK (manufacturer IS NULL OR length(trim(manufacturer)) BETWEEN 1 AND 200),
  manufacturing_site  TEXT          CHECK (manufacturing_site IS NULL OR length(trim(manufacturing_site)) BETWEEN 1 AND 200),
  mfr_batch_no        TEXT          CHECK (mfr_batch_no IS NULL OR length(trim(mfr_batch_no)) BETWEEN 1 AND 60),
  mfg_date            DATE,
  expiry_date         DATE,
  retest_date         DATE,
  lot_id              BIGINT        UNIQUE REFERENCES inv.lots (id) ON DELETE RESTRICT,  -- set at posting
  notes               TEXT          CHECK (notes IS NULL OR length(notes) <= 500),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by          BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by          BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (grn_id, line_no),
  CHECK (expiry_date IS NULL OR mfg_date IS NULL OR expiry_date > mfg_date),
  CHECK (retest_date IS NULL OR expiry_date IS NULL OR retest_date <= expiry_date),
  CHECK (retest_date IS NULL OR mfg_date IS NULL OR retest_date > mfg_date)
);
CREATE INDEX grn_lines_grn_idx ON purch.grn_lines (grn_id);
CREATE INDEX grn_lines_po_line_idx ON purch.grn_lines (po_line_id);
SELECT core.enable_audit('purch.grn_lines');
SELECT core.enable_touch('purch.grn_lines');

-- Over-receipt tolerance in percent (architecture §7.5, default 2), read like the service reads it.
CREATE FUNCTION purch.over_receipt_pct(p_company BIGINT) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT (s.value #>> '{}')::numeric FROM core.settings s
                    WHERE s.company_id = p_company AND s.key = 'purch.grn.over_receipt_pct'), 2);
$$;

-- AVL at receipt (owner 2026-11-25): a GMP material needs an APPROVED source for this item + vendor, naming the
-- manufacturer and site the GRN line records.
CREATE FUNCTION purch.assert_grn_line_source(p_vendor BIGINT, l purch.grn_lines) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  i RECORD;
  s RECORD;
BEGIN
  SELECT code, type INTO i FROM master.items WHERE id = l.item_id;
  IF i.type NOT IN ('RM', 'PM', 'API', 'EXCIPIENT') THEN
    RETURN;
  END IF;
  SELECT vendor_id, item_id, manufacturer, manufacturing_site, status INTO s
    FROM master.approved_sources WHERE id = l.approved_source_id;
  IF NOT FOUND OR s.status <> 'APPROVED' OR s.vendor_id <> p_vendor OR s.item_id <> l.item_id
     OR s.manufacturer IS DISTINCT FROM l.manufacturer OR s.manufacturing_site IS DISTINCT FROM l.manufacturing_site THEN
    RAISE EXCEPTION 'AVL_NOT_APPROVED: line % (%): no APPROVED source for this item, vendor and manufacturer', l.line_no, i.code
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Header: starts DRAFT on an APPROVED / PARTIALLY_RECEIVED PO with its vendor and currency; after DRAFT only the
-- status changes (posting also stamps the rate and the poster, from DRAFT).
CREATE FUNCTION purch.guard_grns() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  po RECORD;
  line purch.grn_lines;
  lot RECORD;
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

  IF TG_OP = 'UPDATE' AND NEW.status = 'POSTED' AND OLD.status = 'DRAFT' THEN
    IF po.status NOT IN ('APPROVED', 'PARTIALLY_RECEIVED') THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: PO % is % and receives nothing', po.doc_no, po.status USING ERRCODE = 'P0001';
    END IF;
    PERFORM purch.assert_vendor_active(NEW.vendor_id);
    IF NOT EXISTS (SELECT 1 FROM purch.grn_lines WHERE grn_id = NEW.id) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: GRN % has no lines', NEW.doc_no USING ERRCODE = 'P0001';
    END IF;
    FOR line IN SELECT * FROM purch.grn_lines WHERE grn_id = NEW.id LOOP
      PERFORM purch.assert_grn_line_source(NEW.vendor_id, line);
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
      IF NOT EXISTS (SELECT 1 FROM qc.sample_requests r WHERE r.lot_id = line.lot_id AND r.ref_doc_type = 'GRN' AND r.ref_doc_id = NEW.id) THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: GRN % line % has no QC sample request', NEW.doc_no, line.line_no USING ERRCODE = 'P0001';
      END IF;
    END LOOP;
  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: GRN % cannot move % → %', NEW.doc_no, OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_grns BEFORE INSERT OR UPDATE ON purch.grns
  FOR EACH ROW EXECUTE FUNCTION purch.guard_grns();

-- Lines change only while the GRN is DRAFT; a line receives a line of the GRN's PO, with its item and price.
CREATE FUNCTION purch.guard_grn_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  g RECORD;
  pl RECORD;
  it RECORD;
BEGIN
  SELECT doc_no, status, po_id, grn_date INTO g FROM purch.grns
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
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_grn_lines BEFORE INSERT OR UPDATE OR DELETE ON purch.grn_lines
  FOR EACH ROW EXECUTE FUNCTION purch.guard_grn_lines();

-- A PO with receipts is PARTIALLY_RECEIVED or RECEIVED, matching its lines (APPROVED = nothing received yet).
CREATE FUNCTION purch.assert_po_receipt_status(p_po BIGINT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  po RECORD;
  any_received BOOLEAN;
  all_received BOOLEAN;
BEGIN
  SELECT doc_no, status INTO po FROM purch.purchase_orders WHERE id = p_po;
  IF po.status NOT IN ('APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED') THEN
    RETURN;
  END IF;
  SELECT bool_or(received_qty > 0), bool_and(received_qty >= qty) INTO any_received, all_received
    FROM purch.po_lines WHERE po_id = p_po;
  IF po.status = 'RECEIVED' AND NOT coalesce(all_received, false) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: PO % is not fully received', po.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF po.status = 'PARTIALLY_RECEIVED' AND (NOT coalesce(any_received, false) OR coalesce(all_received, false)) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: PO % is not partially received', po.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF po.status = 'APPROVED' AND coalesce(any_received, false) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: PO % has receipts; it is PARTIALLY_RECEIVED or RECEIVED', po.doc_no USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- ---------------------------------------------------------------- 3. PO receipt rules
-- 0025's guard_po_lines plus: received_qty moves only on an APPROVED / PARTIALLY_RECEIVED PO, within the tolerance.
CREATE FUNCTION purch.guard_po_line_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  po RECORD;
BEGIN
  IF NEW.received_qty = OLD.received_qty THEN
    RETURN NEW;
  END IF;
  SELECT doc_no, status, company_id INTO po FROM purch.purchase_orders WHERE id = NEW.po_id;
  IF po.status = 'DRAFT' THEN
    RETURN NEW;  -- 0023 guard_po_lines refuses receipts on a DRAFT ("a DRAFT purchase order has no receipts")
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
CREATE TRIGGER guard_po_line_receipt BEFORE UPDATE OF received_qty ON purch.po_lines
  FOR EACH ROW EXECUTE FUNCTION purch.guard_po_line_receipt();

-- At commit, a PO line's received quantity is what its POSTED GRN lines received.
CREATE FUNCTION purch.check_po_line_received() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  posted NUMERIC;
BEGIN
  SELECT coalesce(sum(l.qty), 0) INTO posted
    FROM purch.grn_lines l JOIN purch.grns g ON g.id = l.grn_id
   WHERE l.po_line_id = NEW.id AND g.status = 'POSTED';
  IF NEW.received_qty <> posted THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: PO line % received % but its posted GRN lines hold %', NEW.id, NEW.received_qty, posted
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM purch.assert_po_receipt_status(NEW.po_id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_po_line_received AFTER UPDATE OF received_qty ON purch.po_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION purch.check_po_line_received();

-- And a posted GRN has updated its PO lines (no posting without the received quantity).
CREATE FUNCTION purch.check_grn_posted_received() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bad RECORD;
BEGIN
  SELECT pl.id, pl.received_qty, coalesce(sum(l.qty), 0) AS posted INTO bad
    FROM purch.po_lines pl
    JOIN purch.grn_lines l ON l.po_line_id = pl.id
    JOIN purch.grns g ON g.id = l.grn_id AND g.status = 'POSTED'
   WHERE pl.id IN (SELECT po_line_id FROM purch.grn_lines WHERE grn_id = NEW.id)
   GROUP BY pl.id, pl.received_qty
  HAVING pl.received_qty <> coalesce(sum(l.qty), 0)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: GRN % posted but PO line % still shows % received (posted %)', NEW.doc_no, bad.id, bad.received_qty, bad.posted
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_grn_posted_received AFTER UPDATE OF status ON purch.grns
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'POSTED' AND OLD.status = 'DRAFT')
  EXECUTE FUNCTION purch.check_grn_posted_received();

-- PO receipt statuses must match the received quantities (checked at commit, after the lines are updated).
CREATE FUNCTION purch.check_po_receipt_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM purch.assert_po_receipt_status(NEW.id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_po_receipt_status AFTER UPDATE ON purch.purchase_orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status IN ('APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED'))
  EXECUTE FUNCTION purch.check_po_receipt_status();
