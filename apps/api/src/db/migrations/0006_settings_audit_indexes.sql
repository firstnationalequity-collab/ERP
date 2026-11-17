-- 0006_settings_audit_indexes: company settings and indexes for the audit trail viewer.

-- ---------------------------------------------------------------- settings
-- One row per key that differs from its default. Keys and value shapes are declared in code by each
-- module (registerSetting), so an unknown key can never be written.
CREATE TABLE core.settings (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  key         TEXT        NOT NULL CHECK (key ~ '^[a-z]+(\.[a-z_]+)+$'),
  value       JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, key)
);
SELECT core.enable_audit('core.settings');
SELECT core.enable_touch('core.settings');

CREATE FUNCTION core.guard_settings() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY: settings are changed, never deleted' USING ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER guard_settings BEFORE DELETE ON core.settings
  FOR EACH ROW EXECUTE FUNCTION core.guard_settings();

-- ---------------------------------------------------------------- audit viewer indexes
CREATE INDEX audit_log_changed_by_idx ON core.audit_log (changed_by, changed_at DESC);
CREATE INDEX audit_log_table_time_idx ON core.audit_log (table_name, changed_at DESC);
