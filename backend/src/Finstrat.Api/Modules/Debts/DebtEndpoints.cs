using System.Security.Claims;
using Finstrat.Api.Modules.Identity;
using Finstrat.Api.Modules.Identity.Domain;
using Microsoft.AspNetCore.Identity;

namespace Finstrat.Api.Modules.Debts;

public static class DebtEndpoints
{
    public static IEndpointRouteBuilder MapDebtEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/debts").WithTags("Debts").RequireAuthorization();
        group.MapGet("/overview", async (ClaimsPrincipal principal, UserManager<ApplicationUser> users, DebtQueryService service, CancellationToken ct) =>
        {
            var (household, user) = Context(principal, users);
            return Results.Ok(await service.GetOverviewAsync(household, user, ct));
        });
        group.MapGet("/{debtId:guid}/entries", async (Guid debtId, ClaimsPrincipal principal, UserManager<ApplicationUser> users, DebtQueryService service, CancellationToken ct) =>
        {
            var (household, user) = Context(principal, users);
            return Results.Ok(await service.GetEntriesAsync(household, user, debtId, ct));
        });
        group.MapPost("", async (CreateDebtRequest request, ClaimsPrincipal principal, UserManager<ApplicationUser> users, DebtCommandService service, CancellationToken ct) =>
        {
            try { var (household, user) = Context(principal, users); var result = await service.CreateAsync(household, user, request, ct); return Results.Created($"/api/debts/{result.Id}", result); }
            catch (DebtValidationException exception) { return Validation(exception); }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        group.MapPut("/{debtId:guid}", async (Guid debtId, UpdateDebtRequest request, ClaimsPrincipal principal, UserManager<ApplicationUser> users, DebtCommandService service, CancellationToken ct) =>
        {
            try { var (household, user) = Context(principal, users); await service.UpdateAsync(household, user, debtId, request, ct); return Results.NoContent(); }
            catch (DebtValidationException exception) { return Validation(exception); }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        group.MapPost("/{debtId:guid}/payments", async (Guid debtId, CreateDebtPaymentRequest request, HttpContext http, ClaimsPrincipal principal, UserManager<ApplicationUser> users, DebtCommandService service, CancellationToken ct) =>
        {
            if (!Guid.TryParse(http.Request.Headers["Idempotency-Key"], out var key)) return Results.ValidationProblem(new Dictionary<string, string[]> { ["idempotencyKey"] = ["Idempotency-Key musí být UUID."] });
            try { var (household, user) = Context(principal, users); return Results.Created($"/api/debts/{debtId}/payments", await service.PayAsync(household, user, debtId, key, request, ct)); }
            catch (DebtValidationException exception) { return Validation(exception); }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        group.MapPost("/{debtId:guid}/drawdowns", async (Guid debtId, CreateDebtDrawdownRequest request, HttpContext http, ClaimsPrincipal principal, UserManager<ApplicationUser> users, DebtCommandService service, CancellationToken ct) =>
        {
            if (!Guid.TryParse(http.Request.Headers["Idempotency-Key"], out var key)) return Results.ValidationProblem(new Dictionary<string, string[]> { ["idempotencyKey"] = ["Idempotency-Key musí být UUID."] });
            try { var (household, user) = Context(principal, users); return Results.Created($"/api/debts/{debtId}/drawdowns", await service.DrawAsync(household, user, debtId, key, request, ct)); }
            catch (DebtValidationException exception) { return Validation(exception); }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        group.MapPost("/scheduled-payments/due/confirm", async (ClaimsPrincipal principal, UserManager<ApplicationUser> users, DebtCommandService service, CancellationToken ct) =>
        {
            try { var (household, user) = Context(principal, users); return Results.Ok(await service.ConfirmDueScheduledPaymentsAsync(household, user, ct)); }
            catch (DebtValidationException exception) { return Validation(exception); }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        group.MapPost("/scheduled-payments/{paymentId:guid}/confirm", async (Guid paymentId, ClaimsPrincipal principal, UserManager<ApplicationUser> users, DebtCommandService service, CancellationToken ct) =>
        {
            try { var (household, user) = Context(principal, users); return Results.Ok(await service.ConfirmScheduledPaymentAsync(household, user, paymentId, ct)); }
            catch (DebtValidationException exception) { return Validation(exception); }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        group.MapDelete("/{debtId:guid}/payments/{paymentId:guid}", async (Guid debtId, Guid paymentId, ClaimsPrincipal principal, UserManager<ApplicationUser> users, DebtCommandService service, CancellationToken ct) =>
        {
            try { var (household, user) = Context(principal, users); await service.DeletePaymentAsync(household, user, debtId, paymentId, ct); return Results.NoContent(); }
            catch (DebtValidationException exception) { return Validation(exception); }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        group.MapPost("/{debtId:guid}/archive", async (Guid debtId, ClaimsPrincipal principal, UserManager<ApplicationUser> users, DebtCommandService service, CancellationToken ct) =>
        {
            try { var (household, user) = Context(principal, users); await service.ArchiveAsync(household, user, debtId, ct); return Results.NoContent(); }
            catch (DebtValidationException exception) { return Validation(exception); }
        }).AddEndpointFilter<AntiforgeryEndpointFilter>();
        return endpoints;
    }

    private static Guid Household(ClaimsPrincipal principal) => Guid.Parse(principal.FindFirstValue(IdentityClaims.HouseholdId) ?? throw new InvalidOperationException("Missing household."));
    private static (Guid, Guid) Context(ClaimsPrincipal principal, UserManager<ApplicationUser> users) => (Household(principal), Guid.Parse(users.GetUserId(principal) ?? throw new InvalidOperationException("Missing user.")));
    private static IResult Validation(DebtValidationException exception) => Results.ValidationProblem(new Dictionary<string, string[]> { ["debt"] = [exception.Message] });
}
