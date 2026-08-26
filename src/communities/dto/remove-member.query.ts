import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * The longest a timed community ban may run, in days. A year is already far
 * past the point where "come back when this has blown over" is what is being
 * said, and anything longer is better expressed as the permanent ban the route
 * still supports (omit `banDays`).
 */
export const MAX_COMMUNITY_BAN_DAYS = 365;

/**
 * Query of `DELETE /communities/:slug/members/:memberSlug`.
 *
 * Removing someone from a community bars their return by default: without
 * that, a removed member re-joins a public-tier community in one tap and the
 * removal means nothing. `allowReturn=true` is the explicit opt-out for the
 * tidy-up case (clearing an inactive account, removing someone at their own
 * request), and writes no ban.
 *
 * A member removing THEMSELVES never writes a ban whatever this says. See
 * `CommunitiesService.removeMember`.
 */
export class RemoveMemberQuery {
  /**
   * Query params arrive as strings, so only the exact literal `"true"` opts
   * in; anything else (including `"1"`, `""`, a repeated param arriving as an
   * array) stays `false`, which is the barring default. Mirrors
   * `AdminMediaDeleteQueryDto.force`.
   */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  allowReturn?: boolean;

  /**
   * Optional moderator note stored on the ban row. Shown to owner/mods on the
   * ban list and carried into the governance log; it is never sent to the
   * removed member.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /**
   * How many days the bar should last. Omitted means permanent, which is the
   * behaviour every caller had before timed bans existed.
   *
   * This is the rung the community ladder was missing (TS-10). Removal used to
   * be all-or-nothing, so a moderator dealing with someone having a bad week
   * chose between doing nothing and barring them for life.
   *
   * Ignored when `allowReturn=true` (no ban is written at all) and on a
   * self-leave (which never writes one, whatever the query says).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_COMMUNITY_BAN_DAYS)
  banDays?: number;

  /**
   * Which of the community's own house rules this removal rests on, 0-based
   * into `Community.rules` (TS-15). Optional: a removal can rest on conduct no
   * rule anticipated, and a community with no rules has nothing to cite.
   *
   * The index alone is not what gets stored. `Community.rules` is a plain
   * array and `Community.rulesVersion` moves whenever an owner edits it, so
   * the server snapshots the version and the rule's exact wording alongside
   * the index (see `resolveRuleSnapshot`). An index that falls outside the
   * current rules is dropped rather than stored, so a citation never points at
   * a rule that does not exist.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(199)
  ruleIndex?: number;
}
