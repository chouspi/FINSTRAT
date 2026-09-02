CREATE TABLE wealth_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  snapshot_date date NOT NULL,
  snapshot_at timestamptz NOT NULL,
  source text NOT NULL,
  quality text NOT NULL DEFAULT 'complete',
  btc_quantity numeric(20,8) NOT NULL DEFAULT 0,
  btc_price_czk numeric(24,8),
  btc_value_czk numeric(20,2) NOT NULL DEFAULT 0,
  btc_cost_basis_czk numeric(20,2) NOT NULL DEFAULT 0,
  vwce_shares numeric(20,8) NOT NULL DEFAULT 0,
  vwce_price_czk numeric(24,8),
  vwce_value_czk numeric(20,2) NOT NULL DEFAULT 0,
  vwce_cost_basis_czk numeric(20,2) NOT NULL DEFAULT 0,
  consumer_debt_czk numeric(20,2) NOT NULL DEFAULT 0,
  mortgage_debt_czk numeric(20,2) NOT NULL DEFAULT 0,
  gross_assets_czk numeric(20,2) NOT NULL DEFAULT 0,
  tracked_net_worth_czk numeric(20,2) NOT NULL DEFAULT 0,
  btc_price_id uuid REFERENCES market_prices(id) ON DELETE RESTRICT,
  vwce_price_id uuid REFERENCES market_prices(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (household_id, owner_user_id, snapshot_date),
  FOREIGN KEY (household_id, owner_user_id)
    REFERENCES household_members(household_id, user_id) ON DELETE CASCADE,
  CONSTRAINT wealth_snapshots_source_valid CHECK (source IN ('scheduled', 'manual')),
  CONSTRAINT wealth_snapshots_quality_valid CHECK (quality IN ('complete', 'estimated')),
  CONSTRAINT wealth_snapshots_nonnegative CHECK (
    btc_quantity >= 0 AND btc_value_czk >= 0 AND btc_cost_basis_czk >= 0
    AND vwce_shares >= 0 AND vwce_value_czk >= 0 AND vwce_cost_basis_czk >= 0
    AND consumer_debt_czk >= 0 AND mortgage_debt_czk >= 0 AND gross_assets_czk >= 0
  )
);

CREATE INDEX wealth_snapshots_history_idx
  ON wealth_snapshots (household_id, owner_user_id, snapshot_date DESC);

CREATE TRIGGER wealth_snapshots_set_updated_at
BEFORE UPDATE ON wealth_snapshots FOR EACH ROW EXECUTE FUNCTION set_updated_at();
