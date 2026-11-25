-- 0029_landed_cost: M3 task 4 (owner Q21 2026-11-19, Q2/Q3 2026-11-25; architecture §6 "Landed cost"; build-plan M3).
--   1. GL: event IMPORT_TAX (import-stage sales tax → INPUT_TAX, income tax at import → ADVANCE_TAX, against
--      LANDED_COST_CLEARING); account role ADVANCE_TAX. VALUE_ADJUSTMENT reason LANDED_COST (GRN lots only).
--   2. purch.landed_cost_types: charge types with a capitalise flag. Capitalised types go into the lot cost;
--      the others name the tax role their amount is debited to. Duties may be allocated by GD amounts per PO line.
--   3. purch.landed_costs (DRAFT → POSTED, DRAFT → CANCELLED) on one GRN, with their allocation inputs
--      (purch.landed_cost_inputs, per PO line: GD amount or weight) and posting result
--      (purch.landed_cost_allocations, per GRN line: amount, share still held → lot, share consumed → price variance).
--      A charge entered while the GRN is DRAFT (with_grn) is posted by the GRN posting; one entered after is a
--      later bill, posted on its own date.
--   4. GRN: no POSTED charge on a reversed GRN; no DRAFT charge left on a GRN that is no longer DRAFT.
-- The database re-checks what the service checks.

-- ---------------------------------------------------------------- 1. GL events, roles, value adjustment reason

-- = PostingEventRoles in packages/shared (tested equal): 0017 plus IMPORT_TAX.
CREATE OR REPLACE FUNCTION fin.is_valid_posting_role(p_event TEXT, p_role TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_role = ANY (CASE p_event
    WHEN 'GRN_RECEIPT'          THEN ARRAY['INVENTORY', 'GRNI']
    WHEN 'LANDED_COST'          THEN ARRAY['INVENTORY', 'PRICE_VARIANCE', 'LANDED_COST_CLEARING']
    WHEN 'IMPORT_TAX'           THEN ARRAY['INPUT_TAX', 'ADVANCE_TAX', 'LANDED_COST_CLEARING']
    WHEN 'VENDOR_INVOICE'       THEN ARRAY['GRNI', 'INPUT_TAX', 'PRICE_VARIANCE', 'ACCOUNTS_PAYABLE']
    WHEN 'VENDOR_PAYMENT'       THEN ARRAY['ACCOUNTS_PAYABLE', 'BANK', 'WHT_PAYABLE']
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

ALTER TABLE fin.posting_rules DROP CONSTRAINT posting_rules_event_check;
ALTER TABLE fin.posting_rules ADD CONSTRAINT posting_rules_event_check CHECK (event IN (
  'GRN_RECEIPT', 'LANDED_COST', 'IMPORT_TAX', 'VENDOR_INVOICE', 'VENDOR_PAYMENT', 'MATERIAL_ISSUE', 'MATERIAL_RETURN',
  'CONVERSION_ABSORB', 'FG_OUTPUT', 'FG_COST_ADJUSTMENT', 'DISPATCH', 'SALES_RETURN_RECEIPT', 'SALES_INVOICE',
  'TOLL_INVOICE', 'CUSTOMER_RECEIPT', 'STOCK_ADJUSTMENT', 'LOT_DESTROYED', 'LOT_RETURNED', 'ROUNDING_DIFFERENCE'));
ALTER TABLE fin.journal_entries DROP CONSTRAINT journal_entries_event_check;
ALTER TABLE fin.journal_entries ADD CONSTRAINT journal_entries_event_check CHECK (event IN (
  'GRN_RECEIPT', 'LANDED_COST', 'IMPORT_TAX', 'VENDOR_INVOICE', 'VENDOR_PAYMENT', 'MATERIAL_ISSUE', 'MATERIAL_RETURN',
  'CONVERSION_ABSORB', 'FG_OUTPUT', 'FG_COST_ADJUSTMENT', 'DISPATCH', 'SALES_RETURN_RECEIPT', 'SALES_INVOICE',
  'TOLL_INVOICE', 'CUSTOMER_RECEIPT', 'STOCK_ADJUSTMENT', 'LOT_DESTROYED', 'LOT_RETURNED', 'ROUNDING_DIFFERENCE'));
ALTER TABLE fin.posting_rules DROP CONSTRAINT posting_rules_account_role_check;
ALTER TABLE fin.posting_rules ADD CONSTRAINT posting_rules_account_role_check CHECK (account_role IN (
  'INVENTORY', 'GRNI', 'PRICE_VARIANCE', 'LANDED_COST_CLEARING', 'INPUT_TAX', 'ADVANCE_TAX', 'ACCOUNTS_PAYABLE', 'BANK',
  'WHT_PAYABLE', 'WIP', 'LABOUR_ABSORBED', 'OVERHEAD_ABSORBED', 'COGS', 'ACCOUNTS_RECEIVABLE',
  'SALES_REVENUE', 'CONVERSION_REVENUE', 'OUTPUT_TAX', 'WHT_RECEIVABLE', 'INVENTORY_LOSS',
  'INVENTORY_GAIN', 'REJECTION_WRITE_OFF', 'ROUNDING_DIFFERENCE'));

ALTER TABLE inv.stock_movements DROP CONSTRAINT movement_value_adjustment_reason;
ALTER TABLE inv.stock_movements ADD CONSTRAINT movement_value_adjustment_reason CHECK (
  movement_type <> 'VALUE_ADJUSTMENT' OR (reason_code IS NOT NULL AND reason_code IN ('BATCH_CLOSE', 'LANDED_COST')));

-- A LANDED_COST adjustment raises a GRN lot's value, for a landed-cost document (0017's guard checks the rest).
CREATE FUNCTION inv.guard_value_adjustment_landed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot RECORD;
BEGIN
  SELECT lot_no, source INTO lot FROM inv.lots WHERE id = NEW.lot_id;
  IF lot.source <> 'GRN' OR NEW.ref_doc_type <> 'LANDED_COST' OR NEW.value <= 0 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a landed-cost adjustment raises a GRN lot''s value for a landed-cost document (lot %)', lot.lot_no
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
-- Name sorts after guard_value_adjustment (trigger order is by name).
CREATE TRIGGER guard_value_adjustment_landed BEFORE INSERT ON inv.stock_movements
  FOR EACH ROW WHEN (NEW.movement_type = 'VALUE_ADJUSTMENT' AND NEW.reason_code = 'LANDED_COST')
  EXECUTE FUNCTION inv.guard_value_adjustment_landed();

-- ---------------------------------------------------------------- 2. charge types (owner Q21)
CREATE TABLE purch.landed_cost_types (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id     BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  code           TEXT        NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name           TEXT        NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  -- true: part of the lot cost (duties, freight, insurance, clearing). false: a recoverable tax, debited to tax_role.
  capitalise     BOOLEAN     NOT NULL,
  tax_role       TEXT        CHECK (tax_role IN ('INPUT_TAX', 'ADVANCE_TAX')),
  -- A duty may be allocated by the GD amounts per PO line; other charges by value or weight.
  is_duty        BOOLEAN     NOT NULL DEFAULT false,
  default_basis  TEXT        CHECK (default_basis IN ('VALUE', 'WEIGHT', 'GD_AMOUNTS')),
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, code),
  CHECK (capitalise = (tax_role IS NULL)),
  CHECK (capitalise OR (NOT is_duty AND default_basis IS NULL)),
  CHECK (NOT capitalise OR default_basis IS NOT NULL),
  CHECK (default_basis IS DISTINCT FROM 'GD_AMOUNTS' OR is_duty),
  CHECK (default_basis IS DISTINCT FROM 'WEIGHT' OR NOT is_duty)
);
SELECT core.enable_audit('purch.landed_cost_types');
SELECT core.enable_touch('purch.landed_cost_types');
SELECT core.forbid_delete('purch.landed_cost_types');

-- Code never changes; capitalise / tax role / duty never change once a charge of the type is posted.
CREATE FUNCTION purch.guard_landed_cost_types() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a charge type''s code never changes' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.capitalise, NEW.tax_role, NEW.is_duty) IS DISTINCT FROM (OLD.capitalise, OLD.tax_role, OLD.is_duty)
     AND EXISTS (SELECT 1 FROM purch.landed_costs c WHERE c.charge_type_id = NEW.id AND c.status = 'POSTED') THEN
    RAISE EXCEPTION 'IN_USE: charge type % has posted charges; its capitalise flag, tax role and duty flag stay', OLD.code
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- 3. landed costs
CREATE TABLE purch.landed_costs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  doc_no          TEXT          NOT NULL,
  grn_id          BIGINT        NOT NULL REFERENCES purch.grns (id) ON DELETE RESTRICT,
  charge_type_id  BIGINT        NOT NULL REFERENCES purch.landed_cost_types (id) ON DELETE RESTRICT,
  charge_date     DATE          NOT NULL,                     -- the bill / GD date
  amount          NUMERIC(18,2) NOT NULL CHECK (amount > 0),  -- PKR
  basis           TEXT          CHECK (basis IN ('VALUE', 'WEIGHT', 'GD_AMOUNTS')),  -- capitalised types only
  vendor_id       BIGINT        REFERENCES master.vendors (id) ON DELETE RESTRICT,   -- who bills it (clearing line)
  reference       TEXT          CHECK (reference IS NULL OR length(trim(reference)) BETWEEN 1 AND 60),  -- GD / bill no.
  notes           TEXT          CHECK (notes IS NULL OR length(notes) <= 1000),
  -- Entered while the GRN was DRAFT: posted by the GRN posting, on the GRN date, into the lot's receipt cost.
  with_grn        BOOLEAN       NOT NULL,
  status          TEXT          NOT NULL CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED')),
  posting_date    DATE,                                        -- set at posting
  posted_by       BIGINT        REFERENCES core.users (id) ON DELETE RESTRICT,
  posted_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by      BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by      BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, doc_no),
  CHECK (status <> 'POSTED' OR (posting_date IS NOT NULL AND posted_by IS NOT NULL AND posted_at IS NOT NULL)),
  CHECK (status = 'POSTED' OR (posting_date IS NULL AND posted_by IS NULL AND posted_at IS NULL))
);
CREATE INDEX landed_costs_grn_idx ON purch.landed_costs (grn_id, status);
SELECT core.enable_audit('purch.landed_costs');
SELECT core.enable_touch('purch.landed_costs');
SELECT core.forbid_delete('purch.landed_costs');
SELECT core.require_transition('purch.landed_costs');

CREATE TRIGGER guard_landed_cost_types BEFORE UPDATE ON purch.landed_cost_types
  FOR EACH ROW EXECUTE FUNCTION purch.guard_landed_cost_types();

-- Allocation inputs, per PO line of the GRN: the GD amount (duties, basis GD_AMOUNTS) or the weight (basis WEIGHT).
CREATE TABLE purch.landed_cost_inputs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  landed_cost_id  BIGINT        NOT NULL REFERENCES purch.landed_costs (id) ON DELETE RESTRICT,
  po_line_id      BIGINT        NOT NULL REFERENCES purch.po_lines (id) ON DELETE RESTRICT,
  gd_amount       NUMERIC(18,2) CHECK (gd_amount >= 0),
  weight_kg       NUMERIC(18,4) CHECK (weight_kg >= 0),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by      BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by      BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (landed_cost_id, po_line_id),
  CHECK ((gd_amount IS NULL) <> (weight_kg IS NULL))
);
SELECT core.enable_audit('purch.landed_cost_inputs');
SELECT core.enable_touch('purch.landed_cost_inputs');

-- Posting result, per GRN line: amount = held (into the lot, by a LANDED_COST value adjustment) + variance (consumed).
CREATE TABLE purch.landed_cost_allocations (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  landed_cost_id  BIGINT        NOT NULL REFERENCES purch.landed_costs (id) ON DELETE RESTRICT,
  grn_line_id     BIGINT        NOT NULL REFERENCES purch.grn_lines (id) ON DELETE RESTRICT,
  lot_id          BIGINT        NOT NULL REFERENCES inv.lots (id) ON DELETE RESTRICT,
  amount          NUMERIC(18,2) NOT NULL CHECK (amount >= 0),
  held_qty        NUMERIC(18,4) NOT NULL CHECK (held_qty >= 0),   -- what the lot still held at posting
  held_amount     NUMERIC(18,2) NOT NULL CHECK (held_amount >= 0),
  variance_amount NUMERIC(18,2) NOT NULL CHECK (variance_amount >= 0),
  movement_id     BIGINT        REFERENCES inv.stock_movements (id) ON DELETE RESTRICT,  -- the value adjustment
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by      BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by      BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (landed_cost_id, grn_line_id),
  CHECK (amount = held_amount + variance_amount),
  CHECK ((held_amount > 0) = (movement_id IS NOT NULL))
);
SELECT core.enable_audit('purch.landed_cost_allocations');
SELECT core.enable_touch('purch.landed_cost_allocations');
SELECT core.forbid_delete('purch.landed_cost_allocations');

-- Header: a charge on a DRAFT GRN rolls in with it (with_grn); on a POSTED GRN it is a later bill. After DRAFT only
-- the status changes (posting stamps date and poster). Posting checks the allocations and journals.
CREATE FUNCTION purch.guard_landed_costs() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  g RECORD;
  t RECORD;
  alloc RECORD;
  bad RECORD;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a landed cost starts as DRAFT' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'RECORD_LOCKED: landed cost % is % and never changes', OLD.doc_no, OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.grn_id <> OLD.grn_id OR NEW.with_grn <> OLD.with_grn) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a landed cost never moves to another GRN' USING ERRCODE = 'P0001';
  END IF;
  SELECT doc_no, status, grn_date, company_id INTO g FROM purch.grns WHERE id = NEW.grn_id;
  SELECT code, capitalise, is_duty, is_active, company_id INTO t FROM purch.landed_cost_types WHERE id = NEW.charge_type_id;
  IF g.company_id <> NEW.company_id OR t.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: GRN and charge type must belong to the company' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status = 'DRAFT' THEN
    IF NEW.with_grn <> (g.status = 'DRAFT') OR g.status NOT IN ('DRAFT', 'POSTED') THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: GRN % is %: charges are entered on a DRAFT GRN (rolled in at posting) or a POSTED one (later bill)', g.doc_no, g.status
        USING ERRCODE = 'P0001';
    END IF;
    IF NOT t.is_active THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: charge type % is not active', t.code USING ERRCODE = 'P0001';
    END IF;
    IF t.capitalise <> (NEW.basis IS NOT NULL)
       OR (NEW.basis = 'GD_AMOUNTS' AND NOT t.is_duty) OR (NEW.basis = 'WEIGHT' AND t.is_duty) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: charge type % does not take basis %', t.code, coalesce(NEW.basis, 'none') USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'CANCELLED' THEN
    RETURN NEW;
  END IF;

  -- DRAFT → POSTED
  IF g.status <> 'POSTED' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: GRN % is %; a landed cost posts on a POSTED GRN', g.doc_no, g.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.posting_date <> (CASE WHEN NEW.with_grn THEN g.grn_date ELSE NEW.charge_date END) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: landed cost % posts on % (with the GRN: the GRN date; later bill: the charge date)', NEW.doc_no,
      CASE WHEN NEW.with_grn THEN g.grn_date ELSE NEW.charge_date END USING ERRCODE = 'P0001';
  END IF;
  IF NOT NEW.with_grn AND NEW.charge_date < g.grn_date THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a later bill is dated on or after the GRN date (%)', g.grn_date USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin.journal_entries j
                  WHERE j.source_type = 'LANDED_COST' AND j.source_id = NEW.id AND j.status = 'POSTED' AND j.reversal_of IS NULL
                    AND j.entry_date = NEW.posting_date
                    AND j.event = CASE WHEN t.capitalise THEN 'LANDED_COST' ELSE 'IMPORT_TAX' END) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: landed cost % has no posted journal', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NOT t.capitalise THEN
    IF EXISTS (SELECT 1 FROM purch.landed_cost_allocations a WHERE a.landed_cost_id = NEW.id) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a tax charge is not allocated to lots' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT coalesce(sum(a.amount), 0) AS total INTO alloc FROM purch.landed_cost_allocations a WHERE a.landed_cost_id = NEW.id;
  IF alloc.total <> NEW.amount THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: landed cost % allocates % of %', NEW.doc_no, alloc.total, NEW.amount USING ERRCODE = 'P0001';
  END IF;
  SELECT a.id INTO bad FROM purch.landed_cost_allocations a
    JOIN purch.grn_lines l ON l.id = a.grn_line_id
    LEFT JOIN inv.stock_movements m ON m.id = a.movement_id
   WHERE a.landed_cost_id = NEW.id
     AND (l.grn_id <> NEW.grn_id OR a.lot_id <> l.lot_id
          OR (a.movement_id IS NOT NULL AND (m.lot_id <> a.lot_id OR m.movement_type <> 'VALUE_ADJUSTMENT'
               OR m.reason_code <> 'LANDED_COST' OR m.ref_doc_type <> 'LANDED_COST' OR m.ref_doc_id <> NEW.id
               OR m.value <> a.held_amount OR m.movement_date <> NEW.posting_date)))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: landed cost % has an allocation that does not match its GRN line, lot or value adjustment', NEW.doc_no
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.with_grn AND EXISTS (SELECT 1 FROM purch.landed_cost_allocations a WHERE a.landed_cost_id = NEW.id AND a.variance_amount <> 0) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a charge posted with its GRN goes wholly into the lots' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_landed_costs BEFORE INSERT OR UPDATE ON purch.landed_costs
  FOR EACH ROW EXECUTE FUNCTION purch.guard_landed_costs();

-- Inputs change only while their charge is DRAFT, and name a line of the GRN's PO.
CREATE FUNCTION purch.guard_landed_cost_inputs() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c RECORD;
BEGIN
  SELECT lc.doc_no, lc.status, lc.basis, g.po_id INTO c
    FROM purch.landed_costs lc JOIN purch.grns g ON g.id = lc.grn_id
   WHERE lc.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.landed_cost_id ELSE NEW.landed_cost_id END;
  IF c.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'RECORD_LOCKED: landed cost % is % and its inputs never change', c.doc_no, c.status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM purch.po_lines pl WHERE pl.id = NEW.po_line_id AND pl.po_id = c.po_id) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: landed cost % names a line of another PO', c.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF (c.basis = 'GD_AMOUNTS' AND NEW.gd_amount IS NULL) OR (c.basis = 'WEIGHT' AND NEW.weight_kg IS NULL)
     OR c.basis IS NULL OR c.basis = 'VALUE' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: landed cost % (basis %) takes no such input', c.doc_no, coalesce(c.basis, 'none') USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_landed_cost_inputs BEFORE INSERT OR UPDATE OR DELETE ON purch.landed_cost_inputs
  FOR EACH ROW EXECUTE FUNCTION purch.guard_landed_cost_inputs();

-- Allocations are written by the posting, while the charge is still DRAFT, and never change.
CREATE FUNCTION purch.guard_landed_cost_allocations() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'RECORD_LOCKED: landed cost allocations never change' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT status FROM purch.landed_costs WHERE id = NEW.landed_cost_id) <> 'DRAFT' THEN
    RAISE EXCEPTION 'RECORD_LOCKED: allocations are written while the charge is posted' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_landed_cost_allocations BEFORE INSERT OR UPDATE ON purch.landed_cost_allocations
  FOR EACH ROW EXECUTE FUNCTION purch.guard_landed_cost_allocations();

-- ---------------------------------------------------------------- 4. GRN

-- A GRN with a POSTED charge is not reversed (the charge's value adjustment is never reversed; 0017).
CREATE FUNCTION purch.guard_grn_landed_cost() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM purch.landed_costs c WHERE c.grn_id = NEW.id AND c.status = 'POSTED') THEN
    RAISE EXCEPTION 'GRN_HAS_LANDED_COST: GRN % has posted landed costs and cannot be reversed', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_grn_landed_cost BEFORE UPDATE OF status ON purch.grns
  FOR EACH ROW WHEN (OLD.status = 'POSTED' AND NEW.status = 'REVERSED') EXECUTE FUNCTION purch.guard_grn_landed_cost();

-- At commit: a GRN that left DRAFT has no DRAFT charge (posted with it, or cancelled with it).
CREATE FUNCTION purch.check_grn_draft_charges() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM purch.landed_costs c WHERE c.grn_id = NEW.id AND c.status = 'DRAFT' AND c.with_grn) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: GRN % is % but has DRAFT landed costs entered with it', NEW.doc_no, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'REVERSED' AND EXISTS (SELECT 1 FROM purch.landed_costs c WHERE c.grn_id = NEW.id AND c.status = 'DRAFT') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: GRN % is REVERSED but has DRAFT landed costs', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_grn_draft_charges AFTER UPDATE OF status ON purch.grns
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION purch.check_grn_draft_charges();
