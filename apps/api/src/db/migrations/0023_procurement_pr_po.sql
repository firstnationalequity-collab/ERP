-- 0023_procurement_pr_po: M3 task 2 (docs/build-plan.md M3; architecture §4 "Purchase order", §7.5; decisions 2026-11-25).
--   1. fin.exchange_rates: Finance-maintained daily rates (owner Q4), PKR per 1 unit of the currency.
--   2. purch.purchase_requisitions + pr_lines: DRAFT → SUBMITTED → CONVERTED, or CANCELLED (owner Q6: no approval).
--   3. purch.purchase_orders + po_lines: DRAFT → PENDING_APPROVAL → APPROVED (approval matrix), back to DRAFT
--      on rejection, CANCELLED before any receipt. Receipt moves come with the GRN (task 3).
-- The database re-checks what the service checks: edits only in DRAFT, line amounts, totals, vendor ACTIVE,
-- items ACTIVE and purchasable, and the AVL block for GMP materials (AvlItemTypes) on submit and approve.

-- ---------------------------------------------------------------- 1. exchange rates (owner Q4, 2026-11-25)
CREATE TABLE fin.exchange_rates (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  currency    TEXT          NOT NULL CHECK (currency ~ '^[A-Z]{3}$' AND currency <> 'PKR'),
  rate_date   DATE          NOT NULL,
  rate        NUMERIC(9,4)  NOT NULL CHECK (rate > 0),  -- PKR per 1 unit of `currency`
  source      TEXT          NOT NULL CHECK (length(trim(source)) BETWEEN 1 AND 100),
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by  BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by  BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, currency, rate_date)
);
SELECT core.enable_audit('fin.exchange_rates');
SELECT core.enable_touch('fin.exchange_rates');
SELECT core.forbid_delete('fin.exchange_rates');

-- A rate's currency and date never change; a corrected rate keeps its row (the audit log keeps the old value).
-- Documents copy the rate they used, so a later correction never changes a document.
CREATE FUNCTION fin.guard_exchange_rates() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.currency <> OLD.currency OR NEW.rate_date <> OLD.rate_date THEN
    RAISE EXCEPTION 'FORBIDDEN: the currency and date of a rate never change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_exchange_rates BEFORE UPDATE ON fin.exchange_rates
  FOR EACH ROW EXECUTE FUNCTION fin.guard_exchange_rates();

-- ---------------------------------------------------------------- shared checks
-- Raises unless the vendor is ACTIVE.
CREATE FUNCTION purch.assert_vendor_active(p_vendor BIGINT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v RECORD;
BEGIN
  SELECT code, status INTO v FROM master.vendors WHERE id = p_vendor;
  IF NOT FOUND OR v.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'VENDOR_NOT_ACTIVE: vendor % is not active', coalesce(v.code, p_vendor::text) USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Raises unless the item is ACTIVE and bought from vendors (not BULK or FG).
CREATE FUNCTION purch.assert_item_purchasable(p_item BIGINT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  i RECORD;
BEGIN
  SELECT code, type, status INTO i FROM master.items WHERE id = p_item;
  IF NOT FOUND OR i.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: item % is not active', coalesce(i.code, p_item::text) USING ERRCODE = 'P0001';
  END IF;
  IF i.type IN ('BULK', 'FG') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: item % (%) is made here, not bought', i.code, i.type USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- AVL block (architecture §7.5): a GMP material (AvlItemTypes: RM, PM, API, EXCIPIENT) needs an APPROVED
-- approved source for this vendor + item. Other item types pass.
CREATE FUNCTION purch.assert_avl_approved(p_vendor BIGINT, p_item BIGINT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  i RECORD;
  v_code TEXT;
BEGIN
  SELECT code, type INTO i FROM master.items WHERE id = p_item;
  IF i.type NOT IN ('RM', 'PM', 'API', 'EXCIPIENT') THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM master.approved_sources
                  WHERE vendor_id = p_vendor AND item_id = p_item AND status = 'APPROVED') THEN
    SELECT code INTO v_code FROM master.vendors WHERE id = p_vendor;
    RAISE EXCEPTION 'AVL_NOT_APPROVED: vendor % is not an approved source for % (%)', v_code, i.code, i.type
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- ---------------------------------------------------------------- 2. purchase requisitions (owner Q6)
CREATE TABLE purch.purchase_requisitions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  doc_no       TEXT        NOT NULL,
  pr_date      DATE        NOT NULL,
  required_by  DATE,
  department   TEXT        CHECK (department IS NULL OR length(department) <= 80),
  notes        TEXT        CHECK (notes IS NULL OR length(notes) <= 1000),
  status       TEXT        NOT NULL CHECK (status IN ('DRAFT', 'SUBMITTED', 'CONVERTED', 'CANCELLED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, doc_no),
  CHECK (required_by IS NULL OR required_by >= pr_date)
);
SELECT core.enable_audit('purch.purchase_requisitions');
SELECT core.enable_touch('purch.purchase_requisitions');
SELECT core.forbid_delete('purch.purchase_requisitions');
SELECT core.require_transition('purch.purchase_requisitions');

CREATE TABLE purch.pr_lines (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  pr_id        BIGINT        NOT NULL REFERENCES purch.purchase_requisitions (id) ON DELETE RESTRICT,
  line_no      INTEGER       NOT NULL CHECK (line_no BETWEEN 1 AND 999),
  item_id      BIGINT        NOT NULL REFERENCES master.items (id) ON DELETE RESTRICT,
  qty          NUMERIC(18,4) NOT NULL CHECK (qty > 0),  -- in the item's base UoM
  notes        TEXT          CHECK (notes IS NULL OR length(notes) <= 500),
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by   BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by   BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (pr_id, line_no)
);
CREATE INDEX pr_lines_pr_idx ON purch.pr_lines (pr_id);
SELECT core.enable_audit('purch.pr_lines');
SELECT core.enable_touch('purch.pr_lines');

-- ---------------------------------------------------------------- 3. purchase orders
CREATE TABLE purch.purchase_orders (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id     BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  doc_no         TEXT          NOT NULL,
  po_date        DATE          NOT NULL,
  vendor_id      BIGINT        NOT NULL REFERENCES master.vendors (id) ON DELETE RESTRICT,
  po_type        TEXT          NOT NULL CHECK (po_type IN ('LOCAL', 'IMPORT')),
  currency       TEXT          NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- PKR per 1 unit of currency, from fin.exchange_rates on po_date, set at submit (1 for PKR). Indicative:
  -- it chooses the approval band; the GRN and invoice convert at their own dates (owner Q4).
  exchange_rate  NUMERIC(9,4)  CHECK (exchange_rate > 0),
  incoterm       TEXT          CHECK (incoterm IN ('EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP')),
  delivery_date  DATE,
  notes          TEXT          CHECK (notes IS NULL OR length(notes) <= 1000),
  total_amount   NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),  -- in `currency`, excluding taxes
  submitted_by   BIGINT        REFERENCES core.users (id) ON DELETE RESTRICT,
  submitted_at   TIMESTAMPTZ,
  status         TEXT          NOT NULL CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED')),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by     BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by     BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, doc_no),
  CHECK (po_type = 'IMPORT' OR currency = 'PKR'),        -- a local PO is in rupees
  CHECK (po_type = 'LOCAL' OR incoterm IS NOT NULL),     -- an import PO names its incoterm
  CHECK (currency <> 'PKR' OR exchange_rate IS NULL OR exchange_rate = 1),
  CHECK (delivery_date IS NULL OR delivery_date >= po_date),
  CHECK (status IN ('DRAFT', 'CANCELLED') OR (exchange_rate IS NOT NULL AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL))
);
CREATE INDEX purchase_orders_vendor_idx ON purch.purchase_orders (vendor_id, status);
SELECT core.enable_audit('purch.purchase_orders');
SELECT core.enable_touch('purch.purchase_orders');
SELECT core.forbid_delete('purch.purchase_orders');
SELECT core.require_transition('purch.purchase_orders');

CREATE TABLE purch.po_lines (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  po_id         BIGINT        NOT NULL REFERENCES purch.purchase_orders (id) ON DELETE RESTRICT,
  line_no       INTEGER       NOT NULL CHECK (line_no BETWEEN 1 AND 999),
  item_id       BIGINT        NOT NULL REFERENCES master.items (id) ON DELETE RESTRICT,
  qty           NUMERIC(18,4) NOT NULL CHECK (qty > 0),           -- in the item's base UoM
  unit_price    NUMERIC(18,2) NOT NULL CHECK (unit_price >= 0),   -- in the PO currency, per base UoM
  line_amount   NUMERIC(18,2) NOT NULL,
  received_qty  NUMERIC(18,4) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),  -- kept by the GRN (task 3)
  pr_line_id    BIGINT        UNIQUE REFERENCES purch.pr_lines (id) ON DELETE RESTRICT,  -- a PR line is ordered once
  notes         TEXT          CHECK (notes IS NULL OR length(notes) <= 500),
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by    BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by    BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (po_id, line_no),
  CHECK (line_amount = round(qty * unit_price, 2))  -- half-up for positive values, as decimal.js ROUND_HALF_UP
);
CREATE INDEX po_lines_po_idx ON purch.po_lines (po_id);
CREATE INDEX po_lines_item_idx ON purch.po_lines (item_id);
SELECT core.enable_audit('purch.po_lines');
SELECT core.enable_touch('purch.po_lines');

-- ---------------------------------------------------------------- guards: requisitions
-- Header: after DRAFT only the status changes. Moving to CONVERTED needs every line on a PO.
CREATE FUNCTION purch.guard_purchase_requisitions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: a requisition starts as DRAFT' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'DRAFT'
     AND (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'updated_by'])
         IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'RECORD_LOCKED: requisition % is % and can no longer be edited', OLD.doc_no, OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'SUBMITTED' AND OLD.status = 'DRAFT'
     AND NOT EXISTS (SELECT 1 FROM purch.pr_lines WHERE pr_id = NEW.id) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: requisition % has no lines', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'CONVERTED' AND OLD.status <> 'CONVERTED'
     AND EXISTS (SELECT 1 FROM purch.pr_lines l
                  WHERE l.pr_id = NEW.id AND NOT EXISTS (SELECT 1 FROM purch.po_lines p WHERE p.pr_line_id = l.id)) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: requisition % still has lines not on a purchase order', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_purchase_requisitions BEFORE INSERT OR UPDATE ON purch.purchase_requisitions
  FOR EACH ROW EXECUTE FUNCTION purch.guard_purchase_requisitions();

-- Lines change only while the requisition is DRAFT.
CREATE FUNCTION purch.guard_pr_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  pr RECORD;
BEGIN
  SELECT doc_no, status INTO pr FROM purch.purchase_requisitions
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.pr_id ELSE NEW.pr_id END;
  IF pr.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'RECORD_LOCKED: requisition % is % and its lines can no longer change', pr.doc_no, pr.status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.pr_id <> OLD.pr_id THEN
    RAISE EXCEPTION 'FORBIDDEN: a line never moves to another requisition' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM purch.assert_item_purchasable(NEW.item_id);
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER guard_pr_lines BEFORE INSERT OR UPDATE OR DELETE ON purch.pr_lines
  FOR EACH ROW EXECUTE FUNCTION purch.guard_pr_lines();

-- ---------------------------------------------------------------- guards: purchase orders
CREATE FUNCTION purch.guard_purchase_orders() RETURNS trigger
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

  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('PENDING_APPROVAL', 'APPROVED') THEN
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
CREATE TRIGGER guard_purchase_orders BEFORE INSERT OR UPDATE ON purch.purchase_orders
  FOR EACH ROW EXECUTE FUNCTION purch.guard_purchase_orders();

-- Lines change only while the PO is DRAFT; afterwards only received_qty (the GRN, task 3) may move.
-- A line taken from a requisition keeps its item and comes from a SUBMITTED requisition.
CREATE FUNCTION purch.guard_po_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  po RECORD;
  prl RECORD;
BEGIN
  SELECT doc_no, status INTO po FROM purch.purchase_orders
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.po_id ELSE NEW.po_id END;
  IF po.status <> 'DRAFT' THEN
    IF TG_OP <> 'UPDATE'
       OR (to_jsonb(NEW) - ARRAY['received_qty', 'updated_at', 'updated_by'])
          IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['received_qty', 'updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'RECORD_LOCKED: purchase order % is % and its lines can no longer change', po.doc_no, po.status
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.received_qty <> 0 THEN
    RAISE EXCEPTION 'FORBIDDEN: a DRAFT purchase order has no receipts' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.po_id <> OLD.po_id THEN
    RAISE EXCEPTION 'FORBIDDEN: a line never moves to another purchase order' USING ERRCODE = 'P0001';
  END IF;
  PERFORM purch.assert_item_purchasable(NEW.item_id);
  IF NEW.pr_line_id IS NOT NULL THEN
    SELECT l.item_id, r.status, r.doc_no INTO prl
      FROM purch.pr_lines l JOIN purch.purchase_requisitions r ON r.id = l.pr_id
     WHERE l.id = NEW.pr_line_id;
    IF prl.item_id <> NEW.item_id THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a line from requisition % keeps its item', prl.doc_no USING ERRCODE = 'P0001';
    END IF;
    -- CONVERTED too: a DRAFT PO rewriting its lines puts them back in the same transaction.
    IF TG_OP = 'INSERT' AND prl.status NOT IN ('SUBMITTED', 'CONVERTED') THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: requisition % is % and cannot be ordered', prl.doc_no, prl.status USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_po_lines BEFORE INSERT OR UPDATE OR DELETE ON purch.po_lines
  FOR EACH ROW EXECUTE FUNCTION purch.guard_po_lines();

-- At commit, every line of a CONVERTED requisition is still on a purchase order (a DRAFT PO that rewrites its
-- lines must put requisition lines back; cancelling the PO keeps them, so they are never ordered twice).
CREATE FUNCTION purch.check_converted_pr_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  pr RECORD;
BEGIN
  IF OLD.pr_line_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT r.doc_no, r.status INTO pr
    FROM purch.pr_lines l JOIN purch.purchase_requisitions r ON r.id = l.pr_id
   WHERE l.id = OLD.pr_line_id;
  IF pr.status = 'CONVERTED' AND NOT EXISTS (SELECT 1 FROM purch.po_lines WHERE pr_line_id = OLD.pr_line_id) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a line of converted requisition % must stay on a purchase order', pr.doc_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_converted_pr_lines AFTER DELETE OR UPDATE OF pr_line_id ON purch.po_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION purch.check_converted_pr_lines();
