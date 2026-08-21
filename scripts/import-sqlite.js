const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');

const databaseUrl = process.env.DATABASE_URL;
const sourcePath = process.argv[2];
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!sourcePath) throw new Error('Usage: npm run db:import:sqlite -- /path/to/data.db');

const absoluteSourcePath = path.resolve(sourcePath);
const fingerprint = crypto.createHash('sha256').update(fs.readFileSync(absoluteSourcePath)).digest('hex');

const id = () => crypto.randomUUID();
const money = (value) => value == null ? null : Number(value).toFixed(2);
const quantity = (value) => Number(value).toFixed(8);
const day = (value) => String(value).slice(0, 10);
const timestamp = (value) => {
  if (!value) return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text} 12:00:00 Europe/Prague`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) return `${text.replace(' ', 'T')}Z`;
  return text;
};
const parseJson = (value) => {
  if (!value) return {};
  try { return JSON.parse(value); } catch { return { legacy_value: value }; }
};

function sqliteQuery(sql) {
  const result = spawnSync('sqlite3', ['-json', '-readonly', absoluteSourcePath, sql], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'sqlite3 query failed');
  return result.stdout.trim() ? JSON.parse(result.stdout) : [];
}

function rows(table, order = 'id') {
  return sqliteQuery(`SELECT * FROM ${table} ORDER BY ${order}`);
}

function settingMap() {
  return new Map(sqliteQuery('SELECT key, value FROM settings').map((row) => [row.key, row.value]));
}

function numberSetting(settings, key, fallback) {
  const value = Number(settings.get(key));
  return Number.isFinite(value) ? value : fallback;
}

async function insertMap(client, importId, entityType, legacyId, newId) {
  await client.query(
    'INSERT INTO legacy_id_map (import_id, entity_type, legacy_id, new_id) VALUES ($1, $2, $3, $4)',
    [importId, entityType, String(legacyId), newId],
  );
}

function allocateFifo(lotsByAccount, accountId, amount, at) {
  let remaining = Number(amount);
  const allocations = [];
  const lots = lotsByAccount.get(accountId) || [];
  for (const lot of lots) {
    if (remaining <= 1e-10) break;
    if (lot.acquiredAt > at || lot.remaining <= 1e-10) continue;
    const used = Math.min(lot.remaining, remaining);
    lot.remaining -= used;
    remaining -= used;
    allocations.push({ ...lot, used });
  }
  if (remaining > 1e-8) {
    throw new Error(`BTC FIFO deficit ${remaining.toFixed(8)} for account ${accountId} at ${at}`);
  }
  return allocations;
}

function allocateVwceFifo(lotsByAccount, accountId, shares, at) {
  let remaining = Number(shares);
  const allocations = [];
  const lots = lotsByAccount.get(accountId) || [];
  for (const lot of lots) {
    if (remaining <= 1e-10) break;
    if (lot.acquiredAt > at || lot.remaining <= 1e-10) continue;
    const used = Math.min(lot.remaining, remaining);
    lot.remaining -= used;
    remaining -= used;
    allocations.push({ ...lot, used });
  }
  if (remaining > 1e-8) {
    throw new Error(`VWCE FIFO deficit ${remaining.toFixed(8)} for account ${accountId} at ${at}`);
  }
  return allocations;
}

async function main() {
  const integrity = sqliteQuery('PRAGMA integrity_check')[0]?.integrity_check;
  if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}`);
  if (rows('account_transfers').length) {
    throw new Error('Source contains BTC account transfers; provenance mapping must be reviewed before import');
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("SET TIME ZONE 'Europe/Prague'");

  const duplicate = await client.query(
    'SELECT id FROM data_imports WHERE source_type = $1 AND source_fingerprint = $2',
    ['financialstrategy-sqlite', fingerprint],
  );
  if (duplicate.rowCount) {
    await client.end();
    throw new Error(`This SQLite snapshot was already imported as ${duplicate.rows[0].id}`);
  }

  await client.query('BEGIN');
  try {
    const householdId = id();
    const importId = id();
    const settings = settingMap();
    await client.query(
      'INSERT INTO households (id, name) VALUES ($1, $2)',
      [householdId, 'Financial Strategy'],
    );
    await client.query(
      `INSERT INTO strategy_settings (
        household_id, btc_tax_period_years, checkpoint_auto,
        checkpoint_activation_threshold_czk, checkpoint_trigger_floor_czk,
        checkpoint_trigger_percent, realization_step_profit_czk,
        realization_step_transfer_czk, vwce_rent_rate_percent,
        allocation_without_debt, allocation_with_debt, income_default_capital_czk
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        householdId,
        numberSetting(settings, 'btc_tax_period_years', 3),
        settings.get('checkpoint_auto') === '1',
        money(numberSetting(settings, 'checkpoint_activation_threshold', 100000)),
        money(numberSetting(settings, 'checkpoint_trigger_floor', 20000)),
        numberSetting(settings, 'checkpoint_trigger_pct', 10),
        money(numberSetting(settings, 'realization_step_profit', 20000)),
        money(numberSetting(settings, 'realization_step_transfer', 10000)),
        numberSetting(settings, 'vwce_rent_rate_pct', 2),
        JSON.stringify({
          btc: numberSetting(settings, 'income_nodebts_btc', 90),
          cash: numberSetting(settings, 'income_nodebts_cash', 10),
        }),
        JSON.stringify({
          btc: numberSetting(settings, 'income_withdebts_btc', 70),
          debt: numberSetting(settings, 'income_withdebts_debt', 20),
          cash: numberSetting(settings, 'income_withdebts_cash', 10),
        }),
        money(numberSetting(settings, 'income_default_capital', 0)),
      ],
    );
    await client.query(
      `INSERT INTO data_imports
        (id, household_id, source_type, source_fingerprint, source_label)
       VALUES ($1, $2, 'financialstrategy-sqlite', $3, $4)`,
      [importId, householdId, fingerprint, path.basename(absoluteSourcePath)],
    );
    for (const [key, value] of settings) {
      await client.query(
        'INSERT INTO legacy_settings (import_id, key, value) VALUES ($1, $2, $3)',
        [importId, key, value],
      );
    }

    const btcAccountIds = new Map();
    for (const row of rows('accounts')) {
      const newId = id();
      btcAccountIds.set(row.id, newId);
      await client.query(
        `INSERT INTO btc_accounts
          (id, household_id, name, description, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [newId, householdId, row.name, row.description, timestamp(row.created_at)],
      );
      await insertMap(client, importId, 'accounts', row.id, newId);
    }

    const vwceAccountIds = new Map();
    for (const row of rows('vwce_accounts')) {
      const newId = id();
      vwceAccountIds.set(row.id, newId);
      await client.query(
        `INSERT INTO vwce_accounts
          (id, household_id, name, description, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [newId, householdId, row.name, row.description, timestamp(row.created_at)],
      );
      await insertMap(client, importId, 'vwce_accounts', row.id, newId);
    }

    const expenseIds = new Map();
    for (const row of rows('life_expenses')) {
      const newId = id();
      expenseIds.set(row.id, newId);
      await client.query(
        `INSERT INTO life_expenses
          (id, household_id, amount_czk, category, note, spent_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [newId, householdId, money(row.amount_czk), row.category, row.note,
          timestamp(row.spent_at), timestamp(row.created_at)],
      );
      await insertMap(client, importId, 'life_expenses', row.id, newId);
    }

    const reallocationIds = new Map();
    const inboundTransfers = rows('vwce_transfers').filter((row) => row.direction === 'in');
    for (const row of inboundTransfers) {
      const newId = id();
      reallocationIds.set(row.id, newId);
      await client.query(
        `INSERT INTO vwce_reallocations
          (id, household_id, amount_czk, executed_at, note, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [newId, householdId, money(row.amount_czk), timestamp(row.transferred_at),
          row.note, timestamp(row.created_at)],
      );
      await insertMap(client, importId, 'vwce_transfers_in', row.id, newId);
    }

    const btcLotsByAccount = new Map();
    const btcLotIds = new Map();
    for (const row of rows('purchases', 'purchased_at, id')) {
      if (row.transfer_id != null) throw new Error(`Unexpected transfer purchase ${row.id}`);
      const accountId = btcAccountIds.get(row.account_id);
      if (!accountId) throw new Error(`Missing BTC account ${row.account_id} for purchase ${row.id}`);
      const newId = id();
      btcLotIds.set(row.id, newId);
      await client.query(
        `INSERT INTO btc_lots (
          id, household_id, account_id, quantity_btc, unit_price_czk, unit_price_usd,
          acquired_at, tax_acquired_at, txid, note, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10)`,
        [newId, householdId, accountId, quantity(row.btc_amount), money(row.price_czk),
          money(row.price_usd), timestamp(row.purchased_at), row.transaction_id,
          row.note, timestamp(row.created_at)],
      );
      const accountLots = btcLotsByAccount.get(row.account_id) || [];
      accountLots.push({
        id: newId,
        remaining: Number(row.btc_amount),
        unitPriceCzk: row.price_czk == null ? null : Number(row.price_czk),
        acquiredAt: String(row.purchased_at),
      });
      btcLotsByAccount.set(row.account_id, accountLots);
      await insertMap(client, importId, 'purchases', row.id, newId);
    }

    const withdrawalIds = new Map();
    for (const row of rows('withdrawals', 'withdrawn_at, id')) {
      const accountId = btcAccountIds.get(row.account_id);
      if (!accountId) throw new Error(`Missing BTC account ${row.account_id} for withdrawal ${row.id}`);
      let kind = 'standalone';
      let targetId = null;
      let targetColumn = null;
      if (row.purpose === 'life_expense') {
        kind = 'life_expense';
        targetId = expenseIds.get(row.purpose_ref_id);
        targetColumn = 'life_expense_id';
      } else if (row.purpose === 'vwce') {
        kind = 'vwce_reallocation';
        targetId = reallocationIds.get(row.purpose_ref_id);
        targetColumn = 'vwce_reallocation_id';
      } else if (row.purpose != null) {
        throw new Error(`Unsupported withdrawal purpose ${row.purpose} on ${row.id}`);
      }
      if (targetColumn && !targetId) throw new Error(`Missing target for withdrawal ${row.id}`);

      const newId = id();
      withdrawalIds.set(row.id, newId);
      const columns = targetColumn ? `, ${targetColumn}` : '';
      const placeholders = targetColumn ? ', $11' : '';
      const values = [newId, householdId, accountId, kind, quantity(row.btc_amount),
        money(row.sale_price_czk), timestamp(row.withdrawn_at), row.transaction_id,
        row.note, timestamp(row.created_at)];
      if (targetColumn) values.push(targetId);
      await client.query(
        `INSERT INTO btc_disposals (
          id, household_id, account_id, kind, quantity_btc, unit_price_czk,
          disposed_at, txid, note, created_at${columns}
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10${placeholders})`,
        values,
      );

      const allocations = allocateFifo(
        btcLotsByAccount, row.account_id, row.btc_amount, String(row.withdrawn_at),
      );
      for (const allocation of allocations) {
        const basis = allocation.unitPriceCzk == null
          ? null
          : money(allocation.used * allocation.unitPriceCzk);
        await client.query(
          `INSERT INTO btc_lot_allocations
            (household_id, disposal_id, lot_id, quantity_btc, cost_basis_czk)
           VALUES ($1,$2,$3,$4,$5)`,
          [householdId, newId, allocation.id, quantity(allocation.used), basis],
        );
      }
      await insertMap(client, importId, 'withdrawals', row.id, newId);
    }

    const vwceLotsByAccount = new Map();
    const vwceLotIds = new Map();
    for (const row of rows('vwce_purchases', 'purchased_at, id')) {
      const accountId = vwceAccountIds.get(row.account_id);
      if (!accountId) throw new Error(`Missing VWCE account ${row.account_id} for purchase ${row.id}`);
      const sourceReallocationId = row.transfer_id == null ? null : reallocationIds.get(row.transfer_id);
      if (row.transfer_id != null && !sourceReallocationId) {
        throw new Error(`Missing reallocation ${row.transfer_id} for VWCE purchase ${row.id}`);
      }
      const newId = id();
      vwceLotIds.set(row.id, newId);
      await client.query(
        `INSERT INTO vwce_lots (
          id, household_id, account_id, shares, unit_price_czk, acquired_at,
          provisional, source_reallocation_id, note, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [newId, householdId, accountId, quantity(row.shares), money(row.price_czk),
          timestamp(row.purchased_at), Boolean(row.provisional), sourceReallocationId,
          row.note, timestamp(row.created_at)],
      );
      const accountLots = vwceLotsByAccount.get(row.account_id) || [];
      accountLots.push({
        id: newId,
        remaining: Number(row.shares),
        unitPriceCzk: row.price_czk == null ? null : Number(row.price_czk),
        acquiredAt: String(row.purchased_at),
      });
      vwceLotsByAccount.set(row.account_id, accountLots);
      await insertMap(client, importId, 'vwce_purchases', row.id, newId);
    }

    for (const row of rows('vwce_transfers').filter((item) => item.direction === 'out')) {
      const accountId = vwceAccountIds.get(row.vwce_account_id);
      if (!accountId || !(row.shares > 0) || !(row.price_czk > 0)) {
        throw new Error(`Incomplete VWCE payout ${row.id}`);
      }
      const newId = id();
      await client.query(
        `INSERT INTO vwce_disposals (
          id, household_id, account_id, shares, unit_price_czk, proceeds_czk,
          disposed_at, note, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [newId, householdId, accountId, quantity(row.shares), money(row.price_czk),
          money(row.amount_czk), timestamp(row.transferred_at), row.note,
          timestamp(row.created_at)],
      );
      const allocations = allocateVwceFifo(
        vwceLotsByAccount, row.vwce_account_id, row.shares, String(row.transferred_at),
      );
      for (const allocation of allocations) {
        const basis = allocation.unitPriceCzk == null
          ? null
          : money(allocation.used * allocation.unitPriceCzk);
        await client.query(
          `INSERT INTO vwce_lot_allocations
            (household_id, disposal_id, lot_id, shares, cost_basis_czk)
           VALUES ($1,$2,$3,$4,$5)`,
          [householdId, newId, allocation.id, quantity(allocation.used), basis],
        );
      }
      await insertMap(client, importId, 'vwce_transfers_out', row.id, newId);
    }

    const obligationIds = new Map();
    for (const row of rows('deferred_vwce_pool')) {
      const newId = id();
      obligationIds.set(row.id, newId);
      await client.query(
        `INSERT INTO deferred_vwce_obligations (
          id, household_id, original_amount_czk, cancelled_amount_czk,
          deferred_at, completed_at, note, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [newId, householdId, money(row.amount_czk), money(row.cancelled_czk),
          day(row.deferred_at), row.completed_at ? day(row.completed_at) : null,
          row.note, timestamp(row.created_at)],
      );
      await insertMap(client, importId, 'deferred_vwce_pool', row.id, newId);
    }
    for (const row of rows('deferred_vwce_allocations')) {
      const obligationId = obligationIds.get(row.pool_id);
      const vwceLotId = vwceLotIds.get(row.vwce_purchase_id);
      if (!obligationId || !vwceLotId) throw new Error(`Invalid deferred allocation ${row.id}`);
      const newId = id();
      await client.query(
        `INSERT INTO deferred_vwce_allocations
          (id, household_id, obligation_id, vwce_lot_id, amount_czk, allocated_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [newId, householdId, obligationId, vwceLotId, money(row.amount_czk),
          day(row.allocated_at), timestamp(row.created_at)],
      );
      await insertMap(client, importId, 'deferred_vwce_allocations', row.id, newId);
    }

    const allPayments = rows('debt_payments', 'paid_at, id');
    const paymentsByDebt = new Map();
    for (const payment of allPayments) {
      const list = paymentsByDebt.get(payment.debt_id) || [];
      list.push(payment);
      paymentsByDebt.set(payment.debt_id, list);
    }
    const debtIds = new Map();
    for (const row of rows('debts')) {
      const newId = id();
      debtIds.set(row.id, newId);
      const payments = paymentsByDebt.get(row.id) || [];
      const opening = Number(row.amount) + payments.reduce((sum, item) => sum + Number(item.amount), 0);
      await client.query(
        `INSERT INTO debts (
          id, household_id, name, priority, is_mortgage, opened_at, closed_at, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [newId, householdId, row.name, row.priority, Boolean(row.is_mortgage),
          day(row.created_at), row.paid_off_at ? day(row.paid_off_at) : null,
          timestamp(row.created_at)],
      );
      await client.query(
        `INSERT INTO debt_entries
          (household_id, debt_id, entry_type, amount_czk, effective_at, note, created_at)
         VALUES ($1,$2,'opening_balance',$3,$4,$5,$6)`,
        [householdId, newId, money(opening), day(row.created_at),
          'Imported opening balance reconstructed from current balance and payments',
          timestamp(row.created_at)],
      );
      await insertMap(client, importId, 'debts', row.id, newId);
    }

    const orphanGroups = new Map();
    for (const payment of allPayments) {
      if (debtIds.has(payment.debt_id)) continue;
      const key = payment.debt_name;
      const group = orphanGroups.get(key) || [];
      group.push(payment);
      orphanGroups.set(key, group);
    }
    for (const [name, payments] of orphanGroups) {
      const newId = id();
      const total = payments.reduce((sum, item) => sum + Number(item.amount), 0);
      await client.query(
        `INSERT INTO debts (
          id, household_id, name, priority, opened_at, closed_at, archived_at, note
        ) VALUES ($1,$2,$3,0,$4,$5,now(),$6)`,
        [newId, householdId, name, day(payments[0].paid_at),
          day(payments.at(-1).paid_at), 'Reconstructed from payments after legacy debt deletion'],
      );
      await client.query(
        `INSERT INTO debt_entries
          (household_id, debt_id, entry_type, amount_czk, effective_at, note)
         VALUES ($1,$2,'opening_balance',$3,$4,$5)`,
        [householdId, newId, money(total), day(payments[0].paid_at),
          'Reconstructed opening balance for deleted legacy debt'],
      );
      for (const payment of payments) payment._targetDebtId = newId;
    }
    for (const payment of allPayments) {
      const debtId = debtIds.get(payment.debt_id) || payment._targetDebtId;
      if (!debtId) throw new Error(`Cannot map debt payment ${payment.id}`);
      const newId = id();
      await client.query(
        `INSERT INTO debt_entries (
          id, household_id, debt_id, entry_type, amount_czk, effective_at, note, created_at
        ) VALUES ($1,$2,$3,'payment',$4,$5,$6,$7)`,
        [newId, householdId, debtId, money(payment.amount), day(payment.paid_at),
          `Imported payment; legacy debt name: ${payment.debt_name}`,
          timestamp(payment.created_at)],
      );
      await insertMap(client, importId, 'debt_payments', payment.id, newId);
    }

    const snapshotRows = rows('portfolio_snapshots', 'snap_date, id');
    if (snapshotRows.length) {
      const runId = id();
      await client.query(
        `INSERT INTO snapshot_runs (
          id, household_id, source, calculation_version, status, completed_at, details
        ) VALUES ($1,$2,'import','legacy-sqlite-v1','completed',now(),$3)`,
        [runId, householdId, JSON.stringify({
          note: 'Legacy snapshots do not contain historical quantities or price provenance',
        })],
      );
      for (const row of snapshotRows) {
        const newId = id();
        await client.query(
          `INSERT INTO portfolio_snapshots (
            id, household_id, snapshot_date, run_id, quality, btc_value_czk,
            vwce_value_czk, invested_czk, external_net_cashflow_czk,
            net_worth_czk, created_at
          ) VALUES ($1,$2,$3,$4,'incomplete',$5,$6,$7,$8,$9,$10)`,
          [newId, householdId, day(row.snap_date), runId, money(row.btc_value_czk || 0),
            money(row.vwce_value_czk || 0), money(row.invested_czk || 0),
            money(row.external_net_cashflow_czk), money(row.net_worth_czk),
            timestamp(row.created_at)],
        );
        await insertMap(client, importId, 'portfolio_snapshots', row.id, newId);
      }
    }

    for (const row of rows('ownership_proofs')) {
      const newId = id();
      const accountId = row.account_id == null ? null : btcAccountIds.get(row.account_id);
      if (row.account_id != null && !accountId) throw new Error(`Missing account for proof ${row.id}`);
      await client.query(
        `INSERT INTO ownership_proofs (
          id, household_id, account_id, account_name_snapshot, content,
          content_size_bytes, sha256, anchor_txid, anchored_at, note,
          created_at, updated_at, archived_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [newId, householdId, accountId, row.account_name, row.content,
          Buffer.byteLength(row.content, 'utf8'), row.sha256.toLowerCase(), row.txid,
          timestamp(row.anchored_at), row.note, timestamp(row.created_at),
          timestamp(row.updated_at), timestamp(row.deleted_at)],
      );
      await insertMap(client, importId, 'ownership_proofs', row.id, newId);
    }

    for (const row of rows('activity_log')) {
      const accountId = row.account_id == null ? null : btcAccountIds.get(row.account_id);
      await client.query(
        `INSERT INTO audit_events (
          household_id, event_type, entity_type, entity_id, description, metadata, occurred_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [householdId, row.type, accountId ? 'btc_account' : 'legacy_activity',
          accountId, row.description, JSON.stringify(parseJson(row.meta)),
          timestamp(row.created_at)],
      );
    }

    if (settings.get('checkpoint_active') === '1') {
      const checkpointId = id();
      await client.query(
        `INSERT INTO strategy_checkpoints (
          id, household_id, base_value_czk, activated_at, calculation_version, note
        ) VALUES ($1,$2,$3,now(),'legacy-sqlite-v1',$4)`,
        [checkpointId, householdId, money(numberSetting(settings, 'checkpoint_base', 0)),
          'Imported active checkpoint; legacy watermarks are retained in legacy_settings'],
      );
    }

    const report = {
      household_id: householdId,
      source_fingerprint: fingerprint,
      source_counts: {
        accounts: rows('accounts').length,
        purchases: rows('purchases').length,
        withdrawals: rows('withdrawals').length,
        vwce_accounts: rows('vwce_accounts').length,
        vwce_purchases: rows('vwce_purchases').length,
        life_expenses: rows('life_expenses').length,
        debts: rows('debts').length,
        debt_payments: allPayments.length,
        portfolio_snapshots: snapshotRows.length,
        ownership_proofs: rows('ownership_proofs').length,
        activity_log: rows('activity_log').length,
      },
      reconstructed_archived_debts: orphanGroups.size,
    };
    await client.query(
      `UPDATE data_imports
       SET status = 'completed', report = $2, completed_at = now()
       WHERE id = $1`,
      [importId, JSON.stringify(report)],
    );

    await client.query('COMMIT');
    console.log(JSON.stringify({ import_id: importId, ...report }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
