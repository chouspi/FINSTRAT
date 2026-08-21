using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Npgsql;
using Testcontainers.PostgreSql;

namespace Finstrat.Api.Tests;

public sealed class IdentityApiFixture : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly PostgreSqlContainer _postgres = new PostgreSqlBuilder("postgres:17-alpine").Build();

    public async Task InitializeAsync()
    {
        await _postgres.StartAsync();
        await ApplyMigrationsAsync();
    }

    public new async Task DisposeAsync()
    {
        await base.DisposeAsync();
        await _postgres.DisposeAsync();
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");
        builder.UseSetting("ConnectionStrings:Database", _postgres.GetConnectionString());
        builder.ConfigureAppConfiguration((_, configuration) =>
        {
            configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:Database"] = _postgres.GetConnectionString(),
            });
        });
    }

    private async Task ApplyMigrationsAsync()
    {
        var root = FindRepositoryRoot();
        var files = Directory.GetFiles(Path.Combine(root, "database", "migrations"), "*.sql")
            .Order(StringComparer.Ordinal);
        await using var connection = new NpgsqlConnection(_postgres.GetConnectionString());
        await connection.OpenAsync();
        foreach (var file in files)
        {
            await using var command = new NpgsqlCommand(await File.ReadAllTextAsync(file), connection);
            await command.ExecuteNonQueryAsync();
        }
    }

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "database", "migrations")))
        {
            directory = directory.Parent;
        }
        return directory?.FullName ?? throw new DirectoryNotFoundException("Repository root not found.");
    }
}

[CollectionDefinition("identity-api")]
public sealed class IdentityApiCollection : ICollectionFixture<IdentityApiFixture>;

[Collection("identity-api")]
public sealed class IdentityApiTests(IdentityApiFixture fixture)
{
    [Fact]
    public async Task Anonymous_request_uses_default_identity()
    {
        using var client = fixture.CreateClient();

        var response = await client.GetAsync("/api/identity/me");
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var payload = await response.Content.ReadFromJsonAsync<JsonElement>();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("default", payload.GetProperty("userName").GetString());
        Assert.True(payload.GetProperty("isDefault").GetBoolean());
        Assert.Equal("owner", payload.GetProperty("role").GetString());
    }

    [Fact]
    public async Task State_change_requires_antiforgery_token()
    {
        using var client = fixture.CreateClient();

        var response = await client.PostAsJsonAsync("/api/identity/login", new
        {
            identifier = "someone",
            password = "NotRelevant123!",
        });

        Assert.True(response.StatusCode == HttpStatusCode.BadRequest, await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Owner_can_create_and_login_as_additional_user()
    {
        using var client = fixture.CreateClient(new WebApplicationFactoryClientOptions
        {
            HandleCookies = true,
        });
        var token = await GetAntiforgeryToken(client);
        using var createRequest = new HttpRequestMessage(HttpMethod.Post, "/api/identity/users")
        {
            Content = JsonContent.Create(new
            {
                userName = "private-owner",
                displayName = "Private Owner",
                email = "owner@example.test",
                password = "Sample324",
                role = "owner",
            }),
        };
        createRequest.Headers.Add("X-CSRF-TOKEN", token);

        var createResponse = await client.SendAsync(createRequest);
        Assert.Equal(HttpStatusCode.Created, createResponse.StatusCode);

        token = await GetAntiforgeryToken(client);
        using var loginRequest = new HttpRequestMessage(HttpMethod.Post, "/api/identity/login")
        {
            Content = JsonContent.Create(new
            {
                identifier = "private-owner",
                password = "Sample324",
            }),
        };
        loginRequest.Headers.Add("X-CSRF-TOKEN", token);
        var loginResponse = await client.SendAsync(loginRequest);
        Assert.Equal(HttpStatusCode.NoContent, loginResponse.StatusCode);

        var current = await client.GetFromJsonAsync<JsonElement>("/api/identity/me");
        Assert.Equal("private-owner", current.GetProperty("userName").GetString());
        Assert.False(current.GetProperty("isDefault").GetBoolean());
    }

    private static async Task<string> GetAntiforgeryToken(HttpClient client)
    {
        var response = await client.GetFromJsonAsync<JsonElement>("/api/identity/antiforgery");
        return response.GetProperty("token").GetString()!;
    }
}
