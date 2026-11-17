-- 0002_esign_transition: e-signatures and the generic status history (rules 7 and 8).
-- Design: docs/architecture.md §1 rules 7-8, §4, §5 (Core); decisions Q3, Q10.

-- ---------------------------------------------------------------- e-signatures (append-only)
-- One row per signature. The signer's username and full name are copied at signing time, so the printed
-- name stays correct even if the user is renamed later (21 CFR Part 11 §11.50 manifestation).
CREATE TABLE core.e_signatures (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id    BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  user_id       BIGINT      NOT NULL REFERENCES core.users (id) ON DELETE RESTRICT,
  signer_username TEXT      NOT NULL,
  signer_name   TEXT        NOT NULL,
  meaning       TEXT        NOT NULL CHECK (meaning IN ('REVIEWED', 'APPROVED', 'RELEASED', 'REJECTED', 'WITNESSED', 'PERFORMED')),
  reason        TEXT        NOT NULL CHECK (length(trim(reason)) >= 3),
  record_table  TEXT        NOT NULL,
  record_id     TEXT        NOT NULL,
  signed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip            TEXT,
  user_agent    TEXT,
  tx_id         BIGINT      NOT NULL DEFAULT txid_current(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT
);
CREATE INDEX e_signatures_record_idx ON core.e_signatures (record_table, record_id);
CREATE INDEX e_signatures_user_idx ON core.e_signatures (user_id, signed_at DESC);
SELECT core.enable_audit('core.e_signatures');
SELECT core.make_append_only('core.e_signatures');

-- The SYSTEM user never signs.
CREATE FUNCTION core.guard_e_signatures() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM core.users WHERE id = NEW.user_id AND is_system) THEN
    RAISE EXCEPTION 'ESIGN_FAILED: the SYSTEM user cannot sign' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_e_signatures BEFORE INSERT ON core.e_signatures
  FOR EACH ROW EXECUTE FUNCTION core.guard_e_signatures();

-- ---------------------------------------------------------------- status history (append-only)
-- Written only by core/transition. from_status is NULL for the initial status of a new record.
CREATE TABLE core.status_history (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id        BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  entity_table      TEXT        NOT NULL,
  entity_id         TEXT        NOT NULL,
  from_status       TEXT,
  to_status         TEXT        NOT NULL,
  actor_id          BIGINT      NOT NULL REFERENCES core.users (id) ON DELETE RESTRICT,
  esign_id          BIGINT      REFERENCES core.e_signatures (id) ON DELETE RESTRICT,
  witness_esign_id  BIGINT      REFERENCES core.e_signatures (id) ON DELETE RESTRICT,
  reason            TEXT,
  at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  tx_id             BIGINT      NOT NULL DEFAULT txid_current(),
  CHECK (from_status IS DISTINCT FROM to_status),
  CHECK (witness_esign_id IS NULL OR witness_esign_id IS DISTINCT FROM esign_id)
);
CREATE INDEX status_history_entity_idx ON core.status_history (entity_table, entity_id, id);
SELECT core.make_append_only('core.status_history');

-- ---------------------------------------------------------------- rule 7 in the database
-- Attach to every table whose `status` is governed by core/transition:
--   SELECT core.require_transition('<schema>.<table>');
-- An INSERT or a status UPDATE is refused unless core/transition wrote the matching status_history row
-- earlier in the same transaction. A raw `UPDATE ... SET status = ...` therefore always fails.
CREATE FUNCTION core.require_transition_trigger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tbl TEXT := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM core.status_history h
     WHERE h.entity_table = tbl
       AND h.entity_id = NEW.id::text
       AND h.to_status = NEW.status
       AND h.from_status IS NOT DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.status END)
       AND h.tx_id = txid_current()
  ) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: status of % % must change through core/transition', tbl, NEW.id
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION core.require_transition(target REGCLASS) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- Constraint trigger, deferred to commit for INSERT: the row id is known only after the insert,
  -- so the history row for a new record is written right after it, in the same transaction.
  EXECUTE format(
    'CREATE CONSTRAINT TRIGGER require_transition AFTER INSERT OR UPDATE OF status ON %s '
    'DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.require_transition_trigger()',
    target
  );
END;
$$;
