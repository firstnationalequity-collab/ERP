-- 0039 (M4 task 4): QC re-tests as new rows, and certificates of analysis (architecture §5 QC, §7.6; build-plan M4).
--   qc.results      a re-test is a NEW row: retest_of names the result it repeats (same sample, same test) and
--                   retest_reason says why. The original is never edited (0036 APPEND_ONLY). Each result is re-tested
--                   at most once, so the re-tests of a test form one chain and its newest row is its latest result
--                   (qc.latest_results(), 0037). One original row per test of a sample (replaces results_one_per_test_uq).
--   qc.coas         insert-only, one certificate per APPROVED disposition of a material lot that is APPROVED now and
--                   whose latest disposition it is. Issued by a holder of qc.coa.issue with their own e-signature
--                   (meaning APPROVED) on the disposition; number COA-{FY}-{SEQ:5}. The PDF is stored as an
--                   attachment of the certificate with its SHA-256, written in the same transaction (re-checked on
--                   every download, FILE_INTEGRITY_FAILED); no other file is ever attached to a certificate.

-- ---------------------------------------------------------------- results: re-test rows
ALTER TABLE qc.results
  ADD COLUMN retest_of     BIGINT REFERENCES qc.results (id) ON DELETE RESTRICT,
  ADD COLUMN retest_reason TEXT CHECK (length(trim(retest_reason)) BETWEEN 10 AND 500),
  ADD CONSTRAINT results_retest_has_reason CHECK ((retest_of IS NULL) = (retest_reason IS NULL));
DROP INDEX qc.results_one_per_test_uq;
CREATE UNIQUE INDEX results_one_original_per_test_uq ON qc.results (sample_request_id, spec_test_id) WHERE retest_of IS NULL;
CREATE UNIQUE INDEX results_one_retest_each_uq ON qc.results (retest_of) WHERE retest_of IS NOT NULL;

-- 0036's guard, plus: a re-test repeats a result of the same sample and test.
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
    SELECT sample_request_id, spec_test_id INTO orig FROM qc.results WHERE id = NEW.retest_of;
    IF orig.sample_request_id IS DISTINCT FROM NEW.sample_request_id OR orig.spec_test_id IS DISTINCT FROM NEW.spec_test_id THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a re-test repeats a result of the same sample and test' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- certificates of analysis (insert-only)
CREATE TABLE qc.coas (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id        BIGINT       NOT NULL DEFAULT core.current_company_id() REFERENCES core.companies (id) ON DELETE RESTRICT,
  doc_no            TEXT         NOT NULL CHECK (length(trim(doc_no)) BETWEEN 1 AND 40),
  lot_id            BIGINT       NOT NULL REFERENCES inv.lots (id) ON DELETE RESTRICT,
  disposition_id    BIGINT       NOT NULL UNIQUE REFERENCES qc.dispositions (id) ON DELETE RESTRICT,
  sample_request_id BIGINT       NOT NULL REFERENCES qc.sample_requests (id) ON DELETE RESTRICT,
  file_name         TEXT         NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  sha256            TEXT         NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  esign_id          BIGINT       NOT NULL UNIQUE REFERENCES core.e_signatures (id) ON DELETE RESTRICT,
  issued_by         BIGINT       NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  issued_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  tx_id             BIGINT       NOT NULL DEFAULT txid_current(),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by        BIGINT       NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_by        BIGINT       NOT NULL DEFAULT core.current_user_id() REFERENCES core.users (id) ON DELETE RESTRICT,
  UNIQUE (company_id, doc_no)
);
CREATE INDEX coas_lot_idx ON qc.coas (lot_id, id);
SELECT core.enable_audit('qc.coas');
SELECT core.forbid_delete('qc.coas');

CREATE FUNCTION qc.guard_coa() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot RECORD;
  d RECORD;
  sig RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'APPEND_ONLY: a certificate of analysis is never changed' USING ERRCODE = 'P0001';
  END IF;
  SELECT l.company_id, l.lot_no, l.status, i.type INTO lot FROM inv.lots l JOIN master.items i ON i.id = l.item_id WHERE l.id = NEW.lot_id;
  IF lot.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: the lot is not in this company' USING ERRCODE = 'P0001';
  END IF;
  IF lot.type = 'FG' THEN
    RAISE EXCEPTION 'FG_LOT_QA_DECIDES: a finished-goods certificate follows QA release (M7), not a QC approval' USING ERRCODE = 'P0001';
  END IF;
  IF lot.status IS DISTINCT FROM 'APPROVED' THEN
    RAISE EXCEPTION 'LOT_NOT_APPROVED: a certificate is issued for an APPROVED lot (lot % is %)', lot.lot_no, lot.status USING ERRCODE = 'P0001';
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
  SELECT user_id, meaning, record_table, record_id, tx_id INTO sig FROM core.e_signatures WHERE id = NEW.esign_id;
  IF sig.user_id IS DISTINCT FROM NEW.issued_by OR sig.meaning IS DISTINCT FROM 'APPROVED' OR sig.record_table IS DISTINCT FROM 'qc.dispositions'
     OR sig.record_id IS DISTINCT FROM NEW.disposition_id::text OR sig.tx_id IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'ESIGN_FAILED: a certificate needs the issuer''s own APPROVED e-signature on the disposition, recorded now' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_coa BEFORE INSERT OR UPDATE ON qc.coas FOR EACH ROW EXECUTE FUNCTION qc.guard_coa();

-- At commit: the certificate's PDF is attached to it, with the recorded SHA-256 and file name.
CREATE FUNCTION qc.check_coa_file() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.attachments a WHERE a.record_table = 'qc.coas' AND a.record_id = NEW.id::text
                    AND a.sha256 = NEW.sha256 AND a.file_name = NEW.file_name AND a.content_type = 'application/pdf') THEN
    RAISE EXCEPTION 'FILE_INTEGRITY_FAILED: certificate % is stored with its PDF in the same transaction', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_coa_file AFTER INSERT ON qc.coas
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qc.check_coa_file();

-- A certificate's only file is the PDF written when it is issued.
CREATE FUNCTION qc.guard_coa_attachment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM qc.coas c WHERE c.id::text = NEW.record_id AND c.tx_id = txid_current()
                    AND c.sha256 = NEW.sha256 AND c.file_name = NEW.file_name)
     OR EXISTS (SELECT 1 FROM core.attachments a WHERE a.record_table = 'qc.coas' AND a.record_id = NEW.record_id) THEN
    RAISE EXCEPTION 'RECORD_LOCKED: a certificate of analysis carries only the PDF written when it was issued' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_coa_attachment BEFORE INSERT ON core.attachments
  FOR EACH ROW WHEN (NEW.record_table = 'qc.coas') EXECUTE FUNCTION qc.guard_coa_attachment();

-- Voiding a certificate's PDF is a GMP void (QA Manager countersign, 0025): the TS target is flagged gmp (tested equal).
CREATE OR REPLACE FUNCTION core.gmp_attachment_tables() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['master.approved_sources', 'qc.coas']::TEXT[];
$$;
