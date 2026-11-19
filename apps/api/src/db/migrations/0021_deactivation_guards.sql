-- 0021_deactivation_guards (M2 task 10, owner 2026-11-19; decisions "rule 7 covers status values"):
-- active/inactive switches need a reason and the audit trail, not core/transition; and a master that is still in
-- use cannot be switched off. In the database, so no path around the service skips it (IN_USE, HTTP 409).
--   * a location that holds stock; a warehouse any of whose locations holds stock;
--   * an account with a balance (posted journal lines whose debits and credits do not net to zero)
--     (the "used by an active posting rule" and "has active sub-accounts" checks are in 0012 guard_account);
--   * a UoM, item category or tax code used by an ACTIVE item, or by an item that an active product sells.
-- Reactivating the master itself is never refused here. An item becomes ACTIVE only while its UoM, category and
-- tax code are active (a DRAFT item does not block deactivating them).

CREATE FUNCTION master.guard_location_deactivation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  held NUMERIC;
BEGIN
  IF TG_TABLE_NAME = 'locations' THEN
    SELECT COALESCE(sum(b.qty), 0) INTO held FROM inv.stock_balances b WHERE b.location_id = NEW.id;
  ELSE
    SELECT COALESCE(sum(b.qty), 0) INTO held
      FROM inv.stock_balances b JOIN master.locations l ON l.id = b.location_id
     WHERE l.warehouse_id = NEW.id;
  END IF;
  IF held <> 0 THEN
    RAISE EXCEPTION 'IN_USE: % % holds stock (%); move it out before deactivating',
      CASE TG_TABLE_NAME WHEN 'locations' THEN 'location' ELSE 'warehouse' END, NEW.code, held
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_location_deactivation BEFORE UPDATE OF is_active ON master.locations
  FOR EACH ROW WHEN (OLD.is_active AND NOT NEW.is_active) EXECUTE FUNCTION master.guard_location_deactivation();
CREATE TRIGGER guard_warehouse_deactivation BEFORE UPDATE OF is_active ON master.warehouses
  FOR EACH ROW WHEN (OLD.is_active AND NOT NEW.is_active) EXECUTE FUNCTION master.guard_location_deactivation();

CREATE FUNCTION fin.guard_account_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bal NUMERIC;
BEGIN
  SELECT COALESCE(sum(l.debit - l.credit), 0) INTO bal
    FROM fin.journal_lines l JOIN fin.journal_entries e ON e.id = l.entry_id
   WHERE l.account_id = NEW.id AND e.status IN ('POSTED', 'REVERSED');
  IF bal <> 0 THEN
    RAISE EXCEPTION 'IN_USE: account % has a balance of %; clear it before deactivating', NEW.code, bal USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_account_balance BEFORE UPDATE OF is_active ON fin.accounts
  FOR EACH ROW WHEN (OLD.is_active AND NOT NEW.is_active) EXECUTE FUNCTION fin.guard_account_balance();

-- Items "in use": ACTIVE, or sold by an active product.
CREATE FUNCTION master.guard_item_reference_deactivation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  used TEXT;
BEGIN
  SELECT i.code INTO used
    FROM master.items i
   WHERE (CASE TG_TABLE_NAME
            WHEN 'uoms' THEN i.base_uom_id
            WHEN 'item_categories' THEN i.category_id
            ELSE i.tax_code_id
          END) = NEW.id
     AND (i.status = 'ACTIVE' OR EXISTS (SELECT 1 FROM master.products p WHERE p.item_id = i.id AND p.is_active))
   ORDER BY i.code
   LIMIT 1;
  IF used IS NOT NULL THEN
    RAISE EXCEPTION 'IN_USE: % % is used by active item % (or its product); deactivate or change those first',
      CASE TG_TABLE_NAME WHEN 'uoms' THEN 'UoM' WHEN 'item_categories' THEN 'item category' ELSE 'tax code' END, NEW.code, used USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_uom_deactivation BEFORE UPDATE OF is_active ON master.uoms
  FOR EACH ROW WHEN (OLD.is_active AND NOT NEW.is_active) EXECUTE FUNCTION master.guard_item_reference_deactivation();
CREATE TRIGGER guard_category_deactivation BEFORE UPDATE OF is_active ON master.item_categories
  FOR EACH ROW WHEN (OLD.is_active AND NOT NEW.is_active) EXECUTE FUNCTION master.guard_item_reference_deactivation();
CREATE TRIGGER guard_tax_code_deactivation BEFORE UPDATE OF is_active ON master.tax_codes
  FOR EACH ROW WHEN (OLD.is_active AND NOT NEW.is_active) EXECUTE FUNCTION master.guard_item_reference_deactivation();

-- The other side: a DRAFT item does not block deactivating its UoM, category or tax code, so an item becomes
-- ACTIVE (activation or reactivation) only while all three are active.
CREATE FUNCTION master.guard_item_activation_refs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM master.uoms WHERE id = NEW.base_uom_id AND is_active)
     OR NOT EXISTS (SELECT 1 FROM master.item_categories WHERE id = NEW.category_id AND is_active)
     OR (NEW.tax_code_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM master.tax_codes WHERE id = NEW.tax_code_id AND is_active)) THEN
    RAISE EXCEPTION 'VALIDATION_FAILED: item % needs an active base unit, category and tax code to become ACTIVE', NEW.code
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_item_activation_refs BEFORE UPDATE OF status ON master.items
  FOR EACH ROW WHEN (NEW.status = 'ACTIVE' AND OLD.status IS DISTINCT FROM 'ACTIVE')
  EXECUTE FUNCTION master.guard_item_activation_refs();
