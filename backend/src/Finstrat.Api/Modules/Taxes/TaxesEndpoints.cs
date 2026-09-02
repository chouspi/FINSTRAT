using System.Security.Claims;
using Finstrat.Api.Modules.Identity;
using Finstrat.Api.Modules.Identity.Domain;
using Microsoft.AspNetCore.Identity;

namespace Finstrat.Api.Modules.Taxes;

public static class TaxesEndpoints
{
    public static IEndpointRouteBuilder MapTaxesEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/taxes").WithTags("Taxes").RequireAuthorization();
        group.MapGet("/overview", async (ClaimsPrincipal principal, UserManager<ApplicationUser> users,
            TaxesService service, CancellationToken ct) =>
        {
            var (household, user) = Context(principal, users);
            return Results.Ok(await service.GetOverviewAsync(household, user, ct));
        });
        group.MapPost("/deferred-vwce", async (DeferRecommendedTransferRequest request, HttpContext http,
            ClaimsPrincipal principal, UserManager<ApplicationUser> users, TaxesService service, CancellationToken ct) =>
        {
            if (!Guid.TryParse(http.Request.Headers["Idempotency-Key"], out var key))
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["idempotencyKey"] = ["Idempotency-Key musí být UUID."] });
            try
            {
                var (household, user) = Context(principal, users);
                return Results.Created("/api/taxes/deferred-vwce", await service.DeferRecommendedAsync(household, user, key, request, ct));
            }
            catch (TaxesValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["taxes"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        return endpoints;
    }

    private static (Guid, Guid) Context(ClaimsPrincipal principal, UserManager<ApplicationUser> users) =>
        (Guid.Parse(principal.FindFirstValue(IdentityClaims.HouseholdId) ?? throw new InvalidOperationException("Missing household.")),
         Guid.Parse(users.GetUserId(principal) ?? throw new InvalidOperationException("Missing user.")));
}
