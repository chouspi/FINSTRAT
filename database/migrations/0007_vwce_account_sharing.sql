CREATE TABLE vwce_account_shares (
  household_id uuid NOT NULL,
  account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (account_id, user_id),
  FOREIGN KEY (household_id, account_id)
    REFERENCES vwce_accounts(household_id, id) ON DELETE CASCADE,
  FOREIGN KEY (household_id, user_id)
    REFERENCES household_members(household_id, user_id) ON DELETE CASCADE
);

CREATE INDEX vwce_account_shares_user_idx
  ON vwce_account_shares (household_id, user_id, account_id);
