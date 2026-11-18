-- 0013_journal_series_wht (owner, 18-11-2026; decisions.md "Journal series" and "WHT rates"):
--
-- 1. Two journal series. Manual journal vouchers (source_type MANUAL, no posting event) take the JV series;
--    system journals posted by modules take the SJ series and always name their source document
--    (source_type + source_id + posting event). The engine picks the series; the database keeps the
--    source fields consistent so manual journals can always be listed on their own.
-- 2. Withholding-tax rates are placeholders until Finance confirms them. A journal line may carry the tax code
--    it books; posting an entry with a line whose WITHHOLDING code is still a placeholder is refused
--    (TAX_RATE_NOT_CONFIRMED). Finance confirms a rate by clearing is_placeholder (fin.master.manage); a
--    confirmed code is never marked placeholder again. The seeded WHT rows are renamed "RATE NOT CONFIRMED".

-- ---------------------------------------------------------------- 1. manual vs system journals

ALTER TABLE fin.journal_entries
  ADD CONSTRAINT journal_manual_has_no_event CHECK ((source_type = 'MANUAL') = (event IS NULL)),
  ADD CONSTRAINT journal_system_names_source CHECK ((source_type = 'MANUAL') = (source_id IS NULL));

CREATE INDEX journal_entries_manual_idx ON fin.journal_entries (company_id, entry_date) WHERE source_type = 'MANUAL';

-- ---------------------------------------------------------------- 2. tax code on journal lines

ALTER TABLE fin.journal_lines
  ADD COLUMN tax_code_id BIGINT REFERENCES master.tax_codes (id) ON DELETE RESTRICT;  -- the tax this line books, if any

/** Raises TAX_RATE_NOT_CONFIRMED for a WITHHOLDING code Finance has not confirmed. For any module that books WHT. */
CREATE FUNCTION master.assert_tax_rate_confirmed(tax_code BIGINT) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  tc RECORD;
BEGIN
  IF tax_code IS NULL THEN
    RETURN;
  END IF;
  SELECT code, kind, is_placeholder INTO tc FROM master.tax_codes WHERE id = tax_code;
  IF tc.kind = 'WITHHOLDING' AND tc.is_placeholder THEN
    RAISE EXCEPTION 'TAX_RATE_NOT_CONFIRMED: withholding tax % has a placeholder rate; Finance must confirm it before it is posted', tc.code
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- A confirmed tax code stays confirmed (like accounts and posting rules in 0012).
CREATE FUNCTION master.guard_tax_code() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_placeholder AND NOT OLD.is_placeholder THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a confirmed tax code cannot be marked placeholder again' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a tax code''s kind never changes' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_tax_code BEFORE UPDATE ON master.tax_codes
  FOR EACH ROW EXECUTE FUNCTION master.guard_tax_code();

-- The journal guard from 0012, plus: WHT lines need a confirmed rate when the entry is posted, and a reversal
-- mirrors the tax code too. Everything else is unchanged.
CREATE OR REPLACE FUNCTION fin.guard_journal_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  n_lines INTEGER;
  total_debit NUMERIC(18,2);
  total_credit NUMERIC(18,2);
  original_status TEXT;
  line_tax BIGINT;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a journal entry is created DRAFT, given its lines, then posted' USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'INSERT' OR NEW.entry_date IS DISTINCT FROM OLD.entry_date THEN
    SELECT p.id INTO NEW.period_id FROM core.fiscal_periods p
     WHERE p.company_id = NEW.company_id AND NEW.entry_date BETWEEN p.start_date AND p.end_date;
    IF NEW.period_id IS NULL THEN
      RAISE EXCEPTION 'PERIOD_NOT_DEFINED: no fiscal period covers %', to_char(NEW.entry_date, 'DD-MM-YYYY') USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.period_id IS DISTINCT FROM OLD.period_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: the period follows the entry date' USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status = 'DRAFT' AND NEW.status = 'POSTED' THEN
    SELECT count(*), COALESCE(sum(debit), 0), COALESCE(sum(credit), 0) INTO n_lines, total_debit, total_credit
      FROM fin.journal_lines WHERE entry_id = NEW.id;
    IF n_lines < 2 OR total_debit <> total_credit OR total_debit = 0 THEN
      RAISE EXCEPTION 'JOURNAL_UNBALANCED: entry % has % lines, debits % and credits %', NEW.doc_no, n_lines, total_debit, total_credit
        USING ERRCODE = 'P0001';
    END IF;
    FOR line_tax IN SELECT DISTINCT tax_code_id FROM fin.journal_lines WHERE entry_id = NEW.id AND tax_code_id IS NOT NULL LOOP
      PERFORM master.assert_tax_rate_confirmed(line_tax);
    END LOOP;
    IF NEW.reversal_of IS NOT NULL THEN
      SELECT status INTO original_status FROM fin.journal_entries WHERE id = NEW.reversal_of FOR UPDATE;
      IF original_status IS DISTINCT FROM 'POSTED' THEN
        RAISE EXCEPTION 'INVALID_TRANSITION: only a POSTED entry can be reversed' USING ERRCODE = 'P0001';
      END IF;
      -- The reversal mirrors the original line for line: same account, dimensions and tax code, debit and credit swapped.
      IF EXISTS (
        (SELECT account_id, credit AS debit, debit AS credit, cost_center_id, customer_id, vendor_id, production_order_id, tax_code_id
           FROM fin.journal_lines WHERE entry_id = NEW.reversal_of
         EXCEPT ALL
         SELECT account_id, debit, credit, cost_center_id, customer_id, vendor_id, production_order_id, tax_code_id
           FROM fin.journal_lines WHERE entry_id = NEW.id)
        UNION ALL
        (SELECT account_id, debit, credit, cost_center_id, customer_id, vendor_id, production_order_id, tax_code_id
           FROM fin.journal_lines WHERE entry_id = NEW.id
         EXCEPT ALL
         SELECT account_id, credit, debit, cost_center_id, customer_id, vendor_id, production_order_id, tax_code_id
           FROM fin.journal_lines WHERE entry_id = NEW.reversal_of)
      ) THEN
        RAISE EXCEPTION 'VALIDATION_FAILED: a reversal must mirror the original entry''s lines' USING ERRCODE = 'P0001';
      END IF;
    END IF;
    NEW.posted_at := now();
    NEW.posted_by := COALESCE(core.current_user_id(), NEW.posted_by);
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status = 'REVERSED' AND OLD.status IS DISTINCT FROM 'REVERSED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM fin.journal_entries r WHERE r.id = NEW.reversal_id AND r.reversal_of = NEW.id AND r.status = 'POSTED'
    ) THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: an entry is marked REVERSED only by its own posted reversal' USING ERRCODE = 'P0001';
    END IF;
    NEW.reversed_at := now();
    NEW.reversed_by := COALESCE(core.current_user_id(), NEW.reversed_by);
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- 3. existing rows (dev databases)
-- As SYSTEM, audited with a reason. On a fresh database nothing matches; the seed creates the renamed rows.

SELECT set_config('app.user_id', '1', true),
       set_config('app.company_id', '1', true),
       set_config('app.reason', 'owner 18-11-2026: WHT rate not confirmed; JV for manual journals only', true);

UPDATE master.tax_codes
   SET name = name || ' - RATE NOT CONFIRMED'
 WHERE kind = 'WITHHOLDING' AND is_placeholder AND code IN ('WHT-153-1A', 'WHT-153-1B') AND name NOT LIKE '%RATE NOT CONFIRMED%';

UPDATE core.number_series SET name = 'Manual journal voucher' WHERE doc_type = 'JV' AND name = 'Journal entry';

SELECT set_config('app.reason', '', true),
       set_config('app.user_id', '', true),
       set_config('app.company_id', '', true);
