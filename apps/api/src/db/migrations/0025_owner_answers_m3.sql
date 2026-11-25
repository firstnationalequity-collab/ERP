-- 0025_owner_answers_m3: M3 task 2c, owner answers of 2026-11-25 (decisions.md "M3 owner answers 1–6").
--   1. Voiding a file attached to a GMP record needs a QA Manager e-signature (APPROVED, stored on the attachment
--      in the same transaction). core.gmp_attachment_tables() = the TS targets flagged gmp (tested equal).
--   3. Exchange rate: latest on or before the document date within fin.rate.max_age_days (service, rateOn); the PO
--      keeps the date of the rate it used (exchange_rate_date).
--   4. Cancelling a PO before any receipt frees its requisition lines: the cancelled line keeps the link in
--      released_pr_line_id (history), pr_line_id is cleared, and the requisition goes back CONVERTED → SUBMITTED.
--   6. BULK / FG purchases are refused unless setting purch.allow_bulk_fg_purchase is true (default false).

-- ---------------------------------------------------------------- 1. GMP attachment void
CREATE FUNCTION core.gmp_attachment_tables() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['master.approved_sources']::TEXT[];
$$;

CREATE FUNCTION core.require_gmp_void_signature() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.e_signatures s
     WHERE s.record_table = 'core.attachments' AND s.record_id = NEW.id::text
       AND s.meaning = 'APPROVED' AND s.tx_id = txid_current()
  ) THEN
    RAISE EXCEPTION 'COUNTERSIGN_REQUIRED: attachment % is GMP evidence (%); voiding it needs a QA Manager e-signature',
      NEW.id, NEW.record_table USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER require_gmp_void_signature AFTER UPDATE ON core.attachments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL AND NEW.record_table = ANY (core.gmp_attachment_tables()))
  EXECUTE FUNCTION core.require_gmp_void_signature();

-- ---------------------------------------------------------------- 3. rate date on the PO
ALTER TABLE purch.purchase_orders ADD COLUMN exchange_rate_date DATE;  -- the day of the rate used (≤ po_date)
ALTER TABLE purch.purchase_orders ADD CONSTRAINT po_rate_date_not_after_po CHECK (exchange_rate_date IS NULL OR exchange_rate_date <= po_date);

-- ---------------------------------------------------------------- 4. PO cancel frees requisition lines
ALTER TABLE purch.po_lines ADD COLUMN released_pr_line_id BIGINT REFERENCES purch.pr_lines (id) ON DELETE RESTRICT;
ALTER TABLE purch.po_lines ADD CONSTRAINT po_line_one_pr_link CHECK (pr_line_id IS NULL OR released_pr_line_id IS NULL);

-- 0023 plus: on a CANCELLED PO the only change is freeing the requisition link (pr_line_id → released_pr_line_id).
CREATE OR REPLACE FUNCTION purch.guard_po_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  po RECORD;
  prl RECORD;
BEGIN
  SELECT doc_no, status INTO po FROM purch.purchase_orders
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.po_id ELSE NEW.po_id END;
  IF po.status <> 'DRAFT' THEN
    IF TG_OP = 'UPDATE' AND po.status = 'CANCELLED'
       AND OLD.pr_line_id IS NOT NULL AND NEW.pr_line_id IS NULL AND NEW.released_pr_line_id = OLD.pr_line_id
       AND (to_jsonb(NEW) - ARRAY['pr_line_id', 'released_pr_line_id', 'updated_at', 'updated_by'])
           IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['pr_line_id', 'released_pr_line_id', 'updated_at', 'updated_by']) THEN
      RETURN NEW;  -- owner 2026-11-25 (answer 4): the cancelled PO frees its requisition line
    END IF;
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
  IF NEW.released_pr_line_id IS NOT NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: only cancelling a purchase order frees a requisition line' USING ERRCODE = 'P0001';
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

-- 0023 plus: CONVERTED → SUBMITTED only when a line is free again (its PO was cancelled).
CREATE OR REPLACE FUNCTION purch.guard_purchase_requisitions() RETURNS trigger
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
  IF NEW.status = 'SUBMITTED' AND OLD.status = 'CONVERTED'
     AND NOT EXISTS (SELECT 1 FROM purch.pr_lines l
                      WHERE l.pr_id = NEW.id AND NOT EXISTS (SELECT 1 FROM purch.po_lines p WHERE p.pr_line_id = l.id)) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: requisition % has every line on a purchase order; it stays CONVERTED', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'CONVERTED' AND OLD.status <> 'CONVERTED'
     AND EXISTS (SELECT 1 FROM purch.pr_lines l
                  WHERE l.pr_id = NEW.id AND NOT EXISTS (SELECT 1 FROM purch.po_lines p WHERE p.pr_line_id = l.id)) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: requisition % still has lines not on a purchase order', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- 6. BULK / FG purchase is a setting
CREATE OR REPLACE FUNCTION purch.assert_item_purchasable(p_item BIGINT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  i RECORD;
BEGIN
  SELECT company_id, code, type, status INTO i FROM master.items WHERE id = p_item;
  IF NOT FOUND OR i.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: item % is not active', coalesce(i.code, p_item::text) USING ERRCODE = 'P0001';
  END IF;
  IF i.type IN ('BULK', 'FG') AND NOT coalesce(
       (SELECT s.value = 'true'::jsonb FROM core.settings s WHERE s.company_id = i.company_id AND s.key = 'purch.allow_bulk_fg_purchase'),
       false) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: item % (%) is made here, not bought (setting purch.allow_bulk_fg_purchase is off)', i.code, i.type
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;
