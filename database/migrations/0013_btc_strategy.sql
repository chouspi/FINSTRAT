CREATE TABLE btc_strategy_settings (
  household_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  btc_tax_period_years smallint NOT NULL DEFAULT 3,
  checkpoint_auto boolean NOT NULL DEFAULT true,
  checkpoint_activation_threshold_czk numeric(20,2) NOT NULL DEFAULT 100000,
  checkpoint_trigger_floor_czk numeric(20,2) NOT NULL DEFAULT 20000,
  checkpoint_trigger_percent numeric(7,4) NOT NULL DEFAULT 10,
  realization_step_profit_czk numeric(20,2) NOT NULL DEFAULT 20000,
  realization_step_transfer_czk numeric(20,2) NOT NULL DEFAULT 10000,
  vwce_rent_rate_percent numeric(7,4) NOT NULL DEFAULT 2,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, owner_user_id),
  FOREIGN KEY (household_id, owner_user_id)
    REFERENCES household_members(household_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT btc_strategy_tax_period_valid CHECK (btc_tax_period_years BETWEEN 1 AND 20),
  CONSTRAINT btc_strategy_amounts_valid CHECK (
    checkpoint_activation_threshold_czk > 0
    AND checkpoint_trigger_floor_czk >= 0
    AND realization_step_profit_czk > 0
    AND realization_step_transfer_czk > 0
  ),
  CONSTRAINT btc_strategy_percentages_valid CHECK (
    checkpoint_trigger_percent BETWEEN 0 AND 100
    AND vwce_rent_rate_percent BETWEEN 0 AND 100
  )
);

CREATE TABLE btc_strategy_states (
  household_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  checkpoint_base_czk numeric(20,2) NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, owner_user_id),
  FOREIGN KEY (household_id, owner_user_id)
    REFERENCES household_members(household_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT btc_strategy_checkpoint_nonnegative CHECK (checkpoint_base_czk >= 0)
);
