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

export const COMMUNITY_MEMBER_JOINED = 'community.member_joined';
export const COMMUNITY_MEMBER_LEFT = 'community.member_left';

/** Emitted after a roster row is created, by any join path. */
export interface CommunityMemberJoinedEvent {
  communityId: string;
  userId: string;
}

/**
 * Emitted after a roster row is deleted, whether the member left themselves
 * or a mod removed them. Membership cards listen for this and revoke: a
 * former member must not keep proving a membership they no longer hold.
 */
export interface CommunityMemberLeftEvent {
  communityId: string;
  userId: string;
}
