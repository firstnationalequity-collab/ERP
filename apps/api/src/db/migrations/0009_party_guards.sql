-- 0009_party_guards: database backstops for customer/vendor segregation of duties
-- (decisions M2 Q5 and "M2 task 3, editing active parties", 18-11-2026). The service checks the same rules first.
--
-- 1. DRAFT → ACTIVE: the activator is neither the creator nor the last person who edited the draft.
-- 2. Changing a sensitive field of a customer/vendor that has left DRAFT needs, in the same transaction,
--    an APPROVED e-signature on that record by a different person (the approve-key holder's countersign;
--    the key itself is checked in the service).
--    Customer: ntn, cnic, strn, credit_limit, is_toll_customer.
--    Vendor:   ntn, cnic, strn, is_foreign, country, currency, bank_name, bank_account.

CREATE FUNCTION master.guard_party_activation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE'
     AND core.current_user_id() IN (OLD.created_by, OLD.updated_by) THEN
    RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: the person who created or last edited a draft cannot activate it'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_party_activation BEFORE UPDATE OF status ON master.customers
  FOR EACH ROW EXECUTE FUNCTION master.guard_party_activation();
CREATE TRIGGER guard_party_activation BEFORE UPDATE OF status ON master.vendors
  FOR EACH ROW EXECUTE FUNCTION master.guard_party_activation();

CREATE FUNCTION master.require_party_countersign() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changed BOOLEAN;
  tbl TEXT := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
BEGIN
  IF OLD.status = 'DRAFT' THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'customers' THEN
    changed := (to_jsonb(NEW) -> 'ntn', to_jsonb(NEW) -> 'cnic', to_jsonb(NEW) -> 'strn',
                to_jsonb(NEW) -> 'credit_limit', to_jsonb(NEW) -> 'is_toll_customer')
               IS DISTINCT FROM
               (to_jsonb(OLD) -> 'ntn', to_jsonb(OLD) -> 'cnic', to_jsonb(OLD) -> 'strn',
                to_jsonb(OLD) -> 'credit_limit', to_jsonb(OLD) -> 'is_toll_customer');
  ELSE
    changed := (to_jsonb(NEW) -> 'ntn', to_jsonb(NEW) -> 'cnic', to_jsonb(NEW) -> 'strn',
                to_jsonb(NEW) -> 'is_foreign', to_jsonb(NEW) -> 'country', to_jsonb(NEW) -> 'currency',
                to_jsonb(NEW) -> 'bank_name', to_jsonb(NEW) -> 'bank_account')
               IS DISTINCT FROM
               (to_jsonb(OLD) -> 'ntn', to_jsonb(OLD) -> 'cnic', to_jsonb(OLD) -> 'strn',
                to_jsonb(OLD) -> 'is_foreign', to_jsonb(OLD) -> 'country', to_jsonb(OLD) -> 'currency',
                to_jsonb(OLD) -> 'bank_name', to_jsonb(OLD) -> 'bank_account');
  END IF;
  IF changed AND NOT EXISTS (
    SELECT 1 FROM core.e_signatures s
     WHERE s.record_table = tbl AND s.record_id = NEW.id::text
       AND s.meaning = 'APPROVED' AND s.tx_id = txid_current()
       AND s.user_id <> NEW.updated_by
  ) THEN
    RAISE EXCEPTION 'COUNTERSIGN_REQUIRED: changing tax, credit, toll or bank details of an active % needs a countersign by another person',
      CASE WHEN TG_TABLE_NAME = 'customers' THEN 'customer' ELSE 'vendor' END
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER require_party_countersign AFTER UPDATE ON master.customers
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION master.require_party_countersign();
CREATE CONSTRAINT TRIGGER require_party_countersign AFTER UPDATE ON master.vendors
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION master.require_party_countersign();
