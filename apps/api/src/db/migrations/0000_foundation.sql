-- 0000_foundation: schemas, audit trail, immutability guards.
-- Every later migration that creates a business table must:
--   SELECT core.enable_audit('<schema>.<table>');
-- and, for documents with a status column that can be POSTED:
--   SELECT core.protect_posted('<schema>.<table>');
-- and, for pure ledgers (stock_movements, journal_lines):
--   SELECT core.make_append_only('<schema>.<table>');

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS inv;
CREATE SCHEMA IF NOT EXISTS sales;
CREATE SCHEMA IF NOT EXISTS purch;
CREATE SCHEMA IF NOT EXISTS qc;
CREATE SCHEMA IF NOT EXISTS prod;
CREATE SCHEMA IF NOT EXISTS qa;
CREATE SCHEMA IF NOT EXISTS fin;

-- ---------------------------------------------------------------- audit log
CREATE TABLE core.audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name  TEXT        NOT NULL,
  record_id   TEXT        NOT NULL,
  action      TEXT        NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  old_data    JSONB,
  new_data    JSONB,
  changed_by  BIGINT,                 -- core.users.id; NULL only for system jobs/migrations
  reason      TEXT,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  tx_id       BIGINT      NOT NULL DEFAULT txid_current()
);
CREATE INDEX audit_log_record_idx ON core.audit_log (table_name, record_id);
CREATE INDEX audit_log_changed_at_idx ON core.audit_log (changed_at);

-- Who is acting: set per transaction by withTransaction() in apps/api/src/db/client.ts
CREATE FUNCTION core.current_user_id() RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::BIGINT
$$;

CREATE FUNCTION core.audit_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rec_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    rec_id := to_jsonb(OLD) ->> 'id';
  ELSE
    rec_id := to_jsonb(NEW) ->> 'id';
  END IF;

  INSERT INTO core.audit_log (table_name, record_id, action, old_data, new_data, changed_by, reason)
  VALUES (
    TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
    rec_id,
    TG_OP,
    CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END,
    core.current_user_id(),
    NULLIF(current_setting('app.reason', true), '')
  );
  RETURN NULL; -- AFTER trigger
END;
$$;

-- Attach the audit trigger to a table.
CREATE FUNCTION core.enable_audit(target REGCLASS) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION core.audit_trigger()',
    target
  );
END;
$$;

-- ---------------------------------------------------------------- append-only tables
CREATE FUNCTION core.reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$;

CREATE FUNCTION core.make_append_only(target REGCLASS) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION core.reject_change()',
    target
  );
END;
$$;

SELECT core.make_append_only('core.audit_log');

-- ---------------------------------------------------------------- posted documents
-- A POSTED row may only change status to REVERSED (plus reversal bookkeeping columns).
-- Non-DRAFT rows may never be deleted.
CREATE FUNCTION core.protect_posted_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed_keys TEXT[] := ARRAY['status', 'updated_at', 'updated_by', 'reversed_at', 'reversed_by', 'reversal_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'POSTED_IMMUTABLE: cannot delete % row % in status %', TG_TABLE_NAME, OLD.id, OLD.status
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'REVERSED' THEN
    RAISE EXCEPTION 'POSTED_IMMUTABLE: % row % is reversed', TG_TABLE_NAME, OLD.id USING ERRCODE = 'P0001';
  END IF;

  IF OLD.status = 'POSTED' THEN
    IF NEW.status <> 'REVERSED'
       OR (to_jsonb(NEW) - allowed_keys) IS DISTINCT FROM (to_jsonb(OLD) - allowed_keys) THEN
      RAISE EXCEPTION 'POSTED_IMMUTABLE: % row % is posted; create a reversal instead', TG_TABLE_NAME, OLD.id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION core.protect_posted(target REGCLASS) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER protect_posted BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION core.protect_posted_trigger()',
    target
  );
END;
$$;

-- ---------------------------------------------------------------- updated_at helper
CREATE FUNCTION core.touch_updated() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := COALESCE(core.current_user_id(), NEW.updated_by);
  RETURN NEW;
END;
$$;
