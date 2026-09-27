using System.Security.Claims;
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
        group.MapPost("/deferred-debt-payment", async (AdjustDeferredDebtPaymentRequest request, HttpContext http,
            ClaimsPrincipal principal, UserManager<ApplicationUser> users,
            IncomePlanService service, CancellationToken cancellationToken) =>
        {
            try { var (household, user) = Context(principal, users); return Results.Ok(await service.AdjustDeferredDebtPaymentAsync(household, user, request, true, cancellationToken, ReadOptionalKey(http))); }
            catch (IncomePlanValidationException exception) { return Results.ValidationProblem(new Dictionary<string, string[]> { ["incomePlan"] = [exception.Message] }); }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        group.MapPost("/deferred-debt-payment/consume", async (AdjustDeferredDebtPaymentRequest request, HttpContext http,
            ClaimsPrincipal principal, UserManager<ApplicationUser> users,
            IncomePlanService service, CancellationToken cancellationToken) =>
        {
            try { var (household, user) = Context(principal, users); return Results.Ok(await service.AdjustDeferredDebtPaymentAsync(household, user, request, false, cancellationToken, ReadOptionalKey(http))); }
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
        group.MapGet("/coinmate-czk-balance", async (
            CoinmateBalanceWatchService service, CancellationToken cancellationToken) =>
        {
            try { return Results.Ok(new CoinmateCzkBalanceResponse(await service.GetCzkBalanceAsync(cancellationToken))); }
            catch (CoinmateBalanceWatchNotFoundException) { return Unavailable(); }
            catch (CoinmateBalanceWatchUnavailableException) { return Unavailable(); }
        });
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
        group.MapGet("/coinmate-purchase-requirements", async (CoinmateBalanceWatchService service, CancellationToken cancellationToken) =>
        {
            try
            {
                var limits = await service.GetPurchaseRequirementsAsync(cancellationToken);
                return Results.Ok(new { limits.MinAmountCzk, limits.MinAmountBtc, limits.MaxAmountCzk });
            }
            catch (CoinmateBalanceWatchUnavailableException) { return PurchaseUnavailable(); }
        });
        group.MapPost("/coinmate-bitcoin-purchase", async (
            QueueCoinmatePurchaseRequest request, HttpContext context,
            ClaimsPrincipal principal, UserManager<ApplicationUser> users,
            CoinmatePurchaseJobs jobs, CancellationToken cancellationToken) =>
        {
            if (!Guid.TryParse(context.Request.Headers["Idempotency-Key"], out var key))
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["idempotencyKey"] = ["Idempotency-Key musí být UUID."] });
            try
            {
                var (household, user) = Context(principal, users);
                return Results.Ok(await jobs.QueueAsync(household, user, key, request, cancellationToken));
            }
            catch (IncomePlanValidationException ex)
            { return Results.ValidationProblem(new Dictionary<string, string[]> { ["purchase"] = [ex.Message] }); }
            catch (CoinmateBalanceWatchNotFoundException) { return PurchaseUnavailable(); }
            catch (CoinmateBalanceWatchUnavailableException) { return PurchaseUnavailable(); }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        group.MapGet("/coinmate-bitcoin-purchases", async (
            ClaimsPrincipal principal, UserManager<ApplicationUser> users,
            CoinmatePurchaseJobs jobs, CancellationToken cancellationToken) =>
        {
            var (household, user) = Context(principal, users);
            return Results.Ok(await jobs.ListAsync(household, user, cancellationToken));
        });
        group.MapGet("/coinmate-bitcoin-purchase/{idempotencyKey:guid}", async (
            Guid idempotencyKey, ClaimsPrincipal principal, UserManager<ApplicationUser> users,
            CoinmatePurchaseJobs jobs, CancellationToken cancellationToken) =>
        {
            var (household, user) = Context(principal, users);
            var job = await jobs.GetAsync(household, user, idempotencyKey, cancellationToken);
            return job is null ? Results.NotFound() : Results.Ok(job);
        });
        return endpoints;
    }

    private static Guid? ReadOptionalKey(HttpContext http)
    {
        if (!http.Request.Headers.TryGetValue("Idempotency-Key", out var value)) return null;
        if (Guid.TryParse(value, out var key)) return key;
        throw new IncomePlanValidationException("Idempotency-Key musí být UUID.");
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

public sealed record CoinmateCzkBalanceResponse(decimal BalanceCzk);
