namespace Finstrat.Api.Modules.Identity.Domain;

public sealed class HouseholdMember
{
    public Guid HouseholdId { get; init; }
    public Guid UserId { get; init; }
    public required string Role { get; init; }
    public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;
}
