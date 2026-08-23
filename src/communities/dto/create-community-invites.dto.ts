import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * How many members one call may invite. A deliberate ceiling on top of the
 * route's throttle: the throttle limits how OFTEN an owner can invite, this
 * limits how far a single accepted call reaches, so neither a script nor a
 * stolen staff session can page the whole member directory in one request.
 * `CreateCommunityDto.invites` allows 50 at founding time, where the owner is
 * seeding a brand new room; a live community invites in smaller batches.
 */
export const MAX_INVITES_PER_CALL = 25;

/**
 * Body for `POST /communities/:slug/invites` (owner, co-owner or moderator).
 *
 * Member profile slugs, the same currency `CreateCommunityDto.invites` uses at
 * founding time. An invite is an invitation and nothing else: nobody named
 * here is added to the roster (see `CommunityInvitesService`).
 */
export class CreateCommunityInvitesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_INVITES_PER_CALL)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  memberSlugs!: string[];
}
