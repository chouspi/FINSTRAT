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
        return endpoints;
    }

    private static (Guid, Guid) Context(ClaimsPrincipal principal, UserManager<ApplicationUser> users) =>
        (Guid.Parse(principal.FindFirstValue(IdentityClaims.HouseholdId)
            ?? throw new InvalidOperationException("Missing household.")),
         Guid.Parse(users.GetUserId(principal) ?? throw new InvalidOperationException("Missing user.")));
}
