ALTER TABLE vwce_accounts ADD COLUMN owner_user_id uuid;

UPDATE vwce_accounts
SET owner_user_id = (SELECT id FROM users WHERE is_default LIMIT 1);

ALTER TABLE vwce_accounts ALTER COLUMN owner_user_id SET NOT NULL;
ALTER TABLE vwce_accounts
  ADD CONSTRAINT vwce_accounts_owner_membership_fk
  FOREIGN KEY (household_id, owner_user_id)
  REFERENCES household_members(household_id, user_id) ON DELETE RESTRICT;

CREATE INDEX vwce_accounts_owner_idx ON vwce_accounts (household_id, owner_user_id);
