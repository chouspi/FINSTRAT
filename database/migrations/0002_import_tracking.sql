ALTER TABLE debts DROP CONSTRAINT debts_priority_valid;
ALTER TABLE debts ADD CONSTRAINT debts_priority_valid CHECK (priority BETWEEN 0 AND 5);

ALTER TABLE strategy_settings
  ADD COLUMN income_default_capital_czk numeric(20,2) NOT NULL DEFAULT 0,
  ADD CONSTRAINT strategy_income_default_capital_nonnegative
    CHECK (income_default_capital_czk >= 0);

CREATE TABLE data_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  source_type text NOT NULL,
  source_fingerprint char(64) NOT NULL,
  source_label text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (source_type, source_fingerprint),
  UNIQUE (household_id, id),
  CONSTRAINT data_imports_source_not_blank CHECK (
    btrim(source_type) <> '' AND btrim(source_label) <> ''
  ),
  CONSTRAINT data_imports_fingerprint_valid CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT data_imports_status_valid CHECK (status IN ('running', 'completed', 'failed')),
  CONSTRAINT data_imports_state_valid CHECK (
    (status = 'running' AND completed_at IS NULL)
    OR (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
  )
);

CREATE TABLE legacy_id_map (
  import_id uuid NOT NULL REFERENCES data_imports(id) ON DELETE RESTRICT,
  entity_type text NOT NULL,
  legacy_id text NOT NULL,
  new_id uuid NOT NULL,
  PRIMARY KEY (import_id, entity_type, legacy_id),
  CONSTRAINT legacy_id_map_entity_not_blank CHECK (btrim(entity_type) <> ''),
  CONSTRAINT legacy_id_map_id_not_blank CHECK (btrim(legacy_id) <> '')
);

CREATE INDEX legacy_id_map_new_id_idx ON legacy_id_map (new_id);

CREATE TABLE legacy_settings (
  import_id uuid NOT NULL REFERENCES data_imports(id) ON DELETE RESTRICT,
  key text NOT NULL,
  value text NOT NULL,
  PRIMARY KEY (import_id, key),
  CONSTRAINT legacy_settings_key_not_blank CHECK (btrim(key) <> '')
);
