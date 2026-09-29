/** What one member's monthly invite limit is made of. */
export interface MonthlyInviteLimitInputs {
  /** The staff-set `User.inviteMonthlyQuota`, or null when none is set. */
  inviteQuotaOverride: number | null;
  /** The configured `app.inviteMonthlyQuota`. */
  base: number;
  /** The claimed recognition perk's bonus (`INVITE_QUOTA_BONUS_BY_LEVEL`). */
  levelBonus: number;
  /** `AMBASSADOR_INVITE_BONUS` for an active grant, else 0. */
  ambassadorBonus: number;
}

/**
 * The one rule for a member's monthly invite limit: a staff override wins
 * outright, and otherwise the base plus the level and ambassador bonuses.
 * `InvitesService.resolveMonthlyLimit` enforces it and the perks page prints
 * it (PRD-436), so the two can never disagree. A leaf file with no imports, so
 * the recognition module can share it without pulling in the invites service.
 */
export function resolveMonthlyInviteLimit(
  inputs: MonthlyInviteLimitInputs,
): number {
  if (inputs.inviteQuotaOverride != null) return inputs.inviteQuotaOverride;
  return inputs.base + inputs.levelBonus + inputs.ambassadorBonus;
}
