import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * `POST /listings/:ref/co-managers` — the owner invites one existing active
 * member to co-manage their listing.
 *
 * Addressed by member SLUG rather than by user id or email, matching every
 * other member-targeting route in this codebase
 * (`PATCH /communities/:slug/members/:memberSlug/role`). A slug is what a
 * frontend already has from a member picker, and it resolves through
 * `MemberLookup.userIdForSlug`, which only ever returns ACTIVE members. That is
 * where "only existing active members can be invited" is enforced: a suspended,
 * waitlisted or removed account resolves to nothing and the invite 404s.
 *
 * There is deliberately no free-text note field. A note would be owner-authored
 * prose landing in a notification and in a roster read, and this feature has no
 * need for it; the owner can message the member.
 */
export class InviteListingCoManagerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  memberSlug!: string;
}
