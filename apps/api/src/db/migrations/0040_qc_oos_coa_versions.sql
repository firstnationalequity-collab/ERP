-- 0040 (M4 task 4b; owner 2026-11-27): OOS investigations, and versioned certificates of analysis.
--   qc.oos_investigations  one per failed result, opened automatically when that result is reviewed (the reviewer's
--                          transaction; checked at commit), number OOS-{FY}-{SEQ:5}, linked to the result, its
--                          sample, lot and spec test. OPEN → CLOSED through core/transition by a holder of
--                          qc.oos.close (QC Manager) with their e-signature (meaning APPROVED; the reason is the
--                          conclusion), never by the analyst who entered the failed result (SEGREGATION_OF_DUTIES).
--                          Outcome INVALIDATED (assignable cause: category + description; the result is then
--                          "invalidated", never edited or deleted, and may be re-tested) or CONFIRMED (the failure
--                          stands). A closed investigation never changes.
--   qc.results             a failed result is re-tested only after its OOS investigation closed it as INVALIDATED.
--   qc.dispositions        approval refused while an OOS investigation of the lot is OPEN (OOS_OPEN) or while the latest
--                          result of a test is invalidated (QC_RETEST_REQUIRED); an invalidated failure does not support
--                          a rejection (the category is then required).
--   qc.coas                a correction is a new version of the same number (version + 1, supersedes the current one,
--                          reason = the issuer's APPROVED e-signature on the superseded certificate). The superseded
--                          version is kept and still downloadable; "SUPERSEDED" is read from the newer version.

-- ---------------------------------------------------------------- OOS investigations
CREATE TABLE qc.oos_investigations (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id        BIGINT      NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  doc_no            TEXT        NOT NULL CHECK (length(trim(doc_no)) BETWEEN 1 AND 40),
  result_id         BIGINT      NOT NULL UNIQUE REFERENCES qc.results (id) ON DELETE RESTRICT,
  sample_request_id BIGINT      NOT NULL REFERENCES qc.sample_requests (id) ON DELETE RESTRICT,
  lot_id            BIGINT      NOT NULL REFERENCES inv.lots (id) ON DELETE RESTRICT,
  spec_test_id      BIGINT      NOT NULL REFERENCES qc.spec_tests (id) ON DELETE RESTRICT,
  status            TEXT        NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  opened_by         BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome           TEXT        CHECK (outcome IN ('INVALIDATED', 'CONFIRMED')),
  cause_category    TEXT        CHECK (cause_category IN ('LAB_ERROR', 'INSTRUMENT', 'SAMPLE_PREP', 'CALCULATION', 'OTHER')),
  cause_description TEXT        CHECK (length(trim(cause_description)) BETWEEN 10 AND 2000),
  conclusion        TEXT        CHECK (length(trim(conclusion)) BETWEEN 3 AND 500),
  close_esign_id    BIGINT      UNIQUE REFERENCES core.e_signatures (id) ON DELETE RESTRICT,
  closed_by         BIGINT      REFERENCES core.users (id) ON DELETE RESTRICT,
  closed_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by        BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by        BIGINT      NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, doc_no),
  CONSTRAINT oos_closed_fields CHECK (
    CASE WHEN status = 'OPEN'
      THEN outcome IS NULL AND cause_category IS NULL AND cause_description IS NULL AND conclusion IS NULL
           AND close_esign_id IS NULL AND closed_by IS NULL AND closed_at IS NULL
      ELSE outcome IS NOT NULL AND conclusion IS NOT NULL AND close_esign_id IS NOT NULL AND closed_by IS NOT NULL AND closed_at IS NOT NULL
    END
  ),
  CONSTRAINT oos_invalidated_has_cause CHECK (outcome IS DISTINCT FROM 'INVALIDATED' OR (cause_category IS NOT NULL AND cause_description IS NOT NULL)),
  CONSTRAINT oos_confirmed_no_cause_category CHECK (outcome IS DISTINCT FROM 'CONFIRMED' OR cause_category IS NULL)
);
CREATE INDEX oos_lot_idx ON qc.oos_investigations (lot_id, status);
CREATE INDEX oos_status_idx ON qc.oos_investigations (company_id, status, id);
SELECT core.enable_audit('qc.oos_investigations');
SELECT core.enable_touch('qc.oos_investigations');
SELECT core.forbid_delete('qc.oos_investigations');
SELECT core.require_transition('qc.oos_investigations');

CREATE FUNCTION qc.guard_oos() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  res RECORD;
  sig RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT r.company_id, r.sample_request_id, r.spec_test_id, r.passed, q.lot_id INTO res
      FROM qc.results r JOIN qc.sample_requests q ON q.id = r.sample_request_id WHERE r.id = NEW.result_id;
    IF res.company_id IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: the result is not in this company' USING ERRCODE = 'P0001';
    END IF;
    IF res.passed THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: an OOS investigation is opened for a failed result' USING ERRCODE = 'P0001';
    END IF;
    IF res.sample_request_id IS DISTINCT FROM NEW.sample_request_id OR res.spec_test_id IS DISTINCT FROM NEW.spec_test_id
       OR res.lot_id IS DISTINCT FROM NEW.lot_id THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: an OOS investigation names its result''s sample, lot and test' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM qc.result_reviews v WHERE v.result_id = NEW.result_id) THEN
      RAISE EXCEPTION 'QC_RESULTS_NOT_REVIEWED: an OOS investigation opens when the failed result is reviewed' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.status IS DISTINCT FROM 'OPEN' THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: an OOS investigation starts OPEN' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.opened_by IS DISTINCT FROM core.current_user_id() OR NOT core.user_holds_key(NEW.opened_by, 'qc.result.review') THEN
      RAISE EXCEPTION 'FORBIDDEN: an OOS investigation is opened by the reviewer of the failed result' USING ERRCODE = 'P0001';
    END IF;
    NEW.opened_at := now();
    RETURN NEW;
  END IF;

  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'RECORD_LOCKED: closed OOS investigation % is never changed', OLD.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.doc_no IS DISTINCT FROM OLD.doc_no OR NEW.result_id IS DISTINCT FROM OLD.result_id
     OR NEW.sample_request_id IS DISTINCT FROM OLD.sample_request_id OR NEW.lot_id IS DISTINCT FROM OLD.lot_id
     OR NEW.spec_test_id IS DISTINCT FROM OLD.spec_test_id OR NEW.opened_by IS DISTINCT FROM OLD.opened_by
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at THEN
    RAISE EXCEPTION 'RECORD_LOCKED: an OOS investigation keeps its number, result, sample, lot, test and opener' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'OPEN' THEN
    RETURN NEW; -- the row CHECK keeps every closing field empty
  END IF;
  IF NEW.closed_by IS DISTINCT FROM core.current_user_id() OR NOT core.user_holds_key(NEW.closed_by, 'qc.oos.close') THEN
    RAISE EXCEPTION 'FORBIDDEN: an OOS investigation is closed by the signed-in holder of qc.oos.close' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.closed_by = (SELECT entered_by FROM qc.results WHERE id = NEW.result_id) THEN
    RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: the analyst who entered the failed result does not close its OOS investigation' USING ERRCODE = 'P0001';
  END IF;
  SELECT user_id, meaning, reason, record_table, record_id, tx_id INTO sig FROM core.e_signatures WHERE id = NEW.close_esign_id;
  IF sig.user_id IS DISTINCT FROM NEW.closed_by OR sig.meaning IS DISTINCT FROM 'APPROVED' OR sig.reason IS DISTINCT FROM NEW.conclusion
     OR sig.record_table IS DISTINCT FROM 'qc.oos_investigations' OR sig.record_id IS DISTINCT FROM NEW.id::text
     OR sig.tx_id IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'ESIGN_FAILED: closing an OOS investigation needs the closer''s own APPROVED e-signature on it, recorded now' USING ERRCODE = 'P0001';
  END IF;
  NEW.closed_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_oos BEFORE INSERT OR UPDATE ON qc.oos_investigations FOR EACH ROW EXECUTE FUNCTION qc.guard_oos();

-- At commit: reviewing a failed result opened its OOS investigation (owner 2026-11-27: automatic).
CREATE FUNCTION qc.check_review_opens_oos() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT NOT r.passed FROM qc.results r WHERE r.id = NEW.result_id)
     AND NOT EXISTS (SELECT 1 FROM qc.oos_investigations o WHERE o.result_id = NEW.result_id) THEN
    RAISE EXCEPTION 'OOS_REQUIRED: reviewing failed result % opens its OOS investigation in the same transaction', NEW.result_id USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_review_opens_oos AFTER INSERT ON qc.result_reviews
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qc.check_review_opens_oos();

-- A result its closed OOS investigation found invalid (assignable cause). The row itself is never changed.
CREATE FUNCTION qc.result_invalidated(p_result BIGINT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM qc.oos_investigations o WHERE o.result_id = p_result AND o.status = 'CLOSED' AND o.outcome = 'INVALIDATED')
$$;

-- ---------------------------------------------------------------- results: a failed result is re-tested only once invalidated
CREATE OR REPLACE FUNCTION qc.guard_result() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  req RECORD;
  t RECORD;
  orig RECORD;
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
  IF NEW.retest_of IS NOT NULL THEN
    SELECT sample_request_id, spec_test_id, passed INTO orig FROM qc.results WHERE id = NEW.retest_of;
    IF orig.sample_request_id IS DISTINCT FROM NEW.sample_request_id OR orig.spec_test_id IS DISTINCT FROM NEW.spec_test_id THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a re-test repeats a result of the same sample and test' USING ERRCODE = 'P0001';
    END IF;
    -- Owner 2026-11-27 (0040): no re-test of a failure without an OOS investigation that invalidated it.
    IF NOT orig.passed AND NOT qc.result_invalidated(NEW.retest_of) THEN
      RAISE EXCEPTION 'OOS_NOT_INVALIDATED: a failed result is re-tested only after its OOS investigation closed it as INVALIDATED' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- dispositions: OOS checks (0038's guard, plus)
CREATE OR REPLACE FUNCTION qc.guard_disposition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot RECORD;
  req RECORD;
  sig RECORD;
  today DATE := core.company_today();
  want_assay NUMERIC;
  want_water NUMERIC;
  test_failed BOOLEAN := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'APPEND_ONLY: a QC disposition is never changed' USING ERRCODE = 'P0001';
  END IF;
  SELECT l.company_id, l.lot_no, l.status, l.expiry_date, l.retest_date, i.type INTO lot
    FROM inv.lots l JOIN master.items i ON i.id = l.item_id WHERE l.id = NEW.lot_id;
  IF lot.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: the lot is not in this company' USING ERRCODE = 'P0001';
  END IF;
  IF lot.type = 'FG' THEN
    RAISE EXCEPTION 'FG_LOT_QA_DECIDES: QC does not approve or reject finished-goods lot %; QA decides', lot.lot_no USING ERRCODE = 'P0001';
  END IF;
  IF lot.status IS DISTINCT FROM NEW.from_status THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: lot % is %, not %', lot.lot_no, lot.status, NEW.from_status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.decided_by IS DISTINCT FROM core.current_user_id() OR NOT core.user_holds_key(NEW.decided_by, 'qc.lot.change_status') THEN
    RAISE EXCEPTION 'FORBIDDEN: a lot is approved or rejected by the signed-in holder of qc.lot.change_status' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.tx_id IS DISTINCT FROM txid_current() OR NEW.decided_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a disposition is stamped when it is made' USING ERRCODE = 'P0001';
  END IF;
  SELECT user_id, meaning, reason, record_table, record_id, tx_id INTO sig FROM core.e_signatures WHERE id = NEW.esign_id;
  IF sig.user_id IS DISTINCT FROM NEW.decided_by OR sig.meaning IS DISTINCT FROM NEW.decision
     OR sig.reason IS DISTINCT FROM NEW.reason OR sig.record_table IS DISTINCT FROM 'inv.lots'
     OR sig.record_id IS DISTINCT FROM NEW.lot_id::text OR sig.tx_id IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'ESIGN_FAILED: a disposition needs the decider''s own % e-signature on the lot, recorded now', NEW.decision USING ERRCODE = 'P0001';
  END IF;

  IF NEW.sample_request_id IS NOT NULL THEN
    SELECT company_id, lot_id, status, spec_id INTO req FROM qc.sample_requests WHERE id = NEW.sample_request_id;
    IF req.lot_id IS DISTINCT FROM NEW.lot_id
       OR req.status IS DISTINCT FROM (CASE NEW.from_status WHEN 'QUARANTINE' THEN 'OPEN' ELSE 'SAMPLED' END) THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: the disposition closes this lot''s % request', CASE NEW.from_status WHEN 'QUARANTINE' THEN 'OPEN' ELSE 'SAMPLED' END
        USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM qc.results r WHERE r.sample_request_id = NEW.sample_request_id AND r.entered_by = NEW.decided_by) THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: the analyst who entered a result of the sample does not decide the lot' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM qc.results r WHERE r.sample_request_id = NEW.sample_request_id
                AND NOT EXISTS (SELECT 1 FROM qc.result_reviews v WHERE v.result_id = r.id)) THEN
      RAISE EXCEPTION 'QC_RESULTS_NOT_REVIEWED: every result of the sample is reviewed before the lot is decided' USING ERRCODE = 'P0001';
    END IF;
    -- 0040: a failure its OOS investigation invalidated does not count as a failed test.
    test_failed := EXISTS (SELECT 1 FROM qc.latest_results(NEW.sample_request_id) x WHERE NOT x.passed AND NOT qc.result_invalidated(x.result_id));
    IF NEW.decision = 'APPROVED' THEN
      IF EXISTS (SELECT 1 FROM qc.spec_tests t WHERE t.spec_id = req.spec_id
                  AND NOT EXISTS (SELECT 1 FROM qc.results r WHERE r.sample_request_id = NEW.sample_request_id AND r.spec_test_id = t.id)) THEN
        RAISE EXCEPTION 'QC_RESULTS_INCOMPLETE: every test of the specification has a result before the lot is approved' USING ERRCODE = 'P0001';
      END IF;
      IF EXISTS (SELECT 1 FROM qc.latest_results(NEW.sample_request_id) x WHERE qc.result_invalidated(x.result_id)) THEN
        RAISE EXCEPTION 'QC_RETEST_REQUIRED: the latest result of a test was invalidated by its OOS investigation; re-test it first' USING ERRCODE = 'P0001';
      END IF;
      IF test_failed THEN
        RAISE EXCEPTION 'QC_TEST_FAILED: a lot whose latest result of a test failed is not approved' USING ERRCODE = 'P0001';
      END IF;
      SELECT round(x.numeric_value, 4) INTO want_assay
        FROM qc.latest_results(NEW.sample_request_id) x JOIN qc.spec_tests t ON t.id = x.spec_test_id WHERE t.is_assay;
      SELECT round(x.numeric_value, 4) INTO want_water
        FROM qc.latest_results(NEW.sample_request_id) x JOIN qc.spec_tests t ON t.id = x.spec_test_id WHERE t.is_water;
      IF NEW.assay_pct IS DISTINCT FROM want_assay OR NEW.water_pct IS DISTINCT FROM want_water THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: the disposition carries the latest assay (%) and water (%) results', want_assay, want_water USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;

  -- 0040 (owner 2026-11-27): no approval while an OOS investigation of the lot is open (rejection stays allowed).
  IF NEW.decision = 'APPROVED' AND EXISTS (SELECT 1 FROM qc.oos_investigations o WHERE o.lot_id = NEW.lot_id AND o.status = 'OPEN') THEN
    RAISE EXCEPTION 'OOS_OPEN: lot % has an open OOS investigation; it is not approved until it is closed', lot.lot_no USING ERRCODE = 'P0001';
  END IF;

  -- A rejection no failed latest result supports names its category and describes what was found (owner 2026-11-27).
  IF NEW.decision = 'REJECTED' AND NOT test_failed AND NEW.reject_category IS NULL THEN
    RAISE EXCEPTION 'QC_REJECT_CATEGORY_REQUIRED: lot % has no failed result; a rejection gives a reason category and a description', lot.lot_no
      USING ERRCODE = 'P0001';
  END IF;

  IF NEW.decision = 'APPROVED' THEN
    IF lot.expiry_date IS NOT NULL AND lot.expiry_date <= today THEN
      RAISE EXCEPTION 'LOT_EXPIRED: lot % expired on %; it is not approved', lot.lot_no, lot.expiry_date USING ERRCODE = 'P0001';
    END IF;
    IF NEW.retest_date IS NOT NULL AND (NEW.retest_date <= today OR (lot.expiry_date IS NOT NULL AND NEW.retest_date > lot.expiry_date)) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: the new retest date is after today and not after the expiry date' USING ERRCODE = 'P0001';
    END IF;
    IF COALESCE(NEW.retest_date, lot.retest_date) <= today THEN
      RAISE EXCEPTION 'LOT_RETEST_DUE: lot % has reached its retest date; give the new retest date', lot.lot_no USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- certificates of analysis: versions
ALTER TABLE qc.coas
  ADD COLUMN version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  ADD COLUMN supersedes_id  BIGINT UNIQUE REFERENCES qc.coas (id) ON DELETE RESTRICT,
  ADD COLUMN reissue_reason TEXT CHECK (length(trim(reissue_reason)) BETWEEN 3 AND 500),
  ADD CONSTRAINT coa_version_chain CHECK ((version = 1) = (supersedes_id IS NULL) AND (supersedes_id IS NULL) = (reissue_reason IS NULL));
ALTER TABLE qc.coas DROP CONSTRAINT coas_disposition_id_key;
CREATE UNIQUE INDEX coas_one_first_issue_per_disposition_uq ON qc.coas (disposition_id) WHERE supersedes_id IS NULL;
ALTER TABLE qc.coas DROP CONSTRAINT coas_company_id_doc_no_key;
ALTER TABLE qc.coas ADD CONSTRAINT coas_doc_no_version_uq UNIQUE (company_id, doc_no, version);

CREATE OR REPLACE FUNCTION qc.guard_coa() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot RECORD;
  d RECORD;
  sig RECORD;
  prev RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'APPEND_ONLY: a certificate of analysis is never changed (correct it by a new version)' USING ERRCODE = 'P0001';
  END IF;
  SELECT l.company_id, l.lot_no, l.status, i.type INTO lot FROM inv.lots l JOIN master.items i ON i.id = l.item_id WHERE l.id = NEW.lot_id;
  IF lot.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: the lot is not in this company' USING ERRCODE = 'P0001';
  END IF;
  IF lot.type = 'FG' THEN
    RAISE EXCEPTION 'FG_LOT_QA_DECIDES: a finished-goods certificate follows QA release (M7), not a QC approval' USING ERRCODE = 'P0001';
  END IF;
  SELECT lot_id, decision, sample_request_id INTO d FROM qc.dispositions WHERE id = NEW.disposition_id;
  IF d.lot_id IS DISTINCT FROM NEW.lot_id OR d.decision IS DISTINCT FROM 'APPROVED' OR d.sample_request_id IS DISTINCT FROM NEW.sample_request_id
     OR EXISTS (SELECT 1 FROM qc.dispositions x WHERE x.lot_id = NEW.lot_id AND x.id > NEW.disposition_id) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a certificate reports the lot''s latest disposition, an approval, and its sample' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.issued_by IS DISTINCT FROM core.current_user_id() OR NOT core.user_holds_key(NEW.issued_by, 'qc.coa.issue') THEN
    RAISE EXCEPTION 'FORBIDDEN: a certificate is issued by the signed-in holder of qc.coa.issue' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.tx_id IS DISTINCT FROM txid_current() OR NEW.issued_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a certificate is stamped when it is issued' USING ERRCODE = 'P0001';
  END IF;
  SELECT user_id, meaning, reason, record_table, record_id, tx_id INTO sig FROM core.e_signatures WHERE id = NEW.esign_id;

  IF NEW.supersedes_id IS NULL THEN
    IF lot.status IS DISTINCT FROM 'APPROVED' THEN
      RAISE EXCEPTION 'LOT_NOT_APPROVED: a certificate is issued for an APPROVED lot (lot % is %)', lot.lot_no, lot.status USING ERRCODE = 'P0001';
    END IF;
    IF sig.user_id IS DISTINCT FROM NEW.issued_by OR sig.meaning IS DISTINCT FROM 'APPROVED' OR sig.record_table IS DISTINCT FROM 'qc.dispositions'
       OR sig.record_id IS DISTINCT FROM NEW.disposition_id::text OR sig.tx_id IS DISTINCT FROM txid_current() THEN
      RAISE EXCEPTION 'ESIGN_FAILED: a certificate needs the issuer''s own APPROVED e-signature on the disposition, recorded now' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- A new version: same certificate (number, lot, disposition, sample), next version, of the current version only
  -- (supersedes_id is unique), signed on the version it supersedes with the re-issue reason.
  SELECT company_id, doc_no, version, lot_id, disposition_id, sample_request_id INTO prev FROM qc.coas WHERE id = NEW.supersedes_id;
  IF prev.company_id IS DISTINCT FROM NEW.company_id OR prev.doc_no IS DISTINCT FROM NEW.doc_no OR prev.lot_id IS DISTINCT FROM NEW.lot_id
     OR prev.disposition_id IS DISTINCT FROM NEW.disposition_id OR prev.sample_request_id IS DISTINCT FROM NEW.sample_request_id
     OR NEW.version IS DISTINCT FROM prev.version + 1 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a re-issued certificate is the next version of the same certificate' USING ERRCODE = 'P0001';
  END IF;
  IF sig.user_id IS DISTINCT FROM NEW.issued_by OR sig.meaning IS DISTINCT FROM 'APPROVED' OR sig.reason IS DISTINCT FROM NEW.reissue_reason
     OR sig.record_table IS DISTINCT FROM 'qc.coas' OR sig.record_id IS DISTINCT FROM NEW.supersedes_id::text OR sig.tx_id IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'ESIGN_FAILED: a re-issue needs the issuer''s own APPROVED e-signature on the version it supersedes, with the reason, recorded now'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
