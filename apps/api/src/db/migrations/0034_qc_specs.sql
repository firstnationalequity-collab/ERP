-- M4 task 1: QC specifications (architecture §5 QC group, §7.6; build-plan M4).
--   qc.specs       one version per item: DRAFT (editable, qc.spec.manage) → PENDING_APPROVAL (submit, same key)
--                  → APPROVED (QC Manager, e-signature APPROVED, qc.spec.approve) → OBSOLETE (when the next version
--                  is approved). PENDING_APPROVAL → DRAFT on rejection (reason). One APPROVED and one open
--                  (DRAFT / PENDING_APPROVAL) version per item. The approver is neither the drafter nor the submitter.
--   qc.spec_tests  the tests of a version: NUMERIC (min and/or max, unit) or TEXT (a text limit, e.g. "Complies").
--                  At most one assay test and one water test, both NUMERIC. Changed only while the spec is DRAFT.
-- Limits are NUMERIC(18,6) and may be negative (e.g. optical rotation): agent default, docs/verification-list.md (QC).

CREATE TABLE qc.specs (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id        BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  item_id           BIGINT      NOT NULL REFERENCES master.items (id) ON DELETE RESTRICT,
  version           INTEGER     NOT NULL CHECK (version >= 1),
  reference         TEXT        CHECK (reference IS NULL OR length(reference) <= 200),
  notes             TEXT        CHECK (notes IS NULL OR length(notes) <= 2000),
  status            TEXT        NOT NULL CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'OBSOLETE')),
  submitted_by      BIGINT      REFERENCES core.users (id) ON DELETE RESTRICT,
  approved_by       BIGINT      REFERENCES core.users (id) ON DELETE RESTRICT,
  approved_at       TIMESTAMPTZ,
  approval_esign_id BIGINT      UNIQUE REFERENCES core.e_signatures (id) ON DELETE RESTRICT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (item_id, version),
  CHECK ((status = 'DRAFT') = (submitted_by IS NULL)),
  CHECK ((status IN ('APPROVED', 'OBSOLETE')) = (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approval_esign_id IS NOT NULL)),
  CHECK (approved_by IS NULL OR (approved_by <> created_by AND approved_by <> submitted_by))
);
CREATE UNIQUE INDEX specs_one_approved_uq ON qc.specs (item_id) WHERE status = 'APPROVED';
CREATE UNIQUE INDEX specs_one_open_uq ON qc.specs (item_id) WHERE status IN ('DRAFT', 'PENDING_APPROVAL');
SELECT core.master_table('qc.specs');
SELECT core.require_transition('qc.specs');

CREATE TABLE qc.spec_tests (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  spec_id      BIGINT        NOT NULL REFERENCES qc.specs (id) ON DELETE RESTRICT,
  seq          INTEGER       NOT NULL CHECK (seq >= 1),
  name         TEXT          NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  method       TEXT          CHECK (method IS NULL OR length(method) <= 200),
  result_type  TEXT          NOT NULL CHECK (result_type IN ('NUMERIC', 'TEXT')),
  min_value    NUMERIC(18,6),
  max_value    NUMERIC(18,6),
  text_limit   TEXT          CHECK (text_limit IS NULL OR length(trim(text_limit)) BETWEEN 1 AND 500),
  unit         TEXT          CHECK (unit IS NULL OR length(unit) <= 30),
  is_assay     BOOLEAN       NOT NULL DEFAULT false,
  is_water     BOOLEAN       NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by   BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by   BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (spec_id, seq),
  CHECK (result_type <> 'NUMERIC' OR ((min_value IS NOT NULL OR max_value IS NOT NULL) AND text_limit IS NULL)),
  CHECK (result_type <> 'TEXT' OR (text_limit IS NOT NULL AND min_value IS NULL AND max_value IS NULL AND NOT is_assay AND NOT is_water)),
  CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value),
  CHECK (NOT (is_assay AND is_water))
);
CREATE UNIQUE INDEX spec_tests_one_assay_uq ON qc.spec_tests (spec_id) WHERE is_assay;
CREATE UNIQUE INDEX spec_tests_one_water_uq ON qc.spec_tests (spec_id) WHERE is_water;
SELECT core.enable_audit('qc.spec_tests');
SELECT core.enable_touch('qc.spec_tests');

-- Header: identity never changes; only a DRAFT is edited; submit needs tests; approval needs the approver's own
-- APPROVED signature on this spec, recorded in this transaction.
CREATE FUNCTION qc.guard_spec() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  it RECORD;
  sig RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT company_id, type, status INTO it FROM master.items WHERE id = NEW.item_id;
    IF it.company_id IS DISTINCT FROM NEW.company_id OR it.type NOT IN ('RM', 'PM', 'API', 'EXCIPIENT', 'BULK', 'FG') THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a QC specification is for an RM, PM, API, EXCIPIENT, BULK or FG item' USING ERRCODE = 'P0001';
    END IF;
    IF it.status = 'INACTIVE' THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: the item is inactive' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a specification is created in DRAFT' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.item_id IS DISTINCT FROM OLD.item_id OR NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a specification''s item and version never change' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.reference IS DISTINCT FROM OLD.reference OR NEW.notes IS DISTINCT FROM OLD.notes)
     AND NOT (OLD.status = 'DRAFT' AND NEW.status = 'DRAFT') THEN
    RAISE EXCEPTION 'RECORD_LOCKED: specification v% is % and cannot be edited; create a new version', OLD.version, OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF OLD.approved_by IS NOT NULL AND (NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.approval_esign_id IS DISTINCT FROM OLD.approval_esign_id) THEN
    RAISE EXCEPTION 'RECORD_LOCKED: a specification''s approval never changes' USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'PENDING_APPROVAL' THEN
    IF NOT EXISTS (SELECT 1 FROM qc.spec_tests WHERE spec_id = NEW.id) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a specification needs at least one test' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.submitted_by IS DISTINCT FROM core.current_user_id() THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: the submitter is the user who submits' USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.submitted_by IS DISTINCT FROM OLD.submitted_by AND NOT (OLD.status = 'PENDING_APPROVAL' AND NEW.status = 'DRAFT') THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: the submitter is set by the submission only' USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status = 'PENDING_APPROVAL' AND NEW.status = 'APPROVED' THEN
    SELECT user_id, meaning, record_table, record_id, tx_id INTO sig FROM core.e_signatures WHERE id = NEW.approval_esign_id;
    IF sig.user_id IS DISTINCT FROM NEW.approved_by OR NEW.approved_by IS DISTINCT FROM core.current_user_id()
       OR sig.meaning IS DISTINCT FROM 'APPROVED' OR sig.record_table IS DISTINCT FROM 'qc.specs'
       OR sig.record_id IS DISTINCT FROM NEW.id::text OR sig.tx_id IS DISTINCT FROM txid_current() THEN
      RAISE EXCEPTION 'ESIGN_FAILED: approving a specification needs the approver''s own APPROVED e-signature on it' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.approved_by = NEW.created_by OR NEW.approved_by = NEW.submitted_by THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: the approver of a specification is neither its drafter nor its submitter' USING ERRCODE = 'P0001';
    END IF;
  ELSIF OLD.approved_by IS NULL AND NEW.approved_by IS NOT NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a specification is approved only from PENDING_APPROVAL' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_spec BEFORE INSERT OR UPDATE ON qc.specs FOR EACH ROW EXECUTE FUNCTION qc.guard_spec();

-- A version becomes OBSOLETE only when a later version of the same item is APPROVED by the end of the transaction.
CREATE FUNCTION qc.check_spec_obsolete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'OBSOLETE' AND OLD.status IS DISTINCT FROM 'OBSOLETE' AND NOT EXISTS (
    SELECT 1 FROM qc.specs s WHERE s.item_id = NEW.item_id AND s.version > NEW.version AND s.status = 'APPROVED'
  ) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: specification v% becomes OBSOLETE only when a later version is approved', NEW.version USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_spec_obsolete AFTER UPDATE OF status ON qc.specs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qc.check_spec_obsolete();

-- Tests change only while their spec is DRAFT, and never move to another spec.
CREATE FUNCTION qc.guard_spec_tests() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sid BIGINT;
  st TEXT;
  cid BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN sid := OLD.spec_id; ELSE sid := NEW.spec_id; END IF;
  SELECT status, company_id INTO st, cid FROM qc.specs WHERE id = sid;
  IF st IS DISTINCT FROM 'DRAFT' OR (TG_OP = 'UPDATE' AND OLD.spec_id <> NEW.spec_id) THEN
    RAISE EXCEPTION 'RECORD_LOCKED: tests of a % specification cannot change', COALESCE(st, 'missing') USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.company_id IS DISTINCT FROM cid THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a test belongs to its specification''s company' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_spec_tests BEFORE INSERT OR UPDATE OR DELETE ON qc.spec_tests
  FOR EACH ROW EXECUTE FUNCTION qc.guard_spec_tests();
