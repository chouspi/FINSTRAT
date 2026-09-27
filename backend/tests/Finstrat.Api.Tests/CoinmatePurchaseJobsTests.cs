using System.Net;
using System.Text;
using System.Text.Json;
using Finstrat.Api.Infrastructure.Persistence;
using Finstrat.Api.Modules.Bitcoin;
using Finstrat.Api.Modules.IncomePlan;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Npgsql;

namespace Finstrat.Api.Tests;

[Collection("identity-api")]
public sealed class CoinmatePurchaseJobsTests(IdentityApiFixture fixture)
{
    [Fact]
    public async Task Deposit_wait_is_durable_and_requires_the_full_increase_then_records_once()
    {
        using var client = fixture.CreateClient();
        await client.GetAsync("/api/identity/me");
        var (household, user, account) = await Account();
        var exchange = new FakeController();
        var key = Guid.NewGuid();
        using (var db = Context())
        {
            var jobs = Service(db, exchange);
            var waiting = await jobs.QueueAsync(household, user, key, new("1000", account, true), default);
            Assert.Equal("waiting_deposit", waiting.Status);
            exchange.Balance = 101;
            await jobs.ProcessAsync(default);
            Assert.Equal(0, exchange.BuyCalls);
            Assert.Null(await jobs.GetAsync(household, Guid.NewGuid(), key, default));
            await Assert.ThrowsAsync<IncomePlanValidationException>(() => jobs.QueueAsync(household, user, key, new("1001", account, true), default));
        }
        // A new service/context represents a restart; no browser calls trigger execution.
        using (var db = Context())
        {
            var jobs = Service(db, exchange);
            exchange.Balance = 1100;
            var replay = await jobs.QueueAsync(household, user, key, new("1000", account, true), default);
            Assert.Equal("waiting_deposit", replay.Status);
            await jobs.ProcessAsync(default);
            Assert.Equal(1, exchange.BuyCalls);
            Assert.Equal("buying", (await jobs.GetAsync(household, user, key, default))!.Status);
            exchange.Filled = true;
            await jobs.ProcessAsync(default);
            Assert.True((await jobs.GetAsync(household, user, key, default))!.Success);
            Assert.DoesNotContain(await jobs.ListAsync(household, user, default), j => j.Id == key);
        }
        await using var connection = new NpgsqlConnection(fixture.ConnectionString);
        await connection.OpenAsync();
        // Simulate a crash after the ledger commit, before the job completion marker.
        await using (var reset = new NpgsqlCommand("UPDATE coinmate_purchase_jobs SET completed_at=NULL, status='recording' WHERE id=@id", connection))
        {
            reset.Parameters.AddWithValue("id", key);
            await reset.ExecuteNonQueryAsync();
        }
        using (var db = Context()) await Service(db, exchange).ProcessAsync(default);
        await using var lots = new NpgsqlCommand("SELECT count(*), min(quantity_btc), min(unit_price_czk) FROM btc_lots WHERE account_id=@account", connection);
        lots.Parameters.AddWithValue("account", account);
        await using var reader = await lots.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync());
        Assert.Equal(1L, reader.GetInt64(0));
        Assert.Equal(.0005m, reader.GetDecimal(1));
        Assert.Equal(1999800m, reader.GetDecimal(2)); // actual CZK cost, not the 1000 CZK budget
    }

    [Fact]
    public async Task Direct_job_validates_account_and_is_only_visible_to_its_owner()
    {
        using var client = fixture.CreateClient(); await client.GetAsync("/api/identity/me");
        var (household, user, account) = await Account();
        using var db = Context(); var exchange = new FakeController(); var jobs = Service(db, exchange);
        await Assert.ThrowsAsync<IncomePlanValidationException>(() => jobs.QueueAsync(household, Guid.NewGuid(), Guid.NewGuid(), new("1000", account), default));
        await Assert.ThrowsAsync<IncomePlanValidationException>(() => jobs.QueueAsync(household, user, Guid.NewGuid(), new("25", account), default));
        var key = Guid.NewGuid();
        var job = await jobs.QueueAsync(household, user, key, new("1000", account), default);
        Assert.Equal("queued", job.Status);
        Assert.Equal(0, exchange.BalanceCalls);
        Assert.Contains(await jobs.ListAsync(household, user, default), j => j.Id == key);
        Assert.Empty(await jobs.ListAsync(household, Guid.NewGuid(), default));
        Assert.Null(await jobs.GetAsync(Guid.NewGuid(), user, key, default));
        exchange.Filled = true; await jobs.ProcessAsync(default);
        Assert.True((await jobs.GetAsync(household, user, key, default))!.Success);
    }

    private ApplicationDbContext Context() => new(new DbContextOptionsBuilder<ApplicationDbContext>().UseNpgsql(fixture.ConnectionString).Options);
    private static CoinmatePurchaseJobs Service(ApplicationDbContext db, FakeController exchange)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> {
            ["CoinmateController:ApiToken"]="test", ["CoinmateController:BaseUrl"]="https://controller.test/" }).Build();
        return new(db, new CoinmateBalanceWatchService(exchange, config), new BitcoinCommandService(db));
    }
    private async Task<(Guid,Guid,Guid)> Account()
    {
        await using var connection = new NpgsqlConnection(fixture.ConnectionString); await connection.OpenAsync();
        Guid household, user;
        await using (var query = new NpgsqlCommand("SELECT m.household_id,u.id FROM users u JOIN household_members m ON m.user_id=u.id WHERE u.is_default LIMIT 1",connection))
        await using (var reader = await query.ExecuteReaderAsync())
        {
            Assert.True(await reader.ReadAsync()); household=reader.GetGuid(0);user=reader.GetGuid(1);
        }
        await using (var archive = new NpgsqlCommand("UPDATE btc_accounts SET archived_at=now() WHERE household_id=@household AND lower(name)='coinmate' AND archived_at IS NULL",connection))
        { archive.Parameters.AddWithValue("household",household); await archive.ExecuteNonQueryAsync(); }
        var account=Guid.NewGuid();
        await using var insert=new NpgsqlCommand("INSERT INTO btc_accounts(id,household_id,owner_user_id,name) VALUES(@id,@household,@user,'Coinmate')",connection);
        insert.Parameters.AddWithValue("id",account);insert.Parameters.AddWithValue("household",household);insert.Parameters.AddWithValue("user",user);
        await insert.ExecuteNonQueryAsync(); return (household,user,account);
    }
    private sealed class FakeController : HttpMessageHandler, IHttpClientFactory
    {
        public decimal Balance=100;
        public bool Filled;
        public int BuyCalls;
        public int BalanceCalls;
        public HttpClient CreateClient(string name) => new(this,false);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellationToken)
        {
            string body;
            if(request.RequestUri!.AbsolutePath=="/funding_balance/czk") { BalanceCalls++;body=Balance.ToString(System.Globalization.CultureInfo.InvariantCulture); }
            else if (request.RequestUri.AbsolutePath=="/buy_bitcoin/requirements") body="""{"min_amount_czk":27.43,"min_amount_btc":0.000015,"max_amount_czk":10000}""";
            else
            {
                Assert.Equal("/buy_bitcoin",request.RequestUri.AbsolutePath);
                Assert.True(request.Headers.Contains("Idempotency-Key")); BuyCalls++;
                body=JsonSerializer.Serialize(new { success=Filled, pending=!Filled, status=Filled?"filled":"placed", btc_bought=Filled?.0005m:0m,
                    spent_czk=Filled?999.9m:0m, completed_at=Filled?(double?)DateTimeOffset.Parse("2026-08-01T12:00:00Z").ToUnixTimeSeconds():null });
            }
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(body,Encoding.UTF8,"application/json")});
        }
    }
}
