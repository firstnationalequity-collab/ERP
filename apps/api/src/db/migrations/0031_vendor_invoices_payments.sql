-- 0031_vendor_invoices_payments: M3 task 5 (build-plan M3; architecture §6 "Vendor invoice posted", "Vendor payment",
-- §7.5; owner Q3, Q4, Q5 and "extra" 2026-11-25; owner answers 2026-11-26).
--   1. Landed-cost charge types get pkr_only (owner 2026-11-26): CD, ACD, RD, IMPORT_ST, IMPORT_IT are assessed by
--      customs in PKR; a charge of such a type is in PKR. GD amounts are in PKR (basis GD_AMOUNTS → PKR).
--   2. Account role EXCHANGE_DIFFERENCE (IAS 21, owner Q4): VENDOR_INVOICE uses it and LANDED_COST_CLEARING (Q3);
--      VENDOR_PAYMENT uses it.
--   3. Vendors: WHT section (a WITHHOLDING tax code), filer status (ATL) and the date it was checked. The WHT section
--      and the filer flag are sensitive (countersign after DRAFT, 0009).
--   4. purch.vendor_invoices / vendor_invoice_lines: GOODS (3-way match against GRN lines of one PO) or CHARGES
--      (settles landed-cost clearing, Q3). DRAFT → POSTED (within tolerance) or → MATCH_EXCEPTION (outside), which a
--      Finance Manager releases with an e-signature (creator ≠ releaser, Q5) and which then posts; DRAFT → CANCELLED.
--   5. purch.vendor_payments / payment_allocations: DRAFT → PENDING_APPROVAL → APPROVED (approval matrix, creator ≠
--      approver) → POSTED; WHT from the vendor's section (blocked while the rate is a placeholder, 0013).
--   6. PO → CLOSED once everything received is invoiced; a GRN with invoiced lines or invoiced charges is not
--      reversed; a landed-cost correction never takes a charge below what was invoiced.
-- The database re-checks what the service checks.

-- ---------------------------------------------------------------- 1. PKR-only charge types (owner 2026-11-26)
ALTER TABLE purch.landed_cost_types ADD COLUMN pkr_only BOOLEAN NOT NULL DEFAULT false;
UPDATE purch.landed_cost_types SET pkr_only = true WHERE code IN ('CD', 'ACD', 'RD', 'IMPORT_ST', 'IMPORT_IT');

-- A charge entered or posted on a PKR-only type is in PKR; a charge allocated by GD amounts is in PKR.
CREATE FUNCTION purch.guard_landed_cost_currency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t RECORD;
BEGIN
  -- A correction keeps its original's currency (0030), so only originals are checked.
  IF NOT (TG_OP = 'INSERT' OR OLD.status = 'DRAFT') OR NEW.status NOT IN ('DRAFT', 'POSTED') OR NEW.currency = 'PKR'
     OR NEW.correction_of IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT code, pkr_only INTO t FROM purch.landed_cost_types WHERE id = NEW.charge_type_id;
  IF t.pkr_only THEN
    RAISE EXCEPTION 'CURRENCY_NOT_ALLOWED: charge type % is assessed in PKR; % is not allowed', t.code, NEW.currency USING ERRCODE = 'P0001';
  END IF;
  IF NEW.basis = 'GD_AMOUNTS' THEN
    RAISE EXCEPTION 'CURRENCY_NOT_ALLOWED: GD amounts are in PKR; a charge allocated by GD amounts is in PKR' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_landed_cost_currency BEFORE INSERT OR UPDATE ON purch.landed_costs
  FOR EACH ROW EXECUTE FUNCTION purch.guard_landed_cost_currency();

-- ---------------------------------------------------------------- 2. exchange difference (owner Q4) and clearing (Q3)
-- = PostingEventRoles in packages/shared (tested equal).
CREATE OR REPLACE FUNCTION fin.is_valid_posting_role(p_event TEXT, p_role TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_role = ANY (CASE p_event
    WHEN 'GRN_RECEIPT'          THEN ARRAY['INVENTORY', 'GRNI']
    WHEN 'LANDED_COST'          THEN ARRAY['INVENTORY', 'PRICE_VARIANCE', 'LANDED_COST_CLEARING']
    WHEN 'IMPORT_TAX'           THEN ARRAY['INPUT_TAX', 'ADVANCE_TAX', 'LANDED_COST_CLEARING']
    WHEN 'VENDOR_INVOICE'       THEN ARRAY['GRNI', 'LANDED_COST_CLEARING', 'INPUT_TAX', 'PRICE_VARIANCE', 'EXCHANGE_DIFFERENCE', 'ACCOUNTS_PAYABLE']
    WHEN 'VENDOR_PAYMENT'       THEN ARRAY['ACCOUNTS_PAYABLE', 'BANK', 'WHT_PAYABLE', 'EXCHANGE_DIFFERENCE']
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
    WHEN 'LOT_RETURNED'         THEN ARRAY['ACCOUNTS_PAYABLE', 'INVENTORY']
    WHEN 'ROUNDING_DIFFERENCE'  THEN ARRAY['INVENTORY', 'ROUNDING_DIFFERENCE']
    ELSE ARRAY[]::TEXT[]
  END)
$$;

ALTER TABLE fin.posting_rules DROP CONSTRAINT posting_rules_account_role_check;
ALTER TABLE fin.posting_rules ADD CONSTRAINT posting_rules_account_role_check CHECK (account_role IN (
  'INVENTORY', 'GRNI', 'PRICE_VARIANCE', 'LANDED_COST_CLEARING', 'INPUT_TAX', 'ADVANCE_TAX', 'ACCOUNTS_PAYABLE', 'BANK',
  'WHT_PAYABLE', 'EXCHANGE_DIFFERENCE', 'WIP', 'LABOUR_ABSORBED', 'OVERHEAD_ABSORBED', 'COGS', 'ACCOUNTS_RECEIVABLE',
  'SALES_REVENUE', 'CONVERSION_REVENUE', 'OUTPUT_TAX', 'WHT_RECEIVABLE', 'INVENTORY_LOSS',
  'INVENTORY_GAIN', 'REJECTION_WRITE_OFF', 'ROUNDING_DIFFERENCE'));

-- ---------------------------------------------------------------- 3. vendors: WHT section, filer status (owner extra)
ALTER TABLE master.vendors
  ADD COLUMN wht_tax_code_id  BIGINT  REFERENCES master.tax_codes (id) ON DELETE RESTRICT,
  ADD COLUMN is_filer         BOOLEAN,  -- on the FBR Active Taxpayers List (ATL); NULL = not checked yet
  ADD COLUMN filer_checked_on DATE,
  ADD CONSTRAINT vendors_filer_checked CHECK ((is_filer IS NULL) = (filer_checked_on IS NULL));

CREATE FUNCTION master.guard_vendor_wht() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tc RECORD;
BEGIN
  IF NEW.wht_tax_code_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.wht_tax_code_id IS DISTINCT FROM OLD.wht_tax_code_id) THEN
    SELECT code, kind, is_active, company_id INTO tc FROM master.tax_codes WHERE id = NEW.wht_tax_code_id;
    IF tc.kind <> 'WITHHOLDING' OR NOT tc.is_active OR tc.company_id <> NEW.company_id THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a vendor''s WHT section is an active withholding tax code (% is not)', tc.code USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.filer_checked_on IS NOT NULL AND NEW.filer_checked_on > (now() AT TIME ZONE 'Asia/Karachi')::date THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: the filer status cannot be checked in the future' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_vendor_wht BEFORE INSERT OR UPDATE ON master.vendors
  FOR EACH ROW EXECUTE FUNCTION master.guard_vendor_wht();

-- 0009's countersign rule, with the vendor's WHT section and filer flag added (the checked-on date is not sensitive).
CREATE OR REPLACE FUNCTION master.require_party_countersign() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changed BOOLEAN;
  tbl TEXT := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
BEGIN
  IF OLD.status = 'DRAFT' THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'customers' THEN
    changed := (to_jsonb(NEW) -> 'ntn', to_jsonb(NEW) -> 'cnic', to_jsonb(NEW) -> 'strn',
                to_jsonb(NEW) -> 'credit_limit', to_jsonb(NEW) -> 'is_toll_customer')
               IS DISTINCT FROM
               (to_jsonb(OLD) -> 'ntn', to_jsonb(OLD) -> 'cnic', to_jsonb(OLD) -> 'strn',
                to_jsonb(OLD) -> 'credit_limit', to_jsonb(OLD) -> 'is_toll_customer');
  ELSE
    changed := (to_jsonb(NEW) -> 'ntn', to_jsonb(NEW) -> 'cnic', to_jsonb(NEW) -> 'strn',
                to_jsonb(NEW) -> 'is_foreign', to_jsonb(NEW) -> 'country', to_jsonb(NEW) -> 'currency',
                to_jsonb(NEW) -> 'bank_name', to_jsonb(NEW) -> 'bank_account',
                to_jsonb(NEW) -> 'wht_tax_code_id', to_jsonb(NEW) -> 'is_filer')
               IS DISTINCT FROM
               (to_jsonb(OLD) -> 'ntn', to_jsonb(OLD) -> 'cnic', to_jsonb(OLD) -> 'strn',
                to_jsonb(OLD) -> 'is_foreign', to_jsonb(OLD) -> 'country', to_jsonb(OLD) -> 'currency',
                to_jsonb(OLD) -> 'bank_name', to_jsonb(OLD) -> 'bank_account',
                to_jsonb(OLD) -> 'wht_tax_code_id', to_jsonb(OLD) -> 'is_filer');
  END IF;
  IF changed AND NOT EXISTS (
    SELECT 1 FROM core.e_signatures s
     WHERE s.record_table = tbl AND s.record_id = NEW.id::text
       AND s.meaning = 'APPROVED' AND s.tx_id = txid_current()
       AND s.user_id <> NEW.updated_by
  ) THEN
    RAISE EXCEPTION 'COUNTERSIGN_REQUIRED: changing tax, credit, toll, bank or WHT details of an active % needs a countersign by another person',
      CASE WHEN TG_TABLE_NAME = 'customers' THEN 'customer' ELSE 'vendor' END
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------- 4. vendor invoices
-- Match tolerances (architecture §7.5: a setting). Mirrors of purch.invoice.price_tolerance_pct / qty_tolerance_pct.
CREATE FUNCTION purch.invoice_price_tolerance_pct(p_company BIGINT) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT (s.value #>> '{}')::numeric FROM core.settings s
                    WHERE s.company_id = p_company AND s.key = 'purch.invoice.price_tolerance_pct'), 2);
$$;
CREATE FUNCTION purch.invoice_qty_tolerance_pct(p_company BIGINT) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT (s.value #>> '{}')::numeric FROM core.settings s
                    WHERE s.company_id = p_company AND s.key = 'purch.invoice.qty_tolerance_pct'), 0);
$$;

CREATE TABLE purch.vendor_invoices (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id          BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  doc_no              TEXT          NOT NULL,
  invoice_type        TEXT          NOT NULL CHECK (invoice_type IN ('GOODS', 'CHARGES')),
  vendor_id           BIGINT        NOT NULL REFERENCES master.vendors (id) ON DELETE RESTRICT,
  po_id               BIGINT        REFERENCES purch.purchase_orders (id) ON DELETE RESTRICT,  -- GOODS only
  vendor_invoice_no   TEXT          NOT NULL CHECK (length(trim(vendor_invoice_no)) BETWEEN 1 AND 60),  -- the vendor's own number
  invoice_date        DATE          NOT NULL,
  due_date            DATE          NOT NULL,  -- invoice date + the vendor's payment terms (ageing)
  currency            TEXT          NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- PKR per 1 unit: Finance's rate on the invoice date (latest on or before, max age), refreshed at posting (owner Q4).
  exchange_rate       NUMERIC(18,6) NOT NULL CHECK (exchange_rate > 0),
  exchange_rate_date  DATE          NOT NULL,
  goods_amount        NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (goods_amount >= 0),  -- invoice currency, before tax
  tax_amount          NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),    -- invoice currency
  total_amount        NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),  -- invoice currency
  total_pkr           NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (total_pkr >= 0),     -- = round(total × rate, 2): the AP credit
  notes               TEXT          CHECK (notes IS NULL OR length(notes) <= 1000),
  status              TEXT          NOT NULL CHECK (status IN ('DRAFT', 'MATCH_EXCEPTION', 'POSTED', 'CANCELLED')),
  exception_at        TIMESTAMPTZ,
  released_by         BIGINT        REFERENCES core.users (id) ON DELETE RESTRICT,
  released_at         TIMESTAMPTZ,
  release_reason      TEXT          CHECK (release_reason IS NULL OR length(trim(release_reason)) BETWEEN 3 AND 500),
  posting_date        DATE,
  posted_by           BIGINT        REFERENCES core.users (id) ON DELETE RESTRICT,
  posted_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by          BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by          BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, doc_no),
  CHECK ((invoice_type = 'GOODS') = (po_id IS NOT NULL)),
  CHECK (due_date >= invoice_date),
  CHECK (total_amount = goods_amount + tax_amount),
  CHECK (total_pkr = round(total_amount * exchange_rate, 2)),
  CHECK (currency <> 'PKR' OR (exchange_rate = 1 AND exchange_rate_date = invoice_date)),
  CHECK (exchange_rate_date <= invoice_date),
  CHECK (status <> 'POSTED' OR (posting_date IS NOT NULL AND posted_by IS NOT NULL AND posted_at IS NOT NULL)),
  CHECK (status = 'POSTED' OR (posting_date IS NULL AND posted_by IS NULL AND posted_at IS NULL)),
  CHECK ((released_by IS NULL) = (released_at IS NULL) AND (released_by IS NULL) = (release_reason IS NULL)),
  CHECK (released_by IS NULL OR status = 'POSTED')
);
-- One vendor bill is entered once (cancelled entries do not count).
CREATE UNIQUE INDEX vendor_invoices_vendor_no_uq ON purch.vendor_invoices (company_id, vendor_id, upper(trim(vendor_invoice_no)))
  WHERE status <> 'CANCELLED';
CREATE INDEX vendor_invoices_vendor_idx ON purch.vendor_invoices (vendor_id, status);
CREATE INDEX vendor_invoices_po_idx ON purch.vendor_invoices (po_id) WHERE po_id IS NOT NULL;
SELECT core.enable_audit('purch.vendor_invoices');
SELECT core.enable_touch('purch.vendor_invoices');
SELECT core.forbid_delete('purch.vendor_invoices');
SELECT core.require_transition('purch.vendor_invoices');

CREATE TABLE purch.vendor_invoice_lines (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id          BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  invoice_id          BIGINT        NOT NULL REFERENCES purch.vendor_invoices (id) ON DELETE RESTRICT,
  line_no             INTEGER       NOT NULL CHECK (line_no BETWEEN 1 AND 999),
  grn_line_id         BIGINT        REFERENCES purch.grn_lines (id) ON DELETE RESTRICT,       -- GOODS
  landed_cost_id      BIGINT        REFERENCES purch.landed_costs (id) ON DELETE RESTRICT,    -- CHARGES (an original charge)
  qty                 NUMERIC(18,4) CHECK (qty > 0),                  -- GOODS, base UoM
  unit_price          NUMERIC(18,6) CHECK (unit_price >= 0),          -- GOODS, invoice currency
  amount              NUMERIC(18,2) NOT NULL CHECK (amount >= 0),     -- invoice currency, before tax
  tax_code_id         BIGINT        REFERENCES master.tax_codes (id) ON DELETE RESTRICT,     -- sales tax charged on the bill
  tax_rate            NUMERIC(9,4)  NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 100),
  tax_amount          NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  -- Match result (GOODS), written when the invoice is posted or goes to MATCH_EXCEPTION.
  po_unit_price       NUMERIC(18,6),
  price_diff_pct      NUMERIC(9,4),
  qty_over            NUMERIC(18,4),   -- invoiced beyond the received quantity (cumulative), ≥ 0
  in_tolerance        BOOLEAN,
  -- Posting result, PKR: amount_pkr = cleared_pkr + price_variance_pkr + exchange_diff_pkr.
  amount_pkr          NUMERIC(18,2),
  tax_pkr             NUMERIC(18,2),
  cleared_pkr         NUMERIC(18,2),   -- GRNI (GOODS) or landed-cost clearing (CHARGES) taken off
  matched_qty         NUMERIC(18,4),   -- GOODS: the part of qty that clears GRNI (≤ received, not yet invoiced)
  price_variance_pkr  NUMERIC(18,2),
  exchange_diff_pkr   NUMERIC(18,2),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by          BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by          BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (invoice_id, line_no),
  UNIQUE (invoice_id, grn_line_id),
  UNIQUE (invoice_id, landed_cost_id),
  CHECK ((grn_line_id IS NULL) <> (landed_cost_id IS NULL)),
  CHECK ((grn_line_id IS NOT NULL) = (qty IS NOT NULL AND unit_price IS NOT NULL)),
  CHECK (grn_line_id IS NULL OR amount = round(qty * unit_price, 2)),
  CHECK (tax_amount = round(amount * tax_rate / 100, 2)),
  CHECK (tax_code_id IS NOT NULL OR tax_rate = 0),
  CHECK (amount_pkr IS NULL OR (tax_pkr IS NOT NULL AND cleared_pkr IS NOT NULL AND price_variance_pkr IS NOT NULL
         AND exchange_diff_pkr IS NOT NULL AND amount_pkr = cleared_pkr + price_variance_pkr + exchange_diff_pkr)),
  CHECK (landed_cost_id IS NULL OR price_variance_pkr IS NULL OR price_variance_pkr = 0)
);
CREATE INDEX vendor_invoice_lines_invoice_idx ON purch.vendor_invoice_lines (invoice_id);
CREATE INDEX vendor_invoice_lines_grn_line_idx ON purch.vendor_invoice_lines (grn_line_id) WHERE grn_line_id IS NOT NULL;
CREATE INDEX vendor_invoice_lines_charge_idx ON purch.vendor_invoice_lines (landed_cost_id) WHERE landed_cost_id IS NOT NULL;
SELECT core.enable_audit('purch.vendor_invoice_lines');
SELECT core.enable_touch('purch.vendor_invoice_lines');

-- GRNI booked for a GRN line: the value of its lot's receipt (the GRN_RECEIPT journal credits exactly this).
CREATE FUNCTION purch.grn_line_receipt_value(p_line BIGINT) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(m.value), 0) FROM purch.grn_lines l
    JOIN inv.stock_movements m ON m.lot_id = l.lot_id AND m.ref_doc_type = 'GRN' AND m.ref_doc_id = l.grn_id
                              AND m.movement_type = 'RECEIPT'
   WHERE l.id = p_line;
$$;

-- What is still open on a landed cost to invoice, in its currency: the original + posted corrections − invoiced
-- on POSTED invoices (other than p_except).
CREATE FUNCTION purch.landed_cost_open_foreign(p_charge BIGINT, p_except BIGINT) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT c.foreign_amount
         + coalesce((SELECT sum(x.foreign_amount) FROM purch.landed_costs x WHERE x.correction_of = c.id AND x.status = 'POSTED'), 0)
         - coalesce((SELECT sum(il.amount) FROM purch.vendor_invoice_lines il JOIN purch.vendor_invoices i ON i.id = il.invoice_id
                      WHERE il.landed_cost_id = c.id AND i.status = 'POSTED' AND i.id <> p_except), 0)
    FROM purch.landed_costs c WHERE c.id = p_charge;
$$;

-- Lines change only while the invoice is DRAFT; at posting / exception only the match and posting results are written.
CREATE FUNCTION purch.guard_vendor_invoice_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  inv RECORD;
BEGIN
  SELECT doc_no, status, invoice_type, company_id INTO inv FROM purch.vendor_invoices
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  IF TG_OP = 'UPDATE' AND NEW.invoice_id <> OLD.invoice_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: an invoice line never moves to another invoice' USING ERRCODE = 'P0001';
  END IF;
  IF inv.status = 'DRAFT' THEN
    IF TG_OP <> 'DELETE' AND ((inv.invoice_type = 'GOODS') <> (NEW.grn_line_id IS NOT NULL) OR inv.company_id <> NEW.company_id) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a GOODS invoice names GRN lines, a CHARGES invoice landed costs' USING ERRCODE = 'P0001';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND inv.status = 'MATCH_EXCEPTION'
     AND (to_jsonb(NEW) - ARRAY['po_unit_price', 'price_diff_pct', 'qty_over', 'in_tolerance', 'amount_pkr', 'tax_pkr', 'cleared_pkr',
                                'matched_qty', 'price_variance_pkr', 'exchange_diff_pkr', 'updated_at', 'updated_by'])
         IS NOT DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['po_unit_price', 'price_diff_pct', 'qty_over', 'in_tolerance', 'amount_pkr', 'tax_pkr', 'cleared_pkr',
                                'matched_qty', 'price_variance_pkr', 'exchange_diff_pkr', 'updated_at', 'updated_by']) THEN
    RETURN NEW;  -- the release recomputes the results; what was billed stays
  END IF;
  RAISE EXCEPTION 'RECORD_LOCKED: invoice % is %; its lines no longer change', inv.doc_no, inv.status USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER guard_vendor_invoice_lines BEFORE INSERT OR UPDATE OR DELETE ON purch.vendor_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION purch.guard_vendor_invoice_lines();

-- Is a GOODS line inside the match tolerances (price vs the PO line; cumulative quantity vs the GRN line)?
CREATE FUNCTION purch.invoice_line_in_tolerance(p_line BIGINT) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
  l RECORD;
  billed NUMERIC;
BEGIN
  SELECT il.invoice_id, il.qty, il.unit_price, gl.qty AS grn_qty, pl.unit_price AS po_price, i.company_id
    INTO l
    FROM purch.vendor_invoice_lines il
    JOIN purch.vendor_invoices i ON i.id = il.invoice_id
    JOIN purch.grn_lines gl ON gl.id = il.grn_line_id
    JOIN purch.po_lines pl ON pl.id = gl.po_line_id
   WHERE il.id = p_line;
  IF NOT FOUND THEN
    RETURN true;  -- a CHARGES line has no 3-way match
  END IF;
  IF l.po_price = 0 THEN
    IF l.unit_price <> 0 THEN RETURN false; END IF;
  ELSIF abs(l.unit_price - l.po_price) * 100 / l.po_price > purch.invoice_price_tolerance_pct(l.company_id) THEN
    RETURN false;
  END IF;
  SELECT coalesce(sum(x.qty), 0) INTO billed FROM purch.vendor_invoice_lines x JOIN purch.vendor_invoices xi ON xi.id = x.invoice_id
   WHERE x.grn_line_id = (SELECT grn_line_id FROM purch.vendor_invoice_lines WHERE id = p_line)
     AND xi.status = 'POSTED' AND xi.id <> l.invoice_id;
  RETURN billed + l.qty <= l.grn_qty * (1 + purch.invoice_qty_tolerance_pct(l.company_id) / 100);
END;
$$;

CREATE FUNCTION purch.guard_vendor_invoices() RETURNS trigger
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
  IF TG_OP = 'UPDATE' AND OLD.status IN ('POSTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'RECORD_LOCKED: vendor invoice % is % and never changes', OLD.doc_no, OLD.status USING ERRCODE = 'P0001';
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
    -- The service's match result is the database's: every line re-checked against the tolerances.
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
    -- Owner Q5: a Finance Manager releases with an e-signature and a reason; creator ≠ releaser.
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
    -- GRNI taken off a GRN line never exceeds what its receipt booked.
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
CREATE TRIGGER guard_vendor_invoices BEFORE INSERT OR UPDATE ON purch.vendor_invoices
  FOR EACH ROW EXECUTE FUNCTION purch.guard_vendor_invoices();

-- ---------------------------------------------------------------- 5. vendor payments
CREATE TABLE purch.vendor_payments (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id             BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  doc_no                 TEXT          NOT NULL,
  vendor_id              BIGINT        NOT NULL REFERENCES master.vendors (id) ON DELETE RESTRICT,
  payment_date           DATE          NOT NULL,
  currency               TEXT          NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),   -- of the invoices settled
  foreign_amount         NUMERIC(18,2) NOT NULL CHECK (foreign_amount > 0),        -- settled, = the allocations
  pkr_paid               NUMERIC(18,2) NOT NULL CHECK (pkr_paid > 0),              -- gross PKR (bank + WHT)
  wht_tax_code_id        BIGINT        REFERENCES master.tax_codes (id) ON DELETE RESTRICT,  -- the vendor's WHT section
  wht_rate               NUMERIC(9,4)  NOT NULL DEFAULT 0 CHECK (wht_rate BETWEEN 0 AND 100),
  wht_amount             NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (wht_amount >= 0),
  net_paid               NUMERIC(18,2) NOT NULL CHECK (net_paid > 0),              -- out of the bank
  payee_is_filer         BOOLEAN,       -- the vendor's filer status (ATL) and when it was checked, copied at submit
  payee_filer_checked_on DATE,
  carrying_pkr           NUMERIC(18,2),  -- AP taken off at posting (the settled invoices' PKR)
  exchange_diff_pkr      NUMERIC(18,2),  -- pkr_paid − carrying_pkr (owner Q4)
  reference              TEXT          CHECK (reference IS NULL OR length(trim(reference)) BETWEEN 1 AND 60),  -- cheque / transfer no.
  notes                  TEXT          CHECK (notes IS NULL OR length(notes) <= 1000),
  status                 TEXT          NOT NULL CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'CANCELLED')),
  submitted_by           BIGINT        REFERENCES core.users (id) ON DELETE RESTRICT,
  submitted_at           TIMESTAMPTZ,
  posting_date           DATE,
  posted_by              BIGINT        REFERENCES core.users (id) ON DELETE RESTRICT,
  posted_at              TIMESTAMPTZ,
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by             BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by             BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, doc_no),
  CHECK (currency <> 'PKR' OR pkr_paid = foreign_amount),
  CHECK (net_paid = pkr_paid - wht_amount),
  CHECK (wht_amount = round(pkr_paid * wht_rate / 100, 2)),
  CHECK (wht_tax_code_id IS NOT NULL OR wht_rate = 0),
  CHECK ((carrying_pkr IS NULL) = (exchange_diff_pkr IS NULL)),
  CHECK (carrying_pkr IS NULL OR exchange_diff_pkr = pkr_paid - carrying_pkr),
  CHECK (status <> 'POSTED' OR (carrying_pkr IS NOT NULL AND posting_date IS NOT NULL AND posted_by IS NOT NULL AND posted_at IS NOT NULL)),
  CHECK (status = 'POSTED' OR (posting_date IS NULL AND posted_by IS NULL AND posted_at IS NULL AND carrying_pkr IS NULL)),
  CHECK (status IN ('DRAFT', 'CANCELLED') OR (submitted_by IS NOT NULL AND submitted_at IS NOT NULL))
);
CREATE INDEX vendor_payments_vendor_idx ON purch.vendor_payments (vendor_id, status);
SELECT core.enable_audit('purch.vendor_payments');
SELECT core.enable_touch('purch.vendor_payments');
SELECT core.forbid_delete('purch.vendor_payments');
SELECT core.require_transition('purch.vendor_payments');

CREATE TABLE purch.payment_allocations (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  payment_id      BIGINT        NOT NULL REFERENCES purch.vendor_payments (id) ON DELETE RESTRICT,
  invoice_id      BIGINT        NOT NULL REFERENCES purch.vendor_invoices (id) ON DELETE RESTRICT,
  foreign_amount  NUMERIC(18,2) NOT NULL CHECK (foreign_amount > 0),  -- invoice currency settled
  carrying_pkr    NUMERIC(18,2) CHECK (carrying_pkr >= 0),             -- AP PKR taken off, at posting
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by      BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by      BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (payment_id, invoice_id)
);
CREATE INDEX payment_allocations_invoice_idx ON purch.payment_allocations (invoice_id);
SELECT core.enable_audit('purch.payment_allocations');
SELECT core.enable_touch('purch.payment_allocations');

-- Allocations change only while the payment is DRAFT; at posting (payment APPROVED) only carrying_pkr is written.
CREATE FUNCTION purch.guard_payment_allocations() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p RECORD;
BEGIN
  SELECT doc_no, status INTO p FROM purch.vendor_payments
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.payment_id ELSE NEW.payment_id END;
  IF TG_OP = 'UPDATE' AND (NEW.payment_id <> OLD.payment_id OR NEW.invoice_id <> OLD.invoice_id) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: an allocation never moves' USING ERRCODE = 'P0001';
  END IF;
  IF p.status = 'DRAFT' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND p.status = 'APPROVED' AND NEW.foreign_amount = OLD.foreign_amount AND OLD.carrying_pkr IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'RECORD_LOCKED: payment % is %; its allocations no longer change', p.doc_no, p.status USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER guard_payment_allocations BEFORE INSERT OR UPDATE OR DELETE ON purch.payment_allocations
  FOR EACH ROW EXECUTE FUNCTION purch.guard_payment_allocations();

CREATE FUNCTION purch.guard_vendor_payments() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v RECORD;
  bad RECORD;
  sums RECORD;
  tc RECORD;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a vendor payment starts as DRAFT' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('POSTED', 'CANCELLED') THEN
    RAISE EXCEPTION 'RECORD_LOCKED: vendor payment % is % and never changes', OLD.doc_no, OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.vendor_id <> OLD.vendor_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a payment keeps its vendor' USING ERRCODE = 'P0001';
  END IF;
  -- After DRAFT what is paid stays; the status, the posting stamps and the posting result change.
  IF TG_OP = 'UPDATE' AND OLD.status <> 'DRAFT'
     AND (to_jsonb(NEW) - ARRAY['status', 'posting_date', 'posted_by', 'posted_at', 'carrying_pkr', 'exchange_diff_pkr', 'updated_at', 'updated_by'])
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['status', 'posting_date', 'posted_by', 'posted_at', 'carrying_pkr', 'exchange_diff_pkr', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'RECORD_LOCKED: payment % is %; what it pays no longer changes (a rejection returns it to DRAFT)', OLD.doc_no, OLD.status
      USING ERRCODE = 'P0001';
  END IF;
  SELECT company_id, wht_tax_code_id INTO v FROM master.vendors WHERE id = NEW.vendor_id;
  IF v.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: the vendor belongs to another company' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IN ('DRAFT', 'CANCELLED') OR (TG_OP = 'UPDATE' AND NEW.status = OLD.status) THEN
    RETURN NEW;
  END IF;

  -- PENDING_APPROVAL, APPROVED, POSTED: the allocations add up and settle POSTED invoices of this vendor and currency.
  SELECT coalesce(sum(a.foreign_amount), 0) AS foreign, sum(a.carrying_pkr) AS carrying, count(*) AS n
    INTO sums FROM purch.payment_allocations a WHERE a.payment_id = NEW.id;
  IF sums.n = 0 OR sums.foreign <> NEW.foreign_amount THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: payment % settles % in its allocations, not %', NEW.doc_no, sums.foreign, NEW.foreign_amount USING ERRCODE = 'P0001';
  END IF;
  SELECT i.doc_no INTO bad FROM purch.payment_allocations a JOIN purch.vendor_invoices i ON i.id = a.invoice_id
   WHERE a.payment_id = NEW.id
     AND (i.status <> 'POSTED' OR i.vendor_id <> NEW.vendor_id OR i.currency <> NEW.currency
          OR (SELECT coalesce(sum(x.foreign_amount), 0) FROM purch.payment_allocations x JOIN purch.vendor_payments xp ON xp.id = x.payment_id
               WHERE x.invoice_id = i.id AND (xp.status = 'POSTED' OR xp.id = NEW.id)) > i.total_amount)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AMOUNT_EXCEEDS_OPEN: payment % settles invoice % beyond what is open (or it is not a POSTED invoice of this vendor and currency)', NEW.doc_no, bad.doc_no
      USING ERRCODE = 'P0001';
  END IF;
  -- The WHT section is the vendor's, at its rate.
  IF NEW.wht_tax_code_id IS DISTINCT FROM v.wht_tax_code_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: payment % uses a WHT section that is not the vendor''s', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.wht_tax_code_id IS NOT NULL THEN
    SELECT rate INTO tc FROM master.tax_codes WHERE id = NEW.wht_tax_code_id;
    IF tc.rate <> NEW.wht_rate THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: payment % uses a WHT rate of %, the section''s is %', NEW.doc_no, NEW.wht_rate, tc.rate USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.status = 'PENDING_APPROVAL' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: a payment is submitted from DRAFT' USING ERRCODE = 'P0001';
    END IF;
    PERFORM purch.assert_vendor_active(NEW.vendor_id);
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
CREATE TRIGGER guard_vendor_payments BEFORE INSERT OR UPDATE ON purch.vendor_payments
  FOR EACH ROW EXECUTE FUNCTION purch.guard_vendor_payments();

-- ---------------------------------------------------------------- 6. PO close, GRN reversal, corrections
-- CLOSED: the PO was fully received and everything received is invoiced on POSTED invoices.
CREATE FUNCTION purch.guard_po_close() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'RECEIVED' OR EXISTS (
       SELECT 1 FROM purch.po_lines pl
        WHERE pl.po_id = NEW.id
          AND pl.received_qty > coalesce((SELECT sum(il.qty) FROM purch.vendor_invoice_lines il
                                            JOIN purch.vendor_invoices i ON i.id = il.invoice_id
                                            JOIN purch.grn_lines gl ON gl.id = il.grn_line_id
                                            JOIN purch.grns g ON g.id = gl.grn_id
                                           WHERE gl.po_line_id = pl.id AND i.status = 'POSTED' AND g.status = 'POSTED'), 0)) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: purchase order % closes once fully received and fully invoiced', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_po_close BEFORE UPDATE OF status ON purch.purchase_orders
  FOR EACH ROW WHEN (NEW.status = 'CLOSED' AND OLD.status IS DISTINCT FROM 'CLOSED')
  EXECUTE FUNCTION purch.guard_po_close();

-- A GRN is not reversed once a line or one of its charges is on an invoice that is not cancelled.
CREATE FUNCTION purch.guard_grn_invoiced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  i RECORD;
BEGIN
  SELECT vi.doc_no INTO i FROM purch.vendor_invoice_lines il JOIN purch.vendor_invoices vi ON vi.id = il.invoice_id
   WHERE vi.status <> 'CANCELLED'
     AND (il.grn_line_id IN (SELECT id FROM purch.grn_lines WHERE grn_id = NEW.id)
          OR il.landed_cost_id IN (SELECT id FROM purch.landed_costs WHERE grn_id = NEW.id))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'IN_USE: GRN % is on vendor invoice %; it is no longer reversed', NEW.doc_no, i.doc_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_grn_invoiced BEFORE UPDATE OF status ON purch.grns
  FOR EACH ROW WHEN (NEW.status = 'REVERSED' AND OLD.status = 'POSTED')
  EXECUTE FUNCTION purch.guard_grn_invoiced();

-- A correction never takes a charge below what was already invoiced (CORRECTION_EXCEEDS_CHARGE, 4b + task 5).
CREATE FUNCTION purch.guard_correction_invoiced() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF purch.landed_cost_open_foreign(NEW.correction_of, 0) < 0 THEN
    RAISE EXCEPTION 'CORRECTION_EXCEEDS_CHARGE: correction % would take the charge below what was already invoiced', NEW.doc_no
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER guard_correction_invoiced AFTER UPDATE OF status ON purch.landed_costs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.correction_of IS NOT NULL AND NEW.status = 'POSTED')
  EXECUTE FUNCTION purch.guard_correction_invoiced();
