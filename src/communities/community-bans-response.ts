import { MemberRef } from '../common/member-ref';
import { CommunityBan } from './entities/community-ban.entity';

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * `expires_at` for a ban of `days` days starting now. Lives here, alongside
 * the citation helpers, so both the removal path and the ban-edit path can
 * reach it without either service importing the other.
 */
export function banExpiryFromDays(days: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + days * MILLIS_PER_DAY);
}

/**
 * The house rule a ban was written against, as it read at the moment of the
 * action (TS-15).
 *
 * `Community.rules` is a plain array and `Community.rulesVersion` is bumped on
 * every edit, so `index` alone would drift: rule 3 today can be a different
 * rule tomorrow. `version` and `text` are the snapshot that keeps the record
 * readable after a rewrite, and `isStale` is the one derived field a reader
 * actually acts on ("the rules have changed since this was written").
 */
export interface CommunityBanRuleCitationDTO {
  index: number;
  version: number;
  text: string;
  isStale: boolean;
}

/**
 * `GET /communities/:slug/bans` — one entry on a community's ban list, for
 * that community's owner, co-owners and moderators. Hand-mapped from
 * `CommunityBan` (no global serializer in this repo), so the raw `userId` and
 * `bannedByUserId` columns never leave the server: both are resolved to the
 * compact `MemberRef` every other community response embeds.
 *
 * `member` is null when the banned account has since been erased, and
 * `bannedBy` is null when the moderator who applied the ban has (their FK is
 * `ON DELETE SET NULL` precisely so the ban outlives them). A null `bannedBy`
 * reads as "the moderator who did this is gone", and the ban still stands.
 *
 * `reason` is the moderator's own note, shown here because this list exists to
 * answer "why is this person barred" for the people who have to decide whether
 * to lift it. Since TS-10 the same note is also sent to the barred member.
 *
 * `expiresAt` is null for a permanent ban and an ISO instant for a timed one.
 * `isExpired` is computed at read time from the same clock the join gate uses,
 * so a spent ban is visibly spent even in the window before anything has
 * deleted the row.
 */
export interface CommunityBanDTO {
  id: string;
  member: MemberRef | null;
  bannedBy: MemberRef | null;
  reason: string | null;
  expiresAt: string | null;
  isExpired: boolean;
  rule: CommunityBanRuleCitationDTO | null;
  createdAt: string;
}

/**
 * The cited rule, or null when the ban cites nothing. Returns null unless all
 * three snapshot columns are present: a partial citation would render as a
 * rule number with no words behind it, which is exactly the unstable reference
 * the snapshot exists to avoid.
 */
export function toCommunityBanRuleCitationDTO(
  ban: CommunityBan,
  currentRulesVersion: number,
): CommunityBanRuleCitationDTO | null {
  if (
    ban.ruleIndex === null ||
    ban.ruleVersion === null ||
    ban.ruleText === null
  ) {
    return null;
  }
  return {
    index: ban.ruleIndex,
    version: ban.ruleVersion,
    text: ban.ruleText,
    isStale: ban.ruleVersion !== currentRulesVersion,
  };
}

export function toCommunityBanDTO(
  ban: CommunityBan,
  member: MemberRef | null,
  bannedBy: MemberRef | null,
  currentRulesVersion: number,
  now: Date = new Date(),
): CommunityBanDTO {
  return {
    id: ban.id,
    member,
    bannedBy,
    reason: ban.reason,
    expiresAt: ban.expiresAt?.toISOString() ?? null,
    isExpired:
      ban.expiresAt !== null && ban.expiresAt.getTime() <= now.getTime(),
    rule: toCommunityBanRuleCitationDTO(ban, currentRulesVersion),
    createdAt: ban.createdAt.toISOString(),
  };
}

/**
 * One of the community's current house rules, offered alongside the ban list
 * so the mod panel can render a rule picker without a second request and
 * without prop-drilling the community detail into the panel. Staff-only route,
 * and a community's rules are already visible to its members, so this leaks
 * nothing the caller could not already read.
 */
export interface CommunityRuleOptionDTO {
  index: number;
  text: string;
}

/** The whole ban list for one community, newest ban first. */
export interface CommunityBanListDTO {
  bans: CommunityBanDTO[];
  total: number;
  /** The community's rules as they read right now, for the citation picker. */
  rules: CommunityRuleOptionDTO[];
  /** The version those rules are at, echoed back on a citing write. */
  rulesVersion: number;
}

/** The three snapshot columns a citing write puts on the ban row. */
export interface CommunityBanRuleSnapshot {
  ruleIndex: number;
  ruleVersion: number;
  ruleText: string;
}

/**
 * Turn "the moderator picked rule N" into the snapshot stored on the row.
 *
 * Returns null when nothing was cited, when the index is outside the
 * community's current rules, or when the rule at that index is blank. A
 * citation that cannot be resolved is dropped rather than stored half-formed:
 * the alternative is a record pointing at a rule that does not exist, which is
 * worse than a ban that cites nothing.
 *
 * Shared by the removal path (`CommunitiesService.barReturn`) and the ban-edit
 * path (`CommunityBansService.updateBan`) so both write the same shape.
 */
export function resolveRuleSnapshot(
  rules: string[] | null | undefined,
  rulesVersion: number,
  ruleIndex: number | null | undefined,
): CommunityBanRuleSnapshot | null {
  if (ruleIndex === null || ruleIndex === undefined) return null;
  if (!Number.isInteger(ruleIndex) || ruleIndex < 0) return null;
  const text = rules?.[ruleIndex]?.trim();
  if (!text) return null;
  return { ruleIndex, ruleVersion: rulesVersion, ruleText: text };
}
