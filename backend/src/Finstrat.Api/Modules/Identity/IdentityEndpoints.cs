using System.Security.Claims;
using Finstrat.Api.Infrastructure.Persistence;
using Finstrat.Api.Modules.Identity.Domain;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace Finstrat.Api.Modules.Identity;

public static class IdentityEndpoints
{
    public static IEndpointRouteBuilder MapIdentityEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/identity").WithTags("Identity");

        group.MapGet("/antiforgery", (HttpContext context, IAntiforgery antiforgery) =>
        {
            var tokens = antiforgery.GetAndStoreTokens(context);
            return Results.Ok(new { token = tokens.RequestToken });
        }).AllowAnonymous();

        group.MapGet("/me", async (
            HttpContext context,
            ClaimsPrincipal principal,
            UserManager<ApplicationUser> userManager,
            CancellationToken cancellationToken) =>
        {
            var userId = userManager.GetUserId(principal);
            var user = userId is null
                ? null
                : await userManager.Users.AsNoTracking()
                    .SingleOrDefaultAsync(item => item.Id == Guid.Parse(userId), cancellationToken);
            if (user is null) return Results.Unauthorized();

            DateTimeOffset? sessionExpiresAt = null;
            if (!user.IsDefault)
            {
                var authentication = await context.AuthenticateAsync(IdentityConstants.ApplicationScheme);
                sessionExpiresAt = authentication.Properties?.ExpiresUtc;
            }
            return Results.Ok(ToResponse(user, principal, sessionExpiresAt));
        }).RequireAuthorization();

        group.MapPost("/login", async (
            LoginRequest request,
            UserManager<ApplicationUser> userManager,
            SignInManager<ApplicationUser> signInManager) =>
        {
            var identifier = request.Identifier.Trim();
            var user = await userManager.FindByNameAsync(identifier)
                ?? await userManager.FindByEmailAsync(identifier);
            if (user is null || user.IsDefault || user.DisabledAt is not null)
            {
                return Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Invalid credentials");
            }

            var result = await signInManager.PasswordSignInAsync(user, request.Password, false, true);
            return result.Succeeded
                ? Results.NoContent()
                : Results.Problem(statusCode: StatusCodes.Status401Unauthorized, title: "Invalid credentials");
        }).AddEndpointFilter<AntiforgeryEndpointFilter>().AllowAnonymous();

        group.MapPost("/logout", async (SignInManager<ApplicationUser> signInManager) =>
        {
            await signInManager.SignOutAsync();
            return Results.NoContent();
        }).AddEndpointFilter<AntiforgeryEndpointFilter>().RequireAuthorization();

        group.MapPost("/renew", async (
            HttpContext context,
            UserManager<ApplicationUser> userManager,
            SignInManager<ApplicationUser> signInManager) =>
        {
            var authentication = await context.AuthenticateAsync(IdentityConstants.ApplicationScheme);
            if (!authentication.Succeeded
                || authentication.Properties?.ExpiresUtc is not { } expiresAt
                || expiresAt <= DateTimeOffset.UtcNow)
            {
                return Results.Unauthorized();
            }

            var userId = userManager.GetUserId(authentication.Principal!);
            var user = userId is null ? null : await userManager.FindByIdAsync(userId);
            if (user is null || user.IsDefault || user.DisabledAt is not null)
            {
                return Results.Unauthorized();
            }

            var now = DateTimeOffset.UtcNow;
            await signInManager.SignInAsync(user, new AuthenticationProperties
            {
                IsPersistent = false,
                IssuedUtc = now,
                ExpiresUtc = now.AddMinutes(15),
                AllowRefresh = false,
            });
            return Results.NoContent();
        }).AddEndpointFilter<AntiforgeryEndpointFilter>().RequireAuthorization();

        group.MapGet("/users", async (
            ClaimsPrincipal principal,
            ApplicationDbContext dbContext,
            CancellationToken cancellationToken) =>
        {
            var householdId = CurrentHouseholdId(principal);
            var users = await (
                from member in dbContext.HouseholdMembers.AsNoTracking()
                join user in dbContext.Users.AsNoTracking() on member.UserId equals user.Id
                where member.HouseholdId == householdId
                orderby user.IsDefault descending, user.DisplayName
                select new UserResponse(
                    user.Id, user.UserName!, user.DisplayName, user.Email,
                    user.IsDefault, member.Role)
            ).ToListAsync(cancellationToken);
            return Results.Ok(users);
        }).RequireAuthorization("household-owner");

        group.MapPost("/users", async (
            CreateUserRequest request,
            ClaimsPrincipal principal,
            ApplicationDbContext dbContext,
            UserManager<ApplicationUser> userManager) =>
        {
            if (request.Role is not ("owner" or "editor" or "viewer"))
            {
                return Results.ValidationProblem(new Dictionary<string, string[]>
                {
                    [nameof(request.Role)] = ["Role must be owner, editor or viewer."],
                });
            }

            await using var transaction = await dbContext.Database.BeginTransactionAsync();
            var user = new ApplicationUser
            {
                Id = Guid.NewGuid(),
                UserName = request.UserName.Trim(),
                Email = string.IsNullOrWhiteSpace(request.Email) ? null : request.Email.Trim(),
                DisplayName = request.DisplayName.Trim(),
                EmailConfirmed = false,
                IsDefault = false,
            };
            var result = await userManager.CreateAsync(user, request.Password);
            if (!result.Succeeded)
            {
                return Results.ValidationProblem(result.Errors
                    .GroupBy(error => error.Code)
                    .ToDictionary(grouping => grouping.Key, grouping => grouping.Select(error => error.Description).ToArray()));
            }

            var householdId = CurrentHouseholdId(principal);
            dbContext.HouseholdMembers.Add(new HouseholdMember
            {
                HouseholdId = householdId,
                UserId = user.Id,
                Role = request.Role,
            });
            await dbContext.SaveChangesAsync();
            await transaction.CommitAsync();
            return Results.Created($"/api/identity/users/{user.Id}",
                new UserResponse(user.Id, user.UserName, user.DisplayName, user.Email, false, request.Role));
        }).AddEndpointFilter<AntiforgeryEndpointFilter>().RequireAuthorization("household-owner");

        return endpoints;
    }

    private static Guid CurrentHouseholdId(ClaimsPrincipal principal) =>
        Guid.Parse(principal.FindFirstValue(IdentityClaims.HouseholdId)
            ?? throw new InvalidOperationException("Authenticated user has no household."));

    private static CurrentUserResponse ToResponse(
        ApplicationUser user,
        ClaimsPrincipal principal,
        DateTimeOffset? sessionExpiresAt) => new(
        user.Id,
        user.UserName!,
        user.DisplayName,
        user.Email,
        user.IsDefault,
        principal.FindFirstValue(IdentityClaims.HouseholdId),
        principal.FindFirstValue(IdentityClaims.HouseholdRole),
        sessionExpiresAt);
}

public sealed record LoginRequest(string Identifier, string Password);
public sealed record CreateUserRequest(string UserName, string DisplayName, string? Email, string Password, string Role);
public sealed record UserResponse(Guid Id, string UserName, string DisplayName, string? Email, bool IsDefault, string Role);
public sealed record CurrentUserResponse(
    Guid Id,
    string UserName,
    string DisplayName,
    string? Email,
    bool IsDefault,
    string? HouseholdId,
    string? Role,
    DateTimeOffset? SessionExpiresAt);
