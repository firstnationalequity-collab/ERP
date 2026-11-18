-- 0012_finance_masters: chart of accounts, cost centres, posting rules, journal entries and lines
-- (docs/architecture.md §5 "Finance", §6; CLAUDE.md rules 4, 5, 10, 11; decisions 18-11-2026 M2 Q3).
-- Owned by the finance module (schema `fin`). Accounts are never hard-coded: posting_rules map
-- (event, account role, item category) to an account, so Finance can replace the PLACEHOLDER chart.
-- Database rules: a journal entry is created DRAFT and becomes POSTED only when it has >= 2 lines and
-- debits = credits > 0, in an OPEN period; lines change only while the entry is DRAFT; a POSTED entry
-- changes only to REVERSED, and only once its reversing entry (mirror lines) is POSTED.

-- ---------------------------------------------------------------- posting events and account roles
-- Mirrors PostingEventRoles in packages/shared/src/enums.ts (tested equal).
CREATE FUNCTION fin.is_valid_posting_role(p_event TEXT, p_role TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_role = ANY (CASE p_event
    WHEN 'GRN_RECEIPT'       THEN ARRAY['INVENTORY', 'GRNI']
    WHEN 'LANDED_COST'       THEN ARRAY['INVENTORY', 'PRICE_VARIANCE', 'LANDED_COST_CLEARING']
    WHEN 'VENDOR_INVOICE'    THEN ARRAY['GRNI', 'INPUT_TAX', 'PRICE_VARIANCE', 'ACCOUNTS_PAYABLE']
    WHEN 'VENDOR_PAYMENT'    THEN ARRAY['ACCOUNTS_PAYABLE', 'BANK', 'WHT_PAYABLE']
    WHEN 'MATERIAL_ISSUE'    THEN ARRAY['WIP', 'INVENTORY']
    WHEN 'MATERIAL_RETURN'   THEN ARRAY['INVENTORY', 'WIP']
    WHEN 'CONVERSION_ABSORB' THEN ARRAY['WIP', 'LABOUR_ABSORBED', 'OVERHEAD_ABSORBED']
    WHEN 'FG_OUTPUT'         THEN ARRAY['INVENTORY', 'WIP']
    WHEN 'DISPATCH'          THEN ARRAY['COGS', 'INVENTORY']
    WHEN 'SALES_INVOICE'     THEN ARRAY['ACCOUNTS_RECEIVABLE', 'SALES_REVENUE', 'OUTPUT_TAX']
    WHEN 'TOLL_INVOICE'      THEN ARRAY['ACCOUNTS_RECEIVABLE', 'CONVERSION_REVENUE', 'OUTPUT_TAX']
    WHEN 'CUSTOMER_RECEIPT'  THEN ARRAY['BANK', 'WHT_RECEIVABLE', 'ACCOUNTS_RECEIVABLE']
    WHEN 'STOCK_ADJUSTMENT'  THEN ARRAY['INVENTORY', 'INVENTORY_LOSS', 'INVENTORY_GAIN']
    WHEN 'LOT_DESTROYED'     THEN ARRAY['REJECTION_WRITE_OFF', 'INVENTORY']
    WHEN 'LOT_RETURNED'      THEN ARRAY['ACCOUNTS_PAYABLE', 'INVENTORY']
    ELSE ARRAY[]::TEXT[]
  END)
$$;

-- ---------------------------------------------------------------- chart of accounts

CREATE TABLE fin.accounts (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id     BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  code           TEXT        NOT NULL CHECK (code ~ '^[0-9A-Z][0-9A-Z.-]{0,19}$'),
  name           TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  type           TEXT        NOT NULL CHECK (type IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE')),
  parent_id      BIGINT      REFERENCES fin.accounts (id) ON DELETE RESTRICT,
  is_postable    BOOLEAN     NOT NULL DEFAULT true,   -- false = header (groups accounts, takes no lines)
  is_placeholder BOOLEAN     NOT NULL DEFAULT false,  -- seeded, awaiting Finance's real chart (M2 Q3)
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, code),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX accounts_parent_idx ON fin.accounts (parent_id);
SELECT core.master_table('fin.accounts');

CREATE FUNCTION fin.guard_account() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent RECORD;
  cursor_id BIGINT;
  depth INTEGER := 0;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.code IS DISTINCT FROM OLD.code OR NEW.type IS DISTINCT FROM OLD.type OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: an account''s code and type never change (add a new account instead)' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.is_placeholder AND NOT OLD.is_placeholder THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: an account cannot be marked placeholder again' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.is_postable AND NOT NEW.is_postable
       AND EXISTS (SELECT 1 FROM fin.journal_lines l WHERE l.account_id = NEW.id) THEN
      RAISE EXCEPTION 'IN_USE: account % has journal lines and cannot become a header', NEW.code USING ERRCODE = 'P0001';
    END IF;
    IF NEW.is_postable AND NOT OLD.is_postable
       AND EXISTS (SELECT 1 FROM fin.accounts c WHERE c.parent_id = NEW.id) THEN
      RAISE EXCEPTION 'IN_USE: account % has sub-accounts and must stay a header', NEW.code USING ERRCODE = 'P0001';
    END IF;
    IF OLD.is_active AND NOT NEW.is_active THEN
      IF EXISTS (SELECT 1 FROM fin.posting_rules r WHERE r.account_id = NEW.id AND r.is_active) THEN
        RAISE EXCEPTION 'IN_USE: account % is used by an active posting rule', NEW.code USING ERRCODE = 'P0001';
      END IF;
      IF EXISTS (SELECT 1 FROM fin.accounts c WHERE c.parent_id = NEW.id AND c.is_active) THEN
        RAISE EXCEPTION 'IN_USE: account % has active sub-accounts', NEW.code USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  IF NEW.parent_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id) THEN
    SELECT company_id, type, is_postable, is_active INTO parent FROM fin.accounts WHERE id = NEW.parent_id;
    IF parent.company_id <> NEW.company_id OR parent.type <> NEW.type THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: the parent account must have the same type' USING ERRCODE = 'P0001';
    END IF;
    IF parent.is_postable THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: the parent account must be a header (not postable)' USING ERRCODE = 'P0001';
    END IF;
    IF NOT parent.is_active THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: the parent account is not active' USING ERRCODE = 'P0001';
    END IF;
    cursor_id := NEW.parent_id;
    WHILE cursor_id IS NOT NULL LOOP
      IF cursor_id = NEW.id OR depth > 50 THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: an account cannot be placed under itself' USING ERRCODE = 'P0001';
      END IF;
      SELECT a.parent_id INTO cursor_id FROM fin.accounts a WHERE a.id = cursor_id;
      depth := depth + 1;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_account BEFORE INSERT OR UPDATE ON fin.accounts
  FOR EACH ROW EXECUTE FUNCTION fin.guard_account();

-- ---------------------------------------------------------------- cost centres

CREATE TABLE fin.cost_centers (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  code        TEXT        NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name        TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, code)
);
SELECT core.master_table('fin.cost_centers');

CREATE FUNCTION fin.guard_cost_center() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a cost centre''s code never changes' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_cost_center BEFORE UPDATE ON fin.cost_centers
  FOR EACH ROW EXECUTE FUNCTION fin.guard_cost_center();

-- ---------------------------------------------------------------- posting rules

CREATE TABLE fin.posting_rules (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id       BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  event            TEXT        NOT NULL CHECK (event IN (
                     'GRN_RECEIPT', 'LANDED_COST', 'VENDOR_INVOICE', 'VENDOR_PAYMENT', 'MATERIAL_ISSUE', 'MATERIAL_RETURN',
                     'CONVERSION_ABSORB', 'FG_OUTPUT', 'DISPATCH', 'SALES_INVOICE', 'TOLL_INVOICE', 'CUSTOMER_RECEIPT',
                     'STOCK_ADJUSTMENT', 'LOT_DESTROYED', 'LOT_RETURNED')),
  account_role     TEXT        NOT NULL CHECK (account_role IN (
                     'INVENTORY', 'GRNI', 'PRICE_VARIANCE', 'LANDED_COST_CLEARING', 'INPUT_TAX', 'ACCOUNTS_PAYABLE', 'BANK',
                     'WHT_PAYABLE', 'WIP', 'LABOUR_ABSORBED', 'OVERHEAD_ABSORBED', 'COGS', 'ACCOUNTS_RECEIVABLE',
                     'SALES_REVENUE', 'CONVERSION_REVENUE', 'OUTPUT_TAX', 'WHT_RECEIVABLE', 'INVENTORY_LOSS',
                     'INVENTORY_GAIN', 'REJECTION_WRITE_OFF')),
  item_category_id BIGINT      REFERENCES master.item_categories (id) ON DELETE RESTRICT,  -- NULL = any category
  account_id       BIGINT      NOT NULL REFERENCES fin.accounts (id) ON DELETE RESTRICT,
  is_placeholder   BOOLEAN     NOT NULL DEFAULT false,
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  CONSTRAINT posting_rule_role_valid CHECK (fin.is_valid_posting_role(event, account_role)),
  CONSTRAINT posting_rule_unique UNIQUE NULLS NOT DISTINCT (company_id, event, account_role, item_category_id)
);
SELECT core.master_table('fin.posting_rules');

CREATE FUNCTION fin.guard_posting_rule() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  acct RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.event IS DISTINCT FROM OLD.event OR NEW.account_role IS DISTINCT FROM OLD.account_role
       OR NEW.item_category_id IS DISTINCT FROM OLD.item_category_id OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a posting rule''s event, role and category never change; change its account' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.is_placeholder AND NOT OLD.is_placeholder THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a posting rule cannot be marked placeholder again' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.is_active THEN
    SELECT company_id, code, is_postable, is_active INTO acct FROM fin.accounts WHERE id = NEW.account_id;
    IF acct.company_id <> NEW.company_id OR NOT acct.is_postable OR NOT acct.is_active THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a posting rule needs an active postable account (%)', acct.code USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_posting_rule BEFORE INSERT OR UPDATE ON fin.posting_rules
  FOR EACH ROW EXECUTE FUNCTION fin.guard_posting_rule();

-- ---------------------------------------------------------------- journal entries

CREATE TABLE fin.journal_entries (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  doc_no       TEXT        NOT NULL,
  entry_date   DATE        NOT NULL,
  period_id    BIGINT      NOT NULL REFERENCES core.fiscal_periods (id) ON DELETE RESTRICT,  -- set from entry_date
  source_type  TEXT        NOT NULL CHECK (source_type ~ '^[A-Z][A-Z_]{1,29}$'),  -- MANUAL, GRN, DISPATCH, ...
  source_id    BIGINT,
  event        TEXT        CHECK (event IN (
                 'GRN_RECEIPT', 'LANDED_COST', 'VENDOR_INVOICE', 'VENDOR_PAYMENT', 'MATERIAL_ISSUE', 'MATERIAL_RETURN',
                 'CONVERSION_ABSORB', 'FG_OUTPUT', 'DISPATCH', 'SALES_INVOICE', 'TOLL_INVOICE', 'CUSTOMER_RECEIPT',
                 'STOCK_ADJUSTMENT', 'LOT_DESTROYED', 'LOT_RETURNED')),  -- NULL for manual journal vouchers
  narration    TEXT        NOT NULL CHECK (length(trim(narration)) > 0),
  status       TEXT        NOT NULL CHECK (status IN ('DRAFT', 'POSTED', 'REVERSED')),
  posted_at    TIMESTAMPTZ,
  posted_by    BIGINT      REFERENCES core.users (id) ON DELETE RESTRICT,
  reversal_of  BIGINT      UNIQUE REFERENCES fin.journal_entries (id) ON DELETE RESTRICT,  -- this entry reverses that one
  reversal_id  BIGINT      REFERENCES fin.journal_entries (id) ON DELETE RESTRICT,         -- set when this one is reversed
  reversed_at  TIMESTAMPTZ,
  reversed_by  BIGINT      REFERENCES core.users (id) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, doc_no),
  CHECK (reversal_of IS NULL OR reversal_of <> id),
  CHECK (status = 'DRAFT' OR (posted_at IS NOT NULL AND posted_by IS NOT NULL)),
  CHECK ((status = 'REVERSED') = (reversal_id IS NOT NULL)),
  CHECK (status <> 'REVERSED' OR (reversed_at IS NOT NULL AND reversed_by IS NOT NULL))
);
CREATE INDEX journal_entries_date_idx ON fin.journal_entries (company_id, entry_date);
CREATE INDEX journal_entries_source_idx ON fin.journal_entries (source_type, source_id);

CREATE TABLE fin.journal_lines (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id          BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  entry_id            BIGINT        NOT NULL REFERENCES fin.journal_entries (id) ON DELETE RESTRICT,
  line_no             INTEGER       NOT NULL CHECK (line_no > 0),
  account_id          BIGINT        NOT NULL REFERENCES fin.accounts (id) ON DELETE RESTRICT,
  debit               NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit              NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  cost_center_id      BIGINT        REFERENCES fin.cost_centers (id) ON DELETE RESTRICT,
  customer_id         BIGINT        REFERENCES master.customers (id) ON DELETE RESTRICT,
  vendor_id           BIGINT        REFERENCES master.vendors (id) ON DELETE RESTRICT,
  production_order_id BIGINT,       -- foreign key added with prod.production_orders (M6)
  narration           TEXT,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by          BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by          BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (entry_id, line_no),
  CONSTRAINT journal_line_one_side CHECK ((debit = 0) <> (credit = 0))  -- exactly one side, never both, never neither
);
CREATE INDEX journal_lines_account_idx ON fin.journal_lines (account_id);

-- Entry: created DRAFT; period from date; balance checked when it becomes POSTED; REVERSED only after its reversal.
CREATE FUNCTION fin.guard_journal_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  n_lines INTEGER;
  total_debit NUMERIC(18,2);
  total_credit NUMERIC(18,2);
  original_status TEXT;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a journal entry is created DRAFT, given its lines, then posted' USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'INSERT' OR NEW.entry_date IS DISTINCT FROM OLD.entry_date THEN
    SELECT p.id INTO NEW.period_id FROM core.fiscal_periods p
     WHERE p.company_id = NEW.company_id AND NEW.entry_date BETWEEN p.start_date AND p.end_date;
    IF NEW.period_id IS NULL THEN
      RAISE EXCEPTION 'PERIOD_NOT_DEFINED: no fiscal period covers %', to_char(NEW.entry_date, 'DD-MM-YYYY') USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.period_id IS DISTINCT FROM OLD.period_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: the period follows the entry date' USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'DRAFT' AND NEW.status = 'POSTED' THEN
    SELECT count(*), COALESCE(sum(debit), 0), COALESCE(sum(credit), 0) INTO n_lines, total_debit, total_credit
      FROM fin.journal_lines WHERE entry_id = NEW.id;
    IF n_lines < 2 OR total_debit <> total_credit OR total_debit = 0 THEN
      RAISE EXCEPTION 'JOURNAL_UNBALANCED: entry % has % lines, debits % and credits %', NEW.doc_no, n_lines, total_debit, total_credit
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.reversal_of IS NOT NULL THEN
      SELECT status INTO original_status FROM fin.journal_entries WHERE id = NEW.reversal_of FOR UPDATE;
      IF original_status IS DISTINCT FROM 'POSTED' THEN
        RAISE EXCEPTION 'INVALID_TRANSITION: only a POSTED entry can be reversed' USING ERRCODE = 'P0001';
      END IF;
      -- The reversal mirrors the original line for line: same account and dimensions, debit and credit swapped.
      IF EXISTS (
        (SELECT account_id, credit AS debit, debit AS credit, cost_center_id, customer_id, vendor_id, production_order_id
           FROM fin.journal_lines WHERE entry_id = NEW.reversal_of
         EXCEPT ALL
         SELECT account_id, debit, credit, cost_center_id, customer_id, vendor_id, production_order_id
           FROM fin.journal_lines WHERE entry_id = NEW.id)
        UNION ALL
        (SELECT account_id, debit, credit, cost_center_id, customer_id, vendor_id, production_order_id
           FROM fin.journal_lines WHERE entry_id = NEW.id
         EXCEPT ALL
         SELECT account_id, credit, debit, cost_center_id, customer_id, vendor_id, production_order_id
           FROM fin.journal_lines WHERE entry_id = NEW.reversal_of)
      ) THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: a reversal must mirror the original entry''s lines' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    NEW.posted_at := now();
    NEW.posted_by := COALESCE(core.current_user_id(), NEW.posted_by);
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status = 'REVERSED' AND OLD.status IS DISTINCT FROM 'REVERSED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM fin.journal_entries r WHERE r.id = NEW.reversal_id AND r.reversal_of = NEW.id AND r.status = 'POSTED'
    ) THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: an entry is marked REVERSED only by its own posted reversal' USING ERRCODE = 'P0001';
    END IF;
    NEW.reversed_at := now();
    NEW.reversed_by := COALESCE(core.current_user_id(), NEW.reversed_by);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_journal_entry BEFORE INSERT OR UPDATE ON fin.journal_entries
  FOR EACH ROW EXECUTE FUNCTION fin.guard_journal_entry();

SELECT core.enable_audit('fin.journal_entries');
SELECT core.enable_touch('fin.journal_entries');
SELECT core.protect_posted('fin.journal_entries');
SELECT core.require_open_period('fin.journal_entries', 'entry_date');
SELECT core.require_transition('fin.journal_entries');

-- Lines: written only while the entry is DRAFT, to an active postable account of the same company.
CREATE FUNCTION fin.guard_journal_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entry RECORD;
  acct RECORD;
  cc_active BOOLEAN;
  entry_ids BIGINT[];
  eid BIGINT;
BEGIN
  entry_ids := CASE TG_OP
    WHEN 'INSERT' THEN ARRAY[NEW.entry_id]
    WHEN 'DELETE' THEN ARRAY[OLD.entry_id]
    ELSE ARRAY[OLD.entry_id, NEW.entry_id] END;
  FOREACH eid IN ARRAY entry_ids LOOP
    SELECT status, company_id, doc_no INTO entry FROM fin.journal_entries WHERE id = eid FOR SHARE;
    IF entry.status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'POSTED_IMMUTABLE: lines of journal entry % (%) cannot change', entry.doc_no, entry.status USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF NEW.company_id <> entry.company_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: line and entry belong to different companies' USING ERRCODE = 'P0001';
  END IF;
  SELECT company_id, code, is_postable, is_active INTO acct FROM fin.accounts WHERE id = NEW.account_id;
  IF acct.company_id <> NEW.company_id OR NOT acct.is_postable OR NOT acct.is_active THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: account % is not an active postable account', acct.code USING ERRCODE = 'P0001';
  END IF;
  IF NEW.cost_center_id IS NOT NULL THEN
    SELECT is_active INTO cc_active FROM fin.cost_centers WHERE id = NEW.cost_center_id AND company_id = NEW.company_id;
    IF NOT COALESCE(cc_active, false) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: the cost centre is not active' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_journal_line BEFORE INSERT OR UPDATE OR DELETE ON fin.journal_lines
  FOR EACH ROW EXECUTE FUNCTION fin.guard_journal_line();

SELECT core.enable_audit('fin.journal_lines');
SELECT core.enable_touch('fin.journal_lines');
