ALTER TABLE btc_strategy_settings
  DROP CONSTRAINT btc_strategy_amounts_valid,
  DROP COLUMN checkpoint_auto,
  DROP COLUMN checkpoint_activation_threshold_czk;

ALTER TABLE btc_strategy_settings
  ADD CONSTRAINT btc_strategy_amounts_valid CHECK (
    checkpoint_trigger_floor_czk >= 0
    AND realization_step_profit_czk > 0
    AND realization_step_transfer_czk > 0
  );
