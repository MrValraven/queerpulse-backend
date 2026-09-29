import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import {
  ContentModerationService,
  ContentModerationState,
} from '../content-moderation/content-moderation.service';
import { isCommunityStaffRole } from './community-staff-access';
import { RosterRole } from './entities/community-member.entity';
import { Community } from './entities/community.entity';

/**
 * The moderation subject type a community itself is recorded under in
 * `content_moderation`. Matches `CommunitiesService.SUBJECT_TYPE`, kept as
 * its own export here so a caller outside `communities.service.ts` (this
 * file's own consumers included) never has to import that service just to
 * spell the string correctly.
 */
export const COMMUNITY_MODERATION_SUBJECT_TYPE = 'community';

/**
 * 404 unless this viewer may read a community's interior: its posts,
 * replies and roster. Three separate closures stack, each with the same
 * "don't leak existence" posture:
 *
 * - a moderator takedown (hidden or removed) closes the interior to
 *   everyone but the community's own staff;
 * - an archive closes it to everyone off the roster, drawn at membership
 *   (PRD-143): the archive notification every member receives deep-links
 *   straight back into the interior it promises stays readable;
 * - a space whose parent is gone, archived or itself taken down closes to
 *   everyone with no effective role in the space, mirroring the parent's
 *   own gate.
 *
 * The access-tier gate (private/request/invite closed to a non-member) is
 * left to each caller, exactly as `CommunitiesService.getBySlug` draws its
 * own tier gate after these same three checks. This helper only mirrors the
 * takedown/archive/parent trio that `getBySlug` runs, so posts and replies
 * answer with the identical closures the community's own detail page does.
 */
export async function assertCommunityInteriorReadable(input: {
  community: Pick<Community, 'slug' | 'archivedAt' | 'parentId'>;
  viewerRole: RosterRole | null;
  communities: Repository<Community>;
  contentModeration: Pick<ContentModerationService, 'stateFor'>;
}): Promise<void> {
  const { community, viewerRole, communities, contentModeration } = input;
  const isStaff = viewerRole !== null && isCommunityStaffRole(viewerRole);
  const moderation: ContentModerationState = await contentModeration.stateFor(
    COMMUNITY_MODERATION_SUBJECT_TYPE,
    community.slug,
  );
  if ((moderation.hidden || moderation.removed) && !isStaff) {
    throw new NotFoundException('Community not found');
  }
  if (community.archivedAt != null && viewerRole === null) {
    throw new NotFoundException('Community not found');
  }
  if (community.parentId && viewerRole === null) {
    const parent = await communities.findOne({
      where: { id: community.parentId },
    });
    if (!parent || parent.archivedAt != null) {
      throw new NotFoundException('Community not found');
    }
    const parentModeration = await contentModeration.stateFor(
      COMMUNITY_MODERATION_SUBJECT_TYPE,
      parent.slug,
    );
    if (parentModeration.hidden || parentModeration.removed) {
      throw new NotFoundException('Community not found');
    }
  }
}
