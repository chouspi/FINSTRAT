-- VWCE and VGLA are different instruments. The cutover intentionally discards
-- the old fund ledger instead of reinterpreting its shares as VGLA.
DELETE FROM deferred_vwce_allocations;
DELETE FROM deferred_vwce_obligations;
DELETE FROM vwce_lot_allocations;
DELETE FROM vwce_disposals;
DELETE FROM vwce_lots;
DELETE FROM vwce_account_shares;
DELETE FROM vwce_accounts;
DELETE FROM vwce_rent_pools;

DELETE FROM btc_lot_allocations
WHERE disposal_id IN (SELECT id FROM btc_disposals WHERE kind = 'vwce_reallocation');
DELETE FROM btc_disposals WHERE kind = 'vwce_reallocation';
DELETE FROM vwce_reallocations;

-- Remove the VWCE component from retained wealth history.
UPDATE wealth_snapshots
SET gross_assets_czk = GREATEST(gross_assets_czk - vwce_value_czk, 0),
    tracked_net_worth_czk = tracked_net_worth_czk - vwce_value_czk,
    vwce_shares = 0,
    vwce_price_czk = NULL,
    vwce_value_czk = 0,
    vwce_cost_basis_czk = 0,
    vwce_price_id = NULL;

UPDATE portfolio_snapshots
SET net_worth_czk = CASE
      WHEN net_worth_czk IS NULL THEN NULL
      ELSE net_worth_czk - vwce_value_czk
    END,
    vwce_shares = 0,
    vwce_value_czk = 0,
    vwce_price_id = NULL;

DELETE FROM market_prices WHERE instrument = 'VWCE';
ALTER TABLE market_prices DROP CONSTRAINT market_prices_instrument_valid;
ALTER TABLE market_prices ADD CONSTRAINT market_prices_instrument_valid
  CHECK (instrument IN ('BTC', 'VGLA'));

-- VGLA.DE is quoted in EUR. Trade facts stay in their native currency; CZK is
-- derived at the API/UI boundary using EUR/CZK.
ALTER TABLE vwce_lots RENAME COLUMN unit_price_czk TO unit_price_eur;
ALTER TABLE vwce_disposals RENAME COLUMN unit_price_czk TO unit_price_eur;
ALTER TABLE vwce_disposals RENAME COLUMN proceeds_czk TO proceeds_eur;
ALTER TABLE vwce_lot_allocations RENAME COLUMN cost_basis_czk TO cost_basis_eur;

ALTER TABLE vwce_lots ALTER COLUMN unit_price_eur TYPE numeric(20,4);
ALTER TABLE vwce_disposals DROP CONSTRAINT vwce_disposals_proceeds_match;
ALTER TABLE vwce_disposals ALTER COLUMN unit_price_eur TYPE numeric(20,4);
ALTER TABLE vwce_disposals ALTER COLUMN proceeds_eur TYPE numeric(20,4);
ALTER TABLE vwce_disposals ADD CONSTRAINT vwce_disposals_proceeds_match
  CHECK (abs(proceeds_eur - round(shares * unit_price_eur, 4)) <= 0.0001);
ALTER TABLE vwce_lot_allocations ALTER COLUMN cost_basis_eur TYPE numeric(20,4);
