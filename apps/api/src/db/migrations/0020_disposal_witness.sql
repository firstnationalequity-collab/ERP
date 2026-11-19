-- 0020_disposal_witness (M2 task 10, owner 2026-11-19; rule 1, architecture §5):
-- A DESTROY or RETURN_TO_VENDOR movement of a REJECTED lot, and the lot's status change REJECTED → DESTROYED /
-- RETURNED, need a QA witness e-signature. One signature covers both, in one transaction.
--
-- * core.e_signatures.subject: what the signer signed for, written by the service from the request
--   (NULL for signatures that sign only the record). A disposal witness signs
--   '<MOVEMENT_TYPE> lot <lot id> qty <qty, 4 decimals>' ('REVERSE ' in front for the reversal of a disposal row).
-- * inv.stock_movements.witness_esign_id: required on every DESTROY / RETURN_TO_VENDOR row (reversals too),
--   forbidden on every other type. The signature must be WITNESSED, recorded in this transaction for this lot,
--   name this movement exactly, be by an active user holding qa.lot.witness, and not by the poster.
--   One signature serves one movement (unique).
-- * Lot status → DESTROYED / RETURNED: the status_history row (written first by core/transition) must carry the
--   witness signature of a disposal movement of this lot posted in this transaction, of the matching type.
-- * At COMMIT: a lot that a disposal row emptied is DESTROYED / RETURNED (nothing is left REJECTED and empty).

ALTER TABLE core.e_signatures ADD COLUMN subject TEXT CHECK (subject IS NULL OR length(trim(subject)) > 0);

ALTER TABLE inv.stock_movements ADD COLUMN witness_esign_id BIGINT REFERENCES core.e_signatures (id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX stock_movements_witness_uidx ON inv.stock_movements (witness_esign_id) WHERE witness_esign_id IS NOT NULL;

-- core.user_holds_key (0011) checks the witness key (active user, active role, active key).

CREATE FUNCTION inv.disposal_subject(p_type TEXT, p_lot BIGINT, p_qty NUMERIC, p_reversal BOOLEAN) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_reversal THEN 'REVERSE ' ELSE '' END || p_type || ' lot ' || p_lot || ' qty '
         || trim(to_char(abs(p_qty), 'FM999999999999990.0000'));
$$;

CREATE FUNCTION inv.guard_disposal_witness() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  sig RECORD;
BEGIN
  IF NEW.movement_type NOT IN ('DESTROY', 'RETURN_TO_VENDOR') THEN
    IF NEW.witness_esign_id IS NOT NULL THEN
      RAISE EXCEPTION 'VALIDATION_FAILED: only a DESTROY or RETURN_TO_VENDOR movement carries a witness signature'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.witness_esign_id IS NULL THEN
    RAISE EXCEPTION 'WITNESS_REQUIRED: a % of lot % needs a QA witness e-signature', NEW.movement_type, NEW.lot_id
      USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO sig FROM core.e_signatures WHERE id = NEW.witness_esign_id;
  IF sig.meaning IS DISTINCT FROM 'WITNESSED' OR sig.record_table IS DISTINCT FROM 'inv.lots'
     OR sig.record_id IS DISTINCT FROM NEW.lot_id::text OR sig.tx_id IS DISTINCT FROM txid_current()
     OR sig.company_id IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'WITNESS_REQUIRED: the witness signature must be WITNESSED, for lot %, in this transaction', NEW.lot_id
      USING ERRCODE = 'P0001';
  END IF;
  IF sig.subject IS DISTINCT FROM inv.disposal_subject(NEW.movement_type, NEW.lot_id, NEW.qty, NEW.reversal_of IS NOT NULL) THEN
    RAISE EXCEPTION 'WITNESS_MISMATCH: the witness signed for "%", not this movement', COALESCE(sig.subject, '(nothing)')
      USING ERRCODE = 'P0001';
  END IF;
  IF sig.user_id = NEW.created_by THEN
    RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: the witness must be a different person from the one posting'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT core.user_holds_key(sig.user_id, 'qa.lot.witness') THEN
    RAISE EXCEPTION 'FORBIDDEN: the witness does not hold qa.lot.witness' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
-- Named to fire after guard_stock_movement (triggers fire in name order), so a lot-status refusal comes first.
CREATE TRIGGER guard_witness_disposal BEFORE INSERT ON inv.stock_movements
  FOR EACH ROW EXECUTE FUNCTION inv.guard_disposal_witness();

-- Lot status → DESTROYED / RETURNED needs the witness of a disposal of this lot posted in this transaction.
CREATE FUNCTION inv.guard_lot_disposal() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  h RECORD;
  wanted TEXT := CASE NEW.status WHEN 'DESTROYED' THEN 'DESTROY' ELSE 'RETURN_TO_VENDOR' END;
BEGIN
  SELECT * INTO h FROM core.status_history
   WHERE entity_table = 'inv.lots' AND entity_id = NEW.id::text AND to_status = NEW.status
     AND from_status IS NOT DISTINCT FROM OLD.status AND tx_id = txid_current()
   ORDER BY id DESC LIMIT 1;
  IF h.id IS NULL OR h.witness_esign_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM inv.stock_movements m
      JOIN core.e_signatures s ON s.id = m.witness_esign_id
     WHERE m.lot_id = NEW.id AND m.witness_esign_id = h.witness_esign_id AND m.movement_type = wanted
       AND m.reversal_of IS NULL AND s.user_id <> h.actor_id AND s.tx_id = txid_current()
  ) THEN
    RAISE EXCEPTION 'WITNESS_REQUIRED: lot % becomes % only with the QA witness signature of its % in the same transaction',
      NEW.lot_no, NEW.status, wanted USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_lot_disposal BEFORE UPDATE OF status ON inv.lots
  FOR EACH ROW WHEN (NEW.status IN ('DESTROYED', 'RETURNED') AND NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION inv.guard_lot_disposal();

-- At COMMIT: a lot emptied by a disposal is closed (DESTROYED / RETURNED) in the same transaction.
CREATE FUNCTION inv.require_disposed_lot_closed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lot RECORD;
  on_hand NUMERIC;
BEGIN
  SELECT id, lot_no, status INTO lot FROM inv.lots WHERE id = NEW.lot_id;
  SELECT COALESCE(sum(qty), 0) INTO on_hand FROM inv.stock_balances WHERE lot_id = NEW.lot_id;
  IF on_hand = 0 AND lot.status NOT IN ('DESTROYED', 'RETURNED') THEN
    RAISE EXCEPTION 'LOT_NOT_CLOSED: lot % was emptied by a %; close it (DESTROYED / RETURNED) in the same transaction',
      lot.lot_no, NEW.movement_type USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER require_disposed_lot_closed AFTER INSERT ON inv.stock_movements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.movement_type IN ('DESTROY', 'RETURN_TO_VENDOR') AND NEW.reversal_of IS NULL)
  EXECUTE FUNCTION inv.require_disposed_lot_closed();
