-- 0005_idempotency_attachments: Idempotency-Key store and attachments (docs/architecture.md §7.1; decisions Q11, Q17).

-- ---------------------------------------------------------------- idempotency keys
-- One row per (user, key). Claimed IN_PROGRESS before the action runs; COMPLETED with the response after.
-- A 5xx releases the claim (row deleted) so the client may retry. Expires after 24 hours.
-- Not audited: request plumbing, not business data (the documents themselves are audited).
CREATE TABLE core.idempotency_keys (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id       BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  user_id          BIGINT      NOT NULL REFERENCES core.users (id) ON DELETE RESTRICT,
  key              TEXT        NOT NULL CHECK (length(key) BETWEEN 8 AND 200),
  endpoint         TEXT        NOT NULL,
  request_hash     TEXT        NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status           TEXT        NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
  response_status  INTEGER     CHECK (response_status BETWEEN 200 AND 499),
  response_body    JSONB,
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (user_id, key),
  CHECK ((status = 'COMPLETED') = (response_status IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX idempotency_keys_expires_idx ON core.idempotency_keys (expires_at);
SELECT core.enable_touch('core.idempotency_keys');

-- A completed key never changes and is removed only after it expires; an in-progress claim may be
-- completed once or released.
CREATE FUNCTION core.guard_idempotency_keys() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'COMPLETED' AND OLD.expires_at > now() THEN
      RAISE EXCEPTION 'APPEND_ONLY: a completed idempotency key is kept until it expires' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'APPEND_ONLY: a completed idempotency key cannot change' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.key <> OLD.key OR NEW.user_id <> OLD.user_id OR NEW.endpoint <> OLD.endpoint OR NEW.request_hash <> OLD.request_hash THEN
    RAISE EXCEPTION 'APPEND_ONLY: an idempotency claim cannot be re-pointed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_idempotency_keys BEFORE UPDATE OR DELETE ON core.idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION core.guard_idempotency_keys();

-- ---------------------------------------------------------------- attachments (insert-only)
-- Files live in storage (local disk now, S3 in M10) under a random key; the database keeps the
-- metadata and the SHA-256, which is re-checked on every download.
CREATE TABLE core.attachments (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id      BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  record_table    TEXT        NOT NULL CHECK (record_table ~ '^[a-z_]+\.[a-z_]+$'),
  record_id       TEXT        NOT NULL CHECK (record_id ~ '^\d+$'),
  file_name       TEXT        NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  content_type    TEXT        NOT NULL,
  size_bytes      BIGINT      NOT NULL CHECK (size_bytes > 0),
  sha256          TEXT        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_driver  TEXT        NOT NULL CHECK (storage_driver IN ('local', 's3')),
  storage_key     TEXT        NOT NULL UNIQUE,
  description     TEXT        CHECK (description IS NULL OR length(description) <= 500),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT
);
CREATE INDEX attachments_record_idx ON core.attachments (record_table, record_id);
SELECT core.enable_audit('core.attachments');
SELECT core.make_append_only('core.attachments');
