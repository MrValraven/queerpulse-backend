import type { CommunityTierRef } from '../communities/community-membership.service';
import type { HiddenEventCommunity } from './entities/hidden-event-community.entity';

/**
 * One row of the member's hidden event communities list
 * (`GET /me/hidden-event-communities`, and the body of a successful `POST`).
 * Hand-mapped like every response in this repo: returning the entity would
 * leak the row id and `user_id`.
 */
export interface HiddenEventCommunityResponse {
  communityId: string;
  slug: string;
  name: string;
  /** Resolved through `toImageUrl`. */
  avatarImageUrl: string | null;
  /** ISO 8601. */
  hiddenAt: string;
}

/**
 * Maps a stored row plus its community's display ref. `communityRef` comes
 * from `CommunityMembershipService.tierRefsByIds` (or is built the same way),
 * so its avatar is already a resolved URL.
 */
export function toHiddenEventCommunityResponse(
  row: Pick<HiddenEventCommunity, 'communityId' | 'createdAt'>,
  communityRef: Pick<CommunityTierRef, 'slug' | 'name' | 'avatarImageUrl'>,
): HiddenEventCommunityResponse {
  return {
    communityId: row.communityId,
    slug: communityRef.slug,
    name: communityRef.name,
    avatarImageUrl: communityRef.avatarImageUrl,
    hiddenAt: row.createdAt.toISOString(),
  };
}
