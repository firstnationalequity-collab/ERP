-- 0001_core_identity: company, users, credentials, sessions, auth events, roles and permissions.
-- Design: docs/architecture.md §3, §5 (Core), §7.1; decisions Q1–Q9, Q14.

-- ---------------------------------------------------------------- acting company
-- Set per transaction by withTransaction() (app.company_id), like app.user_id.
CREATE FUNCTION core.current_company_id() RETURNS BIGINT
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.company_id', true), '')::BIGINT
$$;

-- Attach the updated_at/updated_by trigger (core.touch_updated from 0000) to a table.
CREATE FUNCTION core.enable_touch(target REGCLASS) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER touch_updated BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION core.touch_updated()',
    target
  );
END;
$$;

-- ---------------------------------------------------------------- companies
CREATE TABLE core.companies (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT        NOT NULL UNIQUE,
  name        TEXT        NOT NULL,
  ntn         TEXT,
  strn        TEXT,
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT      NOT NULL DEFAULT core.current_user_id(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT      NOT NULL DEFAULT core.current_user_id()
);

-- ---------------------------------------------------------------- users
-- No password hash here (see core.user_credentials). is_system = the SYSTEM user: no roles, cannot log in.
CREATE TABLE core.users (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id            BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  username              TEXT        NOT NULL CHECK (username ~ '^[A-Za-z0-9._-]{2,40}$'),
  full_name             TEXT        NOT NULL CHECK (length(trim(full_name)) > 0),
  email                 TEXT        CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+$'),
  is_system             BOOLEAN     NOT NULL DEFAULT false,
  is_active             BOOLEAN     NOT NULL DEFAULT true,
  failed_attempts       INTEGER     NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_at             TIMESTAMPTZ,
  password_changed_at   TIMESTAMPTZ,
  must_change_password  BOOLEAN     NOT NULL DEFAULT true,
  last_login_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT
);
-- Usernames are unique per company, case-insensitive.
CREATE UNIQUE INDEX users_username_uq ON core.users (company_id, lower(username));
CREATE UNIQUE INDEX users_email_uq ON core.users (company_id, lower(email)) WHERE email IS NOT NULL;

-- companies.created_by/updated_by → users: deferred, because the first company and the SYSTEM user
-- reference each other and are inserted in the same transaction below.
ALTER TABLE core.companies
  ADD CONSTRAINT companies_created_by_fk FOREIGN KEY (created_by) REFERENCES core.users (id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT companies_updated_by_fk FOREIGN KEY (updated_by) REFERENCES core.users (id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- Bootstrap rows every foreign key depends on: company 1 and the SYSTEM user 1.
-- (Structural rows, not seed data: no other row can be inserted without them.)
INSERT INTO core.companies (id, code, name, created_by, updated_by) OVERRIDING SYSTEM VALUE
VALUES (1, 'ALBERT', 'Albert Pharmaceuticals', 1, 1);
INSERT INTO core.users (id, company_id, username, full_name, is_system, must_change_password, created_by, updated_by)
OVERRIDING SYSTEM VALUE
VALUES (1, 1, 'SYSTEM', 'System (jobs and seeds)', true, false, 1, 1);
SELECT setval(pg_get_serial_sequence('core.companies', 'id'), 1);
SELECT setval(pg_get_serial_sequence('core.users', 'id'), 1);

-- The SYSTEM user can never be deactivated, renamed, given a login or deleted.
CREATE FUNCTION core.protect_system_user() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN
      RAISE EXCEPTION 'FORBIDDEN: the SYSTEM user cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.is_system THEN
    RAISE EXCEPTION 'FORBIDDEN: only one SYSTEM user exists' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (OLD.is_system OR NEW.is_system) THEN
    IF NEW.is_system IS DISTINCT FROM OLD.is_system
       OR NEW.username IS DISTINCT FROM OLD.username
       OR NEW.is_active IS DISTINCT FROM OLD.is_active
       OR NEW.must_change_password IS DISTINCT FROM OLD.must_change_password THEN
      RAISE EXCEPTION 'FORBIDDEN: the SYSTEM user cannot be changed' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_system_user BEFORE INSERT OR UPDATE OR DELETE ON core.users
  FOR EACH ROW EXECUTE FUNCTION core.protect_system_user();

-- ---------------------------------------------------------------- user credentials (NO audit trigger)
-- One row per password ever set; is_current marks the live one. Older rows block reuse of the last 5.
-- Deliberately not audited: the audit trigger would copy password hashes into audit_log forever.
-- Password changes are recorded in core.auth_events (PASSWORD_CHANGE) instead.
CREATE TABLE core.user_credentials (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id     BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  user_id        BIGINT      NOT NULL REFERENCES core.users (id) ON DELETE RESTRICT,
  password_hash  TEXT        NOT NULL CHECK (password_hash LIKE '$argon2%'),
  is_current     BOOLEAN     NOT NULL DEFAULT true,
  set_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX user_credentials_current_uq ON core.user_credentials (user_id) WHERE is_current;
CREATE INDEX user_credentials_user_idx ON core.user_credentials (user_id, set_at DESC);
SELECT core.enable_touch('core.user_credentials');

-- Credentials: no SYSTEM-user passwords; rows are never deleted and the hash is never rewritten
-- (the only allowed update is retiring the row: is_current true → false).
CREATE FUNCTION core.guard_user_credentials() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APPEND_ONLY: credentials are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM core.users WHERE id = NEW.user_id AND is_system) THEN
      RAISE EXCEPTION 'FORBIDDEN: the SYSTEM user cannot have a password' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.set_at IS DISTINCT FROM OLD.set_at
     OR (NEW.is_current AND NOT OLD.is_current) THEN
    RAISE EXCEPTION 'APPEND_ONLY: a credential row can only be retired' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_user_credentials BEFORE INSERT OR UPDATE OR DELETE ON core.user_credentials
  FOR EACH ROW EXECUTE FUNCTION core.guard_user_credentials();

-- ---------------------------------------------------------------- sessions (NO audit trigger)
-- One row per login. The refresh token rotates on every use; only the hash of the current token id is kept.
-- Presenting an older token of the same session = reuse → the whole session is revoked (TOKEN_REUSE).
-- Not audited (security infrastructure, rewritten every refresh); creation and revocation are in auth_events.
CREATE TABLE core.sessions (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id          BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  user_id             BIGINT      NOT NULL REFERENCES core.users (id) ON DELETE RESTRICT,
  current_token_hash  TEXT        NOT NULL,
  issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ,
  revoke_reason       TEXT        CHECK (revoke_reason IN ('LOGOUT', 'TOKEN_REUSE', 'PASSWORD_CHANGE', 'LOCKOUT', 'ADMIN')),
  ip                  TEXT,
  user_agent          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by          BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  CHECK (expires_at > issued_at)
);
CREATE INDEX sessions_user_active_idx ON core.sessions (user_id) WHERE revoked_at IS NULL;
SELECT core.enable_touch('core.sessions');

-- A revoked session stays revoked.
CREATE FUNCTION core.guard_sessions() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APPEND_ONLY: sessions are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'SESSION_REVOKED: session % is revoked', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
    RAISE EXCEPTION 'FORBIDDEN: session owner cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_sessions BEFORE UPDATE OR DELETE ON core.sessions
  FOR EACH ROW EXECUTE FUNCTION core.guard_sessions();

-- ---------------------------------------------------------------- auth events (insert-only log)
CREATE TABLE core.auth_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  user_id     BIGINT      REFERENCES core.users (id) ON DELETE RESTRICT,  -- NULL when the username is unknown
  username    TEXT        NOT NULL,                                       -- as typed
  event       TEXT        NOT NULL CHECK (event IN
                ('LOGIN_OK', 'LOGIN_FAIL', 'LOGOUT', 'LOCKOUT', 'UNLOCK', 'PASSWORD_CHANGE', 'ESIGN_FAIL', 'TOKEN_REUSE')),
  actor_id    BIGINT      REFERENCES core.users (id) ON DELETE RESTRICT,  -- who did it, when not the user (e.g. admin unlock)
  session_id  BIGINT      REFERENCES core.sessions (id) ON DELETE RESTRICT,
  ip          TEXT,
  user_agent  TEXT,
  details     JSONB,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_events_user_idx ON core.auth_events (user_id, at DESC);
CREATE INDEX auth_events_at_idx ON core.auth_events (at);
SELECT core.make_append_only('core.auth_events');

-- ---------------------------------------------------------------- permissions (catalogue synced from code)
-- Mirrors packages/shared/src/permissions.ts; the seed upserts it. Global catalogue, so no company_id.
CREATE TABLE core.permissions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key          TEXT        NOT NULL UNIQUE CHECK (key ~ '^[a-z]+(\.[a-z_]+)+$'),
  class        TEXT        NOT NULL CHECK (class IN ('ADMIN', 'VIEW', 'ACTION')),
  description  TEXT        NOT NULL,
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT
);
SELECT core.enable_audit('core.permissions');
SELECT core.enable_touch('core.permissions');

-- ---------------------------------------------------------------- roles
CREATE TABLE core.roles (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  code         TEXT        NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  name         TEXT        NOT NULL,
  description  TEXT,
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, code)
);

CREATE TABLE core.role_permissions (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id     BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  role_id        BIGINT      NOT NULL REFERENCES core.roles (id) ON DELETE RESTRICT,
  permission_id  BIGINT      NOT NULL REFERENCES core.permissions (id) ON DELETE RESTRICT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (role_id, permission_id)
);

CREATE TABLE core.user_roles (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  user_id     BIGINT      NOT NULL REFERENCES core.users (id) ON DELETE RESTRICT,
  role_id     BIGINT      NOT NULL REFERENCES core.roles (id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (user_id, role_id)
);
CREATE INDEX user_roles_role_idx ON core.user_roles (role_id);

-- Rule (Q1): a role holding an ADMIN key never holds an ACTION key. Checked in the service too.
CREATE FUNCTION core.guard_role_permission_classes() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  new_class TEXT;
BEGIN
  SELECT class INTO new_class FROM core.permissions WHERE id = NEW.permission_id;
  IF new_class = 'ACTION' AND EXISTS (
       SELECT 1 FROM core.role_permissions rp JOIN core.permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = NEW.role_id AND p.class = 'ADMIN' AND rp.id IS DISTINCT FROM NEW.id) THEN
    RAISE EXCEPTION 'ROLE_ADMIN_CONFLICT: role % holds an admin key and cannot hold an action key', NEW.role_id
      USING ERRCODE = 'P0001';
  END IF;
  IF new_class = 'ADMIN' AND EXISTS (
       SELECT 1 FROM core.role_permissions rp JOIN core.permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = NEW.role_id AND p.class = 'ACTION' AND rp.id IS DISTINCT FROM NEW.id) THEN
    RAISE EXCEPTION 'ROLE_ADMIN_CONFLICT: role % holds an action key and cannot hold an admin key', NEW.role_id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_role_permission_classes BEFORE INSERT OR UPDATE ON core.role_permissions
  FOR EACH ROW EXECUTE FUNCTION core.guard_role_permission_classes();

-- A permission's class cannot be changed once roles use it (that would bypass the check above).
CREATE FUNCTION core.guard_permission_class() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.class IS DISTINCT FROM OLD.class
     AND EXISTS (SELECT 1 FROM core.role_permissions WHERE permission_id = OLD.id) THEN
    RAISE EXCEPTION 'ROLE_ADMIN_CONFLICT: permission % is in use; its class cannot change', OLD.key
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_permission_class BEFORE UPDATE ON core.permissions
  FOR EACH ROW EXECUTE FUNCTION core.guard_permission_class();

-- Rule (Q1): nobody changes their own role assignments; the SYSTEM user holds no roles.
CREATE FUNCTION core.guard_user_roles() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN target := OLD.user_id; ELSE target := NEW.user_id; END IF;
  IF target = core.current_user_id()
     OR (TG_OP = 'UPDATE' AND OLD.user_id = core.current_user_id()) THEN
    RAISE EXCEPTION 'SELF_ROLE_CHANGE: you cannot change your own role assignments' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP <> 'DELETE' AND EXISTS (SELECT 1 FROM core.users WHERE id = NEW.user_id AND is_system) THEN
    RAISE EXCEPTION 'FORBIDDEN: the SYSTEM user holds no roles' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_user_roles BEFORE INSERT OR UPDATE OR DELETE ON core.user_roles
  FOR EACH ROW EXECUTE FUNCTION core.guard_user_roles();

-- ---------------------------------------------------------------- audit + touch on business tables
SELECT core.enable_audit('core.companies');
SELECT core.enable_touch('core.companies');
SELECT core.enable_audit('core.users');
SELECT core.enable_touch('core.users');
SELECT core.enable_audit('core.roles');
SELECT core.enable_touch('core.roles');
SELECT core.enable_audit('core.role_permissions');
SELECT core.enable_touch('core.role_permissions');
SELECT core.enable_audit('core.user_roles');
SELECT core.enable_touch('core.user_roles');
-- core.user_credentials and core.sessions: deliberately NOT audited (see above).
