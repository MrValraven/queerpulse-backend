import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { Community } from '../communities/entities/community.entity';
import { Event } from '../events/entities/event.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';

// ── Frontend-contract shapes ─────────────────────────────────────────────
// Mirror `AuthorSummary`/`FeedItem`/`FeedItemType` from the frontend's
// `shared/contracts/contracts.ts` field-for-field. Kept local to `feed` (not
// `src/common`) — same idiom as `src/forum/forum-response.ts`, which notes no
// shared `AuthorSummary` mapper exists yet.

export type FeedItemType =
  'community_post' | 'forum_thread' | 'gathering' | 'new_member';

export interface AuthorSummary {
  handle: string;
  displayName: string;
  pronouns: string | null;
  avatarUrl: string | null;
}

/**
 * Unlike `forum-response.ts#toAuthorSummary` (which falls back to a
 * placeholder because `ForumThreadResponse.author` is non-nullable),
 * `FeedItem.actor` in `contracts.ts` IS nullable — so an unresolved author
 * maps straight to `null` here, no placeholder needed.
 */
export function toAuthorSummary(
  ref: MemberRef | null | undefined,
): AuthorSummary | null {
  if (!ref) return null;
  return {
    handle: ref.slug,
    displayName: `${ref.firstName} ${ref.lastName}`.trim(),
    pronouns: ref.pronouns,
    avatarUrl: toImageUrl(ref.avatarUrl),
  };
}

export interface FeedItem {
  id: string;
  type: FeedItemType;
  createdAt: string;
  title: string;
  summary: string;
  link: string;
  actor: AuthorSummary | null;
  // `new_member` (People tab) enrichment the member card renders — omitted
  // (undefined) for every other item type. `neighbourhood` HONOURS the
  // member's profile visibility: it is null unless their profile is `open`,
  // mirroring `toMemberCard`'s gate so the feed can't leak a location the
  // profile detail deliberately hides. `interests` are the member's public
  // `tags` (ungated, same as `toProfileCard`).
  neighbourhood?: string | null;
  interests?: string[];
}

const SUMMARY_MAX = 220;

/** Trims a body/description down to a feed-card-sized preview. */
function truncate(text: string, max = SUMMARY_MAX): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * `title`/`link` for a community post: if it's scoped to a community, both
 * name it (the community is the meaningful "context" a feed card shows,
 * mirroring the old feed mock's `context` field); a flat/global post (see
 * `CommunityPost.communityId`, nullable since Task 3.2) has no community to
 * link into, so it falls back to a generic label and `/feed` (there is no
 * dedicated single-post detail page in the frontend yet).
 */
export function communityPostToFeedItem(
  post: CommunityPost,
  community: Community | null,
  author: MemberRef | null,
): FeedItem {
  return {
    id: post.id,
    type: 'community_post',
    createdAt: post.createdAt.toISOString(),
    title: community ? community.name : 'Community feed',
    summary: truncate(post.body),
    link: community ? `/community/${community.slug}` : '/feed',
    actor: toAuthorSummary(author),
  };
}

/**
 * `summary` deliberately does NOT join the thread's OP post body — that
 * would mean an extra per-thread (or batched-but-still-nontrivial) query
 * against `forum_post` just to preview text already summarized by
 * `category`/`replyCount`. Keeps the aggregation a straightforward
 * per-source query + merge (see the module report for the tradeoff).
 */
export function forumThreadToFeedItem(
  thread: ForumThread,
  author: MemberRef | null,
): FeedItem {
  const replyWord = thread.replyCount === 1 ? 'reply' : 'replies';
  return {
    id: thread.id,
    type: 'forum_thread',
    createdAt: thread.createdAt.toISOString(),
    title: thread.title,
    summary: `${thread.category} · ${thread.replyCount} ${replyWord}`,
    link: `/thread/${thread.slug}`,
    actor: toAuthorSummary(author),
  };
}

export function eventToFeedItem(
  event: Event,
  host: MemberRef | null,
): FeedItem {
  return {
    id: event.id,
    type: 'gathering',
    createdAt: event.createdAt.toISOString(),
    title: event.title,
    summary: truncate(event.description),
    link: `/gatherings/${event.slug}`,
    actor: toAuthorSummary(host),
  };
}

/**
 * A recently-joined active member, for the "People" tab. `title`/`summary`
 * are read straight off the member's own profile row (not the batched
 * `MemberRef`/`actor` lookup) since the candidate row IS the member — the
 * `actor` field is filled in for the `AuthorSummary` shape the frontend's
 * `NewMemberCard` expects (including `pronouns`, which the card renders next
 * to the name), but isn't the source of truth here. `summary` falls back from
 * `tagline` to `bio` to an empty string (both nullable). `neighbourhood`
 * (visibility-gated) and `interests` (public tags) enrich the card off the
 * profile row directly — see `FeedItem`'s field notes.
 */
export function newMemberToFeedItem(
  profile: Profile,
  actor: MemberRef | null,
): FeedItem {
  return {
    id: profile.userId,
    type: 'new_member',
    createdAt: profile.createdAt.toISOString(),
    title: `${profile.firstName} ${profile.lastName}`.trim(),
    summary: profile.tagline ?? profile.bio ?? '',
    link: `/profile/${profile.slug}`,
    actor: toAuthorSummary(actor),
    neighbourhood:
      profile.visibility === ProfileVisibility.Open ? profile.location : null,
    interests: profile.tags,
  };
}

/**
 * A recently-joined member of a community the VIEWER also belongs to ("X
 * joined {community}"), for the `community_new_member` source
 * (`FeedService`'s `community_new_member` candidate kind — added in Task 5
 * and wired into the "communities" tab's `sourcesForTab` in Task 6). Unlike
 * `newMemberToFeedItem` (whose candidate row IS the profile), the joining
 * member's display fields come from the same
 * batched `authorId` -> `MemberRef` lookup `toFeedItems` already builds for
 * every other source, keyed by the joining user's id — `member` is `null`
 * only if that lookup came back empty (shouldn't happen: `community_members`
 * FKs to `users`, and every active user has a profile). The FINAL
 * `FeedItem.type` is deliberately `'new_member'` (not
 * `'community_new_member'`) so the frontend renders it with the same
 * `MemberCard`/`NewMemberCard` the People-tab source already uses — the
 * `'community_new_member'` string only ever exists as `FeedService`'s
 * internal candidate discriminator.
 */
export function communityNewMemberToFeedItem(
  membershipId: string,
  joinedAt: Date,
  member: MemberRef | null,
  community: Community | null,
): FeedItem {
  return {
    id: membershipId,
    type: 'new_member',
    createdAt: joinedAt.toISOString(),
    title: member
      ? `${member.firstName} ${member.lastName}`.trim()
      : 'A member',
    summary: community ? `Joined ${community.name}` : 'Joined a community',
    link: member ? `/profile/${member.slug}` : '/feed',
    actor: toAuthorSummary(member),
  };
}
