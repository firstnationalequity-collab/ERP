-- 0008_masters: master data (docs/architecture.md §5 "Masters", §7.2; decisions 18-11-2026 M2 Q1–Q6).
-- Schema `master` (decision 18-11-2026): one module owns these tables; other modules read them through
-- the masters service. Masters are never hard-deleted (is_active / status instead).

CREATE SCHEMA IF NOT EXISTS master;

-- ---------------------------------------------------------------- helpers

-- Masters are deactivated, never deleted.
CREATE FUNCTION core.forbid_delete_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IN_USE: % rows are deactivated, never deleted', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;

CREATE FUNCTION core.forbid_delete(target REGCLASS) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER forbid_delete BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION core.forbid_delete_trigger()', target);
END;
$$;

-- Standard master table: audit, touch, no delete.
CREATE FUNCTION core.master_table(target REGCLASS) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM core.enable_audit(target);
  PERFORM core.enable_touch(target);
  PERFORM core.forbid_delete(target);
END;
$$;

-- ---------------------------------------------------------------- tax codes (managed with fin.master.manage)

CREATE TABLE master.tax_codes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  BIGINT       NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  code        TEXT         NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  name        TEXT         NOT NULL CHECK (length(trim(name)) > 0),
  kind        TEXT         NOT NULL CHECK (kind IN ('SALES_TAX', 'WITHHOLDING')),
  rate        NUMERIC(9,4) NOT NULL CHECK (rate >= 0 AND rate <= 100),
  is_placeholder BOOLEAN   NOT NULL DEFAULT false,  -- seeded rate awaiting Finance confirmation
  is_active   BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by  BIGINT       NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_by  BIGINT       NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, code)
);
SELECT core.master_table('master.tax_codes');

-- ---------------------------------------------------------------- units of measure

CREATE TABLE master.uoms (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  code        TEXT        NOT NULL CHECK (code ~ '^[A-Za-z0-9]{1,10}$'),
  name        TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, code)
);
SELECT core.master_table('master.uoms');

-- ---------------------------------------------------------------- item categories and items

CREATE TABLE master.item_categories (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  code        TEXT        NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  name        TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, code)
);
SELECT core.master_table('master.item_categories');

CREATE TABLE master.items (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  code            TEXT        NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_./-]{0,39}$'),
  name            TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  type            TEXT        NOT NULL CHECK (type IN ('RM', 'PM', 'API', 'EXCIPIENT', 'BULK', 'FG', 'SPARE', 'CONSUMABLE')),
  category_id     BIGINT      NOT NULL REFERENCES master.item_categories (id) ON DELETE RESTRICT,
  base_uom_id     BIGINT      NOT NULL REFERENCES master.uoms (id) ON DELETE RESTRICT,
  tax_code_id     BIGINT      REFERENCES master.tax_codes (id) ON DELETE RESTRICT,  -- sales tax per item (M2 Q6)
  shelf_life_days INTEGER     CHECK (shelf_life_days > 0),
  retest_days     INTEGER     CHECK (retest_days > 0),
  is_controlled   BOOLEAN     NOT NULL DEFAULT false,  -- psychotropic / narcotic
  storage_zone    TEXT        NOT NULL DEFAULT 'AMBIENT' CHECK (storage_zone IN ('AMBIENT', 'BELOW_25C', 'COLD_2_8C', 'FROZEN')),
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, code),
  CHECK (retest_days IS NULL OR shelf_life_days IS NULL OR retest_days <= shelf_life_days)
);
CREATE INDEX items_category_idx ON master.items (category_id);
SELECT core.master_table('master.items');

-- A sales tax code on an item must be a SALES_TAX code.
CREATE FUNCTION master.guard_item_tax_code() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tax_code_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM master.tax_codes WHERE id = NEW.tax_code_id AND kind = 'SALES_TAX') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: an item''s tax code must be a sales tax code' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_item_tax_code BEFORE INSERT OR UPDATE OF tax_code_id ON master.items
  FOR EACH ROW EXECUTE FUNCTION master.guard_item_tax_code();

-- Conversions: global (item_id NULL, e.g. KG→G) or item-specific (e.g. BOX→TAB for one product).
-- factor: 1 from_uom = factor × to_uom. NUMERIC(18,6) because factors like KG→MG exceed NUMERIC(9,4).
CREATE TABLE master.uom_conversions (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  item_id     BIGINT        REFERENCES master.items (id) ON DELETE RESTRICT,
  from_uom_id BIGINT        NOT NULL REFERENCES master.uoms (id) ON DELETE RESTRICT,
  to_uom_id   BIGINT        NOT NULL REFERENCES master.uoms (id) ON DELETE RESTRICT,
  factor      NUMERIC(18,6) NOT NULL CHECK (factor > 0),
  is_active   BOOLEAN       NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by  BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by  BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  CHECK (from_uom_id <> to_uom_id)
);
CREATE UNIQUE INDEX uom_conversions_uq ON master.uom_conversions
  (company_id, COALESCE(item_id, 0), from_uom_id, to_uom_id) WHERE is_active;
SELECT core.master_table('master.uom_conversions');

-- ---------------------------------------------------------------- warehouses and locations

CREATE TABLE master.warehouses (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  code        TEXT        NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name        TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  address     TEXT,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, code)
);
SELECT core.master_table('master.warehouses');

CREATE TABLE master.locations (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  warehouse_id BIGINT      NOT NULL REFERENCES master.warehouses (id) ON DELETE RESTRICT,
  code         TEXT        NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_./-]{0,29}$'),
  name         TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  storage_zone TEXT        NOT NULL DEFAULT 'AMBIENT' CHECK (storage_zone IN ('AMBIENT', 'BELOW_25C', 'COLD_2_8C', 'FROZEN')),
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (warehouse_id, code)
);
SELECT core.master_table('master.locations');

-- ---------------------------------------------------------------- customers and vendors
-- status DRAFT → ACTIVE → INACTIVE → ACTIVE through core/transition; activator ≠ creator (service).
-- NTN or CNIC is required (architecture §7.2).

CREATE TABLE master.customers (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id         BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  code               TEXT          NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name               TEXT          NOT NULL CHECK (length(trim(name)) > 0),
  ntn                TEXT          CHECK (ntn ~ '^[0-9]{7}-?[0-9]?$'),
  cnic               TEXT          CHECK (cnic ~ '^[0-9]{5}-?[0-9]{7}-?[0-9]$'),
  strn               TEXT          CHECK (strn ~ '^[0-9A-Z-]{5,20}$'),
  credit_limit       NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  payment_terms_days INTEGER       NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 365),
  is_toll_customer   BOOLEAN       NOT NULL DEFAULT false,
  status             TEXT          NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE')),
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by         BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by         BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, code),
  CHECK (ntn IS NOT NULL OR cnic IS NOT NULL)
);
SELECT core.master_table('master.customers');
SELECT core.require_transition('master.customers');

CREATE TABLE master.customer_addresses (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  customer_id BIGINT      NOT NULL REFERENCES master.customers (id) ON DELETE RESTRICT,
  type        TEXT        NOT NULL CHECK (type IN ('BILLING', 'SHIPPING')),
  line1       TEXT        NOT NULL CHECK (length(trim(line1)) > 0),
  line2       TEXT,
  city        TEXT        NOT NULL CHECK (length(trim(city)) > 0),
  province    TEXT,
  is_default  BOOLEAN     NOT NULL DEFAULT false,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX customer_addresses_default_uq ON master.customer_addresses (customer_id, type)
  WHERE is_default AND is_active;
SELECT core.master_table('master.customer_addresses');

CREATE TABLE master.vendors (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  code          TEXT        NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  name          TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  ntn           TEXT        CHECK (ntn ~ '^[0-9]{7}-?[0-9]?$'),
  cnic          TEXT        CHECK (cnic ~ '^[0-9]{5}-?[0-9]{7}-?[0-9]$'),
  strn          TEXT        CHECK (strn ~ '^[0-9A-Z-]{5,20}$'),
  is_foreign    BOOLEAN     NOT NULL DEFAULT false,  -- foreign vendors have no NTN/CNIC
  country       TEXT        NOT NULL DEFAULT 'PK' CHECK (country ~ '^[A-Z]{2}$'),
  currency      TEXT        NOT NULL DEFAULT 'PKR' CHECK (currency ~ '^[A-Z]{3}$'),
  bank_name     TEXT,
  bank_account  TEXT,  -- IBAN or account number
  payment_terms_days INTEGER NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 365),
  status        TEXT        NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, code),
  CHECK (is_foreign OR ntn IS NOT NULL OR cnic IS NOT NULL),
  CHECK (NOT is_foreign OR country <> 'PK')
);
SELECT core.master_table('master.vendors');
SELECT core.require_transition('master.vendors');

-- ---------------------------------------------------------------- approved sources (AVL)
-- vendor + item + manufacturer + manufacturing site (API-01). PENDING → APPROVED/REJECTED via the AVL
-- approval (QA Manager e-signature); APPROVED → BLOCKED by QA Manager (e-signature + reason).

CREATE TABLE master.approved_sources (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id         BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  vendor_id          BIGINT      NOT NULL REFERENCES master.vendors (id) ON DELETE RESTRICT,
  item_id            BIGINT      NOT NULL REFERENCES master.items (id) ON DELETE RESTRICT,
  manufacturer       TEXT        NOT NULL CHECK (length(trim(manufacturer)) > 0),
  manufacturing_site TEXT        NOT NULL CHECK (length(trim(manufacturing_site)) > 0),
  notes              TEXT,
  status             TEXT        NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'BLOCKED')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT
);
-- One live row per source (a REJECTED or BLOCKED one may be proposed again as a new row).
CREATE UNIQUE INDEX approved_sources_live_uq ON master.approved_sources
  (company_id, vendor_id, item_id, lower(manufacturer), lower(manufacturing_site))
  WHERE status IN ('PENDING', 'APPROVED');
CREATE INDEX approved_sources_item_idx ON master.approved_sources (item_id, status);
SELECT core.master_table('master.approved_sources');
SELECT core.require_transition('master.approved_sources');

-- The identity of a source never changes after it is proposed; propose a new row instead.
CREATE FUNCTION master.guard_approved_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.vendor_id, NEW.item_id, NEW.manufacturer, NEW.manufacturing_site)
     IS DISTINCT FROM (OLD.vendor_id, OLD.item_id, OLD.manufacturer, OLD.manufacturing_site) THEN
    RAISE EXCEPTION 'RECORD_LOCKED: an approved source''s vendor, item, manufacturer and site cannot change; propose a new source'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_approved_source BEFORE UPDATE ON master.approved_sources
  FOR EACH ROW EXECUTE FUNCTION master.guard_approved_source();

-- ---------------------------------------------------------------- products
-- An FG item with its regulatory data. customer_id NULL = own brand; set = contract (toll) product.
-- Changing registration_no, artwork_version or quality_agreement_signed_on needs a countersign
-- (holder of qa.product.countersign, checked in the service) by a different person, in the same transaction.

CREATE TABLE master.products (
  id                          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id                  BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  item_id                     BIGINT      NOT NULL REFERENCES master.items (id) ON DELETE RESTRICT,
  customer_id                 BIGINT      REFERENCES master.customers (id) ON DELETE RESTRICT,
  registration_no             TEXT,
  artwork_version             TEXT,
  quality_agreement_signed_on DATE,
  is_active                   BOOLEAN     NOT NULL DEFAULT true,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by                  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, item_id)
);
SELECT core.master_table('master.products');

CREATE FUNCTION master.guard_product_item() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM master.items WHERE id = NEW.item_id AND type = 'FG') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a product must be a finished-goods (FG) item' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.item_id <> OLD.item_id THEN
    RAISE EXCEPTION 'RECORD_LOCKED: a product''s item cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_product_item BEFORE INSERT OR UPDATE OF item_id ON master.products
  FOR EACH ROW EXECUTE FUNCTION master.guard_product_item();

-- Deferred: on INSERT the id is only known after the row exists, so the signature is written just after it.
CREATE FUNCTION master.require_product_countersign() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changed BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' THEN
    changed := NEW.registration_no IS NOT NULL OR NEW.artwork_version IS NOT NULL
               OR NEW.quality_agreement_signed_on IS NOT NULL;
  ELSE
    changed := (NEW.registration_no, NEW.artwork_version, NEW.quality_agreement_signed_on)
               IS DISTINCT FROM (OLD.registration_no, OLD.artwork_version, OLD.quality_agreement_signed_on);
  END IF;
  IF changed AND NOT EXISTS (
    SELECT 1 FROM core.e_signatures s
     WHERE s.record_table = 'master.products' AND s.record_id = NEW.id::text
       AND s.meaning = 'APPROVED' AND s.tx_id = txid_current()
       AND s.user_id <> NEW.updated_by
  ) THEN
    RAISE EXCEPTION 'COUNTERSIGN_REQUIRED: registration no., artwork version and quality agreement changes need a QA countersign by another person'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER require_product_countersign AFTER INSERT OR UPDATE ON master.products
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION master.require_product_countersign();

-- ---------------------------------------------------------------- master formulas (versioned, QA approval)
-- DRAFT (editable) → PENDING_APPROVAL (MASTER_FORMULA approval) → APPROVED (QA Manager) → OBSOLETE
-- when the next version is approved. A rejected approval returns the version to DRAFT.

CREATE TABLE master.master_formulas (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  product_id   BIGINT        NOT NULL REFERENCES master.products (id) ON DELETE RESTRICT,
  version      INTEGER       NOT NULL CHECK (version >= 1),
  batch_size   NUMERIC(18,4) NOT NULL CHECK (batch_size > 0),
  batch_uom_id BIGINT        NOT NULL REFERENCES master.uoms (id) ON DELETE RESTRICT,
  notes        TEXT,
  status       TEXT          NOT NULL CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'OBSOLETE')),
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by   BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by   BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (product_id, version)
);
CREATE UNIQUE INDEX master_formulas_one_approved_uq ON master.master_formulas (product_id) WHERE status = 'APPROVED';
CREATE UNIQUE INDEX master_formulas_one_open_uq ON master.master_formulas (product_id)
  WHERE status IN ('DRAFT', 'PENDING_APPROVAL');
SELECT core.master_table('master.master_formulas');
SELECT core.require_transition('master.master_formulas');

CREATE TABLE master.master_formula_lines (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id     BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  formula_id     BIGINT        NOT NULL REFERENCES master.master_formulas (id) ON DELETE RESTRICT,
  line_no        INTEGER       NOT NULL CHECK (line_no >= 1),
  item_id        BIGINT        NOT NULL REFERENCES master.items (id) ON DELETE RESTRICT,
  qty_per_batch  NUMERIC(18,4) NOT NULL CHECK (qty_per_batch > 0),
  uom_id         BIGINT        NOT NULL REFERENCES master.uoms (id) ON DELETE RESTRICT,
  is_api         BOOLEAN       NOT NULL DEFAULT false,
  is_filler      BOOLEAN       NOT NULL DEFAULT false,
  assay_basis    TEXT          CHECK (assay_basis IN ('AS_IS', 'DRIED')),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by     BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by     BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (formula_id, line_no),
  CHECK (NOT (is_api AND is_filler)),
  CHECK (is_api = (assay_basis IS NOT NULL))
);
CREATE UNIQUE INDEX master_formula_lines_one_filler_uq ON master.master_formula_lines (formula_id) WHERE is_filler;
CREATE INDEX master_formula_lines_item_idx ON master.master_formula_lines (item_id);
SELECT core.enable_audit('master.master_formula_lines');
SELECT core.enable_touch('master.master_formula_lines');

-- Only a DRAFT formula can be edited (header data or lines). Status changes go through core/transition.
CREATE FUNCTION master.guard_formula() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  n_lines INTEGER;
  n_api INTEGER;
  n_filler INTEGER;
BEGIN
  IF OLD.status <> 'DRAFT'
     AND (NEW.product_id, NEW.version, NEW.batch_size, NEW.batch_uom_id, NEW.notes)
         IS DISTINCT FROM (OLD.product_id, OLD.version, OLD.batch_size, OLD.batch_uom_id, OLD.notes) THEN
    RAISE EXCEPTION 'RECORD_LOCKED: master formula % v% is % and cannot be edited; create a new version',
      OLD.product_id, OLD.version, OLD.status USING ERRCODE = 'P0001';
  END IF;
  -- Leaving DRAFT: the formula must be complete. One filler line when there are API lines.
  IF OLD.status = 'DRAFT' AND NEW.status IN ('PENDING_APPROVAL', 'APPROVED') THEN
    SELECT count(*), count(*) FILTER (WHERE is_api), count(*) FILTER (WHERE is_filler)
      INTO n_lines, n_api, n_filler
      FROM master.master_formula_lines WHERE formula_id = NEW.id;
    IF n_lines = 0 THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a master formula needs at least one line' USING ERRCODE = 'P0001';
    END IF;
    IF n_api > 0 AND n_filler <> 1 THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a formula with API lines needs exactly one filler line' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_formula BEFORE UPDATE ON master.master_formulas
  FOR EACH ROW EXECUTE FUNCTION master.guard_formula();

CREATE FUNCTION master.guard_formula_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  fid BIGINT;
  st TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN fid := OLD.formula_id; ELSE fid := NEW.formula_id; END IF;
  SELECT status INTO st FROM master.master_formulas WHERE id = fid;
  IF st IS DISTINCT FROM 'DRAFT' OR (TG_OP = 'UPDATE' AND OLD.formula_id <> NEW.formula_id) THEN
    RAISE EXCEPTION 'RECORD_LOCKED: lines of a % master formula cannot change', COALESCE(st, 'missing')
      USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_formula_lines BEFORE INSERT OR UPDATE OR DELETE ON master.master_formula_lines
  FOR EACH ROW EXECUTE FUNCTION master.guard_formula_lines();

-- ---------------------------------------------------------------- price lists

CREATE TABLE master.price_lists (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  code        TEXT        NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,29}$'),
  name        TEXT        NOT NULL CHECK (length(trim(name)) > 0),
  customer_id BIGINT      REFERENCES master.customers (id) ON DELETE RESTRICT,  -- NULL = general list
  currency    TEXT        NOT NULL DEFAULT 'PKR' CHECK (currency ~ '^[A-Z]{3}$'),
  valid_from  DATE        NOT NULL,
  valid_to    DATE,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, code),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
SELECT core.master_table('master.price_lists');

CREATE TABLE master.price_list_lines (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  price_list_id BIGINT        NOT NULL REFERENCES master.price_lists (id) ON DELETE RESTRICT,
  item_id       BIGINT        NOT NULL REFERENCES master.items (id) ON DELETE RESTRICT,
  uom_id        BIGINT        NOT NULL REFERENCES master.uoms (id) ON DELETE RESTRICT,
  unit_price    NUMERIC(18,2) NOT NULL CHECK (unit_price >= 0),
  is_active     BOOLEAN       NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by    BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by    BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX price_list_lines_uq ON master.price_list_lines (price_list_id, item_id, uom_id) WHERE is_active;
SELECT core.master_table('master.price_list_lines');
