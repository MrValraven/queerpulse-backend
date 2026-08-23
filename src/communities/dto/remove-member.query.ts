import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

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
}
