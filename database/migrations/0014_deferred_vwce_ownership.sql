ALTER TABLE deferred_vwce_obligations ADD COLUMN owner_user_id uuid;

UPDATE deferred_vwce_obligations obligation
SET owner_user_id = COALESCE(
  (SELECT member.user_id FROM household_members member
   WHERE member.household_id = obligation.household_id AND member.user_id = obligation.created_by),
  (SELECT member.user_id FROM household_members member
   JOIN users app_user ON app_user.id = member.user_id
   WHERE member.household_id = obligation.household_id AND app_user.is_default
   LIMIT 1)
);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM deferred_vwce_obligations WHERE owner_user_id IS NULL) THEN
    RAISE EXCEPTION 'Unable to assign deferred VWCE obligation owner';
  END IF;
END $$;

ALTER TABLE deferred_vwce_obligations ALTER COLUMN owner_user_id SET NOT NULL;
ALTER TABLE deferred_vwce_obligations ADD CONSTRAINT deferred_vwce_owner_fk
  FOREIGN KEY (household_id, owner_user_id)
  REFERENCES household_members(household_id, user_id) ON DELETE RESTRICT;
CREATE INDEX deferred_vwce_owner_pending_idx
  ON deferred_vwce_obligations (household_id, owner_user_id, deferred_at, id);
