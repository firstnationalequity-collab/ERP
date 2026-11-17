-- 0007_split_amount_percent (rules review D, rule 10): money NUMERIC(18,2), percents NUMERIC(9,4).
-- core.approvals.measured_value and core.approval_rules.lower_bound/upper_bound held either a PKR amount or a
-- percent in NUMERIC(18,4). Split them into an amount column and a percent column, each with the scale rule 10
-- requires, and let CHECK constraints allow only the pair that matches the measure.
--
-- Backfill: the guard triggers that forbid editing approval rules / decided approvals are paused for this one
-- statement each, inside this migration's transaction, and re-enabled before it ends. The AUDIT triggers stay
-- on, so the conversion itself is recorded in core.audit_log (changed_by NULL = migration).

-- ---------------------------------------------------------------- approvals
ALTER TABLE core.approvals
  ADD COLUMN measured_amount  NUMERIC(18,2),
  ADD COLUMN measured_percent NUMERIC(9,4);

ALTER TABLE core.approvals DISABLE TRIGGER guard_approvals;
UPDATE core.approvals
   SET measured_amount  = CASE WHEN measure = 'AMOUNT_PKR' THEN round(measured_value, 2) END,
       measured_percent = CASE WHEN measure = 'PERCENT' THEN measured_value END
 WHERE measured_value IS NOT NULL;
ALTER TABLE core.approvals ENABLE TRIGGER guard_approvals;

-- Dropping the column also drops the old CHECK that referenced it.
ALTER TABLE core.approvals DROP COLUMN measured_value;
ALTER TABLE core.approvals
  ADD CONSTRAINT approvals_measured_by_measure CHECK (
    (measure = 'AMOUNT_PKR' AND measured_amount IS NOT NULL AND measured_percent IS NULL) OR
    (measure = 'PERCENT'    AND measured_percent IS NOT NULL AND measured_amount IS NULL) OR
    (measure = 'NONE'       AND measured_amount IS NULL AND measured_percent IS NULL)
  );

-- ---------------------------------------------------------------- approval rules
ALTER TABLE core.approval_rules
  ADD COLUMN lower_amount  NUMERIC(18,2),
  ADD COLUMN upper_amount  NUMERIC(18,2),
  ADD COLUMN lower_percent NUMERIC(9,4),
  ADD COLUMN upper_percent NUMERIC(9,4);

ALTER TABLE core.approval_rules DISABLE TRIGGER guard_approval_rules;
UPDATE core.approval_rules
   SET lower_amount  = CASE WHEN measure = 'AMOUNT_PKR' THEN round(lower_bound, 2) END,
       upper_amount  = CASE WHEN measure = 'AMOUNT_PKR' THEN round(upper_bound, 2) END,
       lower_percent = CASE WHEN measure = 'PERCENT' THEN lower_bound END,
       upper_percent = CASE WHEN measure = 'PERCENT' THEN upper_bound END
 WHERE lower_bound IS NOT NULL OR upper_bound IS NOT NULL;
ALTER TABLE core.approval_rules ENABLE TRIGGER guard_approval_rules;

ALTER TABLE core.approval_rules DROP COLUMN lower_bound, DROP COLUMN upper_bound;
ALTER TABLE core.approval_rules
  ADD CONSTRAINT approval_rules_bounds_by_measure CHECK (
    (measure = 'AMOUNT_PKR' AND lower_percent IS NULL AND upper_percent IS NULL) OR
    (measure = 'PERCENT'    AND lower_amount IS NULL AND upper_amount IS NULL) OR
    (measure = 'NONE'       AND lower_amount IS NULL AND upper_amount IS NULL AND lower_percent IS NULL AND upper_percent IS NULL)
  ),
  ADD CONSTRAINT approval_rules_amount_order CHECK (lower_amount IS NULL OR upper_amount IS NULL OR lower_amount < upper_amount),
  ADD CONSTRAINT approval_rules_percent_order CHECK (lower_percent IS NULL OR upper_percent IS NULL OR lower_percent < upper_percent);
