using System.Security.Claims;
using Finstrat.Api.Modules.Identity;
using Microsoft.AspNetCore.Identity;
using Finstrat.Api.Modules.Identity.Domain;

namespace Finstrat.Api.Modules.Bitcoin;

public static class BitcoinEndpoints
{
    public static IEndpointRouteBuilder MapBitcoinEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/bitcoin/overview", async (
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            BitcoinQueryService queryService,
            CancellationToken cancellationToken) =>
        {
            var householdId = Guid.Parse(principal.FindFirstValue(IdentityClaims.HouseholdId)
                ?? throw new InvalidOperationException("Authenticated user has no household."));
            var userId = Guid.Parse(userManager.GetUserId(principal)
                ?? throw new InvalidOperationException("Authenticated principal has no user ID."));
            return Results.Ok(await queryService.GetOverviewAsync(householdId, userId, cancellationToken));
        })
        .WithTags("Bitcoin")
        .RequireAuthorization();

        return endpoints;
    }
}
