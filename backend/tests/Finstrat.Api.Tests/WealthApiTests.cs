using System.Net.Http.Json;
using System.Text.Json;

namespace Finstrat.Api.Tests;

[Collection("identity-api")]
public sealed class WealthApiTests(IdentityApiFixture fixture)
{
    [Fact]
    public async Task Daily_snapshot_persists_components_and_tracks_assets_minus_consumer_debt()
    {
        using var client = fixture.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions { HandleCookies = true });
        var response = await client.GetAsync("/api/wealth/history?days=30");
        response.EnsureSuccessStatusCode();
        var history = await response.Content.ReadFromJsonAsync<JsonElement>();
        var current = history.GetProperty("current");

        Assert.NotEqual(JsonValueKind.Null, current.ValueKind);
        Assert.Equal(
            current.GetProperty("btcValueCzk").GetDecimal()
            + current.GetProperty("vwceValueCzk").GetDecimal(),
            current.GetProperty("grossAssetsCzk").GetDecimal());
        Assert.Equal(
            current.GetProperty("grossAssetsCzk").GetDecimal()
            - current.GetProperty("consumerDebtCzk").GetDecimal(),
            current.GetProperty("trackedNetWorthCzk").GetDecimal());
        Assert.NotEmpty(history.GetProperty("points").EnumerateArray());
    }
}
