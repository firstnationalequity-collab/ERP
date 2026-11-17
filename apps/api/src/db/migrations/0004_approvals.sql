-- 0004_approvals: approval matrix, approval requests and steps (docs/architecture.md §3; decisions Q12, Q13).
-- Bands: value > lower_bound (exclusive, NULL = no lower limit) AND value <= upper_bound (inclusive, NULL = none).
-- Steps with the same step_no run in parallel ("and": all must approve, any order);
-- a higher step_no opens only when every step of the lower one is approved ("then").

CREATE TABLE core.approval_rules (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  doc_type     TEXT          NOT NULL CHECK (doc_type ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  measure      TEXT          NOT NULL CHECK (measure IN ('AMOUNT_PKR', 'PERCENT', 'NONE')),
  lower_bound  NUMERIC(18,4),
  upper_bound  NUMERIC(18,4),
  step_no      INTEGER       NOT NULL CHECK (step_no BETWEEN 1 AND 9),
  role_id      BIGINT        NOT NULL REFERENCES core.roles (id) ON DELETE RESTRICT,
  is_active    BOOLEAN       NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by   BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by   BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  CHECK (measure <> 'NONE' OR (lower_bound IS NULL AND upper_bound IS NULL)),
  CHECK (lower_bound IS NULL OR upper_bound IS NULL OR lower_bound < upper_bound)
);
CREATE INDEX approval_rules_doc_idx ON core.approval_rules (company_id, doc_type) WHERE is_active;
SELECT core.enable_audit('core.approval_rules');
SELECT core.enable_touch('core.approval_rules');

-- Rules are never deleted (approvals reference the matrix that applied); a rule set is replaced by
-- deactivating the old rows and inserting new ones.
CREATE FUNCTION core.guard_approval_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APPEND_ONLY: approval rules are never deleted; deactivate them' USING ERRCODE = 'P0001';
  END IF;
  IF NOT OLD.is_active AND NEW.is_active THEN
    RAISE EXCEPTION 'FORBIDDEN: a replaced approval rule cannot be reactivated' USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['is_active', 'updated_at', 'updated_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['is_active', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'APPEND_ONLY: approval rules cannot be edited; replace the rule set' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_approval_rules BEFORE UPDATE OR DELETE ON core.approval_rules
  FOR EACH ROW EXECUTE FUNCTION core.guard_approval_rules();

-- ---------------------------------------------------------------- approval requests
CREATE TABLE core.approvals (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  doc_type        TEXT          NOT NULL,
  doc_table       TEXT          NOT NULL CHECK (doc_table ~ '^[a-z_]+\.[a-z_]+$'),
  doc_id          TEXT          NOT NULL,
  doc_no          TEXT,
  measure         TEXT          NOT NULL CHECK (measure IN ('AMOUNT_PKR', 'PERCENT', 'NONE')),
  amount          NUMERIC(18,2),                   -- in the document currency (AMOUNT_PKR measure)
  currency        TEXT          CHECK (currency ~ '^[A-Z]{3}$'),
  exchange_rate   NUMERIC(9,4)  CHECK (exchange_rate > 0),
  measured_value  NUMERIC(18,4),                   -- PKR amount or percent the band was chosen on
  requested_by    BIGINT        NOT NULL REFERENCES core.users (id) ON DELETE RESTRICT,
  status          TEXT          NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  decided_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by      BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by      BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  CHECK ((measure = 'NONE') = (measured_value IS NULL)),
  CHECK ((currency IS NULL) = (exchange_rate IS NULL))
);
-- At most one open approval per document.
CREATE UNIQUE INDEX approvals_open_doc_uq ON core.approvals (doc_table, doc_id) WHERE status = 'PENDING';
CREATE INDEX approvals_requested_by_idx ON core.approvals (requested_by, status);
SELECT core.enable_audit('core.approvals');
SELECT core.enable_touch('core.approvals');
SELECT core.require_transition('core.approvals');

CREATE TABLE core.approval_steps (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  approval_id  BIGINT      NOT NULL REFERENCES core.approvals (id) ON DELETE RESTRICT,
  step_no      INTEGER     NOT NULL CHECK (step_no BETWEEN 1 AND 9),
  role_id      BIGINT      NOT NULL REFERENCES core.roles (id) ON DELETE RESTRICT,
  rule_id      BIGINT      REFERENCES core.approval_rules (id) ON DELETE RESTRICT,
  status       TEXT        NOT NULL CHECK (status IN ('WAITING', 'PENDING', 'APPROVED', 'REJECTED', 'SKIPPED')),
  acted_by     BIGINT      REFERENCES core.users (id) ON DELETE RESTRICT,
  acted_at     TIMESTAMPTZ,
  esign_id     BIGINT      REFERENCES core.e_signatures (id) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  -- A decided step always names its signer and e-signature (recorded just before the status changes).
  CHECK (status NOT IN ('APPROVED', 'REJECTED') OR (acted_by IS NOT NULL AND esign_id IS NOT NULL AND acted_at IS NOT NULL)),
  CHECK (status NOT IN ('WAITING', 'SKIPPED') OR acted_by IS NULL)
);
CREATE INDEX approval_steps_inbox_idx ON core.approval_steps (role_id) WHERE status = 'PENDING';
CREATE INDEX approval_steps_approval_idx ON core.approval_steps (approval_id, step_no);
-- One person approves at most one step of the same approval ("and" means two different people).
CREATE UNIQUE INDEX approval_steps_one_per_person_uq ON core.approval_steps (approval_id, acted_by)
  WHERE acted_by IS NOT NULL;
SELECT core.enable_audit('core.approval_steps');
SELECT core.enable_touch('core.approval_steps');
SELECT core.require_transition('core.approval_steps');

-- Segregation of duties in the database: the requester never approves or rejects their own document,
-- and a decided step never changes again.
CREATE FUNCTION core.guard_approval_steps() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APPEND_ONLY: approval steps are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('APPROVED', 'REJECTED', 'SKIPPED') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: approval step % is already %', OLD.id, OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.acted_by IS NOT NULL
     AND EXISTS (SELECT 1 FROM core.approvals a WHERE a.id = NEW.approval_id AND a.requested_by = NEW.acted_by) THEN
    RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: the requester cannot approve their own document' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.approval_id <> OLD.approval_id OR NEW.role_id <> OLD.role_id OR NEW.step_no <> OLD.step_no THEN
    RAISE EXCEPTION 'FORBIDDEN: approval steps cannot be re-routed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_approval_steps BEFORE UPDATE OR DELETE ON core.approval_steps
  FOR EACH ROW EXECUTE FUNCTION core.guard_approval_steps();

CREATE FUNCTION core.guard_approvals() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APPEND_ONLY: approvals are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: approval % is already %', OLD.id, OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'decided_at', 'updated_at', 'updated_by'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'decided_at', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'FORBIDDEN: an approval request cannot be edited' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_approvals BEFORE UPDATE OR DELETE ON core.approvals
  FOR EACH ROW EXECUTE FUNCTION core.guard_approvals();
