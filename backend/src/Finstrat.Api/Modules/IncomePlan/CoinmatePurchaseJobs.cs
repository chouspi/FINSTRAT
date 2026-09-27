using System.Globalization;
using System.Text.Json;
using Finstrat.Api.Infrastructure.Persistence;
using Finstrat.Api.Modules.Bitcoin;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NpgsqlTypes;

namespace Finstrat.Api.Modules.IncomePlan;

public sealed record QueueCoinmatePurchaseRequest(string AmountCzk, Guid? AccountId = null, bool WaitForDeposit = false);
public sealed record CoinmatePurchaseJob(Guid Id, string AccountName, decimal AmountCzk, string Source,
    string Status, decimal BtcBought, decimal? SpentCzk, decimal? LimitPrice, string? Detail,
    DateTime CreatedAt, bool Success, bool Pending);

public sealed class CoinmatePurchaseJobs(
    ApplicationDbContext db, CoinmateBalanceWatchService controller, BitcoinCommandService bitcoin)
{
    private async Task<NpgsqlConnection> Connect(CancellationToken ct)
    {
        var connection = new NpgsqlConnection(db.Database.GetConnectionString());
        await connection.OpenAsync(ct);
        return connection;
    }

    public async Task<CoinmatePurchaseJob> QueueAsync(Guid household, Guid user, Guid key,
        QueueCoinmatePurchaseRequest request, CancellationToken ct)
    {
        if (!decimal.TryParse(request.AmountCzk, NumberStyles.Number, CultureInfo.InvariantCulture, out var amount)
            || amount <= 0 || decimal.Round(amount, 2) != amount)
            throw new IncomePlanValidationException("Částka musí být kladná a mít nejvýše dvě desetinná místa.");
        await using var connection = await Connect(ct);
        await using var tx = await connection.BeginTransactionAsync(ct);
        // Serialize queue registrations and deposit reservations across API instances.
        await using (var gate = new NpgsqlCommand("SELECT pg_advisory_xact_lock(782345091)", connection, tx))
            await gate.ExecuteNonQueryAsync(ct);
        await using (var existing = new NpgsqlCommand("SELECT household_id, user_id, amount_czk, source, account_id FROM coinmate_purchase_jobs WHERE id=@id", connection, tx))
        {
            existing.Parameters.AddWithValue("id", key);
            await using var reader = await existing.ExecuteReaderAsync(ct);
            if (await reader.ReadAsync(ct))
            {
                if (reader.GetGuid(0) != household || reader.GetGuid(1) != user || reader.GetDecimal(2) != amount
                    || reader.GetString(3) != (request.WaitForDeposit ? "income" : "bitcoin")
                    || request.AccountId.HasValue && reader.GetGuid(4) != request.AccountId.Value)
                    throw new IncomePlanValidationException("Tento klíč už patří jinému nákupu.");
                await reader.DisposeAsync();
                await tx.CommitAsync(ct);
                return (await GetAsync(household, user, key, ct))!;
            }
        }
        Guid account;
        await using (var find = new NpgsqlCommand("""
            SELECT id FROM btc_accounts WHERE household_id=@household AND owner_user_id=@user
              AND archived_at IS NULL AND lower(trim(name))='coinmate'
              AND (@account IS NULL OR id=@account)
            """, connection, tx))
        {
            find.Parameters.AddWithValue("household", household);
            find.Parameters.AddWithValue("user", user);
            find.Parameters.Add("account", NpgsqlDbType.Uuid).Value = (object?)request.AccountId ?? DBNull.Value;
            await using var reader = await find.ExecuteReaderAsync(ct);
            if (!await reader.ReadAsync(ct)) throw new IncomePlanValidationException("Vlastní BTC účet Coinmate nebyl nalezen.");
            account = reader.GetGuid(0);
            if (await reader.ReadAsync(ct)) throw new IncomePlanValidationException("Vyberte konkrétní účet Coinmate.");
        }
        var limits = await controller.GetPurchaseRequirementsAsync(ct);
        if (limits.MinAmountCzk <= 0 || limits.MaxAmountCzk < limits.MinAmountCzk)
            throw new CoinmateBalanceWatchUnavailableException();
        if (amount < limits.MinAmountCzk)
            throw new IncomePlanValidationException($"Minimum Coinmate je nyní {limits.MinAmountCzk.ToString("F2", CultureInfo.GetCultureInfo("cs-CZ"))} Kč včetně poplatku ({limits.MinAmountBtc} BTC). Zvyšte částku.");
        if (amount > limits.MaxAmountCzk)
            throw new IncomePlanValidationException($"Maximální rozpočet jednoho API nákupu je {limits.MaxAmountCzk} Kč.");
        // Capture at the actual 'Sent' request, not when the browser opens the form.
        decimal? baseline = request.WaitForDeposit ? await controller.GetFundingBalanceAsync(ct) : null;
        decimal? target = baseline + amount;
        if (baseline.HasValue)
        {
            await using var reserved = new NpgsqlCommand("SELECT max(target_balance_czk) FROM coinmate_purchase_jobs WHERE status='waiting_deposit' AND completed_at IS NULL", connection, tx);
            if (await reserved.ExecuteScalarAsync(ct) is decimal previous) target = Math.Max(previous, baseline.Value) + amount;
        }
        await using var insert = new NpgsqlCommand("""
            INSERT INTO coinmate_purchase_jobs(id, household_id, user_id, account_id, amount_czk, source,
                status, baseline_czk, target_balance_czk)
            VALUES (@id, @household, @user, @account, @amount, @source, @status, @baseline, @target)
            """, connection, tx);
        insert.Parameters.AddWithValue("id", key);
        insert.Parameters.AddWithValue("household", household);
        insert.Parameters.AddWithValue("user", user);
        insert.Parameters.AddWithValue("account", account);
        insert.Parameters.AddWithValue("amount", amount);
        insert.Parameters.AddWithValue("source", request.WaitForDeposit ? "income" : "bitcoin");
        insert.Parameters.AddWithValue("status", request.WaitForDeposit ? "waiting_deposit" : "queued");
        insert.Parameters.Add("baseline", NpgsqlDbType.Numeric).Value = (object?)baseline ?? DBNull.Value;
        insert.Parameters.Add("target", NpgsqlDbType.Numeric).Value = (object?)target ?? DBNull.Value;
        await insert.ExecuteNonQueryAsync(ct);
        await tx.CommitAsync(ct);
        return (await GetAsync(household, user, key, ct))!;
    }

    public async Task<IReadOnlyList<CoinmatePurchaseJob>> ListAsync(Guid household, Guid user, CancellationToken ct)
        => await ReadAsync(household, user, null, ct);

    public async Task<CoinmatePurchaseJob?> GetAsync(Guid household, Guid user, Guid key, CancellationToken ct)
        => (await ReadAsync(household, user, key, ct)).SingleOrDefault();

    private async Task<IReadOnlyList<CoinmatePurchaseJob>> ReadAsync(Guid household, Guid user, Guid? key, CancellationToken ct)
    {
        await using var connection = await Connect(ct);
        await using var command = new NpgsqlCommand("""
            SELECT j.id, a.name, j.amount_czk, j.source, j.status, j.result::text, j.last_error, j.created_at,
              j.completed_at IS NOT NULL FROM coinmate_purchase_jobs j JOIN btc_accounts a ON a.id=j.account_id
            WHERE j.household_id=@household AND j.user_id=@user
              AND ((@id IS NULL AND j.completed_at IS NULL) OR j.id=@id) ORDER BY j.created_at
            """, connection);
        command.Parameters.AddWithValue("household", household);
        command.Parameters.AddWithValue("user", user);
        command.Parameters.Add("id", NpgsqlDbType.Uuid).Value = (object?)key ?? DBNull.Value;
        await using var reader = await command.ExecuteReaderAsync(ct);
        var jobs = new List<CoinmatePurchaseJob>();
        while (await reader.ReadAsync(ct))
        {
            var result = reader.IsDBNull(5) ? null : JsonSerializer.Deserialize<CoinmateBitcoinPurchaseResponse>(reader.GetString(5));
            jobs.Add(new(reader.GetGuid(0), reader.GetString(1), reader.GetDecimal(2), reader.GetString(3),
                reader.GetString(4), result?.BtcBought ?? 0, result?.SpentCzk, result?.LimitPrice,
                reader.IsDBNull(6) ? result?.Detail : reader.GetString(6), reader.GetDateTime(7),
                reader.GetString(4) == "completed", !reader.GetBoolean(8)));
        }
        return jobs;
    }

    public async Task ProcessAsync(CancellationToken ct)
    {
        await using var connection = await Connect(ct);
        // Session lock spans the separate, idempotent BTC ledger transaction.
        await using var gate = new NpgsqlCommand("SELECT pg_try_advisory_lock(782345092)", connection);
        if (await gate.ExecuteScalarAsync(ct) is not true) return;
        try
        {
            // Claim all deposits satisfied by one snapshot before any of them spend it.
            await using (var pending = new NpgsqlCommand("SELECT EXISTS(SELECT 1 FROM coinmate_purchase_jobs WHERE status='waiting_deposit' AND completed_at IS NULL)", connection))
            {
                if (await pending.ExecuteScalarAsync(ct) is true)
                {
                    var balance = await controller.GetFundingBalanceAsync(ct);
                    await using var ready = new NpgsqlCommand("UPDATE coinmate_purchase_jobs SET status='queued', last_error=NULL, updated_at=now() WHERE status='waiting_deposit' AND target_balance_czk<=@balance AND completed_at IS NULL", connection);
                    ready.Parameters.AddWithValue("balance", balance);
                    await ready.ExecuteNonQueryAsync(ct);
                }
            }
            var ids = new List<Guid>();
            await using (var list = new NpgsqlCommand("SELECT id FROM coinmate_purchase_jobs WHERE completed_at IS NULL AND status<>'waiting_deposit' ORDER BY created_at", connection))
            await using (var reader = await list.ExecuteReaderAsync(ct))
                while (await reader.ReadAsync(ct)) ids.Add(reader.GetGuid(0));
            foreach (var id in ids)
            {
                try { await ProcessOne(connection, id, ct); }
                catch (Exception ex) when (!ct.IsCancellationRequested)
                {
                    // Keep the durable intent; retry uses the same exchange/ledger keys.
                    await using var error = new NpgsqlCommand("UPDATE coinmate_purchase_jobs SET last_error=@error, updated_at=now() WHERE id=@id", connection);
                    error.Parameters.AddWithValue("id", id);
                    error.Parameters.AddWithValue("error", ex is BitcoinValidationException ? ex.Message : "Spojení nebo zápis se nepodařil. Server zkusí pokračovat automaticky.");
                    await error.ExecuteNonQueryAsync(ct);
                }
            }
        }
        finally
        {
            await using var unlock = new NpgsqlCommand("SELECT pg_advisory_unlock(782345092)", connection);
            await unlock.ExecuteNonQueryAsync(CancellationToken.None);
        }
    }

    private async Task ProcessOne(NpgsqlConnection connection, Guid id, CancellationToken ct)
    {
        Guid household, user, account;
        decimal budget;
        string source;
        CoinmateBitcoinPurchaseResponse? result;
        await using (var read = new NpgsqlCommand("SELECT household_id,user_id,account_id,amount_czk,source,result::text FROM coinmate_purchase_jobs WHERE id=@id", connection))
        {
            read.Parameters.AddWithValue("id", id);
            await using var reader = await read.ExecuteReaderAsync(ct);
            if (!await reader.ReadAsync(ct)) return;
            household=reader.GetGuid(0); user=reader.GetGuid(1); account=reader.GetGuid(2);
            budget=reader.GetDecimal(3); source=reader.GetString(4);
            result=reader.IsDBNull(5) ? null : JsonSerializer.Deserialize<CoinmateBitcoinPurchaseResponse>(reader.GetString(5));
        }
        if (result is null || result.Pending)
        {
            // The controller owns execution; POST replay is safe even after a lost response.
            result = await controller.PurchaseBitcoinAsync(budget, id, ct);
            await using var save = new NpgsqlCommand("UPDATE coinmate_purchase_jobs SET result=@result, status=@status, last_error=NULL, updated_at=now() WHERE id=@id", connection);
            save.Parameters.AddWithValue("id", id);
            save.Parameters.AddWithValue("result", NpgsqlDbType.Jsonb, JsonSerializer.Serialize(result));
            save.Parameters.AddWithValue("status", result.Pending ? "buying" : "recording");
            await save.ExecuteNonQueryAsync(ct);
        }
        if (result.Pending) return;
        if (result.BtcBought > 0)
        {
            if (result.SpentCzk is not > 0 || result.CompletedAt is not > 0)
                throw new InvalidOperationException("Missing actual purchase costs or fill time");
            var acquired = DateTimeOffset.FromUnixTimeMilliseconds(checked((long)(result.CompletedAt.Value * 1000))).UtcDateTime;
            await bitcoin.CreatePurchaseAsync(household, user, id, new CreateBitcoinPurchaseRequest(account,
                result.BtcBought.ToString("F8", CultureInfo.InvariantCulture),
                (result.SpentCzk.Value / result.BtcBought).ToString("F8", CultureInfo.InvariantCulture),
                acquired.ToString("O"), null, source == "income" ? "Automatický nákup z Income plánu" : "API nákup na Coinmate"), ct);
        }
        await using var finish = new NpgsqlCommand("UPDATE coinmate_purchase_jobs SET status=@status, completed_at=now(), updated_at=now(), last_error=NULL WHERE id=@id", connection);
        finish.Parameters.AddWithValue("id", id);
        finish.Parameters.AddWithValue("status", result.BtcBought > 0 ? "completed" : "rejected");
        await finish.ExecuteNonQueryAsync(ct);
    }
}

public sealed class CoinmatePurchaseWorker(IServiceScopeFactory scopes, IConfiguration configuration,
    ILogger<CoinmatePurchaseWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (string.IsNullOrWhiteSpace(configuration["CoinmateController:ApiToken"])) return;
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        do
        {
            try
            {
                using var scope = scopes.CreateScope();
                await scope.ServiceProvider.GetRequiredService<CoinmatePurchaseJobs>().ProcessAsync(stoppingToken);
            }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            { logger.LogError(ex, "Coinmate purchase processing failed"); }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }
}
