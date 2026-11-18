-- 0011_item_activation (owner decisions 18-11-2026): items get a lifecycle, and QA controls GMP items.
--
-- 1. master.items.status DRAFT / ACTIVE / INACTIVE, changed only through core/transition (rule 7). is_active
--    becomes a generated column (status = 'ACTIVE'), so every existing "item must be active" check still holds
--    and nobody can set it directly.
-- 2. GMP items are fixed by type (RM, PM, API, EXCIPIENT, BULK, FG; master.is_gmp_item_type mirrors
--    GmpItemTypes in packages/shared). Every status move of a GMP item needs a holder of master.item.approve
--    (QA Manager). Non-GMP items (SPARE, CONSUMABLE) need a holder of master.item.manage.
--    A new item always starts DRAFT.
-- 3. DRAFT → ACTIVE: the activator is neither the creator nor the last editor (any item).
--    INACTIVE → ACTIVE of a non-GMP item: not by the person who deactivated it.
-- 4. Changing shelf_life_days, retest_days, storage_zone or is_controlled of a GMP item after DRAFT needs, in the
--    same transaction, an APPROVED e-signature on the item by another person who holds master.item.approve.
-- 5. Item code, type and base UoM never change after creation (decision M2 task 3; GMP status depends on type).
-- The service checks all of this first; these are the database backstops.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM master.items) THEN
    RAISE EXCEPTION '0011_item_activation: master.items has rows; decide their status before migrating (no database had items when this was written)';
  END IF;
END;
$$;

-- ---------------------------------------------------------------- helpers

CREATE FUNCTION master.is_gmp_item_type(item_type TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT item_type IN ('RM', 'PM', 'API', 'EXCIPIENT', 'BULK', 'FG')
$$;

-- Does an active user hold an active key through an active role?
CREATE FUNCTION core.user_holds_key(uid BIGINT, permission_key TEXT) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
      FROM core.users u
      JOIN core.user_roles ur ON ur.user_id = u.id
      JOIN core.roles r ON r.id = ur.role_id AND r.is_active
      JOIN core.role_permissions rp ON rp.role_id = r.id
      JOIN core.permissions p ON p.id = rp.permission_id AND p.is_active
     WHERE u.id = uid AND u.is_active AND p.key = permission_key
  )
$$;

-- ---------------------------------------------------------------- status column

ALTER TABLE master.items DROP COLUMN is_active;
ALTER TABLE master.items
  ADD COLUMN status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE')),
  ADD COLUMN is_active BOOLEAN GENERATED ALWAYS AS (status = 'ACTIVE') STORED;
CREATE INDEX items_status_idx ON master.items (company_id, status);
SELECT core.require_transition('master.items');

CREATE FUNCTION master.guard_item_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'INVALID_TRANSITION: a new item starts as DRAFT' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_item_insert BEFORE INSERT ON master.items
  FOR EACH ROW EXECUTE FUNCTION master.guard_item_insert();

-- ---------------------------------------------------------------- fixed identity

CREATE FUNCTION master.guard_item_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.base_uom_id IS DISTINCT FROM OLD.base_uom_id THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: item code, type and base unit cannot change after creation'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_item_identity BEFORE UPDATE OF code, type, base_uom_id ON master.items
  FOR EACH ROW EXECUTE FUNCTION master.guard_item_identity();

-- ---------------------------------------------------------------- status moves

CREATE FUNCTION master.guard_item_status() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor BIGINT := core.current_user_id();
  gmp BOOLEAN := master.is_gmp_item_type(OLD.type);
  deactivated_by BIGINT;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF gmp AND NOT core.user_holds_key(actor, 'master.item.approve') THEN
    RAISE EXCEPTION 'FORBIDDEN: only a holder of master.item.approve (QA) changes the status of a GMP item'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT gmp AND NOT core.user_holds_key(actor, 'master.item.manage') THEN
    RAISE EXCEPTION 'FORBIDDEN: only a holder of master.item.manage changes the status of a non-GMP item'
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE' AND actor IN (OLD.created_by, OLD.updated_by) THEN
    RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: the person who created or last edited a draft item cannot activate it'
      USING ERRCODE = 'P0001';
  END IF;
  IF NOT gmp AND OLD.status = 'INACTIVE' AND NEW.status = 'ACTIVE' THEN
    SELECT h.actor_id INTO deactivated_by
      FROM core.status_history h
     WHERE h.entity_table = 'master.items' AND h.entity_id = OLD.id::text AND h.to_status = 'INACTIVE'
     ORDER BY h.id DESC LIMIT 1;
    IF actor = deactivated_by THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: the person who deactivated an item cannot reactivate it'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_item_status BEFORE UPDATE OF status ON master.items
  FOR EACH ROW EXECUTE FUNCTION master.guard_item_status();

-- ---------------------------------------------------------------- QA countersign on GMP fields

CREATE FUNCTION master.require_item_countersign() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'DRAFT' OR NOT master.is_gmp_item_type(NEW.type) THEN
    RETURN NULL;
  END IF;
  IF (NEW.shelf_life_days, NEW.retest_days, NEW.storage_zone, NEW.is_controlled)
     IS DISTINCT FROM (OLD.shelf_life_days, OLD.retest_days, OLD.storage_zone, OLD.is_controlled)
     AND NOT EXISTS (
       SELECT 1 FROM core.e_signatures s
        WHERE s.record_table = 'master.items' AND s.record_id = NEW.id::text
          AND s.meaning = 'APPROVED' AND s.tx_id = txid_current()
          AND s.user_id <> NEW.updated_by
          AND core.user_holds_key(s.user_id, 'master.item.approve')
     ) THEN
    RAISE EXCEPTION 'COUNTERSIGN_REQUIRED: changing shelf life, retest period, storage zone or controlled flag of a GMP item needs a QA countersign by another person'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER require_item_countersign AFTER UPDATE ON master.items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION master.require_item_countersign();
