-- 0026_gmp_void_two_people: owner 2026-11-25 (answer 3, changed): voiding a GMP attachment always needs two
-- people. The QA Manager who signs (qa.attachment.countersign, meaning APPROVED) is never the user who voids.
-- The service refuses with SEGREGATION_OF_DUTIES (403); this re-checks it at commit (0025 trigger, replaced).
CREATE OR REPLACE FUNCTION core.require_gmp_void_signature() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.e_signatures s
     WHERE s.record_table = 'core.attachments' AND s.record_id = NEW.id::text
       AND s.meaning = 'APPROVED' AND s.tx_id = txid_current()
  ) THEN
    RAISE EXCEPTION 'COUNTERSIGN_REQUIRED: attachment % is GMP evidence (%); voiding it needs a QA Manager e-signature',
      NEW.id, NEW.record_table USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM core.e_signatures s
     WHERE s.record_table = 'core.attachments' AND s.record_id = NEW.id::text
       AND s.meaning = 'APPROVED' AND s.tx_id = txid_current() AND s.user_id <> NEW.voided_by
  ) THEN
    RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: attachment % is GMP evidence; the QA Manager who signs its void cannot be the one voiding it',
      NEW.id USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
