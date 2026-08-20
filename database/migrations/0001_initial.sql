BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CONSTRAINT users_email_not_blank CHECK (btrim(email) <> ''),
  CONSTRAINT users_display_name_not_blank CHECK (btrim(display_name) <> '')
);

CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE households (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  base_currency char(3) NOT NULL DEFAULT 'CZK',
  time_zone text NOT NULL DEFAULT 'Europe/Prague',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT households_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT households_currency_uppercase CHECK (base_currency = upper(base_currency))
);

CREATE TABLE household_members (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, user_id),
  CONSTRAINT household_members_role_valid CHECK (role IN ('owner', 'editor', 'viewer'))
);

CREATE INDEX household_members_user_idx ON household_members (user_id);

CREATE TABLE strategy_settings (
  household_id uuid PRIMARY KEY REFERENCES households(id) ON DELETE RESTRICT,
  btc_tax_period_years smallint NOT NULL DEFAULT 3,
  checkpoint_auto boolean NOT NULL DEFAULT true,
  checkpoint_activation_threshold_czk numeric(20,2) NOT NULL DEFAULT 100000,
  checkpoint_trigger_floor_czk numeric(20,2) NOT NULL DEFAULT 20000,
  checkpoint_trigger_percent numeric(7,4) NOT NULL DEFAULT 10,
  realization_step_profit_czk numeric(20,2) NOT NULL DEFAULT 20000,
  realization_step_transfer_czk numeric(20,2) NOT NULL DEFAULT 10000,
  vwce_rent_rate_percent numeric(7,4) NOT NULL DEFAULT 2,
  allocation_without_debt jsonb NOT NULL DEFAULT '{"btc": 90, "cash": 10}'::jsonb,
  allocation_with_debt jsonb NOT NULL DEFAULT '{"btc": 70, "debt": 20, "cash": 10}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT strategy_tax_period_valid CHECK (btc_tax_period_years BETWEEN 0 AND 20),
  CONSTRAINT strategy_amounts_nonnegative CHECK (
    checkpoint_activation_threshold_czk >= 0
    AND checkpoint_trigger_floor_czk >= 0
    AND realization_step_profit_czk > 0
    AND realization_step_transfer_czk > 0
  ),
  CONSTRAINT strategy_percentages_valid CHECK (
    checkpoint_trigger_percent BETWEEN 0 AND 100
    AND vwce_rent_rate_percent BETWEEN 0 AND 100
  )
);

CREATE TABLE btc_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (household_id, id),
  CONSTRAINT btc_accounts_name_not_blank CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX btc_accounts_active_name_unique
  ON btc_accounts (household_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE vwce_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (household_id, id),
  CONSTRAINT vwce_accounts_name_not_blank CHECK (btrim(name) <> '')
);

CREATE UNIQUE INDEX vwce_accounts_active_name_unique
  ON vwce_accounts (household_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE life_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  amount_czk numeric(20,2) NOT NULL,
  category text NOT NULL,
  note text,
  spent_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (household_id, id),
  CONSTRAINT life_expenses_amount_positive CHECK (amount_czk > 0),
  CONSTRAINT life_expenses_category_not_blank CHECK (btrim(category) <> '')
);

CREATE TABLE vwce_reallocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  amount_czk numeric(20,2) NOT NULL,
  executed_at timestamptz NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (household_id, id),
  CONSTRAINT vwce_reallocations_amount_positive CHECK (amount_czk > 0)
);

CREATE TABLE btc_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  from_account_id uuid NOT NULL,
  to_account_id uuid NOT NULL,
  gross_quantity_btc numeric(20,8) NOT NULL,
  fee_quantity_btc numeric(20,8) NOT NULL DEFAULT 0,
  net_quantity_btc numeric(20,8) GENERATED ALWAYS AS
    (gross_quantity_btc - fee_quantity_btc) STORED,
  transferred_at timestamptz NOT NULL,
  txid text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, from_account_id)
    REFERENCES btc_accounts(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, to_account_id)
    REFERENCES btc_accounts(household_id, id) ON DELETE RESTRICT,
  CONSTRAINT btc_transfers_accounts_differ CHECK (from_account_id <> to_account_id),
  CONSTRAINT btc_transfers_quantity_valid CHECK (
    gross_quantity_btc > 0 AND fee_quantity_btc >= 0 AND fee_quantity_btc < gross_quantity_btc
  )
);

CREATE TABLE btc_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  quantity_btc numeric(20,8) NOT NULL,
  unit_price_czk numeric(20,2),
  unit_price_usd numeric(20,2),
  acquired_at timestamptz NOT NULL,
  tax_acquired_at timestamptz NOT NULL,
  txid text,
  note text,
  source_transfer_id uuid,
  source_lot_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, account_id)
    REFERENCES btc_accounts(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, source_transfer_id)
    REFERENCES btc_transfers(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, source_lot_id)
    REFERENCES btc_lots(household_id, id) ON DELETE RESTRICT,
  CONSTRAINT btc_lots_quantity_positive CHECK (quantity_btc > 0),
  CONSTRAINT btc_lots_prices_positive CHECK (
    (unit_price_czk IS NULL OR unit_price_czk > 0)
    AND (unit_price_usd IS NULL OR unit_price_usd > 0)
  ),
  CONSTRAINT btc_lots_transfer_origin_complete CHECK (
    (source_transfer_id IS NULL AND source_lot_id IS NULL)
    OR (source_transfer_id IS NOT NULL AND source_lot_id IS NOT NULL)
  )
);

CREATE TABLE btc_disposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  kind text NOT NULL,
  quantity_btc numeric(20,8) NOT NULL,
  unit_price_czk numeric(20,2),
  disposed_at timestamptz NOT NULL,
  txid text,
  note text,
  transfer_id uuid,
  vwce_reallocation_id uuid,
  life_expense_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, account_id)
    REFERENCES btc_accounts(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, transfer_id)
    REFERENCES btc_transfers(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, vwce_reallocation_id)
    REFERENCES vwce_reallocations(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, life_expense_id)
    REFERENCES life_expenses(household_id, id) ON DELETE RESTRICT,
  CONSTRAINT btc_disposals_kind_valid CHECK (
    kind IN ('standalone', 'internal_transfer', 'vwce_reallocation', 'life_expense')
  ),
  CONSTRAINT btc_disposals_quantity_positive CHECK (quantity_btc > 0),
  CONSTRAINT btc_disposals_price_positive CHECK (unit_price_czk IS NULL OR unit_price_czk > 0),
  CONSTRAINT btc_disposals_target_matches_kind CHECK (
    (kind = 'standalone' AND num_nonnulls(transfer_id, vwce_reallocation_id, life_expense_id) = 0)
    OR (kind = 'internal_transfer' AND transfer_id IS NOT NULL
      AND num_nonnulls(vwce_reallocation_id, life_expense_id) = 0)
    OR (kind = 'vwce_reallocation' AND vwce_reallocation_id IS NOT NULL
      AND num_nonnulls(transfer_id, life_expense_id) = 0)
    OR (kind = 'life_expense' AND life_expense_id IS NOT NULL
      AND num_nonnulls(transfer_id, vwce_reallocation_id) = 0)
  )
);

CREATE UNIQUE INDEX btc_disposals_transfer_unique
  ON btc_disposals (transfer_id) WHERE transfer_id IS NOT NULL;

CREATE TABLE btc_lot_allocations (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  disposal_id uuid NOT NULL,
  lot_id uuid NOT NULL,
  quantity_btc numeric(20,8) NOT NULL,
  cost_basis_czk numeric(20,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (disposal_id, lot_id),
  FOREIGN KEY (household_id, disposal_id)
    REFERENCES btc_disposals(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, lot_id)
    REFERENCES btc_lots(household_id, id) ON DELETE RESTRICT,
  CONSTRAINT btc_lot_allocations_quantity_positive CHECK (quantity_btc > 0),
  CONSTRAINT btc_lot_allocations_basis_nonnegative CHECK (cost_basis_czk IS NULL OR cost_basis_czk >= 0)
);

CREATE TABLE vwce_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  shares numeric(20,8) NOT NULL,
  unit_price_czk numeric(20,2),
  acquired_at timestamptz NOT NULL,
  provisional boolean NOT NULL DEFAULT false,
  source_reallocation_id uuid,
  replaces_lot_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, account_id)
    REFERENCES vwce_accounts(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, source_reallocation_id)
    REFERENCES vwce_reallocations(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, replaces_lot_id)
    REFERENCES vwce_lots(household_id, id) ON DELETE RESTRICT,
  CONSTRAINT vwce_lots_shares_positive CHECK (shares > 0),
  CONSTRAINT vwce_lots_price_positive CHECK (unit_price_czk IS NULL OR unit_price_czk > 0),
  CONSTRAINT vwce_lots_replacement_not_self CHECK (replaces_lot_id IS NULL OR replaces_lot_id <> id)
);

CREATE TABLE vwce_disposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'rent_payout',
  shares numeric(20,8) NOT NULL,
  unit_price_czk numeric(20,2) NOT NULL,
  proceeds_czk numeric(20,2) NOT NULL,
  disposed_at timestamptz NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, account_id)
    REFERENCES vwce_accounts(household_id, id) ON DELETE RESTRICT,
  CONSTRAINT vwce_disposals_kind_valid CHECK (kind IN ('rent_payout', 'standalone')),
  CONSTRAINT vwce_disposals_values_positive CHECK (shares > 0 AND unit_price_czk > 0 AND proceeds_czk > 0),
  CONSTRAINT vwce_disposals_proceeds_match CHECK (abs(proceeds_czk - round(shares * unit_price_czk, 2)) <= 0.01)
);

CREATE TABLE vwce_lot_allocations (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  disposal_id uuid NOT NULL,
  lot_id uuid NOT NULL,
  shares numeric(20,8) NOT NULL,
  cost_basis_czk numeric(20,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (disposal_id, lot_id),
  FOREIGN KEY (household_id, disposal_id)
    REFERENCES vwce_disposals(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, lot_id)
    REFERENCES vwce_lots(household_id, id) ON DELETE RESTRICT,
  CONSTRAINT vwce_lot_allocations_shares_positive CHECK (shares > 0),
  CONSTRAINT vwce_lot_allocations_basis_nonnegative CHECK (cost_basis_czk IS NULL OR cost_basis_czk >= 0)
);

CREATE TABLE deferred_vwce_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  original_amount_czk numeric(20,2) NOT NULL,
  cancelled_amount_czk numeric(20,2) NOT NULL DEFAULT 0,
  deferred_at date NOT NULL,
  completed_at date,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (household_id, id),
  CONSTRAINT deferred_vwce_amounts_valid CHECK (
    original_amount_czk > 0
    AND cancelled_amount_czk >= 0
    AND cancelled_amount_czk <= original_amount_czk
  )
);

CREATE TABLE deferred_vwce_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  obligation_id uuid NOT NULL,
  vwce_lot_id uuid NOT NULL,
  amount_czk numeric(20,2) NOT NULL,
  allocated_at date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (obligation_id, vwce_lot_id),
  FOREIGN KEY (household_id, obligation_id)
    REFERENCES deferred_vwce_obligations(household_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (household_id, vwce_lot_id)
    REFERENCES vwce_lots(household_id, id) ON DELETE RESTRICT,
  CONSTRAINT deferred_vwce_allocations_amount_positive CHECK (amount_czk > 0)
);

CREATE TABLE debts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  name text NOT NULL,
  priority smallint NOT NULL DEFAULT 3,
  is_mortgage boolean NOT NULL DEFAULT false,
  opened_at date NOT NULL,
  closed_at date,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (household_id, id),
  CONSTRAINT debts_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT debts_priority_valid CHECK (priority BETWEEN 1 AND 5),
  CONSTRAINT debts_dates_valid CHECK (closed_at IS NULL OR closed_at >= opened_at)
);

CREATE TABLE debt_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  debt_id uuid NOT NULL,
  entry_type text NOT NULL,
  amount_czk numeric(20,2) NOT NULL,
  effective_at date NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, debt_id)
    REFERENCES debts(household_id, id) ON DELETE RESTRICT,
  CONSTRAINT debt_entries_type_valid CHECK (
    entry_type IN ('opening_balance', 'drawdown', 'payment', 'interest', 'fee', 'adjustment_up', 'adjustment_down')
  ),
  CONSTRAINT debt_entries_amount_positive CHECK (amount_czk > 0)
);

CREATE VIEW debt_balances AS
SELECT
  d.household_id,
  d.id AS debt_id,
  d.name,
  COALESCE(sum(
    CASE
      WHEN e.entry_type IN ('opening_balance', 'drawdown', 'interest', 'fee', 'adjustment_up') THEN e.amount_czk
      ELSE -e.amount_czk
    END
  ), 0)::numeric(20,2) AS balance_czk,
  d.closed_at
FROM debts d
LEFT JOIN debt_entries e ON e.debt_id = d.id AND e.household_id = d.household_id
GROUP BY d.household_id, d.id, d.name, d.closed_at;

CREATE TABLE market_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument text NOT NULL,
  quote_currency char(3) NOT NULL DEFAULT 'CZK',
  price numeric(24,8) NOT NULL,
  observed_at timestamptz NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_prices_instrument_valid CHECK (instrument IN ('BTC', 'VWCE')),
  CONSTRAINT market_prices_currency_uppercase CHECK (quote_currency = upper(quote_currency)),
  CONSTRAINT market_prices_price_positive CHECK (price > 0),
  CONSTRAINT market_prices_source_not_blank CHECK (btrim(source) <> ''),
  UNIQUE (instrument, quote_currency, observed_at, source)
);

CREATE TABLE snapshot_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  source text NOT NULL,
  calculation_version text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (household_id, id),
  CONSTRAINT snapshot_runs_source_valid CHECK (source IN ('scheduled', 'manual', 'backfill', 'import')),
  CONSTRAINT snapshot_runs_status_valid CHECK (status IN ('running', 'completed', 'partial', 'failed')),
  CONSTRAINT snapshot_runs_version_not_blank CHECK (btrim(calculation_version) <> '')
);

CREATE TABLE portfolio_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  snapshot_date date NOT NULL,
  run_id uuid NOT NULL,
  quality text NOT NULL DEFAULT 'complete',
  btc_quantity numeric(20,8) NOT NULL DEFAULT 0,
  vwce_shares numeric(20,8) NOT NULL DEFAULT 0,
  debt_czk numeric(20,2) NOT NULL DEFAULT 0,
  btc_value_czk numeric(20,2) NOT NULL DEFAULT 0,
  vwce_value_czk numeric(20,2) NOT NULL DEFAULT 0,
  invested_czk numeric(20,2) NOT NULL DEFAULT 0,
  external_net_cashflow_czk numeric(20,2),
  net_worth_czk numeric(20,2),
  btc_price_id uuid REFERENCES market_prices(id) ON DELETE RESTRICT,
  vwce_price_id uuid REFERENCES market_prices(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, snapshot_date),
  UNIQUE (household_id, id),
  FOREIGN KEY (household_id, run_id)
    REFERENCES snapshot_runs(household_id, id) ON DELETE RESTRICT,
  CONSTRAINT portfolio_snapshots_quality_valid CHECK (quality IN ('complete', 'estimated', 'incomplete')),
  CONSTRAINT portfolio_snapshots_holdings_nonnegative CHECK (
    btc_quantity >= 0 AND vwce_shares >= 0 AND debt_czk >= 0
  )
);

CREATE TABLE ownership_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  account_id uuid,
  account_name_snapshot text NOT NULL,
  content text NOT NULL,
  content_size_bytes bigint NOT NULL,
  sha256 char(64) NOT NULL,
  anchor_txid char(64),
  anchored_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (household_id, id),
  UNIQUE (household_id, sha256),
  FOREIGN KEY (household_id, account_id)
    REFERENCES btc_accounts(household_id, id) ON DELETE SET NULL (account_id),
  CONSTRAINT ownership_proofs_account_name_not_blank CHECK (btrim(account_name_snapshot) <> ''),
  CONSTRAINT ownership_proofs_content_size_valid CHECK (content_size_bytes >= 0),
  CONSTRAINT ownership_proofs_sha256_valid CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ownership_proofs_txid_valid CHECK (anchor_txid IS NULL OR anchor_txid ~ '^[0-9a-fA-F]{64}$'),
  CONSTRAINT ownership_proofs_anchor_complete CHECK (
    (anchor_txid IS NULL AND anchored_at IS NULL)
    OR (anchor_txid IS NOT NULL AND anchored_at IS NOT NULL)
  )
);

CREATE FUNCTION protect_ownership_proof()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ownership proofs cannot be deleted';
  END IF;

  IF OLD.anchor_txid IS NOT NULL AND (
    NEW.content IS DISTINCT FROM OLD.content
    OR NEW.content_size_bytes IS DISTINCT FROM OLD.content_size_bytes
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.anchor_txid IS DISTINCT FROM OLD.anchor_txid
    OR NEW.anchored_at IS DISTINCT FROM OLD.anchored_at
  ) THEN
    RAISE EXCEPTION 'anchored ownership proof is immutable';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ownership_proofs_protect_update
BEFORE UPDATE ON ownership_proofs
FOR EACH ROW EXECUTE FUNCTION protect_ownership_proof();

CREATE TRIGGER ownership_proofs_protect_delete
BEFORE DELETE ON ownership_proofs
FOR EACH ROW EXECUTE FUNCTION protect_ownership_proof();

CREATE TABLE household_secrets (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  key text NOT NULL,
  encrypted_value bytea NOT NULL,
  key_version smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, key),
  CONSTRAINT household_secrets_key_not_blank CHECK (btrim(key) <> ''),
  CONSTRAINT household_secrets_key_version_positive CHECK (key_version > 0)
);

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  request_id uuid,
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  description text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_events_names_not_blank CHECK (
    btrim(event_type) <> '' AND btrim(entity_type) <> '' AND btrim(description) <> ''
  )
);

CREATE TABLE idempotency_keys (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  key uuid NOT NULL,
  request_hash char(64) NOT NULL,
  response_status smallint,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (household_id, key),
  CONSTRAINT idempotency_hash_valid CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_status_valid CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  CONSTRAINT idempotency_dates_valid CHECK (expires_at > created_at)
);

CREATE TABLE strategy_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active',
  base_value_czk numeric(20,2) NOT NULL,
  activated_at timestamptz NOT NULL,
  closed_at timestamptz,
  calculation_version text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, id),
  CONSTRAINT strategy_checkpoints_status_valid CHECK (status IN ('active', 'closed')),
  CONSTRAINT strategy_checkpoints_base_nonnegative CHECK (base_value_czk >= 0),
  CONSTRAINT strategy_checkpoints_dates_valid CHECK (closed_at IS NULL OR closed_at >= activated_at),
  CONSTRAINT strategy_checkpoints_state_valid CHECK (
    (status = 'active' AND closed_at IS NULL) OR (status = 'closed' AND closed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX strategy_checkpoints_one_active
  ON strategy_checkpoints (household_id) WHERE status = 'active';

CREATE TABLE checkpoint_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  checkpoint_id uuid NOT NULL,
  adjustment_czk numeric(20,2) NOT NULL,
  reason text NOT NULL,
  effective_at timestamptz NOT NULL,
  source_entity_type text,
  source_entity_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (household_id, checkpoint_id)
    REFERENCES strategy_checkpoints(household_id, id) ON DELETE RESTRICT,
  CONSTRAINT checkpoint_adjustments_nonzero CHECK (adjustment_czk <> 0),
  CONSTRAINT checkpoint_adjustments_reason_not_blank CHECK (btrim(reason) <> ''),
  CONSTRAINT checkpoint_adjustments_source_complete CHECK (
    (source_entity_type IS NULL AND source_entity_id IS NULL)
    OR (source_entity_type IS NOT NULL AND source_entity_id IS NOT NULL)
  )
);

CREATE INDEX btc_lots_fifo_idx
  ON btc_lots (household_id, account_id, tax_acquired_at, id);
CREATE INDEX btc_disposals_account_time_idx
  ON btc_disposals (household_id, account_id, disposed_at, id);
CREATE INDEX btc_lot_allocations_lot_idx
  ON btc_lot_allocations (household_id, lot_id);
CREATE INDEX btc_transfers_time_idx
  ON btc_transfers (household_id, transferred_at DESC);
CREATE INDEX vwce_lots_fifo_idx
  ON vwce_lots (household_id, account_id, acquired_at, id);
CREATE INDEX vwce_disposals_account_time_idx
  ON vwce_disposals (household_id, account_id, disposed_at, id);
CREATE INDEX vwce_lot_allocations_lot_idx
  ON vwce_lot_allocations (household_id, lot_id);
CREATE INDEX deferred_vwce_allocations_obligation_idx
  ON deferred_vwce_allocations (household_id, obligation_id, allocated_at);
CREATE INDEX debt_entries_history_idx
  ON debt_entries (household_id, debt_id, effective_at, id);
CREATE INDEX market_prices_lookup_idx
  ON market_prices (instrument, quote_currency, observed_at DESC);
CREATE INDEX audit_events_household_time_idx
  ON audit_events (household_id, occurred_at DESC, id DESC);
CREATE INDEX audit_events_entity_idx
  ON audit_events (household_id, entity_type, entity_id, occurred_at DESC);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER households_set_updated_at
BEFORE UPDATE ON households FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER strategy_settings_set_updated_at
BEFORE UPDATE ON strategy_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER btc_accounts_set_updated_at
BEFORE UPDATE ON btc_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER vwce_accounts_set_updated_at
BEFORE UPDATE ON vwce_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER debts_set_updated_at
BEFORE UPDATE ON debts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ownership_proofs_set_updated_at
BEFORE UPDATE ON ownership_proofs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER household_secrets_set_updated_at
BEFORE UPDATE ON household_secrets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
