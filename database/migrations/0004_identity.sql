ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users
  ADD COLUMN user_name text,
  ADD COLUMN normalized_user_name text,
  ADD COLUMN normalized_email text,
  ADD COLUMN email_confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN security_stamp text,
  ADD COLUMN concurrency_stamp text,
  ADD COLUMN phone_number text,
  ADD COLUMN phone_number_confirmed boolean NOT NULL DEFAULT false,
  ADD COLUMN two_factor_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN lockout_end timestamptz,
  ADD COLUMN lockout_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN access_failed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN is_default boolean NOT NULL DEFAULT false;

UPDATE users
SET
  user_name = COALESCE(NULLIF(split_part(email, '@', 1), ''), 'user-' || left(id::text, 8)),
  normalized_user_name = upper(COALESCE(NULLIF(split_part(email, '@', 1), ''), 'user-' || left(id::text, 8))),
  normalized_email = CASE WHEN email IS NULL THEN NULL ELSE upper(email) END,
  security_stamp = gen_random_uuid()::text,
  concurrency_stamp = gen_random_uuid()::text;

ALTER TABLE users
  ALTER COLUMN user_name SET NOT NULL,
  ALTER COLUMN normalized_user_name SET NOT NULL,
  ALTER COLUMN security_stamp SET NOT NULL,
  ALTER COLUMN concurrency_stamp SET NOT NULL;

CREATE UNIQUE INDEX users_normalized_user_name_unique ON users (normalized_user_name);
CREATE INDEX users_normalized_email_idx ON users (normalized_email);
CREATE UNIQUE INDEX users_one_default ON users (is_default) WHERE is_default;

CREATE TABLE identity_user_claims (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  claim_type text,
  claim_value text
);

CREATE INDEX identity_user_claims_user_idx ON identity_user_claims (user_id);

CREATE TABLE identity_user_logins (
  login_provider text NOT NULL,
  provider_key text NOT NULL,
  provider_display_name text,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (login_provider, provider_key)
);

CREATE INDEX identity_user_logins_user_idx ON identity_user_logins (user_id);

CREATE TABLE identity_user_tokens (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  login_provider text NOT NULL,
  name text NOT NULL,
  value text,
  PRIMARY KEY (user_id, login_provider, name)
);

DO $$
DECLARE
  default_user_id uuid;
  default_household_id uuid;
BEGIN
  SELECT id INTO default_user_id FROM users WHERE is_default LIMIT 1;
  IF default_user_id IS NULL THEN
    default_user_id := gen_random_uuid();
    INSERT INTO users (
      id, email, user_name, normalized_user_name, normalized_email,
      display_name, security_stamp, concurrency_stamp, is_default
    ) VALUES (
      default_user_id, NULL, 'default', 'DEFAULT', NULL,
      'Default User', gen_random_uuid()::text, gen_random_uuid()::text, true
    );
  END IF;

  SELECT id INTO default_household_id FROM households ORDER BY created_at, id LIMIT 1;
  IF default_household_id IS NULL THEN
    default_household_id := gen_random_uuid();
    INSERT INTO households (id, name) VALUES (default_household_id, 'Financial Strategy');
    INSERT INTO strategy_settings (household_id) VALUES (default_household_id);
  END IF;

  INSERT INTO household_members (household_id, user_id, role)
  VALUES (default_household_id, default_user_id, 'owner')
  ON CONFLICT (household_id, user_id) DO UPDATE SET role = 'owner';
END;
$$;

ALTER TABLE btc_accounts ADD COLUMN owner_user_id uuid;
UPDATE btc_accounts
SET owner_user_id = (SELECT id FROM users WHERE is_default LIMIT 1);
ALTER TABLE btc_accounts ALTER COLUMN owner_user_id SET NOT NULL;
ALTER TABLE btc_accounts
  ADD CONSTRAINT btc_accounts_owner_membership_fk
  FOREIGN KEY (household_id, owner_user_id)
  REFERENCES household_members(household_id, user_id) ON DELETE RESTRICT;

CREATE INDEX btc_accounts_owner_idx ON btc_accounts (household_id, owner_user_id);

CREATE TABLE btc_account_shares (
  household_id uuid NOT NULL,
  account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (account_id, user_id),
  FOREIGN KEY (household_id, account_id)
    REFERENCES btc_accounts(household_id, id) ON DELETE CASCADE,
  FOREIGN KEY (household_id, user_id)
    REFERENCES household_members(household_id, user_id) ON DELETE CASCADE
);

CREATE INDEX btc_account_shares_user_idx
  ON btc_account_shares (household_id, user_id, account_id);
