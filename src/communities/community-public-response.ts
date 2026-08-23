import { AccessTier, CommunityType } from './entities/community.entity';

/**
 * The next PUBLIC gathering a listed community has coming up, or absent when
 * it has none. Public-visibility events only, so this shows nothing a
 * signed-out visitor could not already see on the gatherings surface.
 */
export interface PublicCommunityGathering {
  slug: string;
  title: string;
  startAt: Date;
  isOnline: boolean;
}

/**
 * `GET /communities/:slug/public` — the signed-out TEASER of an
 * owner-opted-in community. The one and only shape an unauthenticated visitor
 * ever receives for a community.
 *
 * ================= DO NOT WIDEN THIS TYPE =================
 * Every field here is served to anyone on the internet with the link, with no
 * session and no membership. The list is closed, and it is closed on purpose:
 *
 *   name, tagline, purpose, type, accessTier, tags, city, area, isOnline,
 *   languages, memberCount, avatarImageUrl, coverImageUrl, nextGathering
 *
 * It must NEVER carry:
 *   - the roster, or any part of it: no member names, slugs, avatars, roles,
 *     or per-member anything. `memberCount` is a number and stays a number.
 *   - the owner's identity, or any moderator's. Who runs a community is not
 *     public information about them.
 *   - any post, reply, reaction or announcement, in whole or as an excerpt.
 *   - the rules text, the welcome message, join requests, governance log
 *     entries, freeze/archive state or reasons, or any moderation detail.
 *
 * If a future field seems harmless, it still does not go here by default: the
 * signed-out surface is opt-in field by field, the same way the community
 * itself is opt-in via `communities.is_publicly_listed`. Add it to the
 * member-facing `CommunityDetailDTO` instead.
 * ==========================================================
 */
export interface PublicCommunityResponse {
  slug: string;
  name: string;
  tagline: string;
  purpose: string;
  type: CommunityType;
  /**
   * `public` or `request` only (an `invite`/`private` community is never
   * reachable here). Carried so the teaser can say whether a visitor could
   * walk in or would have to ask.
   */
  accessTier: AccessTier;
  tags: string[];
  city: string | null;
  area: string | null;
  isOnline: boolean;
  languages: string[];
  /** A COUNT. Never a list, never a sample, never who. */
  memberCount: number;
  /** Resolved through `toImageUrl`, or null when unset. */
  avatarImageUrl: string | null;
  coverImageUrl: string | null;
  nextGathering: PublicCommunityGathering | null;
}
