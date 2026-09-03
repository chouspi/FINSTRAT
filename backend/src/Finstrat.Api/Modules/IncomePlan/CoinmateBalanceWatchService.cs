using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Finstrat.Api.Modules.IncomePlan;

public sealed class CoinmateBalanceWatchService(
    IHttpClientFactory clients,
    IConfiguration configuration)
{
    private const string DefaultBaseUrl = "http://coinmate-controller:8080/";
    private static readonly TimeSpan StandardTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan WatchTimeout = TimeSpan.FromSeconds(40);

    public async Task<CoinmateBalanceWatchStartedResponse> StartAsync(CancellationToken cancellationToken)
    {
        var response = await SendAsync<StartResponse>(
            HttpMethod.Post, "balance_watch/czk", StandardTimeout, cancellationToken);
        return new(response.WatchId, response.Currency, response.InitialBalance, response.ExpiresInSeconds);
    }

    public async Task<CoinmateBalanceWatchPingResponse> PingAsync(
        Guid watchId,
        CancellationToken cancellationToken)
    {
        var response = await SendAsync<PingResponse>(
            HttpMethod.Post, $"balance_watch/{watchId:D}/ping", StandardTimeout, cancellationToken);
        return new(response.WatchId, response.ExpiresInSeconds);
    }

    public async Task<CoinmateBalanceWatchResponse> WatchAsync(
        Guid watchId,
        CancellationToken cancellationToken)
    {
        var response = await SendAsync<WatchResponse>(
            HttpMethod.Get, $"balance_watch/{watchId:D}", WatchTimeout, cancellationToken);
        return new(response.Changed, response.Currency, response.Balance);
    }

    public async Task<CoinmateBitcoinPurchaseResponse> PurchaseBitcoinAsync(
        decimal amount,
        Guid idempotencyKey,
        CancellationToken cancellationToken)
    {
        var response = await SendAsync<PurchaseResponse>(
            HttpMethod.Post,
            "buy_bitcoin",
            StandardTimeout,
            cancellationToken,
            JsonContent.Create(new PurchaseRequest(amount)),
            idempotencyKey);
        return MapPurchase(response);
    }

    public async Task<CoinmateBitcoinPurchaseResponse> GetBitcoinPurchaseAsync(
        Guid idempotencyKey,
        CancellationToken cancellationToken)
    {
        var response = await SendAsync<PurchaseResponse>(
            HttpMethod.Get,
            $"buy_bitcoin/{idempotencyKey:D}",
            StandardTimeout,
            cancellationToken);
        return MapPurchase(response);
    }

    private async Task<T> SendAsync<T>(
        HttpMethod method,
        string path,
        TimeSpan timeout,
        CancellationToken cancellationToken,
        HttpContent? content = null,
        Guid? idempotencyKey = null)
    {
        var token = configuration["CoinmateController:ApiToken"];
        var configuredBaseUrl = configuration["CoinmateController:BaseUrl"];
        var baseUrl = string.IsNullOrWhiteSpace(configuredBaseUrl) ? DefaultBaseUrl : configuredBaseUrl;
        if (!baseUrl.EndsWith('/')) baseUrl += '/';
        if (string.IsNullOrWhiteSpace(token)
            || !Uri.TryCreate(baseUrl, UriKind.Absolute, out var baseUri)
            || baseUri.Scheme is not ("http" or "https"))
        {
            throw new CoinmateBalanceWatchUnavailableException();
        }

        using var request = new HttpRequestMessage(method, new Uri(baseUri, path));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Content = content;
        if (idempotencyKey.HasValue)
        {
            request.Headers.Add("Idempotency-Key", idempotencyKey.Value.ToString("D"));
        }
        using var timeoutSource = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutSource.CancelAfter(timeout);

        try
        {
            using var response = await clients.CreateClient("coinmate-controller")
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeoutSource.Token);
            if (response.StatusCode == HttpStatusCode.NotFound)
            {
                throw new CoinmateBalanceWatchNotFoundException();
            }

            if (!response.IsSuccessStatusCode)
            {
                throw new CoinmateBalanceWatchUnavailableException();
            }

            var result = await response.Content.ReadFromJsonAsync<T>(cancellationToken: timeoutSource.Token);
            return result ?? throw new CoinmateBalanceWatchUnavailableException();
        }
        catch (CoinmateBalanceWatchNotFoundException)
        {
            throw;
        }
        catch (CoinmateBalanceWatchUnavailableException)
        {
            throw;
        }
        catch (Exception exception) when (
            exception is HttpRequestException or JsonException
            || exception is OperationCanceledException && !cancellationToken.IsCancellationRequested)
        {
            throw new CoinmateBalanceWatchUnavailableException();
        }
    }

    private static CoinmateBitcoinPurchaseResponse MapPurchase(PurchaseResponse response)
    {
        if (response.Success is null || response.BtcBought is null
            || response.Status is null || response.Pending is null)
        {
            throw new CoinmateBalanceWatchUnavailableException();
        }

        return new(response.Success.Value, response.BtcBought.Value, response.Status, response.Pending.Value);
    }

    private sealed record StartResponse(
        [property: JsonPropertyName("watch_id")] Guid WatchId,
        [property: JsonPropertyName("currency")] string Currency,
        [property: JsonPropertyName("initial_balance")] decimal InitialBalance,
        [property: JsonPropertyName("expires_in_seconds")] double ExpiresInSeconds);

    private sealed record PingResponse(
        [property: JsonPropertyName("watch_id")] Guid WatchId,
        [property: JsonPropertyName("expires_in_seconds")] double ExpiresInSeconds);

    private sealed record WatchResponse(
        [property: JsonPropertyName("changed")] bool Changed,
        [property: JsonPropertyName("currency")] string Currency,
        [property: JsonPropertyName("balance")] decimal Balance);

    private sealed record PurchaseRequest(
        [property: JsonPropertyName("amount")] decimal Amount);

    private sealed record PurchaseResponse(
        [property: JsonPropertyName("success")] bool? Success,
        [property: JsonPropertyName("btc_bought")] decimal? BtcBought,
        [property: JsonPropertyName("status")] string? Status,
        [property: JsonPropertyName("pending")] bool? Pending);
}

public sealed record CoinmateBalanceWatchStartedResponse(
    Guid WatchId,
    string Currency,
    decimal InitialBalance,
    double ExpiresInSeconds);

public sealed record CoinmateBalanceWatchPingResponse(Guid WatchId, double ExpiresInSeconds);

public sealed record CoinmateBalanceWatchResponse(bool Changed, string Currency, decimal Balance);

public sealed record CoinmateBitcoinPurchaseResponse(
    bool Success,
    decimal BtcBought,
    string Status,
    bool Pending);

public sealed class CoinmateBalanceWatchUnavailableException : Exception;

public sealed class CoinmateBalanceWatchNotFoundException : Exception;
