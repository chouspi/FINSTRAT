CREATE TABLE vwce_rent_pools (
  household_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  amount_czk numeric(20,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, owner_user_id),
  CONSTRAINT vwce_rent_pools_household_fk FOREIGN KEY (household_id) REFERENCES households(id),
  CONSTRAINT vwce_rent_pools_owner_fk FOREIGN KEY (owner_user_id) REFERENCES users(id),
  CONSTRAINT vwce_rent_pools_amount_valid CHECK (amount_czk >= 0)
);
