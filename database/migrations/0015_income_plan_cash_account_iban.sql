ALTER TABLE income_plan_settings
  ADD COLUMN cash_account_iban varchar(24);

-- Preserve the account previously embedded in Cash QR payments for existing profiles.
UPDATE income_plan_settings
SET cash_account_iban = 'CZ0506000000000264886458';
