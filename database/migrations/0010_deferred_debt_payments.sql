ALTER TABLE income_plan_settings
  ADD COLUMN deferred_debt_payment_czk numeric(20,2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT income_plan_deferred_debt_nonnegative
    CHECK (deferred_debt_payment_czk >= 0);
