using System.Security.Claims;
using System.Text;
using Finstrat.Api.Modules.Identity;
using Microsoft.AspNetCore.Identity;
using Finstrat.Api.Modules.Identity.Domain;

namespace Finstrat.Api.Modules.Bitcoin;

public static class BitcoinEndpoints
{
    public static IEndpointRouteBuilder MapBitcoinEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/bitcoin").WithTags("Bitcoin").RequireAuthorization();

        group.MapGet("/overview", async (
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
        });

        group.MapGet("/accounts/{accountId:guid}/proofs", async (
            Guid accountId,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            BitcoinQueryService queryService,
            CancellationToken cancellationToken) =>
        {
            var (householdId, userId) = CurrentContext(principal, userManager);
            return Results.Ok(await queryService.GetProofsAsync(householdId, userId, accountId, cancellationToken));
        });

        group.MapGet("/accounts/{accountId:guid}/movements", async (
            Guid accountId,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            BitcoinQueryService queryService,
            CancellationToken cancellationToken) =>
        {
            var (householdId, userId) = CurrentContext(principal, userManager);
            return Results.Ok(await queryService.GetAccountMovementsAsync(
                householdId, userId, accountId, cancellationToken));
        });

        group.MapGet("/proofs/{proofId:guid}/content", async (
            Guid proofId,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            BitcoinQueryService queryService,
            CancellationToken cancellationToken) =>
        {
            var (householdId, userId) = CurrentContext(principal, userManager);
            var proof = await queryService.GetProofContentAsync(householdId, userId, proofId, cancellationToken);
            if (proof is null) return Results.NotFound();
            var safeAccountName = string.Concat(proof.Value.AccountName.Select(character =>
                char.IsLetterOrDigit(character) || character is '-' or '_' ? character : '-'));
            return Results.File(
                Encoding.UTF8.GetBytes(proof.Value.Content),
                "text/plain; charset=utf-8",
                $"doklad-{safeAccountName}-{proof.Value.CreatedAt:yyyy-MM-dd}.txt");
        });

        group.MapPost("/accounts", async (
            CreateBitcoinAccountRequest request,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            BitcoinCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                var response = await commandService.CreateAccountAsync(
                    householdId, userId, request, cancellationToken);
                return Results.Created($"/api/bitcoin/accounts/{response.Id}", response);
            }
            catch (BitcoinValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["account"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        group.MapPut("/accounts/{accountId:guid}", async (
            Guid accountId,
            UpdateBitcoinAccountRequest request,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            BitcoinCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                return Results.Ok(await commandService.UpdateAccountAsync(
                    householdId, userId, accountId, request, cancellationToken));
            }
            catch (BitcoinValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["account"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        group.MapDelete("/accounts/{accountId:guid}", async (
            Guid accountId,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            BitcoinCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                await commandService.ArchiveAccountAsync(
                    householdId, userId, accountId, cancellationToken);
                return Results.NoContent();
            }
            catch (BitcoinValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["account"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        group.MapPut("/movements/{movementId:guid}/purchase", async (
            Guid movementId,
            UpdateBitcoinPurchaseMovementRequest request,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            BitcoinCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                await commandService.UpdatePurchaseMovementAsync(
                    householdId, userId, movementId, request, cancellationToken);
                return Results.NoContent();
            }
            catch (BitcoinValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["movement"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        group.MapDelete("/movements/{movementId:guid}/purchase", async (
            Guid movementId,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            BitcoinCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                await commandService.DeletePurchaseMovementAsync(
                    householdId, userId, movementId, cancellationToken);
                return Results.NoContent();
            }
            catch (BitcoinValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["movement"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        group.MapPost("/accounts/{accountId:guid}/proofs", async (
            Guid accountId,
            SaveBitcoinProofRequest request,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            BitcoinCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                var response = await commandService.CreateProofAsync(
                    householdId, userId, accountId, request, cancellationToken);
                return Results.Created($"/api/bitcoin/proofs/{response.Id}", response);
            }
            catch (BitcoinValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["proof"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        group.MapPut("/proofs/{proofId:guid}", async (
            Guid proofId,
            SaveBitcoinProofRequest request,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            BitcoinCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                return Results.Ok(await commandService.UpdateProofAsync(
                    householdId, userId, proofId, request, cancellationToken));
            }
            catch (BitcoinValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["proof"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        group.MapPost("/proofs/{proofId:guid}/archive", async (
            Guid proofId,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            BitcoinCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                await commandService.ArchiveProofAsync(householdId, userId, proofId, cancellationToken);
                return Results.NoContent();
            }
            catch (BitcoinValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["proof"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        group.MapPut("/accounts/{accountId:guid}/default-share", async (
            Guid accountId,
            SetBitcoinDefaultShareRequest request,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            BitcoinCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                await commandService.SetDefaultSharingAsync(
                    householdId, userId, accountId, request.Shared, cancellationToken);
                return Results.NoContent();
            }
            catch (BitcoinValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["sharing"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        group.MapPost("/purchases", async (
            CreateBitcoinPurchaseRequest request,
            HttpContext context,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            BitcoinCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            if (!TryIdempotencyKey(context, out var idempotencyKey, out var error)) return error;
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                var response = await commandService.CreatePurchaseAsync(
                    householdId, userId, idempotencyKey, request, cancellationToken);
                return Results.Created($"/api/bitcoin/purchases/{response.Id}", response);
            }
            catch (BitcoinValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["purchase"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        group.MapPost("/withdrawals", async (
            CreateBitcoinWithdrawalRequest request,
            HttpContext context,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            BitcoinCommandService commandService,
            CancellationToken cancellationToken) =>
        {
            if (!TryIdempotencyKey(context, out var idempotencyKey, out var error)) return error;
            try
            {
                var (householdId, userId) = CurrentContext(principal, userManager);
                var response = await commandService.CreateWithdrawalAsync(
                    householdId, userId, idempotencyKey, request, cancellationToken);
                return Results.Created($"/api/bitcoin/withdrawals/{response.Id}", response);
            }
            catch (BitcoinValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["withdrawal"] = [exception.Message] });
            }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();

        group.MapPost("/transfers", async (
            CreateBitcoinTransferRequest request,
            HttpContext context,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            BitcoinCommandService commandService,
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
                var response = await commandService.CreateTransferAsync(
                    householdId, userId, idempotencyKey, request, cancellationToken);
                return Results.Created($"/api/bitcoin/transfers/{response.Id}", response);
            }
            catch (BitcoinValidationException exception)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["transfer"] = [exception.Message] });
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

    private static bool TryIdempotencyKey(HttpContext context, out Guid key, out IResult error)
    {
        if (Guid.TryParse(context.Request.Headers["Idempotency-Key"], out key))
        {
            error = Results.Empty;
            return true;
        }
        error = Results.ValidationProblem(new Dictionary<string, string[]>
        {
            ["idempotencyKey"] = ["Idempotency-Key header musí být platné UUID."],
        });
        return false;
    }
}
