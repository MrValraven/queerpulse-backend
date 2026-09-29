import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Query of `DELETE /admin/communities/:slug/members/:memberSlug` (PRD-413).
 *
 * An admin removal leaves the member free to rejoin by default, which is what
 * the route did before this flag existed. `barReturn=true` is the admin's
 * explicit choice to also write a permanent bar against this community.
 *
 * Pattern: `communities/dto/remove-member.query.ts`, whose default runs the
 * other way because a community moderator's removal bars by default.
 */
export class AdminRemoveMemberQuery {
  /** Only the literal "true" opts in. Absent keeps the member free to rejoin. */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  barReturn?: boolean;
}
