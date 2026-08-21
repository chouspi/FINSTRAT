using System.Security.Claims;
using Finstrat.Api.Infrastructure.Persistence;
using Finstrat.Api.Modules.Identity.Domain;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Finstrat.Api.Modules.Identity;

public sealed class ApplicationClaimsPrincipalFactory(
    UserManager<ApplicationUser> userManager,
    IOptions<IdentityOptions> options,
    ApplicationDbContext dbContext)
    : UserClaimsPrincipalFactory<ApplicationUser>(userManager, options)
{
    protected override async Task<ClaimsIdentity> GenerateClaimsAsync(ApplicationUser user)
    {
        var identity = await base.GenerateClaimsAsync(user);
        var membership = await dbContext.HouseholdMembers
            .AsNoTracking()
            .Where(member => member.UserId == user.Id)
            .OrderBy(member => member.CreatedAt)
            .FirstOrDefaultAsync();

        if (membership is not null)
        {
            identity.AddClaim(new Claim(IdentityClaims.HouseholdId, membership.HouseholdId.ToString()));
            identity.AddClaim(new Claim(IdentityClaims.HouseholdRole, membership.Role));
        }

        identity.AddClaim(new Claim(IdentityClaims.IsDefault, user.IsDefault ? "true" : "false"));
        return identity;
    }
}
