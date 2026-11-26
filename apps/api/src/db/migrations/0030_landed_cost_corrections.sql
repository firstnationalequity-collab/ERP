-- 0030_landed_cost_corrections: M3 task 4b, owner answers 2026-11-25 to the task-3/4 defaults.
--   1. E-signature meaning REVERSED (a GRN reversal signs REVERSED, not APPROVED).
--   2. A charge carries a currency: foreign amount × the rate of the charge date (latest on or before, within
--      fin.rate.max_age_days) = the PKR amount. PKR charges: rate 1, foreign amount = amount.
--   3. Correction charge: a new landed-cost document with a negative amount, linked to the original (same GRN,
--      type, currency, basis, vendor), allocated like the original and split between held stock and price variance
--      at its own date; posted by a Finance Manager with an e-signature (purch.landed_cost.correct), creator ≠ signer.
--      Never takes a lot's value below zero; corrections never exceed the original.
--   4. GRN reversal with posted charges: allowed while the lots are untouched (the charges' own value adjustments
--      do not count as use); the reversal undoes every posted charge (POSTED → REVERSED) in the same transaction.
--      Replaces GRN_HAS_LANDED_COST.
-- The database re-checks what the service checks.

-- ---------------------------------------------------------------- 1. e-signature meaning
ALTER TABLE core.e_signatures DROP CONSTRAINT e_signatures_meaning_check;
ALTER TABLE core.e_signatures ADD CONSTRAINT e_signatures_meaning_check
  CHECK (meaning IN ('REVIEWED', 'APPROVED', 'RELEASED', 'REJECTED', 'WITNESSED', 'PERFORMED', 'REVERSED'));

-- ---------------------------------------------------------------- 2/3. landed cost columns
ALTER TABLE purch.landed_costs
  ADD COLUMN currency           TEXT          NOT NULL DEFAULT 'PKR' CHECK (currency ~ '^[A-Z]{3}$'),
  ADD COLUMN foreign_amount     NUMERIC(18,2),
  ADD COLUMN exchange_rate      NUMERIC(18,6) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
  ADD COLUMN exchange_rate_date DATE,
  ADD COLUMN correction_of      BIGINT        REFERENCES purch.landed_costs (id) ON DELETE RESTRICT,
  ADD COLUMN correction_reason  TEXT          CHECK (correction_reason IS NULL OR length(trim(correction_reason)) BETWEEN 3 AND 500);
UPDATE purch.landed_costs SET foreign_amount = amount, exchange_rate_date = charge_date;
ALTER TABLE purch.landed_costs ALTER COLUMN foreign_amount SET NOT NULL, ALTER COLUMN exchange_rate_date SET NOT NULL;
ALTER TABLE purch.landed_costs ALTER COLUMN currency DROP DEFAULT, ALTER COLUMN exchange_rate DROP DEFAULT;
CREATE INDEX landed_costs_correction_idx ON purch.landed_costs (correction_of) WHERE correction_of IS NOT NULL;

ALTER TABLE purch.landed_costs DROP CONSTRAINT landed_costs_amount_check;
ALTER TABLE purch.landed_costs DROP CONSTRAINT landed_costs_status_check;
ALTER TABLE purch.landed_costs DROP CONSTRAINT landed_costs_check;
ALTER TABLE purch.landed_costs DROP CONSTRAINT landed_costs_check1;
ALTER TABLE purch.landed_costs
  ADD CONSTRAINT landed_costs_status_check CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED', 'REVERSED')),
  ADD CONSTRAINT landed_costs_posted_stamp CHECK (
    status NOT IN ('POSTED', 'REVERSED') OR (posting_date IS NOT NULL AND posted_by IS NOT NULL AND posted_at IS NOT NULL)),
  ADD CONSTRAINT landed_costs_unposted_stamp CHECK (
    status IN ('POSTED', 'REVERSED') OR (posting_date IS NULL AND posted_by IS NULL AND posted_at IS NULL)),
  -- An original is positive; a correction negative, with its reason.
  ADD CONSTRAINT landed_costs_amount_sign CHECK (
    CASE WHEN correction_of IS NULL THEN amount > 0 AND foreign_amount > 0 AND correction_reason IS NULL
         ELSE amount < 0 AND foreign_amount < 0 AND correction_reason IS NOT NULL END),
  -- PKR amount = foreign amount × rate, half-up to the paisa; a PKR charge has rate 1.
  ADD CONSTRAINT landed_costs_conversion CHECK (
    amount = round(foreign_amount * exchange_rate, 2)
    AND (currency <> 'PKR' OR (exchange_rate = 1 AND exchange_rate_date = charge_date))
    AND exchange_rate_date <= charge_date),
  ADD CONSTRAINT landed_costs_correction_not_self CHECK (correction_of IS DISTINCT FROM id);

-- Allocations of a correction are negative (every part with the same sign).
ALTER TABLE purch.landed_cost_allocations DROP CONSTRAINT landed_cost_allocations_amount_check;
ALTER TABLE purch.landed_cost_allocations DROP CONSTRAINT landed_cost_allocations_held_amount_check;
ALTER TABLE purch.landed_cost_allocations DROP CONSTRAINT landed_cost_allocations_variance_amount_check;
ALTER TABLE purch.landed_cost_allocations DROP CONSTRAINT landed_cost_allocations_check1;
ALTER TABLE purch.landed_cost_allocations
  ADD CONSTRAINT landed_cost_allocations_sign CHECK (
    (amount >= 0 AND held_amount >= 0 AND variance_amount >= 0) OR (amount <= 0 AND held_amount <= 0 AND variance_amount <= 0)),
  ADD CONSTRAINT landed_cost_allocations_movement CHECK ((held_amount <> 0) = (movement_id IS NOT NULL));

-- ---------------------------------------------------------------- header guard (replaces 0029's)
CREATE OR REPLACE FUNCTION purch.guard_landed_costs() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  g RECORD;
  t RECORD;
  o RECORD;
  alloc RECORD;
  bad RECORD;
  corrected NUMERIC;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a landed cost starts as DRAFT' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED' THEN
    -- POSTED → REVERSED (with its GRN, 4b); nothing else changes.
    IF NEW.status <> 'REVERSED'
       OR (to_jsonb(NEW) - ARRAY['status', 'updated_at', 'updated_by']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'updated_at', 'updated_by']) THEN
      RAISE EXCEPTION 'RECORD_LOCKED: landed cost % is POSTED and never changes (it is reversed only with its GRN)', OLD.doc_no USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'RECORD_LOCKED: landed cost % is % and never changes', OLD.doc_no, OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.grn_id <> OLD.grn_id OR NEW.with_grn <> OLD.with_grn OR NEW.correction_of IS DISTINCT FROM OLD.correction_of) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a landed cost never moves to another GRN or original' USING ERRCODE = 'P0001';
  END IF;
  SELECT doc_no, status, grn_date, company_id INTO g FROM purch.grns WHERE id = NEW.grn_id;
  SELECT code, capitalise, is_duty, is_active, company_id INTO t FROM purch.landed_cost_types WHERE id = NEW.charge_type_id;
  IF g.company_id <> NEW.company_id OR t.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: GRN and charge type must belong to the company' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.correction_of IS NOT NULL THEN
    SELECT doc_no, status, grn_id, charge_type_id, currency, basis, vendor_id, correction_of, posting_date, foreign_amount, company_id
      INTO o FROM purch.landed_costs WHERE id = NEW.correction_of;
    IF o.company_id <> NEW.company_id OR o.correction_of IS NOT NULL
       OR (o.grn_id, o.charge_type_id, o.currency, o.basis, o.vendor_id) IS DISTINCT FROM
          (NEW.grn_id, NEW.charge_type_id, NEW.currency, NEW.basis, NEW.vendor_id)
       OR NEW.with_grn THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: correction % keeps its original''s GRN, charge type, currency, basis and vendor (and an original is not a correction)', NEW.doc_no
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.status = 'DRAFT' THEN
    IF NEW.with_grn <> (g.status = 'DRAFT') OR g.status NOT IN ('DRAFT', 'POSTED') THEN
      RAISE EXCEPTION 'INVALID_TRANSITION: GRN % is %: charges are entered on a DRAFT GRN (rolled in at posting) or a POSTED one (later bill)', g.doc_no, g.status
        USING ERRCODE = 'P0001';
    END IF;
    IF NOT t.is_active THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: charge type % is not active', t.code USING ERRCODE = 'P0001';
    END IF;
    IF t.capitalise <> (NEW.basis IS NOT NULL)
       OR (NEW.basis = 'GD_AMOUNTS' AND NOT t.is_duty) OR (NEW.basis = 'WEIGHT' AND t.is_duty) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: charge type % does not take basis %', t.code, coalesce(NEW.basis, 'none') USING ERRCODE = 'P0001';
    END IF;
    IF NEW.correction_of IS NOT NULL THEN
      IF o.status <> 'POSTED' THEN
        RAISE EXCEPTION 'INVALID_TRANSITION: landed cost % is %; only a POSTED charge is corrected', o.doc_no, o.status USING ERRCODE = 'P0001';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'CANCELLED' THEN
    RETURN NEW;
  END IF;

  -- DRAFT → POSTED
  IF g.status <> 'POSTED' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: GRN % is %; a landed cost posts on a POSTED GRN', g.doc_no, g.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.posting_date <> (CASE WHEN NEW.with_grn THEN g.grn_date ELSE NEW.charge_date END) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: landed cost % posts on % (with the GRN: the GRN date; later bill: the charge date)', NEW.doc_no,
      CASE WHEN NEW.with_grn THEN g.grn_date ELSE NEW.charge_date END USING ERRCODE = 'P0001';
  END IF;
  IF NOT NEW.with_grn AND NEW.charge_date < g.grn_date THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a later bill is dated on or after the GRN date (%)', g.grn_date USING ERRCODE = 'P0001';
  END IF;
  -- Owner 2026-11-25 (4b, answer 3): a foreign charge converts at Finance's rate for the charge date.
  IF NEW.currency <> 'PKR' AND NOT EXISTS (
       SELECT 1 FROM fin.exchange_rates r
        WHERE r.company_id = NEW.company_id AND r.currency = NEW.currency AND r.rate_date = NEW.exchange_rate_date AND r.rate = NEW.exchange_rate) THEN
    RAISE EXCEPTION 'RATE_MISSING: landed cost % uses a % rate of % that is not in the rate table', NEW.doc_no, NEW.currency, NEW.exchange_rate_date
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.correction_of IS NOT NULL THEN
    IF o.status <> 'POSTED' OR NEW.charge_date < o.posting_date THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: correction % needs its original % POSTED and is dated on or after it', NEW.doc_no, o.doc_no USING ERRCODE = 'P0001';
    END IF;
    SELECT coalesce(sum(c.foreign_amount), 0) INTO corrected FROM purch.landed_costs c
     WHERE c.correction_of = NEW.correction_of AND c.status = 'POSTED' AND c.id <> NEW.id;
    IF o.foreign_amount + corrected + NEW.foreign_amount < 0 THEN
      RAISE EXCEPTION 'CORRECTION_EXCEEDS_CHARGE: corrections of % would exceed the charge (% %)', o.doc_no, o.foreign_amount, NEW.currency
        USING ERRCODE = 'P0001';
    END IF;
    -- Finance Manager e-signature in this transaction, by another person than the one who entered the correction.
    IF NEW.posted_by = NEW.created_by OR NOT EXISTS (
         SELECT 1 FROM core.e_signatures s
          WHERE s.record_table = 'purch.landed_costs' AND s.record_id = NEW.id::text AND s.meaning = 'APPROVED'
            AND s.tx_id = txid_current() AND s.user_id = NEW.posted_by
            AND core.user_holds_key(s.user_id, 'purch.landed_cost.correct')) THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: correction % is posted by a Finance Manager''s e-signature, not by the person who entered it', NEW.doc_no
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin.journal_entries j
                  WHERE j.source_type = 'LANDED_COST' AND j.source_id = NEW.id AND j.status = 'POSTED' AND j.reversal_of IS NULL
                    AND j.entry_date = NEW.posting_date
                    AND j.event = CASE WHEN t.capitalise THEN 'LANDED_COST' ELSE 'IMPORT_TAX' END) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: landed cost % has no posted journal', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  IF NOT t.capitalise THEN
    IF EXISTS (SELECT 1 FROM purch.landed_cost_allocations a WHERE a.landed_cost_id = NEW.id) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: a tax charge is not allocated to lots' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT coalesce(sum(a.amount), 0) AS total INTO alloc FROM purch.landed_cost_allocations a WHERE a.landed_cost_id = NEW.id;
  IF alloc.total <> NEW.amount THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: landed cost % allocates % of %', NEW.doc_no, alloc.total, NEW.amount USING ERRCODE = 'P0001';
  END IF;
  SELECT a.id INTO bad FROM purch.landed_cost_allocations a
    JOIN purch.grn_lines l ON l.id = a.grn_line_id
    LEFT JOIN inv.stock_movements m ON m.id = a.movement_id
   WHERE a.landed_cost_id = NEW.id
     AND (l.grn_id <> NEW.grn_id OR a.lot_id <> l.lot_id
          OR (a.movement_id IS NOT NULL AND (m.lot_id <> a.lot_id OR m.movement_type <> 'VALUE_ADJUSTMENT'
               OR m.reason_code <> 'LANDED_COST' OR m.ref_doc_type <> 'LANDED_COST' OR m.ref_doc_id <> NEW.id
               OR m.value <> a.held_amount OR m.movement_date <> NEW.posting_date)))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: landed cost % has an allocation that does not match its GRN line, lot or value adjustment', NEW.doc_no
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.with_grn AND EXISTS (SELECT 1 FROM purch.landed_cost_allocations a WHERE a.landed_cost_id = NEW.id AND a.variance_amount <> 0) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a charge posted with its GRN goes wholly into the lots' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- At commit: a REVERSED charge went with its GRN, and its journals are reversed; a POSTED correction still has its
-- original POSTED (a GRN reversal reverses them all).
CREATE FUNCTION purch.check_landed_cost_reversed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'REVERSED' THEN
    IF (SELECT status FROM purch.grns WHERE id = NEW.grn_id) <> 'REVERSED' THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: landed cost % is reversed only with its GRN', NEW.doc_no USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM fin.journal_entries j
                WHERE j.source_type = 'LANDED_COST' AND j.source_id = NEW.id AND j.status = 'POSTED' AND j.reversal_of IS NULL) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: landed cost % is REVERSED but its journal is not', NEW.doc_no USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM purch.landed_costs c WHERE c.correction_of = NEW.id AND c.status IN ('POSTED', 'DRAFT')) THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: landed cost % is REVERSED but a correction of it is still open', NEW.doc_no USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_landed_cost_reversed AFTER UPDATE OF status ON purch.landed_costs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION purch.check_landed_cost_reversed();

-- ---------------------------------------------------------------- lot value adjustments of landed costs
-- Before insert: a LANDED_COST adjustment is on a lot of the charge's GRN (either sign: a correction lowers, the
-- undo at GRN reversal mirrors). 0024's guard keeps the lot's value at or above zero.
CREATE OR REPLACE FUNCTION inv.guard_value_adjustment_landed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot RECORD;
BEGIN
  SELECT lot_no, source INTO lot FROM inv.lots WHERE id = NEW.lot_id;
  IF lot.source <> 'GRN' OR NEW.ref_doc_type <> 'LANDED_COST'
     OR NOT EXISTS (SELECT 1 FROM purch.landed_costs c JOIN purch.grn_lines l ON l.grn_id = c.grn_id
                     WHERE c.id = NEW.ref_doc_id AND l.lot_id = NEW.lot_id) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a landed-cost adjustment changes the value of a lot of the charge''s GRN (lot %)', lot.lot_no
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

-- At commit: per charge and lot, the LANDED_COST adjustments add up to what the charge put in that lot: the held
-- amount while POSTED, zero once REVERSED; a charge that is not posted has none.
CREATE FUNCTION inv.check_landed_cost_adjustments() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c RECORD;
  total NUMERIC;
  held NUMERIC;
BEGIN
  SELECT doc_no, status INTO c FROM purch.landed_costs WHERE id = NEW.ref_doc_id;
  SELECT coalesce(sum(m.value), 0) INTO total FROM inv.stock_movements m
   WHERE m.lot_id = NEW.lot_id AND m.movement_type = 'VALUE_ADJUSTMENT' AND m.reason_code = 'LANDED_COST'
     AND m.ref_doc_type = 'LANDED_COST' AND m.ref_doc_id = NEW.ref_doc_id;
  SELECT coalesce(sum(a.held_amount), 0) INTO held FROM purch.landed_cost_allocations a
   WHERE a.landed_cost_id = NEW.ref_doc_id AND a.lot_id = NEW.lot_id;
  IF c.status NOT IN ('POSTED', 'REVERSED') OR total <> (CASE WHEN c.status = 'POSTED' THEN held ELSE 0 END) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: landed cost % (%) has adjusted a lot by %, not by what it holds there', c.doc_no, c.status, total
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER check_landed_cost_adjustments AFTER INSERT ON inv.stock_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.movement_type = 'VALUE_ADJUSTMENT' AND NEW.reason_code = 'LANDED_COST')
  EXECUTE FUNCTION inv.check_landed_cost_adjustments();

-- ---------------------------------------------------------------- 4. GRN reversal with posted charges

-- Untouched (0028) no longer counts the GRN's own landed-cost adjustments as use.
CREATE OR REPLACE FUNCTION purch.grn_lot_untouched(p_grn BIGINT, p_lot BIGINT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (
           SELECT 1 FROM inv.stock_movements m
            WHERE m.lot_id = p_lot AND m.movement_type <> 'ROUNDING_SWEEP'
              AND NOT (m.movement_type = 'RECEIPT' AND m.ref_doc_type = 'GRN' AND m.ref_doc_id = p_grn)
              AND NOT (m.movement_type = 'VALUE_ADJUSTMENT' AND m.reason_code = 'LANDED_COST' AND m.ref_doc_type = 'LANDED_COST'
                       AND m.ref_doc_id IN (SELECT c.id FROM purch.landed_costs c WHERE c.grn_id = p_grn)))
     AND (SELECT count(*) FROM core.status_history h WHERE h.entity_table = 'inv.lots' AND h.entity_id = p_lot::text) = 1
     AND NOT EXISTS (SELECT 1 FROM inv.stock_reservations r WHERE r.lot_id = p_lot)
     AND NOT EXISTS (SELECT 1 FROM qc.sample_requests s WHERE s.lot_id = p_lot AND s.status NOT IN ('OPEN', 'CANCELLED'))
$$;

DROP TRIGGER guard_grn_landed_cost ON purch.grns;
DROP FUNCTION purch.guard_grn_landed_cost();

-- At commit: a GRN that left DRAFT has no DRAFT charge entered with it; a REVERSED GRN has no DRAFT or POSTED charge.
CREATE OR REPLACE FUNCTION purch.check_grn_draft_charges() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM purch.landed_costs c WHERE c.grn_id = NEW.id AND c.status = 'DRAFT' AND c.with_grn) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: GRN % is % but has DRAFT landed costs entered with it', NEW.doc_no, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF NEW.status = 'REVERSED' AND EXISTS (SELECT 1 FROM purch.landed_costs c WHERE c.grn_id = NEW.id AND c.status IN ('DRAFT', 'POSTED')) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: GRN % is REVERSED but has DRAFT or POSTED landed costs', NEW.doc_no USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;

-- A charge type keeps capitalise / tax role / duty once a charge of it was posted, also when that charge was
-- later reversed with its GRN (0029 looked at POSTED only).
CREATE OR REPLACE FUNCTION purch.guard_landed_cost_types() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: a charge type''s code never changes' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.capitalise, NEW.tax_role, NEW.is_duty) IS DISTINCT FROM (OLD.capitalise, OLD.tax_role, OLD.is_duty)
     AND EXISTS (SELECT 1 FROM purch.landed_costs c WHERE c.charge_type_id = NEW.id AND c.status IN ('POSTED', 'REVERSED')) THEN
    RAISE EXCEPTION 'IN_USE: charge type % has posted charges; its capitalise flag, tax role and duty flag stay', OLD.code
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
