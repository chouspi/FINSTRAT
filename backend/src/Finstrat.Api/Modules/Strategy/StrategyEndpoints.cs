using System.Security.Claims;
using Finstrat.Api.Modules.Identity;
using Finstrat.Api.Modules.Identity.Domain;
using Microsoft.AspNetCore.Identity;

namespace Finstrat.Api.Modules.Strategy;

public static class StrategyEndpoints
{
    public static IEndpointRouteBuilder MapStrategyEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/strategy").WithTags("Strategy").RequireAuthorization();
        group.MapGet("/overview", async (ClaimsPrincipal principal, UserManager<ApplicationUser> users,
            StrategyService service, CancellationToken cancellationToken) =>
        {
            var (household, user) = Context(principal, users);
            return Results.Ok(await service.GetOverviewAsync(household, user, cancellationToken));
        });
        group.MapPut("/settings", async (UpdateStrategySettingsRequest request,
            ClaimsPrincipal principal, UserManager<ApplicationUser> users,
            StrategyService service, CancellationToken cancellationToken) =>
        {
            try
            {
                var (household, user) = Context(principal, users);
                return Results.Ok(await service.UpdateSettingsAsync(household, user, request, cancellationToken));
            }
            catch (StrategyValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["strategy"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        return endpoints;
    }

    private static (Guid, Guid) Context(ClaimsPrincipal principal, UserManager<ApplicationUser> users) =>
        (Guid.Parse(principal.FindFirstValue(IdentityClaims.HouseholdId)
            ?? throw new InvalidOperationException("Missing household.")),
         Guid.Parse(users.GetUserId(principal) ?? throw new InvalidOperationException("Missing user.")));
}
