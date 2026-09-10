using System.Globalization;

namespace Finstrat.Api.Modules.Identity;

public sealed class GamblingCounterService(IConfiguration configuration)
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly string _filePath = configuration["GamblingCounter:FilePath"]
        ?? Path.Combine(AppContext.BaseDirectory, "data", "counter_kokotstvi.txt");

    public async Task<long> GetAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            return await ReadAsync(cancellationToken);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<long> IncrementAsync(CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var count = checked(await ReadAsync(cancellationToken) + 1);
            Directory.CreateDirectory(Path.GetDirectoryName(_filePath)!);
            var temporaryPath = _filePath + ".tmp";
            await File.WriteAllTextAsync(temporaryPath, count.ToString(CultureInfo.InvariantCulture) + Environment.NewLine, cancellationToken);
            File.Move(temporaryPath, _filePath, true);
            return count;
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<long> ReadAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(_filePath)) return 0;

        var value = await File.ReadAllTextAsync(_filePath, cancellationToken);
        return long.TryParse(value.Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var count) && count >= 0
            ? count
            : throw new InvalidDataException("Gambling counter file does not contain a non-negative integer.");
    }
}
