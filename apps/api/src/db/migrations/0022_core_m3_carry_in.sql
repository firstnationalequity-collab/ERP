-- 0022_core_m3_carry_in: owner decisions 2026-11-19 carried into M3 (decisions.md Q2, Q3, Q4, Q5).
--   1. Fiscal periods close and reopen in order: the CLOSED periods are always the earliest ones.
--      (The Finance Manager e-signature on reopen is enforced by core/transition in the service.)
--   2. One user may not hold both a role with an ADMIN key and a role with an ACTION key.
--      Existing users are checked first: any violator stops this migration with the list (owner 2026-11-25).
--   3. Attachments: "void with reason". The file is kept; the row is marked void once, never deleted.

-- ---------------------------------------------------------------- 1. period order (Q2, Q3)
-- Invariant per company: no OPEN period starts before a CLOSED one. So only the earliest OPEN period can
-- close, and only the latest CLOSED period can reopen; a new period is never created before a CLOSED one.
-- An advisory lock per company serialises these checks (two closes at once cannot both pass).
CREATE FUNCTION core.guard_fiscal_period_order() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  blocker RECORD;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('core.fiscal_periods'), NEW.company_id::int);

  IF NEW.status = 'CLOSED' THEN
    SELECT name INTO blocker FROM core.fiscal_periods
     WHERE company_id = NEW.company_id AND status = 'OPEN' AND start_date < NEW.start_date AND id <> NEW.id
     ORDER BY start_date LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'PERIOD_OUT_OF_ORDER: % is still open; periods close in order', blocker.name
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT name INTO blocker FROM core.fiscal_periods
     WHERE company_id = NEW.company_id AND status = 'CLOSED' AND start_date > NEW.start_date AND id <> NEW.id
     ORDER BY start_date DESC LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'PERIOD_OUT_OF_ORDER: % is closed; reopen the latest closed period first', blocker.name
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_fiscal_period_order BEFORE INSERT OR UPDATE OF status ON core.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION core.guard_fiscal_period_order();

-- ---------------------------------------------------------------- 2. admin + action per user (Q4)
-- Roles count whether active or not: an inactive role can be reactivated without touching user_roles.
CREATE FUNCTION core.user_mixes_admin_action(p_user BIGINT) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT bool_or(p.class = 'ADMIN') AND bool_or(p.class = 'ACTION')
    FROM core.user_roles ur
    JOIN core.role_permissions rp ON rp.role_id = ur.role_id
    JOIN core.permissions p ON p.id = rp.permission_id
   WHERE ur.user_id = p_user
$$;

DO $$
DECLARE
  offenders TEXT;
BEGIN
  SELECT string_agg(u.username, ', ' ORDER BY u.username) INTO offenders
    FROM core.users u
   WHERE core.user_mixes_admin_action(u.id);
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'ROLE_ADMIN_CONFLICT: these users hold both an admin role and an action role: %. Fix their role assignments before migrating (owner 2026-11-25)', offenders
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Assigning a role to a user.
CREATE FUNCTION core.guard_user_role_classes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF core.user_mixes_admin_action(NEW.user_id) THEN
    RAISE EXCEPTION 'ROLE_ADMIN_CONFLICT: user % would hold both an admin role and an action role', NEW.user_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER guard_user_role_classes AFTER INSERT OR UPDATE ON core.user_roles
  FOR EACH ROW EXECUTE FUNCTION core.guard_user_role_classes();

-- Adding a key to a role that users already hold.
CREATE FUNCTION core.guard_role_key_holders() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  offender TEXT;
BEGIN
  SELECT u.username INTO offender
    FROM core.user_roles ur JOIN core.users u ON u.id = ur.user_id
   WHERE ur.role_id = NEW.role_id AND core.user_mixes_admin_action(ur.user_id)
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ROLE_ADMIN_CONFLICT: user % would hold both an admin role and an action role', offender
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER guard_role_key_holders AFTER INSERT OR UPDATE ON core.role_permissions
  FOR EACH ROW EXECUTE FUNCTION core.guard_role_key_holders();

-- ---------------------------------------------------------------- 3. attachments: void with reason (Q5)
ALTER TABLE core.attachments
  ADD COLUMN voided_at   TIMESTAMPTZ,
  ADD COLUMN voided_by   BIGINT REFERENCES core.users (id) ON DELETE RESTRICT,
  ADD COLUMN void_reason TEXT,
  ADD CONSTRAINT attachments_void_complete CHECK (
    (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
    OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND length(trim(void_reason)) >= 3 AND length(void_reason) <= 500)
  );

-- Replaces the insert-only trigger: never deleted; the only change is marking the row void, once, by the
-- current user (the file itself is never touched).
DROP TRIGGER append_only ON core.attachments;
CREATE FUNCTION core.guard_attachments() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APPEND_ONLY: attachments are never deleted; void them with a reason' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'APPEND_ONLY: attachment % is already void', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.voided_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['voided_at', 'voided_by', 'void_reason', 'updated_at', 'updated_by'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['voided_at', 'voided_by', 'void_reason', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'APPEND_ONLY: an attachment can only be voided' USING ERRCODE = 'P0001';
  END IF;
  NEW.voided_at := now();
  NEW.voided_by := core.current_user_id();
  NEW.updated_at := now();
  NEW.updated_by := NEW.voided_by;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_attachments BEFORE UPDATE OR DELETE ON core.attachments
  FOR EACH ROW EXECUTE FUNCTION core.guard_attachments();
