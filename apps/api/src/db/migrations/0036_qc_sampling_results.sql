-- 0036 (M4 task 2): sample queue, sampling, results and review (architecture §4 lot table, §5 QC, §7.6).
--   qc.sample_requests  OPEN → SAMPLED (qc.result.enter): the analyst takes the sample. In ONE transaction the lot
--                       moves QUARANTINE / RETEST_DUE → UNDER_TEST, the SAMPLE_ISSUE movements (0035) take the test
--                       quantity (and any retention quantity) out of the lot with their QC_SAMPLE journal, and the
--                       request records the APPROVED spec version it is tested against (pinned), who sampled, where
--                       and how much. Sampling fields never change afterwards. ref_doc_type gains PRODUCTION_OUTPUT
--                       (M6 raises FG requests under prod.output.verify).
--   qc.results          insert-only, one row per spec test of a SAMPLED request (a re-test is a new row: task 4).
--                       NUMERIC: the value; pass is computed from the pinned limits (min ≤ value ≤ max) and the
--                       database refuses any other. TEXT: the observation and the analyst's complies yes/no.
--                       Entered by a holder of qc.result.enter. A failed result on an FG lot leaves the lot in HOLD
--                       at commit (owner 2026-11-18: UNDER_TEST → HOLD with the result, qc.result.enter).
--   qc.result_reviews   insert-only, one per result: the reviewer (qc.result.review) is not the analyst who entered
--                       it (SEGREGATION_OF_DUTIES) and signs REVIEWED on the sample request in the same transaction.

-- ---------------------------------------------------------------- sample requests
ALTER TABLE qc.sample_requests DROP CONSTRAINT sample_requests_status_check;
ALTER TABLE qc.sample_requests ADD CONSTRAINT sample_requests_status_check CHECK (status = ANY (ARRAY['OPEN', 'SAMPLED', 'CANCELLED']));
ALTER TABLE qc.sample_requests DROP CONSTRAINT sample_requests_ref_doc_type_check;
ALTER TABLE qc.sample_requests ADD CONSTRAINT sample_requests_ref_doc_type_check CHECK (ref_doc_type IN ('GRN', 'PRODUCTION_OUTPUT'));

ALTER TABLE qc.sample_requests
  ADD COLUMN spec_id            BIGINT        REFERENCES qc.specs (id) ON DELETE RESTRICT,
  ADD COLUMN sampled_by         BIGINT        REFERENCES core.users (id) ON DELETE RESTRICT,
  ADD COLUMN sampled_at         TIMESTAMPTZ,
  ADD COLUMN sample_location_id BIGINT        REFERENCES master.locations (id) ON DELETE RESTRICT,
  ADD COLUMN test_qty           NUMERIC(18,4) CHECK (test_qty IS NULL OR test_qty > 0),
  ADD COLUMN retention_qty      NUMERIC(18,4) CHECK (retention_qty IS NULL OR retention_qty >= 0),
  ADD COLUMN sample_notes       TEXT          CHECK (sample_notes IS NULL OR length(sample_notes) <= 1000),
  ADD CONSTRAINT sample_requests_sampled_fields CHECK (
    CASE WHEN status IN ('OPEN', 'CANCELLED')
      THEN spec_id IS NULL AND sampled_by IS NULL AND sampled_at IS NULL AND sample_location_id IS NULL
           AND test_qty IS NULL AND retention_qty IS NULL AND sample_notes IS NULL
      ELSE spec_id IS NOT NULL AND sampled_by IS NOT NULL AND sampled_at IS NOT NULL AND sample_location_id IS NOT NULL
           AND test_qty IS NOT NULL AND retention_qty IS NOT NULL
    END
  );
CREATE INDEX sample_requests_status_idx ON qc.sample_requests (status);

-- 0028's guard, plus OPEN → SAMPLED: the lot is UNDER_TEST, the spec is the APPROVED version of the lot's item, the
-- sampler holds qc.result.enter, and the SAMPLE_ISSUE movements of this request carry exactly the recorded
-- quantities (TEST = test_qty, RETENTION = retention_qty). Sampling fields never change once set.
CREATE OR REPLACE FUNCTION qc.guard_sample_request_status() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot RECORD;
  taken_test NUMERIC;
  taken_ret NUMERIC;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'OPEN' THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: a sample request starts OPEN' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.lot_id IS DISTINCT FROM OLD.lot_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.ref_doc_type IS DISTINCT FROM OLD.ref_doc_type OR NEW.ref_doc_id IS DISTINCT FROM OLD.ref_doc_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a sample request keeps its lot and source document' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'OPEN' AND (NEW.spec_id IS DISTINCT FROM OLD.spec_id OR NEW.sampled_by IS DISTINCT FROM OLD.sampled_by
     OR NEW.sampled_at IS DISTINCT FROM OLD.sampled_at OR NEW.sample_location_id IS DISTINCT FROM OLD.sample_location_id
     OR NEW.test_qty IS DISTINCT FROM OLD.test_qty OR NEW.retention_qty IS DISTINCT FROM OLD.retention_qty
     OR NEW.sample_notes IS DISTINCT FROM OLD.sample_notes) THEN
    RAISE EXCEPTION 'RECORD_LOCKED: a sample request''s sampling record never changes' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'OPEN' AND NEW.status = 'CANCELLED' THEN
    RETURN NEW;  -- checked at commit: its GRN is REVERSED (0028)
  END IF;
  IF NOT (OLD.status = 'OPEN' AND NEW.status = 'SAMPLED') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: sample request % cannot move % → %', NEW.id, OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;

  SELECT l.status, l.item_id INTO lot FROM inv.lots l WHERE l.id = NEW.lot_id;
  IF lot.status IS DISTINCT FROM 'UNDER_TEST' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a lot is UNDER_TEST once its sample is taken (lot is %)', lot.status USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM qc.specs s WHERE s.id = NEW.spec_id AND s.item_id = lot.item_id AND s.status = 'APPROVED') THEN
    RAISE EXCEPTION 'SPEC_NOT_APPROVED: a sample is tested against the APPROVED specification of its item' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.sampled_by IS DISTINCT FROM core.current_user_id() OR NOT core.user_holds_key(NEW.sampled_by, 'qc.result.enter') THEN
    RAISE EXCEPTION 'FORBIDDEN: the sampler is the user taking the sample and holds qc.result.enter' USING ERRCODE = 'P0001';
  END IF;
  SELECT COALESCE(-sum(m.qty) FILTER (WHERE m.reason_code = 'TEST'), 0),
         COALESCE(-sum(m.qty) FILTER (WHERE m.reason_code = 'RETENTION'), 0)
    INTO taken_test, taken_ret
    FROM inv.stock_movements m
   WHERE m.movement_type = 'SAMPLE_ISSUE' AND m.ref_doc_type = 'QC_SAMPLE' AND m.ref_doc_id = NEW.id AND m.lot_id = NEW.lot_id
     AND m.from_location_id = NEW.sample_location_id;
  IF taken_test <> NEW.test_qty OR taken_ret <> COALESCE(NEW.retention_qty, 0) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: the sample quantities (test %, retention %) must leave the lot as SAMPLE_ISSUE movements of this request (found %, %)',
      NEW.test_qty, COALESCE(NEW.retention_qty, 0), taken_test, taken_ret USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
-- 0028 created the trigger BEFORE INSERT OR UPDATE; the function is replaced in place.

-- ---------------------------------------------------------------- results (insert-only)
CREATE TABLE qc.results (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id        BIGINT        NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  sample_request_id BIGINT        NOT NULL REFERENCES qc.sample_requests (id) ON DELETE RESTRICT,
  spec_test_id      BIGINT        NOT NULL REFERENCES qc.spec_tests (id) ON DELETE RESTRICT,
  result_type       TEXT          NOT NULL CHECK (result_type IN ('NUMERIC', 'TEXT')),
  numeric_value     NUMERIC(18,6),
  text_value        TEXT          CHECK (text_value IS NULL OR length(trim(text_value)) BETWEEN 1 AND 500),
  passed            BOOLEAN       NOT NULL,
  remarks           TEXT          CHECK (remarks IS NULL OR length(remarks) <= 1000),
  entered_by        BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  entered_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  tx_id             BIGINT        NOT NULL DEFAULT txid_current(),
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  created_by        BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_by        BIGINT        NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  CHECK ((result_type = 'NUMERIC') = (numeric_value IS NOT NULL)),
  CHECK ((result_type = 'TEXT') = (text_value IS NOT NULL))
);
-- One result per test of a sample; a re-test (task 4) will be a new row linked to the one it repeats.
CREATE UNIQUE INDEX results_one_per_test_uq ON qc.results (sample_request_id, spec_test_id);
SELECT core.enable_audit('qc.results');
SELECT core.forbid_delete('qc.results');

CREATE FUNCTION qc.guard_result() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  req RECORD;
  t RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'APPEND_ONLY: a QC result is never changed; re-test it as a new row' USING ERRCODE = 'P0001';
  END IF;
  SELECT company_id, status, spec_id INTO req FROM qc.sample_requests WHERE id = NEW.sample_request_id;
  IF req.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: the sample request is not in this company' USING ERRCODE = 'P0001';
  END IF;
  IF req.status IS DISTINCT FROM 'SAMPLED' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: results are entered for a SAMPLED request (this one is %)', req.status USING ERRCODE = 'P0001';
  END IF;
  SELECT spec_id, result_type, min_value, max_value INTO t FROM qc.spec_tests WHERE id = NEW.spec_test_id;
  IF t.spec_id IS DISTINCT FROM req.spec_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: the test belongs to the specification version the sample is tested against' USING ERRCODE = 'P0001';
  END IF;
  IF t.result_type IS DISTINCT FROM NEW.result_type THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: the result has its test''s type (%)', t.result_type USING ERRCODE = 'P0001';
  END IF;
  IF NEW.result_type = 'NUMERIC' AND NEW.passed IS DISTINCT FROM
     ((t.min_value IS NULL OR NEW.numeric_value >= t.min_value) AND (t.max_value IS NULL OR NEW.numeric_value <= t.max_value)) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: pass / fail of a numeric result is computed from the limits' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.entered_by IS DISTINCT FROM core.current_user_id() OR NOT core.user_holds_key(NEW.entered_by, 'qc.result.enter') THEN
    RAISE EXCEPTION 'FORBIDDEN: a result is entered by its analyst, a holder of qc.result.enter' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.tx_id IS DISTINCT FROM txid_current() OR NEW.entered_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a result is stamped when it is entered' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_result BEFORE INSERT OR UPDATE ON qc.results FOR EACH ROW EXECUTE FUNCTION qc.guard_result();

-- Owner 2026-11-18 (architecture §4): a failed result on an FG lot moves the lot UNDER_TEST → HOLD with the result.
-- At commit the lot is on HOLD.
CREATE FUNCTION qc.check_fg_fail_hold() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot RECORD;
BEGIN
  IF NEW.passed THEN
    RETURN NULL;
  END IF;
  SELECT l.lot_no, l.status, i.type INTO lot
    FROM qc.sample_requests r JOIN inv.lots l ON l.id = r.lot_id JOIN master.items i ON i.id = l.item_id
   WHERE r.id = NEW.sample_request_id;
  IF lot.type = 'FG' AND lot.status IS DISTINCT FROM 'HOLD' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a failed QC result puts finished-goods lot % on HOLD in the same transaction (it is %)', lot.lot_no, lot.status
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_fg_fail_hold AFTER INSERT ON qc.results
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qc.check_fg_fail_hold();

-- ---------------------------------------------------------------- reviews (insert-only)
CREATE TABLE qc.result_reviews (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id   BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  result_id    BIGINT      NOT NULL UNIQUE REFERENCES qc.results (id) ON DELETE RESTRICT,
  reviewed_by  BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  reviewed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  esign_id     BIGINT      NOT NULL REFERENCES core.e_signatures (id) ON DELETE RESTRICT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by   BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT
);
SELECT core.enable_audit('qc.result_reviews');
SELECT core.forbid_delete('qc.result_reviews');

CREATE FUNCTION qc.guard_result_review() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  res RECORD;
  sig RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'APPEND_ONLY: a result review is never changed' USING ERRCODE = 'P0001';
  END IF;
  SELECT company_id, entered_by, sample_request_id INTO res FROM qc.results WHERE id = NEW.result_id;
  IF res.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: the result is not in this company' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.reviewed_by IS DISTINCT FROM core.current_user_id() OR NOT core.user_holds_key(NEW.reviewed_by, 'qc.result.review') THEN
    RAISE EXCEPTION 'FORBIDDEN: a result is reviewed by the signed-in holder of qc.result.review' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.reviewed_by = res.entered_by THEN
    RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: the reviewer of a QC result is not the analyst who entered it' USING ERRCODE = 'P0001';
  END IF;
  SELECT user_id, meaning, record_table, record_id, tx_id INTO sig FROM core.e_signatures WHERE id = NEW.esign_id;
  IF sig.user_id IS DISTINCT FROM NEW.reviewed_by OR sig.meaning IS DISTINCT FROM 'REVIEWED'
     OR sig.record_table IS DISTINCT FROM 'qc.sample_requests' OR sig.record_id IS DISTINCT FROM res.sample_request_id::text
     OR sig.tx_id IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'ESIGN_FAILED: a review needs the reviewer''s own REVIEWED e-signature on the sample, recorded now' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_result_review BEFORE INSERT OR UPDATE ON qc.result_reviews
  FOR EACH ROW EXECUTE FUNCTION qc.guard_result_review();
