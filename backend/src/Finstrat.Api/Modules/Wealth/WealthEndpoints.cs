using System.Security.Claims;
using Finstrat.Api.Modules.Identity;
using Finstrat.Api.Modules.Identity.Domain;
using Microsoft.AspNetCore.Identity;
using System.Text.Json;

namespace Finstrat.Api.Modules.Wealth;

public static class WealthEndpoints
{
    public static IEndpointRouteBuilder MapWealthEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/wealth/history", async (int? days, ClaimsPrincipal principal,
            UserManager<ApplicationUser> users, WealthSnapshotService service,
            CancellationToken cancellationToken) =>
        {
            var householdId = Guid.Parse(principal.FindFirstValue(IdentityClaims.HouseholdId)
                ?? throw new InvalidOperationException("Missing household."));
            var userId = Guid.Parse(users.GetUserId(principal)
                ?? throw new InvalidOperationException("Missing user."));
            var range = Math.Clamp(days ?? 365, 7, 3650);
            try
            {
                await service.CaptureAsync(householdId, userId,
                    await service.GetLocalDateAsync(householdId, userId, cancellationToken),
                    "manual", cancellationToken);
            }
            catch (Exception exception) when (
                (exception is HttpRequestException or JsonException or InvalidOperationException or TaskCanceledException)
                && !cancellationToken.IsCancellationRequested)
            {
                // Preserve the latest completed history when a price provider is temporarily unavailable.
            }
            return Results.Ok(await service.GetHistoryAsync(
                householdId, userId, range, cancellationToken));
        }).WithTags("Wealth").RequireAuthorization();
        return endpoints;
    }
}
