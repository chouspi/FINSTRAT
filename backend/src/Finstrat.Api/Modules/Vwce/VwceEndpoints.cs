using System.Security.Claims;
using Finstrat.Api.Modules.Identity;
using Finstrat.Api.Modules.Identity.Domain;
using Microsoft.AspNetCore.Identity;

namespace Finstrat.Api.Modules.Vwce;

public static class VwceEndpoints
{
    public static IEndpointRouteBuilder MapVwceEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/vwce").WithTags("VWCE").RequireAuthorization();

        group.MapGet("/overview", async (
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            VwceQueryService queryService,
            CancellationToken cancellationToken) =>
        {
            var householdId = Guid.Parse(principal.FindFirstValue(IdentityClaims.HouseholdId)
                ?? throw new InvalidOperationException("Authenticated user has no household."));
            var userId = Guid.Parse(userManager.GetUserId(principal)
                ?? throw new InvalidOperationException("Authenticated principal has no user ID."));
            return Results.Ok(await queryService.GetOverviewAsync(householdId, userId, cancellationToken));
        });

        group.MapGet("/accounts/{accountId:guid}/movements", async (
            Guid accountId,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            VwceQueryService queryService,
            CancellationToken cancellationToken) =>
        {
            var (householdId, userId) = CurrentContext(principal, userManager);
            return Results.Ok(await queryService.GetAccountMovementsAsync(
                householdId, userId, accountId, cancellationToken));
        });

        group.MapPost("/accounts", async (
            CreateVwceAccountRequest request,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            VwceCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                var response = await commandService.CreateAccountAsync(
                    householdId, userId, request, cancellationToken);
                return Results.Created($"/api/vwce/accounts/{response.Id}", response);
            }
            catch (VwceValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["account"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        group.MapPut("/accounts/{accountId:guid}", async (
            Guid accountId,
            UpdateVwceAccountRequest request,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            VwceCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                return Results.Ok(await commandService.UpdateAccountAsync(
                    householdId, userId, accountId, request, cancellationToken));
            }
            catch (VwceValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["account"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        group.MapDelete("/accounts/{accountId:guid}", async (
            Guid accountId,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            VwceCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                await commandService.ArchiveAccountAsync(householdId, userId, accountId, cancellationToken);
                return Results.NoContent();
            }
            catch (VwceValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["account"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        group.MapPut("/movements/{movementId:guid}/purchase", async (
            Guid movementId,
            UpdateVwcePurchaseMovementRequest request,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            VwceCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                await commandService.UpdatePurchaseMovementAsync(
                    householdId, userId, movementId, request, cancellationToken);
                return Results.NoContent();
            }
            catch (VwceValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["movement"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        group.MapPost("/accounts/{accountId:guid}/purchases", async (
            Guid accountId,
            CreateVwcePurchaseRequest request,
            HttpContext context,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            VwceCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            if (!Guid.TryParse(context.Request.Headers["Idempotency-Key"], out var idempotencyKey))
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["idempotencyKey"] = ["Idempotency-Key header musí být platné UUID."] });
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                var response = await commandService.CreatePurchaseAsync(
                    householdId, userId, accountId, idempotencyKey, request, cancellationToken);
                return Results.Created($"/api/vwce/movements/{response.Id}", response);
            }
            catch (VwceValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["purchase"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        group.MapDelete("/movements/{movementId:guid}/purchase", async (
            Guid movementId,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            VwceCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                await commandService.DeletePurchaseMovementAsync(
                    householdId, userId, movementId, cancellationToken);
                return Results.NoContent();
            }
            catch (VwceValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["movement"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        group.MapPost("/payouts", async (
            CreateVwcePayoutRequest request,
            HttpContext context,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            VwceCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            if (!Guid.TryParse(context.Request.Headers["Idempotency-Key"], out var idempotencyKey))
            {
                return Results.ValidationProblem(new Dictionary<string, string[]>
                {
                    ["idempotencyKey"] = ["Idempotency-Key header musí být platné UUID."],
                });
            }
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                var response = await commandService.CreatePayoutAsync(
                    householdId, userId, idempotencyKey, request, cancellationToken);
                return Results.Created($"/api/vwce/payouts/{response.Id}", response);
            }
            catch (VwceValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["payout"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        group.MapPut("/accounts/{accountId:guid}/default-share", async (
            Guid accountId,
            SetVwceDefaultShareRequest request,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            VwceCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                await commandService.SetDefaultSharingAsync(
                    householdId, userId, accountId, request.Shared, cancellationToken);
                return Results.NoContent();
            }
            catch (VwceValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["sharing"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        return endpoints;
    }

    private static (Guid HouseholdId, Guid UserId) CurrentContext(
        ClaimsPrincipal principal,
        UserManager<ApplicationUser> userManager) =>
        (Guid.Parse(principal.FindFirstValue(IdentityClaims.HouseholdId)
            ?? throw new InvalidOperationException("Authenticated user has no household.")),
          Guid.Parse(userManager.GetUserId(principal)
            ?? throw new InvalidOperationException("Authenticated principal has no user ID.")));
}
