import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { IsNull, Repository } from 'typeorm';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { Community } from './entities/community.entity';

/**
 * Shared "resolve a community by slug, then place the caller on its roster"
 * steps for the four standalone community endpoints added by this build
 * (resources, invites, bans, owner review). Plain functions taking the
 * caller's own repositories rather than an `@Injectable()`, the same shape
 * `MemberLookup` (`src/common/member-ref.ts`) uses: every one of those
 * services already holds a `Community` + `CommunityMember` repository, so
 * this needs no DI registration of its own.
 *
 * `CommunityMembershipService` covers the two older tiers
 * (`assertMemberBySlug`, `assertOwnerOrModBySlug`) and is reused directly
 * wherever those fit. It predates `RosterRole.CoOwner`
 * (`1793920000000-AddCommunityCoOwnerRole`) and so its owner-or-mod tier does
 * not admit a co-owner. The staff tier below does, which is why it lives here
 * instead: the co-owner role carries owner-level powers inside the community
 * (settings, roster, moderation), so it belongs on every staff-gated route in
 * this build.
 */

/**
 * The roles that may curate a community's shelf, send invites, read and lift
 * bans. Owner-level powers inside one community, which `co_owner` holds by
 * definition. This says nothing about `communities.owner_id`, which still
 * names exactly one accountable owner of record.
 */
export const COMMUNITY_STAFF_ROLES: readonly RosterRole[] = [
  RosterRole.Owner,
  RosterRole.CoOwner,
  RosterRole.Mod,
];

export function isCommunityStaffRole(role: RosterRole): boolean {
  return COMMUNITY_STAFF_ROLES.includes(role);
}

/**
 * A live community by slug, or a 404. Archived communities 404 like they do
 * everywhere else in this module: existence is never leaked, and an archived
 * room has nothing left to curate.
 */
export async function loadActiveCommunityOr404(
  communities: Repository<Community>,
  slug: string,
): Promise<Community> {
  const community = await communities.findOne({
    where: { slug, archivedAt: IsNull() },
  });
  if (!community) {
    throw new NotFoundException('Community not found');
  }
  return community;
}

/**
 * The caller's roster row in a community, or a 403. Same posture as
 * `CommunityMembershipService.assertMemberBySlug`: a resolved-but-non-member
 * caller is refused rather than told anything about the community.
 */
export async function loadMembershipOr403(
  members: Repository<CommunityMember>,
  communityId: string,
  userId: string,
): Promise<CommunityMember> {
  const membership = await members.findOne({
    where: { communityId, userId },
  });
  if (!membership) {
    throw new ForbiddenException('Only roster members can do that');
  }
  return membership;
}

/**
 * Resolve the community and assert the caller holds a staff role on it
 * (owner, co-owner or moderator). 404 for an unknown or archived slug, 403
 * for anyone else, including a plain member.
 */
export async function resolveStaffCommunity(
  communities: Repository<Community>,
  members: Repository<CommunityMember>,
  slug: string,
  userId: string,
): Promise<{ community: Community; membership: CommunityMember }> {
  const community = await loadActiveCommunityOr404(communities, slug);
  const membership = await loadMembershipOr403(members, community.id, userId);
  if (!isCommunityStaffRole(membership.role)) {
    throw new ForbiddenException(
      'Only the community owner, a co-owner or a moderator can do that',
    );
  }
  return { community, membership };
}

/**
 * Resolve the community and assert the caller is on its roster at any role.
 * The member-scoped read tier: a private community's shelf is readable by the
 * people in the room and by nobody else, which is exactly what roster
 * membership already encodes (every access tier gates who can GET onto that
 * roster in the first place).
 */
export async function resolveMemberCommunity(
  communities: Repository<Community>,
  members: Repository<CommunityMember>,
  slug: string,
  userId: string,
): Promise<{ community: Community; membership: CommunityMember }> {
  const community = await loadActiveCommunityOr404(communities, slug);
  const membership = await loadMembershipOr403(members, community.id, userId);
  return { community, membership };
}
