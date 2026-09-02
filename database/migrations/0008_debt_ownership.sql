ALTER TABLE debts ADD COLUMN IF NOT EXISTS owner_user_id uuid;

UPDATE debts debt
SET owner_user_id = COALESCE(
  (
    SELECT member.user_id
    FROM household_members member
    JOIN users samuel ON samuel.id = member.user_id
    WHERE member.household_id = debt.household_id
      AND samuel.normalized_user_name = 'SAMUEL'
    LIMIT 1
  ),
  (
    SELECT member.user_id
    FROM household_members member
    JOIN users default_user ON default_user.id = member.user_id
    WHERE member.household_id = debt.household_id AND default_user.is_default
    LIMIT 1
  )
);

ALTER TABLE debts ALTER COLUMN owner_user_id SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'debts_owner_membership_fk') THEN
    ALTER TABLE debts
      ADD CONSTRAINT debts_owner_membership_fk
      FOREIGN KEY (household_id, owner_user_id)
      REFERENCES household_members(household_id, user_id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS debts_owner_idx ON debts (household_id, owner_user_id);
