ALTER TABLE income_plan_settings
  ADD COLUMN coinmate_iban varchar(24),
  ADD COLUMN coinmate_variable_symbol varchar(10),
  ADD COLUMN coinmate_recipient_message varchar(60);

UPDATE income_plan_settings settings
SET
  coinmate_iban = 'CZ9255000000000622633603',
  coinmate_variable_symbol = '3301195845',
  coinmate_recipient_message = 'SAMUEL KRATOS COINMATE VKLAD'
FROM users app_user
WHERE app_user.id = settings.user_id
  AND app_user.normalized_user_name = 'SAMUEL';
