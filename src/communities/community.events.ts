import { AccessTier } from './entities/community.entity';

export const COMMUNITY_POST_CREATED = 'community.post_created';

/**
 * A member posted in a community. Emitted after the post row has saved.
 *
 * Carries the community's `accessTier` on purpose: a post only counts as
 * "publicly visible on the platform" when the community itself is public.
 * The profiles `ActivityListener` records an activity row ONLY for
 * `AccessTier.Public` communities and drops posts in request/invite/private
 * ones, so a member's activity feed never discloses that they are active in a
 * non-public space (which would also leak the community's existence).
 */
export interface CommunityPostCreatedEvent {
  authorId: string;
  communitySlug: string;
  communityName: string;
  accessTier: AccessTier;
  postId: string;
  excerpt: string;
}
