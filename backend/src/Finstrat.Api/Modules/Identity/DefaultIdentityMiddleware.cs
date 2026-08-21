using Finstrat.Api.Infrastructure.Persistence;
using Finstrat.Api.Modules.Identity.Domain;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace Finstrat.Api.Modules.Identity;

public sealed class DefaultIdentityMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(
        HttpContext context,
        ApplicationDbContext dbContext,
        IUserClaimsPrincipalFactory<ApplicationUser> claimsFactory)
    {
        if (context.User.Identity?.IsAuthenticated != true)
        {
            var defaultUser = await dbContext.Users
                .AsNoTracking()
                .SingleAsync(user => user.IsDefault && user.DisabledAt == null);
            context.User = await claimsFactory.CreateAsync(defaultUser);
        }

        await next(context);
    }
}
