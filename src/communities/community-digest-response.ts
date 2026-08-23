import { CommunityNotificationLevel } from './entities/community-member.entity';
import { PostKind } from './entities/community-post.entity';
import { RosterRole } from './entities/community-member.entity';

/** How many days one digest looks back. */
export const DIGEST_WINDOW_DAYS = 7;

/** How many post excerpts one community contributes to the digest. */
export const DIGEST_EXCERPTS_PER_COMMUNITY = 2;

/** Characters of a post body one excerpt carries. */
export const DIGEST_EXCERPT_LENGTH = 160;

/**
 * A representative post from the digest window: a taste of what was said, so
 * the digest reads as a week rather than a set of counters. The body is
 * truncated to `DIGEST_EXCERPT_LENGTH` and carries no author identity, which
 * keeps the digest a summary of the community and avoids turning it into a
 * report on who has been talking.
 */
export interface CommunityDigestExcerpt {
  postId: string;
  kind: PostKind;
  excerpt: string;
  createdAt: Date;
}

/** One community's last seven days, from the viewer's own point of view. */
export interface CommunityDigestEntry {
  slug: string;
  name: string;
  /** Resolved through `toImageUrl`, or null when the community has no avatar. */
  avatarImageUrl: string | null;
  /** The viewer's own role on this roster. */
  myRole: RosterRole;
  /** The viewer's own notification level, so the client can offer to change it. */
  notificationLevel: CommunityNotificationLevel;
  newPostCount: number;
  newMemberCount: number;
  upcomingGatheringCount: number;
  excerpts: CommunityDigestExcerpt[];
}

/**
 * `GET /me/communities/digest` — the caller's own week across every community
 * they belong to.
 *
 * Scoped entirely to the caller: a community they have MUTED
 * (`notificationLevel: muted`) is absent, because a mute is a request to stop
 * hearing from a room and a digest is hearing from it. Communities are ordered
 * by how much happened in them, so a quiet week sorts below a loud one.
 */
export interface CommunityDigestResponse {
  /** The start of the window every count below is measured from. */
  since: Date;
  communities: CommunityDigestEntry[];
}
