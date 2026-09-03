using System.Security.Claims;
using System.Globalization;
using Finstrat.Api.Modules.Identity;
using Finstrat.Api.Modules.Identity.Domain;
using Microsoft.AspNetCore.Identity;

namespace Finstrat.Api.Modules.IncomePlan;

public static class IncomePlanEndpoints
{
    public static IEndpointRouteBuilder MapIncomePlanEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/income-plan").WithTags("Income plan").RequireAuthorization();
        group.MapGet("/overview", async (ClaimsPrincipal principal, UserManager<ApplicationUser> users,
            IncomePlanService service, CancellationToken cancellationToken) =>
        {
            var (household, user) = Context(principal, users);
            return Results.Ok(await service.GetOverviewAsync(household, user, cancellationToken));
        });
        group.MapPut("/settings", async (UpdateIncomePlanSettingsRequest request,
            ClaimsPrincipal principal, UserManager<ApplicationUser> users,
            IncomePlanService service, CancellationToken cancellationToken) =>
        {
            try
            {
                var (household, user) = Context(principal, users);
                return Results.Ok(await service.UpdateAsync(household, user, request, cancellationToken));
            }
            catch (IncomePlanValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["incomePlan"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        group.MapPost("/deferred-debt-payment", async (AdjustDeferredDebtPaymentRequest request,
            ClaimsPrincipal principal, UserManager<ApplicationUser> users,
            IncomePlanService service, CancellationToken cancellationToken) =>
        {
            try { var (household, user) = Context(principal, users); return Results.Ok(await service.AdjustDeferredDebtPaymentAsync(household, user, request, true, cancellationToken)); }
            catch (IncomePlanValidationException exception) { return Results.ValidationProblem(new Dictionary<string, string[]> { ["incomePlan"] = [exception.Message] }); }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        group.MapPost("/deferred-debt-payment/consume", async (AdjustDeferredDebtPaymentRequest request,
            ClaimsPrincipal principal, UserManager<ApplicationUser> users,
            IncomePlanService service, CancellationToken cancellationToken) =>
        {
            try { var (household, user) = Context(principal, users); return Results.Ok(await service.AdjustDeferredDebtPaymentAsync(household, user, request, false, cancellationToken)); }
            catch (IncomePlanValidationException exception) { return Results.ValidationProblem(new Dictionary<string, string[]> { ["incomePlan"] = [exception.Message] }); }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        group.MapDelete("/deferred-debt-payment", async (string expectedDeferredDebtPaymentCzk,
            ClaimsPrincipal principal, UserManager<ApplicationUser> users,
            IncomePlanService service, CancellationToken cancellationToken) =>
        {
            try
            {
                var (household, user) = Context(principal, users);
                await service.DeleteDeferredDebtPaymentAsync(household, user, expectedDeferredDebtPaymentCzk, cancellationToken);
                return Results.NoContent();
            }
            catch (IncomePlanValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["incomePlan"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        group.MapPost("/coinmate-balance-watch", async (
            CoinmateBalanceWatchService service, CancellationToken cancellationToken) =>
        {
            try { return Results.Ok(await service.StartAsync(cancellationToken)); }
            catch (CoinmateBalanceWatchNotFoundException) { return Unavailable(); }
            catch (CoinmateBalanceWatchUnavailableException) { return Unavailable(); }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        group.MapPost("/coinmate-balance-watch/{watchId:guid}/ping", async (Guid watchId,
            CoinmateBalanceWatchService service, CancellationToken cancellationToken) =>
        {
            try { return Results.Ok(await service.PingAsync(watchId, cancellationToken)); }
            catch (CoinmateBalanceWatchNotFoundException) { return Results.NotFound(); }
            catch (CoinmateBalanceWatchUnavailableException) { return Unavailable(); }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        group.MapGet("/coinmate-balance-watch/{watchId:guid}", async (Guid watchId,
            CoinmateBalanceWatchService service, CancellationToken cancellationToken) =>
        {
            try { return Results.Ok(await service.WatchAsync(watchId, cancellationToken)); }
            catch (CoinmateBalanceWatchNotFoundException) { return Results.NotFound(); }
            catch (CoinmateBalanceWatchUnavailableException) { return Unavailable(); }
        });
        group.MapPost("/coinmate-bitcoin-purchase", async (
            CoinmateBitcoinPurchaseRequest request, HttpContext context,
            CoinmateBalanceWatchService service, CancellationToken cancellationToken) =>
        {
            if (!Guid.TryParse(context.Request.Headers["Idempotency-Key"], out var idempotencyKey))
            {
                return Results.ValidationProblem(new Dictionary<string, string[]>
                {
                    ["idempotencyKey"] = ["Idempotency-Key header must be a valid UUID."],
                });
            }
            if (!decimal.TryParse(request.AmountCzk, NumberStyles.Number, CultureInfo.InvariantCulture,
                    out var amount) || amount <= 0 || decimal.Round(amount, 2) != amount)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]>
                {
                    ["amountCzk"] = ["Amount must be positive and have at most two decimal places."],
                });
            }

            try { return Results.Ok(await service.PurchaseBitcoinAsync(amount, idempotencyKey, cancellationToken)); }
            catch (CoinmateBalanceWatchNotFoundException) { return PurchaseUnavailable(); }
            catch (CoinmateBalanceWatchUnavailableException) { return PurchaseUnavailable(); }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        group.MapGet("/coinmate-bitcoin-purchase/{idempotencyKey:guid}", async (
            Guid idempotencyKey, CoinmateBalanceWatchService service,
            CancellationToken cancellationToken) =>
        {
            try { return Results.Ok(await service.GetBitcoinPurchaseAsync(idempotencyKey, cancellationToken)); }
            catch (CoinmateBalanceWatchNotFoundException) { return Results.NotFound(); }
            catch (CoinmateBalanceWatchUnavailableException) { return PurchaseUnavailable(); }
        });
        return endpoints;
    }

    private static IResult Unavailable() => Results.Problem(
        statusCode: StatusCodes.Status503ServiceUnavailable,
        title: "Coinmate balance watch unavailable");

    private static IResult PurchaseUnavailable() => Results.Problem(
        statusCode: StatusCodes.Status503ServiceUnavailable,
        title: "Coinmate bitcoin purchase unavailable");

    private static (Guid, Guid) Context(ClaimsPrincipal principal, UserManager<ApplicationUser> users) =>
        (Guid.Parse(principal.FindFirstValue(IdentityClaims.HouseholdId)
            ?? throw new InvalidOperationException("Missing household.")),
         Guid.Parse(users.GetUserId(principal) ?? throw new InvalidOperationException("Missing user.")));
}

public sealed record CoinmateBitcoinPurchaseRequest(string AmountCzk);
