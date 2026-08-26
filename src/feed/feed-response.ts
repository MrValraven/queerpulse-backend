import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { Community } from '../communities/entities/community.entity';
import { Event } from '../events/entities/event.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { matchNeighbourhood } from '../profiles/neighbourhoods';
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
    // `ref.avatarUrl` is already `photoVisible`-gated at its single source
    // (`toMemberRef`), so a member who hid their photo arrives here with a
    // `null` avatar and it stays null — the gate isn't re-applied here because
    // this shape has no `photoVisible`/viewer signal to re-derive it from.
    avatarUrl: toImageUrl(ref.avatarUrl),
  };
}

/**
 * Why this item is in the member's feed (SOC-04). Mirrors `FeedReason` in
 * `feed-affinity.ts`, which is where the precedence is defined. Present on
 * the "All" tab, where ranking runs; omitted elsewhere, where the tab itself
 * is already the explanation.
 */
export type FeedItemReason = 'membership' | 'connection' | 'topic' | 'recent';

/**
 * The interaction state that lets a feed card act instead of only link out
 * (SOC-04). `reactionCount` and `myReaction` are the flat `like` counter
 * `POST /community-posts/:id/like` maintains, so the optimistic update on the
 * card and the number the server returns are counting the same thing. Carried
 * for `community_post`; `replyCount` is also carried for `forum_thread`,
 * which already stores it on the row.
 */
/** A source a member can turn down in their own feed (SOC-18). `name` is
 *  carried so the card's menu and the managed list can say what is being
 *  quieted without a second lookup. Null for an item with no room behind it
 *  (a flat post, a global new-member row). */
export interface FeedItemSource {
  kind: 'community' | 'forum_thread';
  id: string;
  name: string;
}

export interface FeedItemSignals {
  /** Present on every tab: muting is a reader's preference, not a ranking
   *  concept, so it is offered wherever the card is. */
  source?: FeedItemSource | null;
  reason?: FeedItemReason;
  /** The community, person or topic named by `reason`, ready to render.
   *  Null for `recent`, and for a reason whose subject didn't resolve. */
  reasonSubject?: string | null;
  reactionCount?: number;
  replyCount?: number;
  /** The viewer's OWN reaction key, or null. See `FeedInteractionsService`. */
  myReaction?: string | null;
}

export interface FeedItem extends FeedItemSignals {
  id: string;
  type: FeedItemType;
  createdAt: string;
  title: string;
  summary: string;
  link: string;
  actor: AuthorSummary | null;
  // `new_member` (People tab) enrichment the member card renders — omitted
  // (undefined) for every other item type. `neighbourhood` HONOURS the
  // member's privacy choices exactly as `toMemberCard` does: it is null unless
  // the profile is `open` AND the member left `hoodVisible` on, and it carries
  // the COARSENED neighbourhood (`matchNeighbourhood`), never the raw exact
  // location — so the feed can't leak a location the profile detail
  // deliberately hides or coarsens. `interests` are the member's public
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
 * `title`/`link` for a community post: if it's scoped to a community, the
 * title names it (the community is the meaningful "context" a feed card
 * shows, mirroring the old feed mock's `context` field) and the link is the
 * post's own PERMALINK, `/community/:slug/post/:id` (SOC-02). It used to be
 * the community page, which dropped the reader at the top of a timeline with
 * the post they clicked somewhere below.
 *
 * A flat/global post (see `CommunityPost.communityId`, nullable since Task
 * 3.2) has no community to link into, so it falls back to a generic label and
 * `/feed`: the permalink route is community-scoped, and a community-less post
 * has no other surface in the frontend to open.
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
    link: community ? `/community/${community.slug}/post/${post.id}` : '/feed',
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
    // Free: the thread row already maintains this counter. The feed card
    // shows it as context; replying still happens in the thread itself,
    // since a forum reply is a threaded post rather than a one-line note.
    replyCount: thread.replyCount,
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
    // Mirrors `toMemberCard`'s gate exactly: only an `open` profile that also
    // left `hoodVisible` on exposes a neighbourhood, and it's the coarsened
    // `matchNeighbourhood(location)`, never the raw exact string. A member who
    // is `open` but hid their neighbourhood (`hoodVisible = false`) gets null
    // here, same as everywhere else.
    neighbourhood:
      profile.visibility === ProfileVisibility.Open && profile.hoodVisible
        ? matchNeighbourhood(profile.location)
        : null,
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
