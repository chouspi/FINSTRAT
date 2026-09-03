using Finstrat.Api.Infrastructure.Persistence;
using Finstrat.Api.Modules.Bitcoin;
using Finstrat.Api.Modules.Debts;
using Finstrat.Api.Modules.Identity;
using Finstrat.Api.Modules.Identity.Domain;
using Finstrat.Api.Modules.IncomePlan;
using Finstrat.Api.Modules.MarketData;
using Finstrat.Api.Modules.Strategy;
using Finstrat.Api.Modules.Taxes;
using Finstrat.Api.Modules.Vwce;
using Finstrat.Api.Modules.Wealth;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
var connectionString = builder.Configuration.GetConnectionString("Database");
if (string.IsNullOrWhiteSpace(connectionString))
{
    throw new InvalidOperationException("ConnectionStrings:Database is required.");
}

builder.Services.AddDbContext<ApplicationDbContext>(options => options.UseNpgsql(connectionString));
builder.Services
    .AddIdentityCore<ApplicationUser>(options =>
    {
        options.User.RequireUniqueEmail = false;
        options.Password.RequiredLength = 8;
        options.Password.RequireDigit = true;
        options.Password.RequireLowercase = true;
        options.Password.RequireUppercase = true;
        options.Password.RequireNonAlphanumeric = false;
        options.Lockout.MaxFailedAccessAttempts = 5;
        options.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
    })
    .AddSignInManager()
    .AddEntityFrameworkStores<ApplicationDbContext>();
builder.Services.AddScoped<IUserClaimsPrincipalFactory<ApplicationUser>, ApplicationClaimsPrincipalFactory>();

builder.Services.AddAuthentication(IdentityConstants.ApplicationScheme).AddIdentityCookies();
builder.Services.ConfigureApplicationCookie(options =>
{
    options.Cookie.Name = builder.Environment.IsDevelopment() ? "finstrat.auth" : "__Host-finstrat.auth";
    options.Cookie.HttpOnly = true;
    options.Cookie.SameSite = SameSiteMode.Strict;
    options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
    options.SlidingExpiration = false;
    options.ExpireTimeSpan = TimeSpan.FromMinutes(15);
    options.Events.OnRedirectToLogin = context =>
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return Task.CompletedTask;
    };
    options.Events.OnRedirectToAccessDenied = context =>
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        return Task.CompletedTask;
    };
});
builder.Services.AddAuthorizationBuilder()
    .AddPolicy("household-owner", policy => policy.RequireClaim(IdentityClaims.HouseholdRole, "owner"));
builder.Services.AddAntiforgery(options =>
{
    options.Cookie.Name = builder.Environment.IsDevelopment() ? "finstrat.xsrf" : "__Host-finstrat.xsrf";
    options.Cookie.HttpOnly = true;
    options.Cookie.SameSite = SameSiteMode.Strict;
    options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
    options.HeaderName = "X-CSRF-TOKEN";
});
builder.Services.AddHttpClient("btc-price", client =>
{
    client.BaseAddress = new Uri("https://api.exchange.coinbase.com/");
    client.Timeout = TimeSpan.FromSeconds(4);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("FINSTRAT/2.0");
});
builder.Services.AddHttpClient("vwce-price", client =>
{
    client.BaseAddress = new Uri("https://query1.finance.yahoo.com/");
    client.Timeout = TimeSpan.FromSeconds(8);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("FINSTRAT/2.0");
});
builder.Services.AddHttpClient("coinmate-controller", client =>
{
    client.Timeout = TimeSpan.FromSeconds(45);
});
builder.Services.AddSingleton<BtcPriceService>();
builder.Services.AddSingleton<VwcePriceService>();
builder.Services.AddSingleton<CoinmateBalanceWatchService>();
builder.Services.AddScoped<BitcoinQueryService>();
builder.Services.AddScoped<BitcoinCommandService>();
builder.Services.AddScoped<VwceQueryService>();
builder.Services.AddScoped<VwceCommandService>();
builder.Services.AddScoped<DebtQueryService>();
builder.Services.AddScoped<DebtCommandService>();
builder.Services.AddScoped<IncomePlanService>();
builder.Services.AddScoped<StrategyService>();
builder.Services.AddScoped<TaxesService>();
builder.Services.AddScoped<WealthSnapshotService>();
builder.Services.AddHostedService<WealthSnapshotWorker>();
builder.Services.AddOpenApi();

var app = builder.Build();

if (app.Environment.IsDevelopment()) app.MapOpenApi();

app.UseAuthentication();
app.UseMiddleware<DefaultIdentityMiddleware>();
app.UseAuthorization();

app.MapGet("/api/health", () => Results.Ok(new { status = "healthy" }));
app.MapIdentityEndpoints();
app.MapMarketDataEndpoints();
app.MapBitcoinEndpoints();
app.MapVwceEndpoints();
app.MapDebtEndpoints();
app.MapIncomePlanEndpoints();
app.MapStrategyEndpoints();
app.MapTaxesEndpoints();
app.MapWealthEndpoints();

app.Run();

public partial class Program;
