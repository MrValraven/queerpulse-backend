import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import {
  ContentModerationService,
  ContentModerationState,
} from '../content-moderation/content-moderation.service';
import { isGatedTier, membersOnlyException } from './community-gate';
import { isCommunityStaffRole } from './community-staff-access';
import { RosterRole } from './entities/community-member.entity';
import { AccessTier, Community } from './entities/community.entity';

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

/**
 * The full read gate of a community's post board: the takedown, archive and
 * parent closures of `assertCommunityInteriorReadable`, then the access-tier
 * gate. This is gate 4 of `CommunityPostsService.assertViewable` lifted into
 * a shared helper for reads that must answer exactly like the post board
 * (the giving section is the first). The posts service keeps its own private
 * copy unchanged.
 *
 * The tier gate: a `public` community is readable by any signed-in viewer,
 * roster or not. Every gated tier is readable only with an effective role.
 * A viewer with none gets 404 `Community not found` on `private`, where the
 * community's existence is the secret, and the 403 `membersOnlyException()`
 * on `request` and `invite`, which discover already lists, so the client
 * can show the gate card.
 */
export async function assertCommunityBoardReadable(input: {
  community: Pick<Community, 'slug' | 'archivedAt' | 'parentId' | 'accessTier'>;
  viewerRole: RosterRole | null;
  communities: Repository<Community>;
  contentModeration: Pick<ContentModerationService, 'stateFor'>;
}): Promise<void> {
  await assertCommunityInteriorReadable(input);
  const { community, viewerRole } = input;
  if (!isGatedTier(community.accessTier) || viewerRole !== null) return;
  if (community.accessTier === AccessTier.Private) {
    throw new NotFoundException('Community not found');
  }
  throw membersOnlyException();
}
