CREATE TABLE IF NOT EXISTS income_plan_settings (
  household_id uuid NOT NULL,
  user_id uuid NOT NULL,
  default_capital_czk numeric(20,2) NOT NULL DEFAULT 0,
  without_debt_btc_percent numeric(7,4) NOT NULL DEFAULT 90,
  without_debt_cash_percent numeric(7,4) NOT NULL DEFAULT 10,
  with_debt_btc_percent numeric(7,4) NOT NULL DEFAULT 70,
  with_debt_debt_percent numeric(7,4) NOT NULL DEFAULT 20,
  with_debt_cash_percent numeric(7,4) NOT NULL DEFAULT 10,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, user_id),
  FOREIGN KEY (household_id, user_id)
    REFERENCES household_members(household_id, user_id) ON DELETE CASCADE,
  CONSTRAINT income_plan_capital_nonnegative CHECK (default_capital_czk >= 0),
  CONSTRAINT income_plan_percentages_valid CHECK (
    without_debt_btc_percent BETWEEN 0 AND 100
    AND without_debt_cash_percent BETWEEN 0 AND 100
    AND with_debt_btc_percent BETWEEN 0 AND 100
    AND with_debt_debt_percent BETWEEN 0 AND 100
    AND with_debt_cash_percent BETWEEN 0 AND 100
    AND without_debt_btc_percent + without_debt_cash_percent = 100
    AND with_debt_btc_percent + with_debt_debt_percent + with_debt_cash_percent = 100
  )
);

INSERT INTO income_plan_settings (
  household_id, user_id, default_capital_czk,
  without_debt_btc_percent, without_debt_cash_percent,
  with_debt_btc_percent, with_debt_debt_percent, with_debt_cash_percent
)
SELECT settings.household_id, samuel.id, settings.income_default_capital_czk,
  COALESCE((settings.allocation_without_debt ->> 'btc')::numeric, 90),
  COALESCE((settings.allocation_without_debt ->> 'cash')::numeric, 10),
  COALESCE((settings.allocation_with_debt ->> 'btc')::numeric, 70),
  COALESCE((settings.allocation_with_debt ->> 'debt')::numeric, 20),
  COALESCE((settings.allocation_with_debt ->> 'cash')::numeric, 10)
FROM strategy_settings settings
JOIN household_members member ON member.household_id = settings.household_id
JOIN users samuel ON samuel.id = member.user_id AND samuel.normalized_user_name = 'SAMUEL'
ON CONFLICT (household_id, user_id) DO NOTHING;

DROP TRIGGER IF EXISTS income_plan_settings_set_updated_at ON income_plan_settings;
CREATE TRIGGER income_plan_settings_set_updated_at
BEFORE UPDATE ON income_plan_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
