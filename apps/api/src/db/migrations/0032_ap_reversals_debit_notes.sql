-- 0032_ap_reversals_debit_notes: M3 task 5b (owner answers 2026-11-26 to task 5).
--   1. WHT codes (owner answers 3, 4): each WITHHOLDING code has a filer (ATL) rate (`rate`) and a non-filer rate, and
--      a base, INCL_SALES_TAX or EXCL_SALES_TAX. Seeded codes get the base unconfirmed; WHT is posted only once
--      Finance has confirmed the rates (is_placeholder false, which needs the non-filer rate) and the base.
--   2. Payments: the rate follows the payee's filer status copied onto the payment; WHT = rate × the base (gross PKR,
--      or the part of it that is not sales tax). A filer status checked more than setting
--      purch.vendor.filer_check_max_days (default 30) before the approval, or never, is a warning the approver
--      acknowledges (stored on the payment). Posting needs the bank reference / cheque number (owner answer 5).
--   3. Reversals (owner answer 7): a POSTED vendor invoice nothing is paid or debited against, and a POSTED payment,
--      are reversed by a Finance Manager with an e-signature (meaning REVERSED) and a reason; the journal is
--      mirrored on the reversal date; quantities and amounts open again. A reversed invoice no longer blocks its GRN
--      or its vendor invoice number.
--   4. Debit notes against a POSTED GOODS invoice (owner answer 7): PRICE_CLAIM, SHORT_SUPPLY, RETURN_TO_VENDOR
--      (posts and links the witnessed RETURN_TO_VENDOR movement of a REJECTED lot), DN-{FY}-{SEQ:5}, approval
--      matrix DEBIT_NOTE, creator ≠ approver. Journal: Dr AP / Cr price variance (or inventory, for a return) / Cr
--      input tax where the invoice line had input tax. Open = total − POSTED payments − POSTED debit notes.
-- The database re-checks what the service checks.

-- ---------------------------------------------------------------- 0. posting events and roles
-- = PostingEventRoles in packages/shared (tested equal).
CREATE OR REPLACE FUNCTION fin.is_valid_posting_role(p_event TEXT, p_role TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_role = ANY (CASE p_event
    WHEN 'GRN_RECEIPT'          THEN ARRAY['INVENTORY', 'GRNI']
    WHEN 'LANDED_COST'          THEN ARRAY['INVENTORY', 'PRICE_VARIANCE', 'LANDED_COST_CLEARING']
    WHEN 'IMPORT_TAX'           THEN ARRAY['INPUT_TAX', 'ADVANCE_TAX', 'LANDED_COST_CLEARING']
    WHEN 'VENDOR_INVOICE'       THEN ARRAY['GRNI', 'LANDED_COST_CLEARING', 'INPUT_TAX', 'PRICE_VARIANCE', 'EXCHANGE_DIFFERENCE', 'ACCOUNTS_PAYABLE']
    WHEN 'VENDOR_PAYMENT'       THEN ARRAY['ACCOUNTS_PAYABLE', 'BANK', 'WHT_PAYABLE', 'EXCHANGE_DIFFERENCE']
    WHEN 'VENDOR_DEBIT_NOTE'    THEN ARRAY['ACCOUNTS_PAYABLE', 'PRICE_VARIANCE', 'INPUT_TAX']
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
    WHEN 'LOT_RETURNED'         THEN ARRAY['ACCOUNTS_PAYABLE', 'INVENTORY', 'PRICE_VARIANCE', 'INPUT_TAX']
    WHEN 'ROUNDING_DIFFERENCE'  THEN ARRAY['INVENTORY', 'ROUNDING_DIFFERENCE']
    ELSE ARRAY[]::TEXT[]
  END)
$$;

ALTER TABLE fin.posting_rules DROP CONSTRAINT posting_rules_event_check;
ALTER TABLE fin.posting_rules ADD CONSTRAINT posting_rules_event_check CHECK (event IN (
  'GRN_RECEIPT', 'LANDED_COST', 'IMPORT_TAX', 'VENDOR_INVOICE', 'VENDOR_PAYMENT', 'VENDOR_DEBIT_NOTE', 'MATERIAL_ISSUE',
  'MATERIAL_RETURN', 'CONVERSION_ABSORB', 'FG_OUTPUT', 'FG_COST_ADJUSTMENT', 'DISPATCH', 'SALES_RETURN_RECEIPT',
  'SALES_INVOICE', 'TOLL_INVOICE', 'CUSTOMER_RECEIPT', 'STOCK_ADJUSTMENT', 'LOT_DESTROYED', 'LOT_RETURNED',
  'ROUNDING_DIFFERENCE'));
ALTER TABLE fin.journal_entries DROP CONSTRAINT journal_entries_event_check;
ALTER TABLE fin.journal_entries ADD CONSTRAINT journal_entries_event_check CHECK (event IN (
  'GRN_RECEIPT', 'LANDED_COST', 'IMPORT_TAX', 'VENDOR_INVOICE', 'VENDOR_PAYMENT', 'VENDOR_DEBIT_NOTE', 'MATERIAL_ISSUE',
  'MATERIAL_RETURN', 'CONVERSION_ABSORB', 'FG_OUTPUT', 'FG_COST_ADJUSTMENT', 'DISPATCH', 'SALES_RETURN_RECEIPT',
  'SALES_INVOICE', 'TOLL_INVOICE', 'CUSTOMER_RECEIPT', 'STOCK_ADJUSTMENT', 'LOT_DESTROYED', 'LOT_RETURNED',
  'ROUNDING_DIFFERENCE'));

-- ---------------------------------------------------------------- 1. WHT codes: filer / non-filer rate, base
ALTER TABLE master.tax_codes
  ADD COLUMN non_filer_rate     NUMERIC(9,4) CHECK (non_filer_rate IS NULL OR (non_filer_rate >= 0 AND non_filer_rate <= 100)),
  ADD COLUMN wht_base           TEXT         CHECK (wht_base IS NULL OR wht_base IN ('INCL_SALES_TAX', 'EXCL_SALES_TAX')),
  ADD COLUMN wht_base_confirmed BOOLEAN      NOT NULL DEFAULT false;

-- A new WITHHOLDING code without a base takes INCL_SALES_TAX, unconfirmed (Finance confirms it).
CREATE FUNCTION master.guard_wht_code() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'WITHHOLDING' THEN
    NEW.wht_base := coalesce(NEW.wht_base, 'INCL_SALES_TAX');
    -- Owner 2026-11-26: confirming the rates confirms both; the non-filer rate is given first.
    IF NOT NEW.is_placeholder AND NEW.non_filer_rate IS NULL
       AND (TG_OP = 'INSERT' OR OLD.is_placeholder OR OLD.non_filer_rate IS NOT NULL) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: give the non-filer rate of % before confirming its rates', NEW.code USING ERRCODE = 'P0001';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.wht_base_confirmed AND NOT NEW.wht_base_confirmed THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a confirmed WHT base stays confirmed' USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.non_filer_rate IS NOT NULL OR NEW.wht_base IS NOT NULL OR NEW.wht_base_confirmed THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: only a withholding code has a non-filer rate and a WHT base' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_wht_code BEFORE INSERT OR UPDATE ON master.tax_codes
  FOR EACH ROW EXECUTE FUNCTION master.guard_wht_code();

SELECT set_config('app.user_id', '1', true),
       set_config('app.company_id', '1', true),
       set_config('app.reason', 'owner 2026-11-26: WHT base per code (unconfirmed until Finance confirms it)', true);
UPDATE master.tax_codes SET wht_base = 'INCL_SALES_TAX' WHERE kind = 'WITHHOLDING' AND wht_base IS NULL;
SELECT set_config('app.reason', '', true);

ALTER TABLE master.tax_codes ADD CONSTRAINT tax_codes_wht_base CHECK ((kind = 'WITHHOLDING') = (wht_base IS NOT NULL));

-- 0013's check, now also for the base (owner 2026-11-26): WHT is posted only with confirmed rates and base.
CREATE OR REPLACE FUNCTION master.assert_tax_rate_confirmed(tax_code BIGINT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  tc RECORD;
BEGIN
  IF tax_code IS NULL THEN
    RETURN;
  END IF;
  SELECT code, kind, is_placeholder, wht_base_confirmed INTO tc FROM master.tax_codes WHERE id = tax_code;
  IF tc.kind = 'WITHHOLDING' AND tc.is_placeholder THEN
    RAISE EXCEPTION 'TAX_RATE_NOT_CONFIRMED: withholding tax % has a placeholder rate; Finance must confirm it before it is posted', tc.code
      USING ERRCODE = 'P0001';
  END IF;
  IF tc.kind = 'WITHHOLDING' AND NOT tc.wht_base_confirmed THEN
    RAISE EXCEPTION 'TAX_RATE_NOT_CONFIRMED: the base of withholding tax % (incl. or excl. sales tax) is not confirmed; Finance must confirm it before it is posted', tc.code
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Owner 2026-11-26 (answer 4): mirror of setting purch.vendor.filer_check_max_days.
CREATE FUNCTION purch.vendor_filer_check_max_days(p_company BIGINT) RETURNS INTEGER
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT (s.value #>> '{}')::integer FROM core.settings s
                    WHERE s.company_id = p_company AND s.key = 'purch.vendor.filer_check_max_days'), 30);
$$;

-- ---------------------------------------------------------------- 2. invoices: REVERSED
ALTER TABLE purch.vendor_invoices
  ADD COLUMN reversed_by      BIGINT REFERENCES core.users (id) ON DELETE RESTRICT,
  ADD COLUMN reversed_at      TIMESTAMPTZ,
  ADD COLUMN reversal_date    DATE,
  ADD COLUMN reversal_reason  TEXT CHECK (reversal_reason IS NULL OR length(trim(reversal_reason)) BETWEEN 3 AND 500);
ALTER TABLE purch.vendor_invoices DROP CONSTRAINT vendor_invoices_status_check;
ALTER TABLE purch.vendor_invoices ADD CONSTRAINT vendor_invoices_status_check
  CHECK (status IN ('DRAFT', 'MATCH_EXCEPTION', 'POSTED', 'CANCELLED', 'REVERSED'));
ALTER TABLE purch.vendor_invoices DROP CONSTRAINT vendor_invoices_check6;
ALTER TABLE purch.vendor_invoices DROP CONSTRAINT vendor_invoices_check7;
ALTER TABLE purch.vendor_invoices DROP CONSTRAINT vendor_invoices_check9;
ALTER TABLE purch.vendor_invoices
  ADD CONSTRAINT vendor_invoices_posted_stamps CHECK (status NOT IN ('POSTED', 'REVERSED') OR (posting_date IS NOT NULL AND posted_by IS NOT NULL AND posted_at IS NOT NULL)),
  ADD CONSTRAINT vendor_invoices_unposted_stamps CHECK (status IN ('POSTED', 'REVERSED') OR (posting_date IS NULL AND posted_by IS NULL AND posted_at IS NULL)),
  ADD CONSTRAINT vendor_invoices_released CHECK (released_by IS NULL OR status IN ('POSTED', 'REVERSED')),
  ADD CONSTRAINT vendor_invoices_reversal CHECK ((status = 'REVERSED') = (reversed_by IS NOT NULL AND reversed_at IS NOT NULL AND reversal_date IS NOT NULL AND reversal_reason IS NOT NULL)),
  ADD CONSTRAINT vendor_invoices_reversal_date CHECK (reversal_date IS NULL OR reversal_date >= posting_date);
-- A reversed entry may be entered again under the vendor's number.
DROP INDEX purch.vendor_invoices_vendor_no_uq;
CREATE UNIQUE INDEX vendor_invoices_vendor_no_uq ON purch.vendor_invoices (company_id, vendor_id, upper(trim(vendor_invoice_no)))
  WHERE status NOT IN ('CANCELLED', 'REVERSED');

-- ---------------------------------------------------------------- 3. payments: WHT base, filer warning, REVERSED
ALTER TABLE purch.vendor_payments
  ADD COLUMN wht_base             TEXT CHECK (wht_base IS NULL OR wht_base IN ('INCL_SALES_TAX', 'EXCL_SALES_TAX')),
  ADD COLUMN wht_base_pkr         NUMERIC(18,2),
  ADD COLUMN filer_warning_ack_by BIGINT REFERENCES core.users (id) ON DELETE RESTRICT,
  ADD COLUMN filer_warning_ack_at TIMESTAMPTZ,
  ADD COLUMN reversed_by          BIGINT REFERENCES core.users (id) ON DELETE RESTRICT,
  ADD COLUMN reversed_at          TIMESTAMPTZ,
  ADD COLUMN reversal_date        DATE,
  ADD COLUMN reversal_reason      TEXT CHECK (reversal_reason IS NULL OR length(trim(reversal_reason)) BETWEEN 3 AND 500);

-- Payments drafted before 0032 (dev databases) keep wht_base_pkr / wht_base NULL: their WHT was on the gross PKR.
-- They are not rewritten (a posted payment never changes); one still in DRAFT gets its base when next saved, and one
-- waiting for approval is cancelled and drafted again (the guard below needs the base for every move).
ALTER TABLE purch.vendor_payments DROP CONSTRAINT vendor_payments_status_check;
ALTER TABLE purch.vendor_payments ADD CONSTRAINT vendor_payments_status_check
  CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'CANCELLED', 'REVERSED'));
ALTER TABLE purch.vendor_payments DROP CONSTRAINT vendor_payments_check2;  -- WHT on the gross PKR (0031)
ALTER TABLE purch.vendor_payments DROP CONSTRAINT vendor_payments_check6;
ALTER TABLE purch.vendor_payments DROP CONSTRAINT vendor_payments_check7;
ALTER TABLE purch.vendor_payments
  ADD CONSTRAINT vendor_payments_wht CHECK (wht_amount = round(coalesce(wht_base_pkr, pkr_paid) * wht_rate / 100, 2)
    AND (wht_base_pkr IS NULL OR (wht_base_pkr >= 0 AND wht_base_pkr <= pkr_paid))),
  ADD CONSTRAINT vendor_payments_wht_base CHECK ((wht_base IS NOT NULL) = (wht_tax_code_id IS NOT NULL AND wht_base_pkr IS NOT NULL)),
  ADD CONSTRAINT vendor_payments_posted_stamps CHECK (status NOT IN ('POSTED', 'REVERSED')
    OR (carrying_pkr IS NOT NULL AND posting_date IS NOT NULL AND posted_by IS NOT NULL AND posted_at IS NOT NULL)),
  ADD CONSTRAINT vendor_payments_unposted_stamps CHECK (status IN ('POSTED', 'REVERSED')
    OR (posting_date IS NULL AND posted_by IS NULL AND posted_at IS NULL AND carrying_pkr IS NULL)),
  ADD CONSTRAINT vendor_payments_filer_ack CHECK ((filer_warning_ack_by IS NULL) = (filer_warning_ack_at IS NULL)),
  ADD CONSTRAINT vendor_payments_reversal CHECK ((status = 'REVERSED') = (reversed_by IS NOT NULL AND reversed_at IS NOT NULL AND reversal_date IS NOT NULL AND reversal_reason IS NOT NULL)),
  ADD CONSTRAINT vendor_payments_reversal_date CHECK (reversal_date IS NULL OR reversal_date >= posting_date);

-- ---------------------------------------------------------------- 4. debit notes
CREATE TABLE purch.debit_notes (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  doc_no          TEXT          NOT NULL,
  reason          TEXT          NOT NULL CHECK (reason IN ('PRICE_CLAIM', 'SHORT_SUPPLY', 'RETURN_TO_VENDOR')),
  vendor_id       BIGINT        NOT NULL REFERENCES master.vendors (id) ON DELETE RESTRICT,
  invoice_id      BIGINT        NOT NULL REFERENCES purch.vendor_invoices (id) ON DELETE RESTRICT,
  dn_date         DATE          NOT NULL,
  currency        TEXT          NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),   -- the invoice's
  exchange_rate   NUMERIC(18,6) NOT NULL CHECK (exchange_rate > 0),         -- the invoice's: AP comes off at its rate
  goods_amount    NUMERIC(18,2) NOT NULL CHECK (goods_amount >= 0),
  tax_amount      NUMERIC(18,2) NOT NULL CHECK (tax_amount >= 0),
  total_amount    NUMERIC(18,2) NOT NULL CHECK (total_amount >= 0),
  total_pkr       NUMERIC(18,2) NOT NULL CHECK (total_pkr >= 0),            -- the AP debit
  notes           TEXT          CHECK (notes IS NULL OR length(notes) <= 1000),
  status          TEXT          NOT NULL CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'CANCELLED')),
  submitted_by    BIGINT        REFERENCES core.users (id) ON DELETE RESTRICT,
  submitted_at    TIMESTAMPTZ,
  posting_date    DATE,
  posted_by       BIGINT        REFERENCES core.users (id) ON DELETE RESTRICT,
  posted_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by      BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by      BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, doc_no),
  CHECK (total_amount = goods_amount + tax_amount),
  CHECK (total_pkr = round(total_amount * exchange_rate, 2)),
  CHECK (status <> 'POSTED' OR (posting_date IS NOT NULL AND posted_by IS NOT NULL AND posted_at IS NOT NULL)),
  CHECK (status = 'POSTED' OR (posting_date IS NULL AND posted_by IS NULL AND posted_at IS NULL)),
  CHECK (status IN ('DRAFT', 'CANCELLED') OR (submitted_by IS NOT NULL AND submitted_at IS NOT NULL))
);
CREATE INDEX debit_notes_invoice_idx ON purch.debit_notes (invoice_id, status);
CREATE INDEX debit_notes_vendor_idx ON purch.debit_notes (vendor_id, status);
SELECT core.enable_audit('purch.debit_notes');
SELECT core.enable_touch('purch.debit_notes');
SELECT core.forbid_delete('purch.debit_notes');
SELECT core.require_transition('purch.debit_notes');

CREATE TABLE purch.debit_note_lines (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id         BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  debit_note_id      BIGINT        NOT NULL REFERENCES purch.debit_notes (id) ON DELETE RESTRICT,
  line_no            INTEGER       NOT NULL CHECK (line_no BETWEEN 1 AND 999),
  invoice_line_id    BIGINT        NOT NULL REFERENCES purch.vendor_invoice_lines (id) ON DELETE RESTRICT,
  qty                NUMERIC(18,4) CHECK (qty > 0),                  -- SHORT_SUPPLY / RETURN_TO_VENDOR
  unit_price         NUMERIC(18,6) CHECK (unit_price >= 0),          -- the invoice line's
  amount             NUMERIC(18,2) NOT NULL CHECK (amount > 0),      -- invoice currency, before tax
  tax_code_id        BIGINT        REFERENCES master.tax_codes (id) ON DELETE RESTRICT,  -- the invoice line's
  tax_rate           NUMERIC(9,4)  NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  tax_amount         NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  amount_pkr         NUMERIC(18,2) NOT NULL CHECK (amount_pkr >= 0),
  tax_pkr            NUMERIC(18,2) NOT NULL CHECK (tax_pkr >= 0),
  lot_id             BIGINT        REFERENCES inv.lots (id) ON DELETE RESTRICT,           -- RETURN_TO_VENDOR: the GRN line's lot
  movement_id        BIGINT        UNIQUE REFERENCES inv.stock_movements (id) ON DELETE RESTRICT,  -- RETURN_TO_VENDOR, at posting
  stock_value_pkr    NUMERIC(18,2) CHECK (stock_value_pkr >= 0),     -- what the movement took off the lot
  price_variance_pkr NUMERIC(18,2),                                  -- amount_pkr − stock value (at posting)
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by         BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by         BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (debit_note_id, line_no),
  UNIQUE (debit_note_id, invoice_line_id),
  CHECK ((qty IS NULL) = (unit_price IS NULL)),
  CHECK (qty IS NULL OR amount = round(qty * unit_price, 2)),
  CHECK (tax_amount = round(amount * tax_rate / 100, 2)),
  CHECK (tax_code_id IS NOT NULL OR tax_rate = 0),
  CHECK ((movement_id IS NULL) = (stock_value_pkr IS NULL)),
  CHECK (movement_id IS NULL OR lot_id IS NOT NULL),
  CHECK (price_variance_pkr IS NULL OR price_variance_pkr = amount_pkr - coalesce(stock_value_pkr, 0))
);
CREATE INDEX debit_note_lines_note_idx ON purch.debit_note_lines (debit_note_id);
CREATE INDEX debit_note_lines_invoice_line_idx ON purch.debit_note_lines (invoice_line_id);
SELECT core.enable_audit('purch.debit_note_lines');
SELECT core.enable_touch('purch.debit_note_lines');

-- Lines change only while the note is DRAFT; at posting only the posting result is written.
CREATE FUNCTION purch.guard_debit_note_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  dn RECORD;
BEGIN
  SELECT doc_no, status, company_id INTO dn FROM purch.debit_notes
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.debit_note_id ELSE NEW.debit_note_id END;
  IF TG_OP = 'UPDATE' AND NEW.debit_note_id <> OLD.debit_note_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a debit note line never moves to another note' USING ERRCODE = 'P0001';
  END IF;
  IF dn.status = 'DRAFT' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF NEW.company_id <> dn.company_id OR NEW.movement_id IS NOT NULL OR NEW.price_variance_pkr IS NOT NULL THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a draft debit note line has no posting result' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND dn.status = 'APPROVED'
     AND OLD.movement_id IS NULL AND OLD.price_variance_pkr IS NULL
     AND (to_jsonb(NEW) - ARRAY['movement_id', 'stock_value_pkr', 'price_variance_pkr', 'updated_at', 'updated_by'])
         IS NOT DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['movement_id', 'stock_value_pkr', 'price_variance_pkr', 'updated_at', 'updated_by']) THEN
    RETURN NEW;  -- the posting writes its result
  END IF;
  RAISE EXCEPTION 'RECORD_LOCKED: debit note % is %; its lines no longer change', dn.doc_no, dn.status USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER guard_debit_note_lines BEFORE INSERT OR UPDATE OR DELETE ON purch.debit_note_lines
  FOR EACH ROW EXECUTE FUNCTION purch.guard_debit_note_lines();

-- Taken off an invoice, in its currency: POSTED payments' allocations; POSTED debit notes (other than p_except_*).
CREATE FUNCTION purch.invoice_paid_foreign(p_invoice BIGINT, p_except_payment BIGINT) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(a.foreign_amount), 0) FROM purch.payment_allocations a JOIN purch.vendor_payments p ON p.id = a.payment_id
   WHERE a.invoice_id = p_invoice AND p.status = 'POSTED' AND p.id <> p_except_payment;
$$;
CREATE FUNCTION purch.invoice_debited_foreign(p_invoice BIGINT, p_except_note BIGINT) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(d.total_amount), 0) FROM purch.debit_notes d
   WHERE d.invoice_id = p_invoice AND d.status = 'POSTED' AND d.id <> p_except_note;
$$;

CREATE FUNCTION purch.guard_debit_notes() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  inv RECORD;
  bad RECORD;
  sums RECORD;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a debit note starts as DRAFT' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('POSTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'RECORD_LOCKED: debit note % is % and never changes', OLD.doc_no, OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.invoice_id <> OLD.invoice_id OR NEW.vendor_id <> OLD.vendor_id OR NEW.reason <> OLD.reason) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a debit note keeps its invoice, vendor and reason (cancel it and enter a new one)' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'DRAFT'
     AND (to_jsonb(NEW) - ARRAY['status', 'posting_date', 'posted_by', 'posted_at', 'updated_at', 'updated_by'])
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['status', 'posting_date', 'posted_by', 'posted_at', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'RECORD_LOCKED: debit note % is %; what it debits no longer changes (a rejection returns it to DRAFT)', OLD.doc_no, OLD.status
      USING ERRCODE = 'P0001';
  END IF;
  SELECT doc_no, vendor_id, invoice_type, status, currency, exchange_rate, invoice_date, total_amount, company_id INTO inv
    FROM purch.vendor_invoices WHERE id = NEW.invoice_id;
  IF inv.company_id <> NEW.company_id OR inv.vendor_id <> NEW.vendor_id OR inv.currency <> NEW.currency OR inv.exchange_rate <> NEW.exchange_rate THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a debit note is for the invoice''s vendor, in its currency and at its rate (invoice %)', inv.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.dn_date < inv.invoice_date THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: debit note % is dated before invoice %', NEW.doc_no, inv.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IN ('DRAFT', 'CANCELLED') OR (TG_OP = 'UPDATE' AND NEW.status = OLD.status) THEN
    RETURN NEW;
  END IF;

  -- PENDING_APPROVAL, APPROVED, POSTED: lines of this GOODS invoice, priced and taxed as billed, within what is open.
  IF inv.invoice_type <> 'GOODS' OR inv.status <> 'POSTED' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a debit note is against a POSTED goods invoice (% is %)', inv.doc_no, inv.status USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) AS n, coalesce(sum(l.amount), 0) AS goods, coalesce(sum(l.tax_amount), 0) AS tax, coalesce(sum(l.amount_pkr + l.tax_pkr), 0) AS pkr,
         count(*) FILTER (WHERE l.qty IS NULL) AS no_qty
    INTO sums FROM purch.debit_note_lines l WHERE l.debit_note_id = NEW.id;
  IF sums.n = 0 OR sums.goods <> NEW.goods_amount OR sums.tax <> NEW.tax_amount OR sums.pkr <> NEW.total_pkr THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: debit note % totals do not equal its lines', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.reason = 'PRICE_CLAIM') <> (sums.no_qty = sums.n) OR (NEW.reason <> 'PRICE_CLAIM' AND sums.no_qty > 0)
     OR (NEW.reason = 'RETURN_TO_VENDOR' AND sums.n <> 1) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: debit note % lines do not fit its reason %', NEW.doc_no, NEW.reason USING ERRCODE = 'P0001';
  END IF;
  SELECT l.line_no INTO bad FROM purch.debit_note_lines l
    JOIN purch.vendor_invoice_lines il ON il.id = l.invoice_line_id
    JOIN purch.grn_lines gl ON gl.id = il.grn_line_id
   WHERE l.debit_note_id = NEW.id
     AND (il.invoice_id <> NEW.invoice_id
          OR (l.qty IS NOT NULL AND l.unit_price <> il.unit_price)
          OR l.tax_code_id IS DISTINCT FROM il.tax_code_id OR l.tax_rate <> il.tax_rate
          OR (NEW.reason = 'RETURN_TO_VENDOR') <> (l.lot_id IS NOT NULL)
          OR (l.lot_id IS NOT NULL AND l.lot_id IS DISTINCT FROM gl.lot_id)
          -- Per invoice line: everything debited never exceeds the amount billed.
          OR (SELECT coalesce(sum(x.amount), 0) FROM purch.debit_note_lines x JOIN purch.debit_notes xd ON xd.id = x.debit_note_id
               WHERE x.invoice_line_id = il.id AND (xd.status = 'POSTED' OR xd.id = NEW.id)) > il.amount
          -- Short supply: never more than was billed beyond the quantity received (matched).
          OR (NEW.reason = 'SHORT_SUPPLY'
              AND (SELECT coalesce(sum(x.qty), 0) FROM purch.debit_note_lines x JOIN purch.debit_notes xd ON xd.id = x.debit_note_id
                    WHERE x.invoice_line_id = il.id AND xd.reason = 'SHORT_SUPPLY' AND (xd.status = 'POSTED' OR xd.id = NEW.id))
                  > il.qty - il.matched_qty)
          -- Return: never more than was billed and received.
          OR (NEW.reason = 'RETURN_TO_VENDOR'
              AND (SELECT coalesce(sum(x.qty), 0) FROM purch.debit_note_lines x JOIN purch.debit_notes xd ON xd.id = x.debit_note_id
                    WHERE x.invoice_line_id = il.id AND xd.reason = 'RETURN_TO_VENDOR' AND (xd.status = 'POSTED' OR xd.id = NEW.id))
                  > il.matched_qty))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AMOUNT_EXCEEDS_OPEN: debit note % line % debits more than its invoice line billed (or does not follow it)', NEW.doc_no, bad.line_no
      USING ERRCODE = 'P0001';
  END IF;
  -- The note never takes the invoice below zero: total − POSTED payments − POSTED notes.
  IF NEW.total_amount + purch.invoice_paid_foreign(NEW.invoice_id, 0) + purch.invoice_debited_foreign(NEW.invoice_id, NEW.id) > inv.total_amount THEN
    RAISE EXCEPTION 'AMOUNT_EXCEEDS_OPEN: debit note % is more than is open on invoice %', NEW.doc_no, inv.doc_no USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status = 'PENDING_APPROVAL' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: a debit note is submitted from DRAFT' USING ERRCODE = 'P0001';
    END IF;
    PERFORM purch.assert_vendor_active(NEW.vendor_id);
    RETURN NEW;
  END IF;
  IF NEW.status = 'APPROVED' THEN
    -- Rule 9: whoever creates or submits a debit note does not approve it.
    IF OLD.status <> 'PENDING_APPROVAL' OR NOT EXISTS (
         SELECT 1 FROM core.approvals a WHERE a.doc_table = 'purch.debit_notes' AND a.doc_id = NEW.id::text AND a.status = 'APPROVED')
       OR EXISTS (
         SELECT 1 FROM core.approvals a JOIN core.approval_steps s ON s.approval_id = a.id
          WHERE a.doc_table = 'purch.debit_notes' AND a.doc_id = NEW.id::text AND a.status = 'APPROVED'
            AND s.acted_by IN (NEW.created_by, NEW.submitted_by)) THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: debit note % is approved through the approval matrix by someone other than its creator', NEW.doc_no
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- → POSTED (from APPROVED), on its date.
  IF OLD.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: debit note % is posted once approved', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  PERFORM purch.assert_vendor_active(NEW.vendor_id);
  IF NEW.posting_date <> NEW.dn_date THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: debit note % posts on its date', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM purch.debit_note_lines l WHERE l.debit_note_id = NEW.id AND l.price_variance_pkr IS NULL) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: debit note % has lines without a posting result', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.reason = 'RETURN_TO_VENDOR' THEN
    -- The witnessed RETURN_TO_VENDOR movement of the line's lot, made for this note, of exactly its quantity and value.
    SELECT l.line_no INTO bad FROM purch.debit_note_lines l LEFT JOIN inv.stock_movements m ON m.id = l.movement_id
     WHERE l.debit_note_id = NEW.id
       AND (m.id IS NULL OR m.movement_type <> 'RETURN_TO_VENDOR' OR m.reversal_of IS NOT NULL OR m.lot_id <> l.lot_id
            OR m.ref_doc_type <> 'DEBIT_NOTE' OR m.ref_doc_id <> NEW.id OR m.qty <> -l.qty OR m.value <> -l.stock_value_pkr
            OR m.movement_date <> NEW.posting_date)
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: debit note % line % is not linked to its return movement', NEW.doc_no, bad.line_no USING ERRCODE = 'P0001';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM purch.debit_note_lines l WHERE l.debit_note_id = NEW.id AND (l.movement_id IS NOT NULL OR l.lot_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: only a return note moves stock' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin.journal_entries j
                  WHERE j.source_type = 'DEBIT_NOTE' AND j.source_id = NEW.id
                    AND j.event = CASE WHEN NEW.reason = 'RETURN_TO_VENDOR' THEN 'LOT_RETURNED' ELSE 'VENDOR_DEBIT_NOTE' END
                    AND j.status = 'POSTED' AND j.reversal_of IS NULL AND j.entry_date = NEW.posting_date) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: debit note % has no posted journal', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_debit_notes BEFORE INSERT OR UPDATE ON purch.debit_notes
  FOR EACH ROW EXECUTE FUNCTION purch.guard_debit_notes();

-- ---------------------------------------------------------------- 5. invoice guard: reversal, debit notes
CREATE OR REPLACE FUNCTION purch.guard_vendor_invoices() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v RECORD;
  po RECORD;
  bad RECORD;
  sums RECORD;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a vendor invoice starts as DRAFT' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('CANCELLED', 'REVERSED') THEN
    RAISE EXCEPTION 'RECORD_LOCKED: vendor invoice % is % and never changes', OLD.doc_no, OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED' THEN
    -- Owner 2026-11-26: a posted invoice changes only by its reversal.
    IF NEW.status <> 'REVERSED'
       OR (to_jsonb(NEW) - ARRAY['status', 'reversed_by', 'reversed_at', 'reversal_date', 'reversal_reason', 'updated_at', 'updated_by'])
          IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['status', 'reversed_by', 'reversed_at', 'reversal_date', 'reversal_reason', 'updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'RECORD_LOCKED: vendor invoice % is POSTED; it changes only by its reversal', OLD.doc_no USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
         SELECT 1 FROM core.e_signatures s
          WHERE s.record_table = 'purch.vendor_invoices' AND s.record_id = NEW.id::text AND s.meaning = 'REVERSED'
            AND s.tx_id = txid_current() AND s.user_id = NEW.reversed_by AND core.user_holds_key(s.user_id, 'fin.invoice.reverse')) THEN
      RAISE EXCEPTION 'ESIGN_FAILED: reversing invoice % needs the e-signature (REVERSED) of a holder of fin.invoice.reverse', NEW.doc_no
        USING ERRCODE = 'P0001';
    END IF;
    SELECT p.doc_no INTO bad FROM purch.payment_allocations a JOIN purch.vendor_payments p ON p.id = a.payment_id
     WHERE a.invoice_id = NEW.id AND p.status NOT IN ('CANCELLED', 'REVERSED') LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'IN_USE: invoice % is on payment %; reverse or cancel the payment first', NEW.doc_no, bad.doc_no USING ERRCODE = 'P0001';
    END IF;
    SELECT d.doc_no INTO bad FROM purch.debit_notes d WHERE d.invoice_id = NEW.id AND d.status <> 'CANCELLED' LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'IN_USE: invoice % has debit note %; it is no longer reversed', NEW.doc_no, bad.doc_no USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM fin.journal_entries j JOIN fin.journal_entries r ON r.id = j.reversal_id
                    WHERE j.source_type = 'VENDOR_INVOICE' AND j.source_id = NEW.id AND j.event = 'VENDOR_INVOICE'
                      AND j.reversal_of IS NULL AND j.status = 'REVERSED' AND r.status = 'POSTED' AND r.entry_date = NEW.reversal_date)
       OR EXISTS (SELECT 1 FROM fin.journal_entries j WHERE j.source_type = 'VENDOR_INVOICE' AND j.source_id = NEW.id AND j.status = 'POSTED'
                    AND j.reversal_of IS NULL) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: invoice % is reversed together with its journal', NEW.doc_no USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.invoice_type <> OLD.invoice_type OR NEW.vendor_id <> OLD.vendor_id OR NEW.po_id IS DISTINCT FROM OLD.po_id) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: an invoice keeps its type, vendor and PO (cancel it and enter a new one)' USING ERRCODE = 'P0001';
  END IF;
  -- In MATCH_EXCEPTION what was billed stays: only the status, the release and the rate at posting change.
  IF TG_OP = 'UPDATE' AND OLD.status = 'MATCH_EXCEPTION'
     AND (to_jsonb(NEW) - ARRAY['status', 'exception_at', 'released_by', 'released_at', 'release_reason', 'posting_date', 'posted_by', 'posted_at',
                                'exchange_rate', 'exchange_rate_date', 'total_pkr', 'updated_at', 'updated_by'])
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['status', 'exception_at', 'released_by', 'released_at', 'release_reason', 'posting_date', 'posted_by', 'posted_at',
                                'exchange_rate', 'exchange_rate_date', 'total_pkr', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'RECORD_LOCKED: invoice % is in MATCH_EXCEPTION; it is released or returned to DRAFT, not edited', OLD.doc_no
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'REVERSED' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: only a POSTED invoice is reversed' USING ERRCODE = 'P0001';
  END IF;
  SELECT company_id INTO v FROM master.vendors WHERE id = NEW.vendor_id;
  IF v.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: the vendor belongs to another company' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.po_id IS NOT NULL THEN
    SELECT doc_no, vendor_id, currency, status, company_id INTO po FROM purch.purchase_orders WHERE id = NEW.po_id;
    IF po.company_id <> NEW.company_id OR po.vendor_id <> NEW.vendor_id OR po.currency <> NEW.currency THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a GOODS invoice is from the PO''s vendor, in the PO''s currency (PO %)', po.doc_no USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.status IN ('DRAFT', 'CANCELLED') OR (TG_OP = 'UPDATE' AND NEW.status = OLD.status) THEN
    RETURN NEW;
  END IF;

  -- DRAFT → MATCH_EXCEPTION or → POSTED; MATCH_EXCEPTION → POSTED.
  IF NOT EXISTS (SELECT 1 FROM purch.vendor_invoice_lines WHERE invoice_id = NEW.id) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: invoice % has no lines', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(sum(amount), 0) AS goods, coalesce(sum(tax_amount), 0) AS tax,
         sum(amount_pkr + tax_pkr) AS pkr, bool_and(in_tolerance) AS all_ok, count(*) FILTER (WHERE in_tolerance IS NULL) AS unchecked
    INTO sums FROM purch.vendor_invoice_lines WHERE invoice_id = NEW.id;
  IF sums.goods <> NEW.goods_amount OR sums.tax <> NEW.tax_amount THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: invoice % totals do not equal its lines', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.invoice_type = 'GOODS' THEN
    IF sums.unchecked > 0 OR EXISTS (SELECT 1 FROM purch.vendor_invoice_lines l WHERE l.invoice_id = NEW.id
                                      AND l.in_tolerance IS DISTINCT FROM purch.invoice_line_in_tolerance(l.id)) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: invoice % has a match result that does not follow the tolerances', NEW.doc_no USING ERRCODE = 'P0001';
    END IF;
    SELECT l.line_no INTO bad FROM purch.vendor_invoice_lines l
      JOIN purch.grn_lines gl ON gl.id = l.grn_line_id JOIN purch.grns g ON g.id = gl.grn_id
     WHERE l.invoice_id = NEW.id AND (g.status <> 'POSTED' OR g.po_id <> NEW.po_id) LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: invoice % line % names a GRN line that is not a POSTED receipt of its PO', NEW.doc_no, bad.line_no
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.status = 'MATCH_EXCEPTION' THEN
    IF OLD.status <> 'DRAFT' OR coalesce(sums.all_ok, true) THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: only a DRAFT invoice with a line outside the tolerances goes to MATCH_EXCEPTION' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- → POSTED
  PERFORM purch.assert_vendor_active(NEW.vendor_id);
  IF OLD.status = 'DRAFT' AND NOT coalesce(sums.all_ok, true) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: invoice % is outside the match tolerances; it goes to MATCH_EXCEPTION', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'MATCH_EXCEPTION' THEN
    IF NEW.released_by IS DISTINCT FROM NEW.posted_by OR NEW.released_by = NEW.created_by OR NOT EXISTS (
         SELECT 1 FROM core.e_signatures s
          WHERE s.record_table = 'purch.vendor_invoices' AND s.record_id = NEW.id::text AND s.meaning = 'APPROVED'
            AND s.tx_id = txid_current() AND s.user_id = NEW.released_by
            AND core.user_holds_key(s.user_id, 'fin.invoice.match_release')) THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: invoice % in MATCH_EXCEPTION is released by a Finance Manager''s e-signature, not by the person who entered it', NEW.doc_no
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.released_by IS NOT NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: only an invoice in MATCH_EXCEPTION is released' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.posting_date <> NEW.invoice_date THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: invoice % posts on its invoice date', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.currency <> 'PKR' AND NOT EXISTS (
       SELECT 1 FROM fin.exchange_rates r
        WHERE r.company_id = NEW.company_id AND r.currency = NEW.currency AND r.rate_date = NEW.exchange_rate_date AND r.rate = NEW.exchange_rate) THEN
    RAISE EXCEPTION 'RATE_MISSING: invoice % uses a % rate of % that is not in the rate table', NEW.doc_no, NEW.currency, NEW.exchange_rate_date
      USING ERRCODE = 'P0001';
  END IF;
  IF sums.pkr IS DISTINCT FROM NEW.total_pkr THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: invoice % lines carry % PKR, the total is %', NEW.doc_no, sums.pkr, NEW.total_pkr USING ERRCODE = 'P0001';
  END IF;
  IF NEW.invoice_type = 'GOODS' THEN
    SELECT gl.line_no INTO bad FROM purch.vendor_invoice_lines l JOIN purch.grn_lines gl ON gl.id = l.grn_line_id
     WHERE l.invoice_id = NEW.id
       AND (SELECT coalesce(sum(x.cleared_pkr), 0) FROM purch.vendor_invoice_lines x JOIN purch.vendor_invoices xi ON xi.id = x.invoice_id
             WHERE x.grn_line_id = l.grn_line_id AND (xi.status = 'POSTED' OR xi.id = NEW.id)) > purch.grn_line_receipt_value(l.grn_line_id)
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: invoice % would take more GRNI off GRN line % than its receipt booked', NEW.doc_no, bad.line_no
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT c.doc_no INTO bad FROM purch.vendor_invoice_lines l JOIN purch.landed_costs c ON c.id = l.landed_cost_id
     WHERE l.invoice_id = NEW.id
       AND (c.status <> 'POSTED' OR c.correction_of IS NOT NULL OR c.currency <> NEW.currency
            OR (c.vendor_id IS NOT NULL AND c.vendor_id <> NEW.vendor_id)
            OR l.amount > purch.landed_cost_open_foreign(c.id, NEW.id))
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'AMOUNT_EXCEEDS_OPEN: invoice % bills landed cost % beyond what is open (or it is not a POSTED charge of this vendor and currency)', NEW.doc_no, bad.doc_no
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin.journal_entries j
                  WHERE j.source_type = 'VENDOR_INVOICE' AND j.source_id = NEW.id AND j.event = 'VENDOR_INVOICE'
                    AND j.status = 'POSTED' AND j.reversal_of IS NULL AND j.entry_date = NEW.posting_date) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: invoice % has no posted journal', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- 6. payment guard: WHT base and rate, filer warning, reference, reversal
CREATE OR REPLACE FUNCTION purch.guard_vendor_payments() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v RECORD;
  bad RECORD;
  sums RECORD;
  tc RECORD;
  allowed TEXT[] := ARRAY['status', 'posting_date', 'posted_by', 'posted_at', 'carrying_pkr', 'exchange_diff_pkr', 'updated_at', 'updated_by'];
  expected_base NUMERIC;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a vendor payment starts as DRAFT' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('CANCELLED', 'REVERSED') THEN
    RAISE EXCEPTION 'RECORD_LOCKED: vendor payment % is % and never changes', OLD.doc_no, OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED' THEN
    -- Owner 2026-11-26 (bounced cheque, wrong payment): a posted payment changes only by its reversal.
    IF NEW.status <> 'REVERSED'
       OR (to_jsonb(NEW) - ARRAY['status', 'reversed_by', 'reversed_at', 'reversal_date', 'reversal_reason', 'updated_at', 'updated_by'])
          IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['status', 'reversed_by', 'reversed_at', 'reversal_date', 'reversal_reason', 'updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'RECORD_LOCKED: vendor payment % is POSTED; it changes only by its reversal', OLD.doc_no USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
         SELECT 1 FROM core.e_signatures s
          WHERE s.record_table = 'purch.vendor_payments' AND s.record_id = NEW.id::text AND s.meaning = 'REVERSED'
            AND s.tx_id = txid_current() AND s.user_id = NEW.reversed_by AND core.user_holds_key(s.user_id, 'fin.payment.reverse')) THEN
      RAISE EXCEPTION 'ESIGN_FAILED: reversing payment % needs the e-signature (REVERSED) of a holder of fin.payment.reverse', NEW.doc_no
        USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM fin.journal_entries j JOIN fin.journal_entries r ON r.id = j.reversal_id
                    WHERE j.source_type = 'VENDOR_PAYMENT' AND j.source_id = NEW.id AND j.event = 'VENDOR_PAYMENT'
                      AND j.reversal_of IS NULL AND j.status = 'REVERSED' AND r.status = 'POSTED' AND r.entry_date = NEW.reversal_date)
       OR EXISTS (SELECT 1 FROM fin.journal_entries j WHERE j.source_type = 'VENDOR_PAYMENT' AND j.source_id = NEW.id AND j.status = 'POSTED'
                    AND j.reversal_of IS NULL) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: payment % is reversed together with its journal', NEW.doc_no USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'REVERSED' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: only a POSTED payment is reversed' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.vendor_id <> OLD.vendor_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a payment keeps its vendor' USING ERRCODE = 'P0001';
  END IF;
  -- After DRAFT what is paid stays. The approver's acknowledgement of a filer warning is written while it waits for
  -- approval; the bank reference may still be given once approved (owner 2026-11-26).
  IF TG_OP = 'UPDATE' AND OLD.status = 'PENDING_APPROVAL' THEN
    allowed := allowed || ARRAY['filer_warning_ack_by', 'filer_warning_ack_at'];
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'APPROVED' AND OLD.reference IS NULL THEN
    allowed := allowed || ARRAY['reference'];
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'DRAFT' AND (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION 'RECORD_LOCKED: payment % is %; what it pays no longer changes (a rejection returns it to DRAFT)', OLD.doc_no, OLD.status
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.wht_base_pkr IS NULL AND (TG_OP = 'INSERT' OR OLD.status = 'DRAFT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: payment % has no WHT base (drafted before 0032: cancel it and draft it again)', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'DRAFT' AND NEW.filer_warning_ack_by IS NOT NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a draft payment has no approver''s acknowledgement' USING ERRCODE = 'P0001';
  END IF;
  SELECT company_id, wht_tax_code_id, is_filer, filer_checked_on INTO v FROM master.vendors WHERE id = NEW.vendor_id;
  IF v.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: the vendor belongs to another company' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IN ('DRAFT', 'CANCELLED') OR (TG_OP = 'UPDATE' AND NEW.status = OLD.status) THEN
    RETURN NEW;
  END IF;

  -- PENDING_APPROVAL, APPROVED, POSTED: the allocations add up and settle POSTED invoices of this vendor and currency,
  -- never beyond what is open (total − POSTED payments − POSTED debit notes).
  SELECT coalesce(sum(a.foreign_amount), 0) AS foreign, sum(a.carrying_pkr) AS carrying, count(*) AS n,
         sum(round(a.foreign_amount * i.goods_amount / i.total_amount, 2)) AS excl_tax
    INTO sums FROM purch.payment_allocations a JOIN purch.vendor_invoices i ON i.id = a.invoice_id WHERE a.payment_id = NEW.id;
  IF sums.n = 0 OR sums.foreign <> NEW.foreign_amount THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: payment % settles % in its allocations, not %', NEW.doc_no, sums.foreign, NEW.foreign_amount USING ERRCODE = 'P0001';
  END IF;
  SELECT i.doc_no INTO bad FROM purch.payment_allocations a JOIN purch.vendor_invoices i ON i.id = a.invoice_id
   WHERE a.payment_id = NEW.id
     AND (i.status <> 'POSTED' OR i.vendor_id <> NEW.vendor_id OR i.currency <> NEW.currency
          OR a.foreign_amount + purch.invoice_paid_foreign(i.id, NEW.id) + purch.invoice_debited_foreign(i.id, 0) > i.total_amount)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AMOUNT_EXCEEDS_OPEN: payment % settles invoice % beyond what is open (or it is not a POSTED invoice of this vendor and currency)', NEW.doc_no, bad.doc_no
      USING ERRCODE = 'P0001';
  END IF;
  -- WHT (owner 2026-11-26): the vendor's section; the filer rate only for a payee on the ATL, else the non-filer rate;
  -- on the gross PKR, or on the part of it that is not sales tax.
  IF NEW.wht_tax_code_id IS DISTINCT FROM v.wht_tax_code_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: payment % uses a WHT section that is not the vendor''s', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.wht_tax_code_id IS NOT NULL THEN
    SELECT rate, non_filer_rate, wht_base INTO tc FROM master.tax_codes WHERE id = NEW.wht_tax_code_id;
    IF NEW.wht_rate IS DISTINCT FROM (CASE WHEN NEW.payee_is_filer IS TRUE THEN tc.rate ELSE tc.non_filer_rate END) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: payment % uses a WHT rate of %, the section''s % rate is %', NEW.doc_no, NEW.wht_rate,
        CASE WHEN NEW.payee_is_filer IS TRUE THEN 'filer' ELSE 'non-filer' END,
        coalesce((CASE WHEN NEW.payee_is_filer IS TRUE THEN tc.rate ELSE tc.non_filer_rate END)::text, 'not given') USING ERRCODE = 'P0001';
    END IF;
    expected_base := CASE WHEN tc.wht_base = 'EXCL_SALES_TAX' THEN round(NEW.pkr_paid * sums.excl_tax / NEW.foreign_amount, 2) ELSE NEW.pkr_paid END;
    IF NEW.wht_base IS DISTINCT FROM tc.wht_base OR NEW.wht_base_pkr <> expected_base THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: payment % works WHT out on % (%), the section''s base gives %', NEW.doc_no, NEW.wht_base_pkr, NEW.wht_base, expected_base
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.wht_base_pkr <> NEW.pkr_paid THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: payment % has no WHT section; nothing is withheld', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status = 'PENDING_APPROVAL' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: a payment is submitted from DRAFT' USING ERRCODE = 'P0001';
    END IF;
    PERFORM purch.assert_vendor_active(NEW.vendor_id);
    -- The filer status as the vendor has it when the payment goes for approval.
    IF NEW.payee_is_filer IS DISTINCT FROM v.is_filer OR NEW.payee_filer_checked_on IS DISTINCT FROM v.filer_checked_on THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: payment % carries a filer status that is not the vendor''s', NEW.doc_no USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'APPROVED' THEN
    -- Rule 9 / §3: whoever creates (or submits) a payment cannot approve it.
    IF OLD.status <> 'PENDING_APPROVAL' OR NOT EXISTS (
         SELECT 1 FROM core.approvals a WHERE a.doc_table = 'purch.vendor_payments' AND a.doc_id = NEW.id::text AND a.status = 'APPROVED')
       OR EXISTS (
         SELECT 1 FROM core.approvals a JOIN core.approval_steps s ON s.approval_id = a.id
          WHERE a.doc_table = 'purch.vendor_payments' AND a.doc_id = NEW.id::text AND a.status = 'APPROVED'
            AND s.acted_by IN (NEW.created_by, NEW.submitted_by)) THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: payment % is approved through the approval matrix by someone other than its creator', NEW.doc_no
        USING ERRCODE = 'P0001';
    END IF;
    -- Owner 2026-11-26 (answer 4): a filer status checked too long ago (or never) is acknowledged by an approver.
    IF NEW.wht_tax_code_id IS NOT NULL
       AND (NEW.payee_filer_checked_on IS NULL
            OR (now() AT TIME ZONE 'Asia/Karachi')::date - NEW.payee_filer_checked_on > purch.vendor_filer_check_max_days(NEW.company_id))
       AND NOT EXISTS (
         SELECT 1 FROM core.approvals a JOIN core.approval_steps s ON s.approval_id = a.id
          WHERE a.doc_table = 'purch.vendor_payments' AND a.doc_id = NEW.id::text AND a.status = 'APPROVED'
            AND s.acted_by = NEW.filer_warning_ack_by) THEN
      RAISE EXCEPTION 'ACKNOWLEDGEMENT_REQUIRED: the filer status on payment % was checked too long ago; the approver acknowledges it', NEW.doc_no
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- → POSTED (from APPROVED)
  IF OLD.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: payment % is posted once approved', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  PERFORM purch.assert_vendor_active(NEW.vendor_id);
  PERFORM master.assert_tax_rate_confirmed(NEW.wht_tax_code_id);
  IF NEW.posting_date <> NEW.payment_date THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: payment % posts on its payment date', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  -- Owner 2026-11-26 (answer 5): the bank reference or cheque number.
  IF NEW.reference IS NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: payment % needs the bank reference or cheque number before it is posted', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF sums.carrying IS DISTINCT FROM NEW.carrying_pkr THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: payment % allocations carry % PKR, the payment %', NEW.doc_no, sums.carrying, NEW.carrying_pkr USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin.journal_entries j
                  WHERE j.source_type = 'VENDOR_PAYMENT' AND j.source_id = NEW.id AND j.event = 'VENDOR_PAYMENT'
                    AND j.status = 'POSTED' AND j.reversal_of IS NULL AND j.entry_date = NEW.posting_date) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: payment % has no posted journal', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- 7. GRN reversal, PO re-open
-- A GRN is not reversed once a line or one of its charges is on an invoice that is neither cancelled nor reversed.
CREATE OR REPLACE FUNCTION purch.guard_grn_invoiced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  i RECORD;
BEGIN
  SELECT vi.doc_no INTO i FROM purch.vendor_invoice_lines il JOIN purch.vendor_invoices vi ON vi.id = il.invoice_id
   WHERE vi.status NOT IN ('CANCELLED', 'REVERSED')
     AND (il.grn_line_id IN (SELECT id FROM purch.grn_lines WHERE grn_id = NEW.id)
          OR il.landed_cost_id IN (SELECT id FROM purch.landed_costs WHERE grn_id = NEW.id))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'IN_USE: GRN % is on vendor invoice %; it is no longer reversed', NEW.doc_no, i.doc_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- CLOSED → RECEIVED only when an invoice reversal leaves something received not invoiced.
CREATE FUNCTION purch.guard_po_reopen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'RECEIVED' OR NOT EXISTS (
       SELECT 1 FROM purch.po_lines pl
        WHERE pl.po_id = NEW.id
          AND pl.received_qty > coalesce((SELECT sum(il.qty) FROM purch.vendor_invoice_lines il
                                            JOIN purch.vendor_invoices i ON i.id = il.invoice_id
                                            JOIN purch.grn_lines gl ON gl.id = il.grn_line_id
                                            JOIN purch.grns g ON g.id = gl.grn_id
                                           WHERE gl.po_line_id = pl.id AND i.status = 'POSTED' AND g.status = 'POSTED'), 0)) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: purchase order % is closed; it re-opens to RECEIVED only when an invoice reversal leaves receipts not invoiced', NEW.doc_no
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_po_reopen BEFORE UPDATE OF status ON purch.purchase_orders
  FOR EACH ROW WHEN (OLD.status = 'CLOSED' AND NEW.status IS DISTINCT FROM 'CLOSED')
  EXECUTE FUNCTION purch.guard_po_reopen();
