-- 0033_debit_note_reversal: M3 (owner answers 2026-11-27 to task 5b).
--   A POSTED vendor debit note is reversed by a Finance Manager (fin.debit_note.reverse) with an e-signature, meaning
--   REVERSED, and a reason. Its journal is mirrored on the reversal day (an open period). A RETURN_TO_VENDOR note's
--   return movement is reversed with it, only while the lot is still REJECTED (one the return emptied is RETURNED
--   and never moves again: LOT_RETURN_NOT_REVERSIBLE in the service); the reversal of a disposal movement needs the
--   QA witness (0020). What the note took off the invoice is open again. The unwinding order is debit note →
--   invoice: an invoice is reversed only once no debit note in force names it.

-- ---------------------------------------------------------------- 1. debit notes: REVERSED
ALTER TABLE purch.debit_notes
  ADD COLUMN reversed_by     BIGINT REFERENCES core.users (id) ON DELETE RESTRICT,
  ADD COLUMN reversed_at     TIMESTAMPTZ,
  ADD COLUMN reversal_date   DATE,
  ADD COLUMN reversal_reason TEXT CHECK (reversal_reason IS NULL OR length(reversal_reason) BETWEEN 3 AND 500);

ALTER TABLE purch.debit_notes DROP CONSTRAINT debit_notes_status_check;
ALTER TABLE purch.debit_notes ADD CONSTRAINT debit_notes_status_check
  CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'POSTED', 'CANCELLED', 'REVERSED'));
-- 0032's posted-stamp checks (unnamed there), now with REVERSED as a posted note.
ALTER TABLE purch.debit_notes DROP CONSTRAINT debit_notes_check2;
ALTER TABLE purch.debit_notes DROP CONSTRAINT debit_notes_check3;
ALTER TABLE purch.debit_notes
  ADD CONSTRAINT debit_notes_posted_stamps CHECK (status NOT IN ('POSTED', 'REVERSED') OR (posting_date IS NOT NULL AND posted_by IS NOT NULL AND posted_at IS NOT NULL)),
  ADD CONSTRAINT debit_notes_unposted_stamps CHECK (status IN ('POSTED', 'REVERSED') OR (posting_date IS NULL AND posted_by IS NULL AND posted_at IS NULL)),
  ADD CONSTRAINT debit_notes_reversal CHECK ((status = 'REVERSED') = (reversed_by IS NOT NULL AND reversed_at IS NOT NULL AND reversal_date IS NOT NULL AND reversal_reason IS NOT NULL)),
  ADD CONSTRAINT debit_notes_reversal_after_posting CHECK (reversal_date IS NULL OR reversal_date >= posting_date);

-- ---------------------------------------------------------------- 2. debit-note guard: POSTED → REVERSED
-- 0032's guard, with the reversal in place of "a POSTED note never changes".
CREATE OR REPLACE FUNCTION purch.guard_debit_notes() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  inv RECORD;
  bad RECORD;
  sums RECORD;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a debit note starts as DRAFT' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('CANCELLED', 'REVERSED') THEN
    RAISE EXCEPTION 'RECORD_LOCKED: debit note % is % and never changes', OLD.doc_no, OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED' THEN
    -- Owner 2026-11-27: a posted note changes only by its reversal.
    IF NEW.status <> 'REVERSED'
       OR (to_jsonb(NEW) - ARRAY['status', 'reversed_by', 'reversed_at', 'reversal_date', 'reversal_reason', 'updated_at', 'updated_by'])
          IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['status', 'reversed_by', 'reversed_at', 'reversal_date', 'reversal_reason', 'updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'RECORD_LOCKED: debit note % is POSTED; it changes only by its reversal', OLD.doc_no USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
         SELECT 1 FROM core.e_signatures s
          WHERE s.record_table = 'purch.debit_notes' AND s.record_id = NEW.id::text AND s.meaning = 'REVERSED'
            AND s.tx_id = txid_current() AND s.user_id = NEW.reversed_by AND core.user_holds_key(s.user_id, 'fin.debit_note.reverse')) THEN
      RAISE EXCEPTION 'ESIGN_FAILED: reversing debit note % needs the e-signature (REVERSED) of a holder of fin.debit_note.reverse', NEW.doc_no
        USING ERRCODE = 'P0001';
    END IF;
    -- The note's journal is mirrored on the reversal day; no original of it stays POSTED (rounding sweeps excepted:
    -- they are never reversed).
    IF NOT EXISTS (SELECT 1 FROM fin.journal_entries j JOIN fin.journal_entries r ON r.id = j.reversal_id
                    WHERE j.source_type = 'DEBIT_NOTE' AND j.source_id = NEW.id
                      AND j.event = CASE WHEN NEW.reason = 'RETURN_TO_VENDOR' THEN 'LOT_RETURNED' ELSE 'VENDOR_DEBIT_NOTE' END
                      AND j.reversal_of IS NULL AND j.status = 'REVERSED' AND r.status = 'POSTED' AND r.entry_date = NEW.reversal_date)
       OR EXISTS (SELECT 1 FROM fin.journal_entries j WHERE j.source_type = 'DEBIT_NOTE' AND j.source_id = NEW.id AND j.status = 'POSTED'
                    AND j.reversal_of IS NULL AND j.event <> 'ROUNDING_DIFFERENCE') THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: debit note % is reversed together with its journal', NEW.doc_no USING ERRCODE = 'P0001';
    END IF;
    -- A return note: its return movement is reversed in the same reversal, on the same day.
    IF NEW.reason = 'RETURN_TO_VENDOR' AND EXISTS (
         SELECT 1 FROM purch.debit_note_lines l
          WHERE l.debit_note_id = NEW.id
            AND NOT EXISTS (SELECT 1 FROM inv.stock_movements m
                             WHERE m.reversal_of = l.movement_id AND m.ref_doc_type = 'DEBIT_NOTE' AND m.ref_doc_id = NEW.id
                               AND m.movement_date = NEW.reversal_date)) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: return note % is reversed together with its return movement', NEW.doc_no USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'REVERSED' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: only a POSTED debit note is reversed' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.invoice_id <> OLD.invoice_id OR NEW.vendor_id <> OLD.vendor_id OR NEW.reason <> OLD.reason) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a debit note keeps its invoice, vendor and reason (cancel it and enter a new one)' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'DRAFT'
     AND (to_jsonb(NEW) - ARRAY['status', 'posting_date', 'posted_by', 'posted_at', 'updated_at', 'updated_by'])
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['status', 'posting_date', 'posted_by', 'posted_at', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'RECORD_LOCKED: debit note % is %; what it debits no longer changes (a rejection returns it to DRAFT)', OLD.doc_no, OLD.status
      USING ERRCODE = 'P0001';
  END IF;
  SELECT doc_no, vendor_id, invoice_type, status, currency, exchange_rate, invoice_date, total_amount, company_id INTO inv
    FROM purch.vendor_invoices WHERE id = NEW.invoice_id;
  IF inv.company_id <> NEW.company_id OR inv.vendor_id <> NEW.vendor_id OR inv.currency <> NEW.currency OR inv.exchange_rate <> NEW.exchange_rate THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a debit note is for the invoice''s vendor, in its currency and at its rate (invoice %)', inv.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.dn_date < inv.invoice_date THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: debit note % is dated before invoice %', NEW.doc_no, inv.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status IN ('DRAFT', 'CANCELLED') OR (TG_OP = 'UPDATE' AND NEW.status = OLD.status) THEN
    RETURN NEW;
  END IF;

  -- PENDING_APPROVAL, APPROVED, POSTED: lines of this GOODS invoice, priced and taxed as billed, within what is open.
  IF inv.invoice_type <> 'GOODS' OR inv.status <> 'POSTED' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a debit note is against a POSTED goods invoice (% is %)', inv.doc_no, inv.status USING ERRCODE = 'P0001';
  END IF;
  SELECT count(*) AS n, coalesce(sum(l.amount), 0) AS goods, coalesce(sum(l.tax_amount), 0) AS tax, coalesce(sum(l.amount_pkr + l.tax_pkr), 0) AS pkr,
         count(*) FILTER (WHERE l.qty IS NULL) AS no_qty
    INTO sums FROM purch.debit_note_lines l WHERE l.debit_note_id = NEW.id;
  IF sums.n = 0 OR sums.goods <> NEW.goods_amount OR sums.tax <> NEW.tax_amount OR sums.pkr <> NEW.total_pkr THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: debit note % totals do not equal its lines', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.reason = 'PRICE_CLAIM') <> (sums.no_qty = sums.n) OR (NEW.reason <> 'PRICE_CLAIM' AND sums.no_qty > 0)
     OR (NEW.reason = 'RETURN_TO_VENDOR' AND sums.n <> 1) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: debit note % lines do not fit its reason %', NEW.doc_no, NEW.reason USING ERRCODE = 'P0001';
  END IF;
  SELECT l.line_no INTO bad FROM purch.debit_note_lines l
    JOIN purch.vendor_invoice_lines il ON il.id = l.invoice_line_id
    JOIN purch.grn_lines gl ON gl.id = il.grn_line_id
   WHERE l.debit_note_id = NEW.id
     AND (il.invoice_id <> NEW.invoice_id
          OR (l.qty IS NOT NULL AND l.unit_price <> il.unit_price)
          OR l.tax_code_id IS DISTINCT FROM il.tax_code_id OR l.tax_rate <> il.tax_rate
          OR (NEW.reason = 'RETURN_TO_VENDOR') <> (l.lot_id IS NOT NULL)
          OR (l.lot_id IS NOT NULL AND l.lot_id IS DISTINCT FROM gl.lot_id)
          -- Per invoice line: everything debited never exceeds the amount billed.
          OR (SELECT coalesce(sum(x.amount), 0) FROM purch.debit_note_lines x JOIN purch.debit_notes xd ON xd.id = x.debit_note_id
               WHERE x.invoice_line_id = il.id AND (xd.status = 'POSTED' OR xd.id = NEW.id)) > il.amount
          -- Short supply: never more than was billed beyond the quantity received (matched).
          OR (NEW.reason = 'SHORT_SUPPLY'
              AND (SELECT coalesce(sum(x.qty), 0) FROM purch.debit_note_lines x JOIN purch.debit_notes xd ON xd.id = x.debit_note_id
                    WHERE x.invoice_line_id = il.id AND xd.reason = 'SHORT_SUPPLY' AND (xd.status = 'POSTED' OR xd.id = NEW.id))
                  > il.qty - il.matched_qty)
          -- Return: never more than was billed and received.
          OR (NEW.reason = 'RETURN_TO_VENDOR'
              AND (SELECT coalesce(sum(x.qty), 0) FROM purch.debit_note_lines x JOIN purch.debit_notes xd ON xd.id = x.debit_note_id
                    WHERE x.invoice_line_id = il.id AND xd.reason = 'RETURN_TO_VENDOR' AND (xd.status = 'POSTED' OR xd.id = NEW.id))
                  > il.matched_qty))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'AMOUNT_EXCEEDS_OPEN: debit note % line % debits more than its invoice line billed (or does not follow it)', NEW.doc_no, bad.line_no
      USING ERRCODE = 'P0001';
  END IF;
  -- The note never takes the invoice below zero: total − POSTED payments − POSTED notes.
  IF NEW.total_amount + purch.invoice_paid_foreign(NEW.invoice_id, 0) + purch.invoice_debited_foreign(NEW.invoice_id, NEW.id) > inv.total_amount THEN
    RAISE EXCEPTION 'AMOUNT_EXCEEDS_OPEN: debit note % is more than is open on invoice %', NEW.doc_no, inv.doc_no USING ERRCODE = 'P0001';
  END IF;

  IF NEW.status = 'PENDING_APPROVAL' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: a debit note is submitted from DRAFT' USING ERRCODE = 'P0001';
    END IF;
    PERFORM purch.assert_vendor_active(NEW.vendor_id);
    RETURN NEW;
  END IF;
  IF NEW.status = 'APPROVED' THEN
    -- Rule 9: whoever creates or submits a debit note does not approve it.
    IF OLD.status <> 'PENDING_APPROVAL' OR NOT EXISTS (
         SELECT 1 FROM core.approvals a WHERE a.doc_table = 'purch.debit_notes' AND a.doc_id = NEW.id::text AND a.status = 'APPROVED')
       OR EXISTS (
         SELECT 1 FROM core.approvals a JOIN core.approval_steps s ON s.approval_id = a.id
          WHERE a.doc_table = 'purch.debit_notes' AND a.doc_id = NEW.id::text AND a.status = 'APPROVED'
            AND s.acted_by IN (NEW.created_by, NEW.submitted_by)) THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: debit note % is approved through the approval matrix by someone other than its creator', NEW.doc_no
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- → POSTED (from APPROVED), on its date.
  IF OLD.status <> 'APPROVED' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: debit note % is posted once approved', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  PERFORM purch.assert_vendor_active(NEW.vendor_id);
  IF NEW.posting_date <> NEW.dn_date THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: debit note % posts on its date', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM purch.debit_note_lines l WHERE l.debit_note_id = NEW.id AND l.price_variance_pkr IS NULL) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: debit note % has lines without a posting result', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.reason = 'RETURN_TO_VENDOR' THEN
    -- The witnessed RETURN_TO_VENDOR movement of the line's lot, made for this note, of exactly its quantity and value.
    SELECT l.line_no INTO bad FROM purch.debit_note_lines l LEFT JOIN inv.stock_movements m ON m.id = l.movement_id
     WHERE l.debit_note_id = NEW.id
       AND (m.id IS NULL OR m.movement_type <> 'RETURN_TO_VENDOR' OR m.reversal_of IS NOT NULL OR m.lot_id <> l.lot_id
            OR m.ref_doc_type <> 'DEBIT_NOTE' OR m.ref_doc_id <> NEW.id OR m.qty <> -l.qty OR m.value <> -l.stock_value_pkr
            OR m.movement_date <> NEW.posting_date)
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: debit note % line % is not linked to its return movement', NEW.doc_no, bad.line_no USING ERRCODE = 'P0001';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM purch.debit_note_lines l WHERE l.debit_note_id = NEW.id AND (l.movement_id IS NOT NULL OR l.lot_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: only a return note moves stock' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin.journal_entries j
                  WHERE j.source_type = 'DEBIT_NOTE' AND j.source_id = NEW.id
                    AND j.event = CASE WHEN NEW.reason = 'RETURN_TO_VENDOR' THEN 'LOT_RETURNED' ELSE 'VENDOR_DEBIT_NOTE' END
                    AND j.status = 'POSTED' AND j.reversal_of IS NULL AND j.entry_date = NEW.posting_date) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: debit note % has no posted journal', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- 3. invoice guard: a REVERSED note no longer holds it
-- 0032's guard; only the debit-note line changes (the unwinding order is debit note → invoice, owner 2026-11-27).
CREATE OR REPLACE FUNCTION purch.guard_vendor_invoices() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v RECORD;
  po RECORD;
  bad RECORD;
  sums RECORD;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a vendor invoice starts as DRAFT' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('CANCELLED', 'REVERSED') THEN
    RAISE EXCEPTION 'RECORD_LOCKED: vendor invoice % is % and never changes', OLD.doc_no, OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED' THEN
    -- Owner 2026-11-26: a posted invoice changes only by its reversal.
    IF NEW.status <> 'REVERSED'
       OR (to_jsonb(NEW) - ARRAY['status', 'reversed_by', 'reversed_at', 'reversal_date', 'reversal_reason', 'updated_at', 'updated_by'])
          IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['status', 'reversed_by', 'reversed_at', 'reversal_date', 'reversal_reason', 'updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'RECORD_LOCKED: vendor invoice % is POSTED; it changes only by its reversal', OLD.doc_no USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
         SELECT 1 FROM core.e_signatures s
          WHERE s.record_table = 'purch.vendor_invoices' AND s.record_id = NEW.id::text AND s.meaning = 'REVERSED'
            AND s.tx_id = txid_current() AND s.user_id = NEW.reversed_by AND core.user_holds_key(s.user_id, 'fin.invoice.reverse')) THEN
      RAISE EXCEPTION 'ESIGN_FAILED: reversing invoice % needs the e-signature (REVERSED) of a holder of fin.invoice.reverse', NEW.doc_no
        USING ERRCODE = 'P0001';
    END IF;
    SELECT p.doc_no INTO bad FROM purch.payment_allocations a JOIN purch.vendor_payments p ON p.id = a.payment_id
     WHERE a.invoice_id = NEW.id AND p.status NOT IN ('CANCELLED', 'REVERSED') LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'IN_USE: invoice % is on payment %; reverse or cancel the payment first', NEW.doc_no, bad.doc_no USING ERRCODE = 'P0001';
    END IF;
    SELECT d.doc_no INTO bad FROM purch.debit_notes d WHERE d.invoice_id = NEW.id AND d.status NOT IN ('CANCELLED', 'REVERSED') LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'IN_USE: invoice % has debit note %; reverse the debit note first', NEW.doc_no, bad.doc_no USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM fin.journal_entries j JOIN fin.journal_entries r ON r.id = j.reversal_id
                    WHERE j.source_type = 'VENDOR_INVOICE' AND j.source_id = NEW.id AND j.event = 'VENDOR_INVOICE'
                      AND j.reversal_of IS NULL AND j.status = 'REVERSED' AND r.status = 'POSTED' AND r.entry_date = NEW.reversal_date)
       OR EXISTS (SELECT 1 FROM fin.journal_entries j WHERE j.source_type = 'VENDOR_INVOICE' AND j.source_id = NEW.id AND j.status = 'POSTED'
                    AND j.reversal_of IS NULL) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: invoice % is reversed together with its journal', NEW.doc_no USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.invoice_type <> OLD.invoice_type OR NEW.vendor_id <> OLD.vendor_id OR NEW.po_id IS DISTINCT FROM OLD.po_id) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: an invoice keeps its type, vendor and PO (cancel it and enter a new one)' USING ERRCODE = 'P0001';
  END IF;
  -- In MATCH_EXCEPTION what was billed stays: only the status, the release and the rate at posting change.
  IF TG_OP = 'UPDATE' AND OLD.status = 'MATCH_EXCEPTION'
     AND (to_jsonb(NEW) - ARRAY['status', 'exception_at', 'released_by', 'released_at', 'release_reason', 'posting_date', 'posted_by', 'posted_at',
                                'exchange_rate', 'exchange_rate_date', 'total_pkr', 'updated_at', 'updated_by'])
         IS DISTINCT FROM
         (to_jsonb(OLD) - ARRAY['status', 'exception_at', 'released_by', 'released_at', 'release_reason', 'posting_date', 'posted_by', 'posted_at',
                                'exchange_rate', 'exchange_rate_date', 'total_pkr', 'updated_at', 'updated_by']) THEN
    RAISE EXCEPTION 'RECORD_LOCKED: invoice % is in MATCH_EXCEPTION; it is released or returned to DRAFT, not edited', OLD.doc_no
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'REVERSED' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: only a POSTED invoice is reversed' USING ERRCODE = 'P0001';
  END IF;
  SELECT company_id INTO v FROM master.vendors WHERE id = NEW.vendor_id;
  IF v.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: the vendor belongs to another company' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.po_id IS NOT NULL THEN
    SELECT doc_no, vendor_id, currency, status, company_id INTO po FROM purch.purchase_orders WHERE id = NEW.po_id;
    IF po.company_id <> NEW.company_id OR po.vendor_id <> NEW.vendor_id OR po.currency <> NEW.currency THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a GOODS invoice is from the PO''s vendor, in the PO''s currency (PO %)', po.doc_no USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NEW.status IN ('DRAFT', 'CANCELLED') OR (TG_OP = 'UPDATE' AND NEW.status = OLD.status) THEN
    RETURN NEW;
  END IF;

  -- DRAFT → MATCH_EXCEPTION or → POSTED; MATCH_EXCEPTION → POSTED.
  IF NOT EXISTS (SELECT 1 FROM purch.vendor_invoice_lines WHERE invoice_id = NEW.id) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: invoice % has no lines', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  SELECT coalesce(sum(amount), 0) AS goods, coalesce(sum(tax_amount), 0) AS tax,
         sum(amount_pkr + tax_pkr) AS pkr, bool_and(in_tolerance) AS all_ok, count(*) FILTER (WHERE in_tolerance IS NULL) AS unchecked
    INTO sums FROM purch.vendor_invoice_lines WHERE invoice_id = NEW.id;
  IF sums.goods <> NEW.goods_amount OR sums.tax <> NEW.tax_amount THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: invoice % totals do not equal its lines', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.invoice_type = 'GOODS' THEN
    IF sums.unchecked > 0 OR EXISTS (SELECT 1 FROM purch.vendor_invoice_lines l WHERE l.invoice_id = NEW.id
                                      AND l.in_tolerance IS DISTINCT FROM purch.invoice_line_in_tolerance(l.id)) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: invoice % has a match result that does not follow the tolerances', NEW.doc_no USING ERRCODE = 'P0001';
    END IF;
    SELECT l.line_no INTO bad FROM purch.vendor_invoice_lines l
      JOIN purch.grn_lines gl ON gl.id = l.grn_line_id JOIN purch.grns g ON g.id = gl.grn_id
     WHERE l.invoice_id = NEW.id AND (g.status <> 'POSTED' OR g.po_id <> NEW.po_id) LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: invoice % line % names a GRN line that is not a POSTED receipt of its PO', NEW.doc_no, bad.line_no
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.status = 'MATCH_EXCEPTION' THEN
    IF OLD.status <> 'DRAFT' OR coalesce(sums.all_ok, true) THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: only a DRAFT invoice with a line outside the tolerances goes to MATCH_EXCEPTION' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- → POSTED
  PERFORM purch.assert_vendor_active(NEW.vendor_id);
  IF OLD.status = 'DRAFT' AND NOT coalesce(sums.all_ok, true) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: invoice % is outside the match tolerances; it goes to MATCH_EXCEPTION', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'MATCH_EXCEPTION' THEN
    IF NEW.released_by IS DISTINCT FROM NEW.posted_by OR NEW.released_by = NEW.created_by OR NOT EXISTS (
         SELECT 1 FROM core.e_signatures s
          WHERE s.record_table = 'purch.vendor_invoices' AND s.record_id = NEW.id::text AND s.meaning = 'APPROVED'
            AND s.tx_id = txid_current() AND s.user_id = NEW.released_by
            AND core.user_holds_key(s.user_id, 'fin.invoice.match_release')) THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: invoice % in MATCH_EXCEPTION is released by a Finance Manager''s e-signature, not by the person who entered it', NEW.doc_no
        USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.released_by IS NOT NULL THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: only an invoice in MATCH_EXCEPTION is released' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.posting_date <> NEW.invoice_date THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: invoice % posts on its invoice date', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NEW.currency <> 'PKR' AND NOT EXISTS (
       SELECT 1 FROM fin.exchange_rates r
        WHERE r.company_id = NEW.company_id AND r.currency = NEW.currency AND r.rate_date = NEW.exchange_rate_date AND r.rate = NEW.exchange_rate) THEN
    RAISE EXCEPTION 'RATE_MISSING: invoice % uses a % rate of % that is not in the rate table', NEW.doc_no, NEW.currency, NEW.exchange_rate_date
      USING ERRCODE = 'P0001';
  END IF;
  IF sums.pkr IS DISTINCT FROM NEW.total_pkr THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: invoice % lines carry % PKR, the total is %', NEW.doc_no, sums.pkr, NEW.total_pkr USING ERRCODE = 'P0001';
  END IF;
  IF NEW.invoice_type = 'GOODS' THEN
    SELECT gl.line_no INTO bad FROM purch.vendor_invoice_lines l JOIN purch.grn_lines gl ON gl.id = l.grn_line_id
     WHERE l.invoice_id = NEW.id
       AND (SELECT coalesce(sum(x.cleared_pkr), 0) FROM purch.vendor_invoice_lines x JOIN purch.vendor_invoices xi ON xi.id = x.invoice_id
             WHERE x.grn_line_id = l.grn_line_id AND (xi.status = 'POSTED' OR xi.id = NEW.id)) > purch.grn_line_receipt_value(l.grn_line_id)
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: invoice % would take more GRNI off GRN line % than its receipt booked', NEW.doc_no, bad.line_no
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    SELECT c.doc_no INTO bad FROM purch.vendor_invoice_lines l JOIN purch.landed_costs c ON c.id = l.landed_cost_id
     WHERE l.invoice_id = NEW.id
       AND (c.status <> 'POSTED' OR c.correction_of IS NOT NULL OR c.currency <> NEW.currency
            OR (c.vendor_id IS NOT NULL AND c.vendor_id <> NEW.vendor_id)
            OR l.amount > purch.landed_cost_open_foreign(c.id, NEW.id))
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'AMOUNT_EXCEEDS_OPEN: invoice % bills landed cost % beyond what is open (or it is not a POSTED charge of this vendor and currency)', NEW.doc_no, bad.doc_no
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin.journal_entries j
                  WHERE j.source_type = 'VENDOR_INVOICE' AND j.source_id = NEW.id AND j.event = 'VENDOR_INVOICE'
                    AND j.status = 'POSTED' AND j.reversal_of IS NULL AND j.entry_date = NEW.posting_date) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: invoice % has no posted journal', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
