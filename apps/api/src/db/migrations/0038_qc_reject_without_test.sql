-- 0038 (M4, owner decision 2026-11-27): the QC Manager may reject a material lot without a failed test.
--   A rejection that no failed latest result supports (QUARANTINE, HOLD, or UNDER_TEST with every latest result passed
--   or no result yet) needs a reason category (DAMAGED_CONTAINER, LABELLING, SEAL_BROKEN, CONTAMINATION, COA_MISMATCH,
--   VENDOR_ISSUE, OTHER), a description and the QC Manager's e-signature. Same segregation as 0037: whoever entered a
--   result of the sample does not decide the lot; every entered result is reviewed first.
--   New move QUARANTINE → REJECTED (a lot not sampled yet, e.g. a damaged container at receipt): it cancels the lot's
--   OPEN sample request in the same transaction (OPEN → CANCELLED, besides GRN reversal, 0028).
--   FG lots stay QA's (FG_LOT_QA_DECIDES); the lot guard refuses QUARANTINE → REJECTED of any lot without a disposition.

-- ---------------------------------------------------------------- dispositions: QUARANTINE, category, description
ALTER TABLE qc.dispositions DROP CONSTRAINT dispositions_from_status_check;
ALTER TABLE qc.dispositions ADD CONSTRAINT dispositions_from_status_check CHECK (from_status IN ('QUARANTINE', 'UNDER_TEST', 'HOLD'));
ALTER TABLE qc.dispositions DROP CONSTRAINT disposition_request_from_test;
ALTER TABLE qc.dispositions ADD CONSTRAINT disposition_request_from_test CHECK ((from_status = 'HOLD') = (sample_request_id IS NULL));
ALTER TABLE qc.dispositions
  ADD COLUMN reject_category TEXT CHECK (reject_category IN ('DAMAGED_CONTAINER', 'LABELLING', 'SEAL_BROKEN', 'CONTAMINATION', 'COA_MISMATCH', 'VENDOR_ISSUE', 'OTHER')),
  ADD COLUMN reject_description TEXT CHECK (length(trim(reject_description)) BETWEEN 10 AND 2000),
  ADD CONSTRAINT disposition_category_on_rejection CHECK (decision = 'REJECTED' OR reject_category IS NULL),
  ADD CONSTRAINT disposition_category_described CHECK ((reject_category IS NULL) = (reject_description IS NULL));

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
    test_failed := EXISTS (SELECT 1 FROM qc.latest_results(NEW.sample_request_id) x WHERE NOT x.passed);
    IF NEW.decision = 'APPROVED' THEN
      IF EXISTS (SELECT 1 FROM qc.spec_tests t WHERE t.spec_id = req.spec_id
                  AND NOT EXISTS (SELECT 1 FROM qc.results r WHERE r.sample_request_id = NEW.sample_request_id AND r.spec_test_id = t.id)) THEN
        RAISE EXCEPTION 'QC_RESULTS_INCOMPLETE: every test of the specification has a result before the lot is approved' USING ERRCODE = 'P0001';
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

-- At commit: the lot has the decided status and carries the values; the request is CLOSED (sampled) or CANCELLED (not sampled).
CREATE OR REPLACE FUNCTION qc.check_disposition_applied() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot RECORD;
BEGIN
  SELECT lot_no, status, assay_pct, water_pct, retest_date INTO lot FROM inv.lots WHERE id = NEW.lot_id;
  IF lot.status IS DISTINCT FROM NEW.decision
     OR (NEW.assay_pct IS NOT NULL AND lot.assay_pct IS DISTINCT FROM NEW.assay_pct)
     OR (NEW.water_pct IS NOT NULL AND lot.water_pct IS DISTINCT FROM NEW.water_pct)
     OR (NEW.retest_date IS NOT NULL AND lot.retest_date IS DISTINCT FROM NEW.retest_date) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: lot % takes the disposition''s status % and values in the same transaction', lot.lot_no, NEW.decision
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.sample_request_id IS NOT NULL
     AND (SELECT status FROM qc.sample_requests WHERE id = NEW.sample_request_id)
         IS DISTINCT FROM (CASE NEW.from_status WHEN 'QUARANTINE' THEN 'CANCELLED' ELSE 'CLOSED' END) THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: the disposition closes its sample request in the same transaction' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------- lots: QUARANTINE → REJECTED needs a disposition too
CREATE OR REPLACE FUNCTION inv.guard_lot_qc_disposition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  is_fg BOOLEAN;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT i.type = 'FG' INTO is_fg FROM master.items i WHERE i.id = NEW.item_id;
    -- Material lots only for UNDER_TEST / HOLD: the FG lot moves are guarded with QA release (M6 / M7; owner 2026-11-27).
    IF (OLD.status = 'UNDER_TEST' AND NEW.status IN ('APPROVED', 'REJECTED') AND NOT is_fg)
       OR (OLD.status = 'HOLD' AND NEW.status = 'REJECTED' AND NOT is_fg)
       OR (OLD.status = 'QUARANTINE' AND NEW.status = 'REJECTED') THEN
      IF NOT EXISTS (SELECT 1 FROM qc.dispositions d WHERE d.lot_id = NEW.id AND d.tx_id = txid_current()
                        AND d.from_status = OLD.status AND d.decision = NEW.status) THEN
        RAISE EXCEPTION 'INVALID_TRANSITION: lot % moves % → % only with a QC Manager disposition', NEW.lot_no, OLD.status, NEW.status
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  END IF;
  IF (NEW.assay_pct IS DISTINCT FROM OLD.assay_pct OR NEW.water_pct IS DISTINCT FROM OLD.water_pct
      OR NEW.retest_date IS DISTINCT FROM OLD.retest_date)
     AND NOT EXISTS (
       SELECT 1 FROM qc.dispositions d
        WHERE d.lot_id = NEW.id AND d.tx_id = txid_current() AND d.decision = 'APPROVED'
          AND (NEW.assay_pct IS NOT DISTINCT FROM OLD.assay_pct OR NEW.assay_pct = d.assay_pct)
          AND (NEW.water_pct IS NOT DISTINCT FROM OLD.water_pct OR NEW.water_pct = d.water_pct)
          AND (NEW.retest_date IS NOT DISTINCT FROM OLD.retest_date OR NEW.retest_date = d.retest_date)
     ) THEN
    RAISE EXCEPTION 'RECORD_LOCKED: lot %''s assay, water and retest date change only with a QC approval', NEW.lot_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- sample requests: OPEN → CANCELLED by a rejection
-- 0028: cancelled only by reversing its GRN; now also by the QC Manager rejecting the not-yet-sampled lot (same transaction).
CREATE OR REPLACE FUNCTION qc.check_sample_request_cancelled() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM qc.dispositions d WHERE d.sample_request_id = NEW.id AND d.from_status = 'QUARANTINE'
                AND d.decision = 'REJECTED' AND d.tx_id = txid_current()) THEN
    RETURN NULL;
  END IF;
  IF NEW.ref_doc_type = 'GRN' AND NOT EXISTS (SELECT 1 FROM purch.grns g WHERE g.id = NEW.ref_doc_id AND g.status = 'REVERSED') THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: sample request % is cancelled only by reversing its GRN or rejecting its lot', NEW.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
