-- 0003_numbering_periods: number series and fiscal periods (rule 11; docs/architecture.md §7.1; decision Q16).

CREATE EXTENSION IF NOT EXISTS btree_gist; -- for the no-overlap constraint on fiscal periods

-- ---------------------------------------------------------------- number series
-- Pattern tokens {PREFIX} {FY} {YYYY} {YY} {SEQ:n}; validated in the service (numberPatternErrors).
CREATE TABLE core.number_series (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  doc_type    TEXT        NOT NULL CHECK (doc_type ~ '^[A-Z][A-Z0-9_]{1,29}$'),
  name        TEXT        NOT NULL,
  prefix      TEXT        NOT NULL CHECK (prefix ~ '^[A-Za-z0-9]{0,10}$'),
  pattern     TEXT        NOT NULL CHECK (pattern LIKE '%{SEQ:%}%'),
  reset       TEXT        NOT NULL CHECK (reset IN ('FISCAL_YEAR', 'CALENDAR_YEAR', 'NEVER')),
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, doc_type)
);
SELECT core.enable_audit('core.number_series');
SELECT core.enable_touch('core.number_series');

-- One counter per series per reset bucket ('2627', '2026' or 'ALL'). Taken with one atomic upsert that
-- holds the row lock until the business transaction ends: no duplicates, and a rollback leaves no gap.
-- Not audited (it changes on every document; the documents themselves are audited).
CREATE TABLE core.number_series_counters (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id  BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  series_id   BIGINT      NOT NULL REFERENCES core.number_series (id) ON DELETE RESTRICT,
  period_key  TEXT        NOT NULL CHECK (period_key ~ '^(\d{4}|ALL)$'),
  next_value  BIGINT      NOT NULL CHECK (next_value >= 1),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (series_id, period_key)
);
SELECT core.enable_touch('core.number_series_counters');

-- Counters only move forward and are never deleted (a number is never handed out twice).
CREATE FUNCTION core.guard_number_counters() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APPEND_ONLY: number counters are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.next_value < OLD.next_value OR NEW.series_id <> OLD.series_id OR NEW.period_key <> OLD.period_key THEN
    RAISE EXCEPTION 'APPEND_ONLY: number counters only move forward' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_number_counters BEFORE UPDATE OR DELETE ON core.number_series_counters
  FOR EACH ROW EXECUTE FUNCTION core.guard_number_counters();

-- ---------------------------------------------------------------- fiscal periods
-- Monthly periods, fiscal year July–June. Status OPEN/CLOSED, changed only through core/transition.
CREATE TABLE core.fiscal_periods (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  fiscal_year  TEXT        NOT NULL CHECK (fiscal_year ~ '^\d{4}-\d{2}$'),
  period_no    INTEGER     NOT NULL CHECK (period_no BETWEEN 1 AND 12),
  name         TEXT        NOT NULL,
  start_date   DATE        NOT NULL,
  end_date     DATE        NOT NULL,
  status       TEXT        NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  CHECK (end_date >= start_date),
  UNIQUE (company_id, fiscal_year, period_no),
  EXCLUDE USING gist (company_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
);
SELECT core.enable_audit('core.fiscal_periods');
SELECT core.enable_touch('core.fiscal_periods');
SELECT core.require_transition('core.fiscal_periods');

-- Periods are never deleted, and their dates never change once created.
CREATE FUNCTION core.guard_fiscal_periods() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APPEND_ONLY: fiscal periods are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.start_date <> OLD.start_date OR NEW.end_date <> OLD.end_date
     OR NEW.fiscal_year <> OLD.fiscal_year OR NEW.period_no <> OLD.period_no THEN
    RAISE EXCEPTION 'FORBIDDEN: fiscal period dates cannot change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_fiscal_periods BEFORE UPDATE OR DELETE ON core.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION core.guard_fiscal_periods();

-- ---------------------------------------------------------------- rule 11 in the database
-- Raises unless `posting_date` falls in an OPEN period of the company. Takes a share lock on the
-- period row, so a concurrent close waits until this posting transaction ends.
CREATE FUNCTION core.assert_period_open(p_company BIGINT, posting_date DATE) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  p RECORD;
BEGIN
  SELECT id, name, status INTO p FROM core.fiscal_periods
   WHERE company_id = p_company AND posting_date BETWEEN start_date AND end_date
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PERIOD_NOT_DEFINED: no fiscal period covers %', to_char(posting_date, 'DD-MM-YYYY')
      USING ERRCODE = 'P0001';
  END IF;
  IF p.status <> 'OPEN' THEN
    RAISE EXCEPTION 'PERIOD_CLOSED: fiscal period % is closed; posting on % refused', p.name, to_char(posting_date, 'DD-MM-YYYY')
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Attach to every posting table: SELECT core.require_open_period('<schema>.<table>', '<date column>');
-- Checks on INSERT of a row that is POSTED (or of any row, for tables without a status column such as
-- ledgers) and on UPDATE to POSTED. Marking an old document REVERSED is not a posting and is allowed;
-- the reversing document itself is checked against its own date.
CREATE FUNCTION core.require_open_period_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  row_json JSONB := to_jsonb(NEW);
  posting_date DATE;
  is_posting BOOLEAN;
BEGIN
  IF row_json ? 'status' THEN
    is_posting := (row_json ->> 'status') = 'POSTED'
                  AND (TG_OP = 'INSERT' OR (to_jsonb(OLD) ->> 'status') IS DISTINCT FROM 'POSTED');
  ELSE
    is_posting := TG_OP = 'INSERT';
  END IF;
  IF is_posting THEN
    posting_date := (row_json ->> TG_ARGV[0])::DATE;
    IF posting_date IS NULL THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: % is required to post', TG_ARGV[0] USING ERRCODE = 'P0001';
    END IF;
    PERFORM core.assert_period_open((row_json ->> 'company_id')::BIGINT, posting_date);
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION core.require_open_period(target REGCLASS, date_column TEXT) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER require_open_period BEFORE INSERT OR UPDATE ON %s FOR EACH ROW '
    'EXECUTE FUNCTION core.require_open_period_trigger(%L)',
    target, date_column
  );
END;
$$;
