namespace Finstrat.Api.Modules.Wealth;

public sealed class WealthSnapshotWorker(
    IServiceScopeFactory scopeFactory,
    IConfiguration configuration,
    ILogger<WealthSnapshotWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!configuration.GetValue("WealthSnapshots:SchedulerEnabled", true)) return;
        await CaptureAsync(startup: true, stoppingToken);
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
        while (await timer.WaitForNextTickAsync(stoppingToken))
            await CaptureAsync(startup: false, stoppingToken);
    }

    private async Task CaptureAsync(bool startup, CancellationToken cancellationToken)
    {
        try
        {
            using var scope = scopeFactory.CreateScope();
            var service = scope.ServiceProvider.GetRequiredService<WealthSnapshotService>();
            var targets = await service.ReadSnapshotTargetsAsync(cancellationToken);
            foreach (var target in targets)
            {
                if (!startup && !target.IsDailyCutoff) continue;
                await service.CaptureAsync(target.HouseholdId, target.UserId,
                    target.LocalDate, "scheduled", cancellationToken);
            }
        }
        catch (Exception exception) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogError(exception, "Daily wealth snapshot failed.");
        }
    }
}
