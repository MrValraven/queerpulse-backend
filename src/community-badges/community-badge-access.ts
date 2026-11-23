import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { membersOnlyException } from '../communities/community-gate';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { assertCommunityBoardReadable } from '../communities/community-read-gate';
import {
  isCommunityOwnerLevelRole,
  isCommunityStaffRole,
  loadActiveCommunityOr404,
  loadCommunityOr404,
} from '../communities/community-staff-access';
import { RosterRole } from '../communities/entities/community-member.entity';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import {
  CommunityBadgeRefusalCode,
  communityBadgeError,
  spaceFeatureUnavailableError,
} from './community-badges.constants';

/** What every badge, gift and flair route gets back once access passes: the
 *  community and the caller's effective role in it (null for a non-member who
 *  may still read a public community). */
export interface CommunityBadgeAccess {
  community: Community;
  role: RosterRole | null;
}

/** The role a route demands: any roster role, staff (owner, co-owner or
 *  moderator) or owner-level (owner or co-owner). */
export type CommunityBadgeRoleTier = 'member' | 'staff' | 'owner_level';

/** The collaborators the access functions read, kept as plain dependencies so
 *  no module registration is needed. */
export interface CommunityBadgeAccessDeps {
  communities: Repository<Community>;
  membership: Pick<CommunityMembershipService, 'effectiveRole'>;
  contentModeration: Pick<ContentModerationService, 'stateFor'>;
}

/** Whether a role satisfies a tier. A null role fails every tier. */
function roleMeetsTier(
  role: RosterRole | null,
  tier: CommunityBadgeRoleTier,
): boolean {
  if (role === null) {
    return false;
  }
  if (tier === 'owner_level') {
    return isCommunityOwnerLevelRole(role);
  }
  if (tier === 'staff') {
    return isCommunityStaffRole(role);
  }
  return true;
}

/** A private community answers an outsider with the same 404 as a missing slug. */
function assertPrivateOutsiderSees404(
  community: Community,
  role: RosterRole | null,
): void {
  if (role === null && community.accessTier === AccessTier.Private) {
    throw new NotFoundException('Community not found');
  }
}

/** Every badge, gift and flair route refuses a space, after access passes. */
function assertNotSpace(community: Community): void {
  if (community.parentId) {
    throw spaceFeatureUnavailableError();
  }
}

/**
 * Resolve a community for a route that demands a role tier. Refusals come in
 * this order: unknown slug (or archived slug on a write) 404, a private
 * outsider 404, the route's own refusal code when the role misses the tier,
 * then the space refusal.
 */
export async function resolveForRole(
  deps: CommunityBadgeAccessDeps,
  input: {
    slug: string;
    userId: string;
    isWrite: boolean;
    tier: CommunityBadgeRoleTier;
    refusalCode: CommunityBadgeRefusalCode | 'COMMUNITY_MEMBERS_ONLY';
  },
): Promise<CommunityBadgeAccess> {
  const community = input.isWrite
    ? await loadActiveCommunityOr404(deps.communities, input.slug)
    : await loadCommunityOr404(deps.communities, input.slug);
  const role = await deps.membership.effectiveRole(community, input.userId);
  assertPrivateOutsiderSees404(community, role);
  if (!roleMeetsTier(role, input.tier)) {
    throw input.refusalCode === 'COMMUNITY_MEMBERS_ONLY'
      ? membersOnlyException()
      : communityBadgeError(input.refusalCode);
  }
  assertNotSpace(community);
  return { community, role };
}

/**
 * Resolve a community for a read that answers like the post board: no archive
 * filter, the board read gate (404 private, COMMUNITY_MEMBERS_ONLY gated,
 * takedown and archive closures), then the space refusal.
 */
export async function resolveForBoardRead(
  deps: CommunityBadgeAccessDeps,
  input: { slug: string; userId: string },
): Promise<CommunityBadgeAccess> {
  const community = await loadCommunityOr404(deps.communities, input.slug);
  const role = await deps.membership.effectiveRole(community, input.userId);
  await assertCommunityBoardReadable({
    community,
    viewerRole: role,
    communities: deps.communities,
    contentModeration: deps.contentModeration,
  });
  assertNotSpace(community);
  return { community, role };
}

/**
 * Resolve a community for a route that decides on the gift itself and needs
 * no role: a private outsider still 404s first, then the space refusal.
 */
export async function resolveForAnyCaller(
  deps: CommunityBadgeAccessDeps,
  input: { slug: string; userId: string; isWrite: boolean },
): Promise<CommunityBadgeAccess> {
  const community = input.isWrite
    ? await loadActiveCommunityOr404(deps.communities, input.slug)
    : await loadCommunityOr404(deps.communities, input.slug);
  const role = await deps.membership.effectiveRole(community, input.userId);
  assertPrivateOutsiderSees404(community, role);
  assertNotSpace(community);
  return { community, role };
}
