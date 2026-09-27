CREATE TABLE coinmate_purchase_jobs (
  id uuid PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id),
  user_id uuid NOT NULL REFERENCES users(id),
  account_id uuid NOT NULL REFERENCES btc_accounts(id),
  amount_czk numeric(20,2) NOT NULL CHECK (amount_czk > 0),
  source text NOT NULL CHECK (source IN ('income', 'bitcoin')),
  status text NOT NULL DEFAULT 'queued',
  baseline_czk numeric(28,8),
  target_balance_czk numeric(28,8),
  result jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX coinmate_purchase_jobs_active ON coinmate_purchase_jobs(created_at) WHERE completed_at IS NULL;
