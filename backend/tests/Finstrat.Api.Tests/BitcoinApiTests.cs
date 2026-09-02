using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Npgsql;

namespace Finstrat.Api.Tests;

[Collection("identity-api")]
public sealed class BitcoinApiTests(IdentityApiFixture fixture)
{
    [Fact]
    public async Task Independent_latest_purchase_can_be_updated_and_deleted()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var token = await GetAntiforgeryToken(client);
        using var accountRequest = new HttpRequestMessage(HttpMethod.Post, "/api/bitcoin/accounts")
        {
            Content = JsonContent.Create(new { name = $"Editable movement {Guid.NewGuid():N}", description = (string?)null }),
        };
        accountRequest.Headers.Add("X-CSRF-TOKEN", token);
        var accountId = (await (await client.SendAsync(accountRequest)).Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        token = await GetAntiforgeryToken(client);
        var purchase = await SendCommand(client, token, "/api/bitcoin/purchases", new
        {
            accountId, quantityBtc = "0.10000000", unitPriceCzk = "1000000",
            acquiredAt = DateTimeOffset.UtcNow.ToString("O"), txid = (string?)null, note = "Original",
        });
        var movementId = (await purchase.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
        var movements = await client.GetFromJsonAsync<JsonElement>($"/api/bitcoin/accounts/{accountId}/movements");
        Assert.True(movements[0].GetProperty("canEdit").GetBoolean());

        token = await GetAntiforgeryToken(client);
        using var update = new HttpRequestMessage(HttpMethod.Put, $"/api/bitcoin/movements/{movementId}/purchase")
        {
            Content = JsonContent.Create(new { quantityBtc = "0.20000000", unitPriceCzk = "1100000", acquiredAt = DateTimeOffset.UtcNow.ToString("O"), txid = (string?)null, note = "Updated" }),
        };
        update.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(update)).StatusCode);

        await using (var connection = new NpgsqlConnection(fixture.ConnectionString))
        {
            await connection.OpenAsync();
            await using var checkpoint = new NpgsqlCommand("""
                INSERT INTO btc_strategy_states (household_id, owner_user_id, checkpoint_base_czk, activated_at)
                SELECT household_id, owner_user_id, 220000, now() + interval '1 second'
                FROM btc_accounts WHERE id = @account_id
                ON CONFLICT (household_id, owner_user_id) DO UPDATE SET
                  checkpoint_base_czk = EXCLUDED.checkpoint_base_czk,
                  activated_at = EXCLUDED.activated_at
                """, connection);
            checkpoint.Parameters.AddWithValue("account_id", accountId);
            await checkpoint.ExecuteNonQueryAsync();
        }

        token = await GetAntiforgeryToken(client);
        using var delete = new HttpRequestMessage(HttpMethod.Delete, $"/api/bitcoin/movements/{movementId}/purchase");
        delete.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(delete)).StatusCode);
        Assert.Empty((await client.GetFromJsonAsync<JsonElement>($"/api/bitcoin/accounts/{accountId}/movements")).EnumerateArray());
        await using (var connection = new NpgsqlConnection(fixture.ConnectionString))
        {
            await connection.OpenAsync();
            await using var checkpoint = new NpgsqlCommand("SELECT COUNT(*) FROM btc_strategy_states state JOIN btc_accounts account ON account.household_id = state.household_id AND account.owner_user_id = state.owner_user_id WHERE account.id = @account_id", connection);
            checkpoint.Parameters.AddWithValue("account_id", accountId);
            Assert.Equal(0L, (long)(await checkpoint.ExecuteScalarAsync())!);
        }
    }

    [Fact]
    public async Task Owner_can_create_a_bitcoin_account()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            HandleCookies = true,
        });
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/bitcoin/accounts")
        {
            Content = JsonContent.Create(new
            {
                name = $"Ledger-{Guid.NewGuid():N}",
                description = "Integration account",
            }),
        };
        request.Headers.Add("X-CSRF-TOKEN", await GetAntiforgeryToken(client));

        var response = await client.SendAsync(request);
        var payload = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.Equal("Integration account", payload.GetProperty("description").GetString());
    }

    [Fact]
    public async Task Owner_can_rename_and_soft_delete_a_bitcoin_account()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            HandleCookies = true,
        });
        var originalName = $"Editable-{Guid.NewGuid():N}";
        var renamedName = $"Renamed-{Guid.NewGuid():N}";
        var token = await GetAntiforgeryToken(client);
        using var create = new HttpRequestMessage(HttpMethod.Post, "/api/bitcoin/accounts")
        {
            Content = JsonContent.Create(new { name = originalName, description = (string?)null }),
        };
        create.Headers.Add("X-CSRF-TOKEN", token);
        var created = await client.SendAsync(create);
        var accountId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();

        token = await GetAntiforgeryToken(client);
        using var rename = new HttpRequestMessage(HttpMethod.Put, $"/api/bitcoin/accounts/{accountId}")
        {
            Content = JsonContent.Create(new { name = renamedName }),
        };
        rename.Headers.Add("X-CSRF-TOKEN", token);
        var renamed = await client.SendAsync(rename);
        Assert.Equal(HttpStatusCode.OK, renamed.StatusCode);
        Assert.Equal(renamedName, (await renamed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("name").GetString());

        token = await GetAntiforgeryToken(client);
        using var archive = new HttpRequestMessage(HttpMethod.Delete, $"/api/bitcoin/accounts/{accountId}");
        archive.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(archive)).StatusCode);

        var overview = await client.GetFromJsonAsync<JsonElement>("/api/bitcoin/overview");
        Assert.DoesNotContain(overview.GetProperty("accounts").EnumerateArray(),
            account => account.GetProperty("id").GetGuid() == accountId);

        await using var connection = new NpgsqlConnection(fixture.ConnectionString);
        await connection.OpenAsync();
        await using var verify = new NpgsqlCommand(
            "SELECT name, archived_at IS NOT NULL FROM btc_accounts WHERE id = @account_id", connection);
        verify.Parameters.AddWithValue("account_id", accountId);
        await using var reader = await verify.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync());
        Assert.Equal(renamedName, reader.GetString(0));
        Assert.True(reader.GetBoolean(1));
    }

    [Fact]
    public async Task Overview_returns_only_accounts_accessible_to_current_user()
    {
        var ownAccountId = Guid.NewGuid();
        var hiddenAccountId = Guid.NewGuid();
        await using (var connection = new NpgsqlConnection(fixture.ConnectionString))
        {
            await connection.OpenAsync();
            await using var command = new NpgsqlCommand("""
                WITH context AS (
                  SELECT h.id AS household_id, u.id AS default_user_id
                  FROM households h CROSS JOIN users u
                  WHERE u.is_default
                  ORDER BY h.created_at
                  LIMIT 1
                ), other_user AS (
                  INSERT INTO users (
                    id, user_name, normalized_user_name, display_name,
                    security_stamp, concurrency_stamp
                  ) VALUES (
                    gen_random_uuid(), @other_name, upper(@other_name), 'Other user',
                    gen_random_uuid()::text, gen_random_uuid()::text
                  ) RETURNING id
                ), other_member AS (
                  INSERT INTO household_members (household_id, user_id, role)
                  SELECT context.household_id, other_user.id, 'owner'
                  FROM context, other_user
                ), own_account AS (
                  INSERT INTO btc_accounts (id, household_id, owner_user_id, name)
                  SELECT @own_account_id, context.household_id, context.default_user_id, @own_name
                  FROM context
                ), hidden_account AS (
                  INSERT INTO btc_accounts (id, household_id, owner_user_id, name)
                  SELECT @hidden_account_id, context.household_id, other_user.id, @hidden_name
                  FROM context, other_user
                )
                INSERT INTO btc_lots (
                  household_id, account_id, quantity_btc, unit_price_czk,
                  acquired_at, tax_acquired_at, note
                )
                SELECT context.household_id, @own_account_id, 1.25000000, 1000000.00,
                  now(), now(), 'Visible lot'
                FROM context;

                INSERT INTO btc_lots (
                  household_id, account_id, quantity_btc, unit_price_czk,
                  acquired_at, tax_acquired_at, note
                )
                SELECT household_id, @hidden_account_id, 9.00000000, 1000000.00,
                  now(), now(), 'Hidden lot'
                FROM btc_accounts WHERE id = @hidden_account_id;
                """, connection);
            command.Parameters.AddWithValue("other_name", $"other-{Guid.NewGuid():N}");
            command.Parameters.AddWithValue("own_account_id", ownAccountId);
            command.Parameters.AddWithValue("hidden_account_id", hiddenAccountId);
            command.Parameters.AddWithValue("own_name", $"Visible-{Guid.NewGuid():N}");
            command.Parameters.AddWithValue("hidden_name", $"Hidden-{Guid.NewGuid():N}");
            await command.ExecuteNonQueryAsync();
        }

        using var client = fixture.CreateClient();
        var response = await client.GetAsync("/api/bitcoin/overview");
        var payload = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var accounts = payload.GetProperty("accounts").EnumerateArray().ToArray();
        Assert.Contains(accounts, account => account.GetProperty("id").GetGuid() == ownAccountId
            && account.GetProperty("quantityBtc").GetDecimal() == 1.25m);
        Assert.DoesNotContain(accounts, account => account.GetProperty("id").GetGuid() == hiddenAccountId);
        Assert.Contains(payload.GetProperty("recentMovements").EnumerateArray(),
            movement => movement.GetProperty("accountId").GetGuid() == ownAccountId);
        var accountMovements = await client.GetFromJsonAsync<JsonElement>($"/api/bitcoin/accounts/{ownAccountId}/movements");
        Assert.Contains(accountMovements.EnumerateArray(),
            movement => movement.GetProperty("accountId").GetGuid() == ownAccountId
                && movement.GetProperty("type").GetString() == "purchase");
    }

    [Fact]
    public async Task Transfer_is_atomic_allocates_fifo_and_replays_idempotently()
    {
        var sourceAccountId = Guid.NewGuid();
        var destinationAccountId = Guid.NewGuid();
        await using (var connection = new NpgsqlConnection(fixture.ConnectionString))
        {
            await connection.OpenAsync();
            await using var command = new NpgsqlCommand("""
                WITH context AS (
                  SELECT h.id AS household_id, u.id AS user_id
                  FROM households h CROSS JOIN users u
                  WHERE u.is_default ORDER BY h.created_at LIMIT 1
                ), accounts AS (
                  INSERT INTO btc_accounts (id, household_id, owner_user_id, name)
                  SELECT @source_id, household_id, user_id, @source_name FROM context
                  UNION ALL
                  SELECT @destination_id, household_id, user_id, @destination_name FROM context
                )
                INSERT INTO btc_lots (
                  household_id, account_id, quantity_btc, unit_price_czk,
                  acquired_at, tax_acquired_at
                )
                SELECT household_id, @source_id, 1.00000000, 1000000.00,
                  now() - interval '1 minute', now() - interval '1 minute'
                FROM context;
                """, connection);
            command.Parameters.AddWithValue("source_id", sourceAccountId);
            command.Parameters.AddWithValue("destination_id", destinationAccountId);
            command.Parameters.AddWithValue("source_name", $"Source-{Guid.NewGuid():N}");
            command.Parameters.AddWithValue("destination_name", $"Destination-{Guid.NewGuid():N}");
            await command.ExecuteNonQueryAsync();
        }

        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            HandleCookies = true,
        });
        var token = await GetAntiforgeryToken(client);
        var idempotencyKey = Guid.NewGuid();
        var body = new
        {
            fromAccountId = sourceAccountId,
            toAccountId = destinationAccountId,
            grossQuantityBtc = "0.50000000",
            feeQuantityBtc = "0.01000000",
            transferredAt = DateTimeOffset.UtcNow.ToString("O"),
            txid = (string?)null,
            note = "Cold storage move",
        };

        var first = await SendTransfer(client, token, idempotencyKey, body);
        var firstPayload = await first.Content.ReadFromJsonAsync<JsonElement>();
        var second = await SendTransfer(client, token, idempotencyKey, body);
        var secondPayload = await second.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(firstPayload.GetProperty("id").GetGuid(), secondPayload.GetProperty("id").GetGuid());
        Assert.Equal(0.49m, firstPayload.GetProperty("netQuantityBtc").GetDecimal());
        var sourceMovements = await client.GetFromJsonAsync<JsonElement>($"/api/bitcoin/accounts/{sourceAccountId}/movements");
        var linkedPurchase = sourceMovements.EnumerateArray().Single(item => item.GetProperty("type").GetString() == "purchase");
        Assert.False(linkedPurchase.GetProperty("canEdit").GetBoolean());
        token = await GetAntiforgeryToken(client);
        using var forbiddenDelete = new HttpRequestMessage(HttpMethod.Delete, $"/api/bitcoin/movements/{linkedPurchase.GetProperty("id").GetGuid()}/purchase");
        forbiddenDelete.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(forbiddenDelete)).StatusCode);

        await using var verifyConnection = new NpgsqlConnection(fixture.ConnectionString);
        await verifyConnection.OpenAsync();
        await using var verify = new NpgsqlCommand("""
            SELECT
              (SELECT COUNT(*) FROM btc_transfers WHERE id = @transfer_id),
              (SELECT SUM(quantity_btc) FROM btc_lot_allocations WHERE disposal_id = (
                SELECT id FROM btc_disposals WHERE transfer_id = @transfer_id
              )),
              (SELECT SUM(quantity_btc) FROM btc_lots WHERE source_transfer_id = @transfer_id)
            """, verifyConnection);
        verify.Parameters.AddWithValue("transfer_id", firstPayload.GetProperty("id").GetGuid());
        await using var reader = await verify.ExecuteReaderAsync();
        Assert.True(await reader.ReadAsync());
        Assert.Equal(1, reader.GetInt64(0));
        Assert.Equal(0.5m, reader.GetDecimal(1));
        Assert.Equal(0.49m, reader.GetDecimal(2));
    }

    [Fact]
    public async Task Owner_can_record_purchase_and_fifo_withdrawal()
    {
        Guid checkpointId;
        await using (var checkpointConnection = new NpgsqlConnection(fixture.ConnectionString))
        {
            await checkpointConnection.OpenAsync();
            await using var checkpointCommand = new NpgsqlCommand("""
                INSERT INTO strategy_checkpoints (
                  household_id, base_value_czk, activated_at, calculation_version
                )
                SELECT id, 100000, now(), 'integration-v1' FROM households
                WHERE NOT EXISTS (
                  SELECT 1 FROM strategy_checkpoints checkpoint
                  WHERE checkpoint.household_id = households.id AND checkpoint.status = 'active'
                )
                RETURNING id
                """, checkpointConnection);
            checkpointId = (Guid)(await checkpointCommand.ExecuteScalarAsync()
                ?? throw new InvalidOperationException("Integration checkpoint was not created."));
        }
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            HandleCookies = true,
        });
        var token = await GetAntiforgeryToken(client);
        using var accountRequest = new HttpRequestMessage(HttpMethod.Post, "/api/bitcoin/accounts")
        {
            Content = JsonContent.Create(new { name = $"Trading-{Guid.NewGuid():N}", description = (string?)null }),
        };
        accountRequest.Headers.Add("X-CSRF-TOKEN", token);
        var accountResponse = await client.SendAsync(accountRequest);
        var account = await accountResponse.Content.ReadFromJsonAsync<JsonElement>();
        var accountId = account.GetProperty("id").GetGuid();

        token = await GetAntiforgeryToken(client);
        var purchaseAt = DateTimeOffset.UtcNow.AddSeconds(-1);
        var purchase = await SendCommand(client, token, "/api/bitcoin/purchases", new
        {
            accountId,
            quantityBtc = "0.50000000",
            unitPriceCzk = "1500000.00",
            acquiredAt = purchaseAt.ToString("O"),
            txid = (string?)null,
            note = "Integration purchase",
        });
        Assert.Equal(HttpStatusCode.Created, purchase.StatusCode);

        token = await GetAntiforgeryToken(client);
        var withdrawal = await SendCommand(client, token, "/api/bitcoin/withdrawals", new
        {
            accountId,
            quantityBtc = "0.20000000",
            unitPriceCzk = "1600000.00",
            withdrawnAt = DateTimeOffset.UtcNow.ToString("O"),
            txid = (string?)null,
            note = "Integration withdrawal",
        });
        Assert.Equal(HttpStatusCode.Created, withdrawal.StatusCode);

        token = await GetAntiforgeryToken(client);
        var lifeExpense = await SendCommand(client, token, "/api/bitcoin/withdrawals", new
        {
            accountId,
            quantityBtc = "0.10000000",
            unitPriceCzk = "1600000.00",
            withdrawnAt = DateTimeOffset.UtcNow.AddMilliseconds(10).ToString("O"),
            txid = (string?)null,
            note = "Car expense",
            purpose = "life_expense",
            lifeExpenseCategory = "auto",
        });
        Assert.Equal(HttpStatusCode.Created, lifeExpense.StatusCode);

        var overview = await client.GetFromJsonAsync<JsonElement>("/api/bitcoin/overview");
        var result = overview.GetProperty("accounts").EnumerateArray()
            .Single(item => item.GetProperty("id").GetGuid() == accountId);
        Assert.Equal(0.2m, result.GetProperty("quantityBtc").GetDecimal());

        await using var verifyConnection = new NpgsqlConnection(fixture.ConnectionString);
        await verifyConnection.OpenAsync();
        await using var verify = new NpgsqlCommand("""
            SELECT COALESCE(SUM(adjustment_czk), 0)
            FROM checkpoint_adjustments WHERE checkpoint_id = @checkpoint_id
            """, verifyConnection);
        verify.Parameters.AddWithValue("checkpoint_id", checkpointId);
        Assert.Equal(590000m, (decimal)(await verify.ExecuteScalarAsync())!);
    }

    [Fact]
    public async Task Non_default_owner_can_share_account_with_default_user()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            HandleCookies = true,
        });
        var userName = $"sharing-{Guid.NewGuid():N}";
        var token = await GetAntiforgeryToken(client);
        using var createUser = new HttpRequestMessage(HttpMethod.Post, "/api/identity/users")
        {
            Content = JsonContent.Create(new
            {
                userName,
                displayName = "Sharing Owner",
                email = (string?)null,
                password = "Sample324",
                role = "owner",
            }),
        };
        createUser.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.Created, (await client.SendAsync(createUser)).StatusCode);

        token = await GetAntiforgeryToken(client);
        using var login = new HttpRequestMessage(HttpMethod.Post, "/api/identity/login")
        {
            Content = JsonContent.Create(new { identifier = userName, password = "Sample324" }),
        };
        login.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(login)).StatusCode);

        token = await GetAntiforgeryToken(client);
        using var createAccount = new HttpRequestMessage(HttpMethod.Post, "/api/bitcoin/accounts")
        {
            Content = JsonContent.Create(new { name = $"Shared-{Guid.NewGuid():N}", description = (string?)null }),
        };
        createAccount.Headers.Add("X-CSRF-TOKEN", token);
        var accountResponse = await client.SendAsync(createAccount);
        var account = await accountResponse.Content.ReadFromJsonAsync<JsonElement>();
        var accountId = account.GetProperty("id").GetGuid();

        token = await GetAntiforgeryToken(client);
        using var share = new HttpRequestMessage(HttpMethod.Put, $"/api/bitcoin/accounts/{accountId}/default-share")
        {
            Content = JsonContent.Create(new { shared = true }),
        };
        share.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(share)).StatusCode);

        token = await GetAntiforgeryToken(client);
        using var logout = new HttpRequestMessage(HttpMethod.Post, "/api/identity/logout");
        logout.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(logout)).StatusCode);

        var overview = await client.GetFromJsonAsync<JsonElement>("/api/bitcoin/overview");
        Assert.Contains(overview.GetProperty("accounts").EnumerateArray(),
            item => item.GetProperty("id").GetGuid() == accountId
                && item.GetProperty("ownerDisplayName").GetString() == "Sharing Owner");

        token = await GetAntiforgeryToken(client);
        var purchaseAt = DateTimeOffset.UtcNow.AddSeconds(-1);
        Assert.Equal(HttpStatusCode.Created, (await SendCommand(client, token, "/api/bitcoin/purchases", new
        {
            accountId,
            quantityBtc = "0.10000000",
            unitPriceCzk = "1500000.00",
            acquiredAt = purchaseAt.ToString("O"),
            txid = (string?)null,
            note = "Default managed purchase",
        })).StatusCode);

        token = await GetAntiforgeryToken(client);
        Assert.Equal(HttpStatusCode.Created, (await SendCommand(client, token, "/api/bitcoin/withdrawals", new
        {
            accountId,
            quantityBtc = "0.05000000",
            unitPriceCzk = "1500000.00",
            withdrawnAt = DateTimeOffset.UtcNow.ToString("O"),
            txid = (string?)null,
            note = "Default managed withdrawal",
            purpose = "standalone",
            lifeExpenseCategory = (string?)null,
        })).StatusCode);

        token = await GetAntiforgeryToken(client);
        using var proofRequest = new HttpRequestMessage(HttpMethod.Post, $"/api/bitcoin/accounts/{accountId}/proofs")
        {
            Content = JsonContent.Create(new
            {
                content = "Default user can manage this explicitly shared account.",
                anchorTxid = (string?)null,
                anchoredAt = (string?)null,
                note = "Shared proof",
            }),
        };
        proofRequest.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.Created, (await client.SendAsync(proofRequest)).StatusCode);
    }

    [Fact]
    public async Task Anchored_proof_is_immutable_but_can_be_archived()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            HandleCookies = true,
        });
        var token = await GetAntiforgeryToken(client);
        using var accountRequest = new HttpRequestMessage(HttpMethod.Post, "/api/bitcoin/accounts")
        {
            Content = JsonContent.Create(new { name = $"Proof-{Guid.NewGuid():N}", description = (string?)null }),
        };
        accountRequest.Headers.Add("X-CSRF-TOKEN", token);
        var accountResponse = await client.SendAsync(accountRequest);
        var account = await accountResponse.Content.ReadFromJsonAsync<JsonElement>();
        var accountId = account.GetProperty("id").GetGuid();

        token = await GetAntiforgeryToken(client);
        using var create = new HttpRequestMessage(HttpMethod.Post, $"/api/bitcoin/accounts/{accountId}/proofs")
        {
            Content = JsonContent.Create(new
            {
                content = "I control this Bitcoin address.",
                anchorTxid = (string?)null,
                anchoredAt = (string?)null,
                note = "Initial proof",
            }),
        };
        create.Headers.Add("X-CSRF-TOKEN", token);
        var createResponse = await client.SendAsync(create);
        Assert.Equal(HttpStatusCode.Created, createResponse.StatusCode);
        var proof = await createResponse.Content.ReadFromJsonAsync<JsonElement>();
        var proofId = proof.GetProperty("id").GetGuid();

        var anchoredBody = new
        {
            content = "I control this Bitcoin address.",
            anchorTxid = new string('a', 64),
            anchoredAt = DateTimeOffset.UtcNow.AddMinutes(-1).ToString("O"),
            note = "Initial proof",
        };
        token = await GetAntiforgeryToken(client);
        using var anchor = new HttpRequestMessage(HttpMethod.Put, $"/api/bitcoin/proofs/{proofId}")
        {
            Content = JsonContent.Create(anchoredBody),
        };
        anchor.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(anchor)).StatusCode);

        token = await GetAntiforgeryToken(client);
        using var forbiddenEdit = new HttpRequestMessage(HttpMethod.Put, $"/api/bitcoin/proofs/{proofId}")
        {
            Content = JsonContent.Create(new
            {
                anchoredBody.content,
                anchoredBody.anchorTxid,
                anchoredBody.anchoredAt,
                note = "Changed note",
            }),
        };
        forbiddenEdit.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.SendAsync(forbiddenEdit)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync($"/api/bitcoin/proofs/{proofId}/content")).StatusCode);

        token = await GetAntiforgeryToken(client);
        using var archive = new HttpRequestMessage(HttpMethod.Post, $"/api/bitcoin/proofs/{proofId}/archive");
        archive.Headers.Add("X-CSRF-TOKEN", token);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(archive)).StatusCode);
        var activeProofs = await client.GetFromJsonAsync<JsonElement>($"/api/bitcoin/accounts/{accountId}/proofs");
        Assert.Empty(activeProofs.EnumerateArray());
    }

    private static async Task<string> GetAntiforgeryToken(HttpClient client)
    {
        var response = await client.GetFromJsonAsync<JsonElement>("/api/identity/antiforgery");
        return response.GetProperty("token").GetString()!;
    }

    private static Task<HttpResponseMessage> SendTransfer(
        HttpClient client,
        string token,
        Guid idempotencyKey,
        object body)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/bitcoin/transfers")
        {
            Content = JsonContent.Create(body),
        };
        request.Headers.Add("X-CSRF-TOKEN", token);
        request.Headers.Add("Idempotency-Key", idempotencyKey.ToString());
        return client.SendAsync(request);
    }

    private static Task<HttpResponseMessage> SendCommand(
        HttpClient client,
        string token,
        string path,
        object body)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, path) { Content = JsonContent.Create(body) };
        request.Headers.Add("X-CSRF-TOKEN", token);
        request.Headers.Add("Idempotency-Key", Guid.NewGuid().ToString());
        return client.SendAsync(request);
    }
}
