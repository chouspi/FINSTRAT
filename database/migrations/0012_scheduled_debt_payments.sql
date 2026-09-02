DROP VIEW debt_balances;

ALTER TABLE debt_entries DROP CONSTRAINT debt_entries_type_valid;
ALTER TABLE debt_entries ADD CONSTRAINT debt_entries_type_valid CHECK (
  entry_type IN (
    'opening_balance', 'drawdown', 'payment', 'scheduled_payment',
    'interest', 'fee', 'adjustment_up', 'adjustment_down'
  )
);

CREATE VIEW debt_balances AS
SELECT
  debt.household_id,
  debt.id AS debt_id,
  debt.name,
  COALESCE(sum(
    CASE
      WHEN entry.entry_type IN ('opening_balance', 'drawdown', 'interest', 'fee', 'adjustment_up') THEN entry.amount_czk
      ELSE -entry.amount_czk
    END
  ), 0)::numeric(20,2) AS balance_czk,
  debt.closed_at
FROM debts debt
JOIN households household ON household.id = debt.household_id
LEFT JOIN debt_entries entry
  ON entry.debt_id = debt.id
  AND entry.household_id = debt.household_id
  AND entry.entry_type <> 'scheduled_payment'
GROUP BY debt.household_id, debt.id, debt.name, debt.closed_at;
