import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import { toPlainTextExcerpt } from '../communities/community-plain-text';
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

/**
 * PRD-107 adds `article`: a published magazine piece. The magazine was the one
 * thing the desk ships that never reached the home screen, so a piece an
 * editor commissioned, edited and published was invisible to every member who
 * did not go looking for it.
 */
export type FeedItemType =
  'community_post' | 'forum_thread' | 'gathering' | 'new_member' | 'article';

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
  /**
   * A plain-text preview of the item's own body (PRD-167). Carried for
   * `forum_thread`, whose card used to be the only one in the feed with no
   * content preview at all: members had to decide whether to open a thread
   * from its title alone, which made threads the least clickable thing on the
   * home screen. Null when the thread's opening post could not be read (it is
   * tombstoned, or the thread has no flagged OP row).
   *
   * Undefined for every other item type, which already previews itself
   * through `summary`.
   */
  excerpt?: string | null;
  /**
   * `article` (PRD-107) enrichment, undefined for every other item type. The
   * card needs the magazine's own furniture: the kicker or section the piece
   * runs under, the byline credit, the read time and the lead art, none of
   * which the shared `title`/`summary`/`actor` triple can carry, because a
   * magazine byline is a `magazine_author` row rather than a member account.
   */
  kicker?: string;
  section?: string;
  readMinutes?: number;
  /** The piece's lead art, falling back to its social-share image, or null
   *  when the desk set neither. Same precedence `MagazineFrontService` uses. */
  imageUrl?: string | null;
  /** The language of the row the card is actually showing, so a Portuguese
   *  reader served the English original can be told so. */
  locale?: string;
  byline?: MagazineByline | null;
}

/**
 * The magazine credit on an `article` item (PRD-107).
 *
 * Deliberately NOT folded into `actor`. `actor` is a member account: the feed
 * block-filters on it, the frontend hides items whose `actor.handle` it has
 * blocked, and its avatar links to `/members/:slug`. A magazine byline is a
 * `magazine_author` row that may belong to no member at all (plenty of
 * contributors are credited by name only), and its `slug` addresses
 * `/magazine/author/:slug`. Sending it as `actor` would put a byline slug
 * where a member handle is expected on both counts.
 *
 * `actor` is still filled in when the byline IS linked to a member
 * (`MagazineAuthor.userId`), so the card can show their profile photo and the
 * block filter has something to work with.
 */
export interface MagazineByline {
  name: string;
  /** Addresses `/magazine/author/:slug`, never a member profile. */
  slug: string;
  avatarUrl: string | null;
}

const SUMMARY_MAX = 220;

/** Contract C4: the forum card's excerpt window, matching the thread
 *  response's own excerpt (C3) so the same thread previews identically in the
 *  feed and in the forum list. */
const FORUM_EXCERPT_MAX = 180;

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
 * What the feed knows about a thread that the thread ROW cannot tell it, read
 * off `forum_post` in one batched query per page (see
 * `FeedService.forumThreadCards`).
 *
 * Both fields exist because the denormalized `forum_thread` columns were
 * lying. `replyCount` on the row is incremented when a reply is created and
 * never decremented when one is tombstoned (ENG-132), so a thread whose three
 * replies were all deleted still advertised "3 replies" on its card. And
 * there was no preview at all (PRD-167): `summary` was `category` plus that
 * same wrong count.
 */
export interface ForumThreadCard {
  /** Contract C4: the opening post, HTML stripped and cut to 180 characters
   *  on a word boundary. Null when there is no readable OP. */
  excerpt: string | null;
  /** Live count of the thread's non-deleted replies (the OP is not a reply,
   *  matching `ForumThread.replyCount`'s own definition). */
  replyCount: number;
}

/**
 * Contract C4 (PRD-167): the thread's opening post as a feed-card preview.
 *
 * Goes through `toPlainTextExcerpt`, the same fixed-point strip-and-collapse
 * the community moderation queue's excerpts use, so a body carrying markup
 * (or entity-encoded markup) can never reach a card as anything but text. The
 * ellipsis is appended here rather than inside the helper, which reports
 * truncation separately so each caller draws its own affordance.
 *
 * A body that strips down to nothing at all (an image-only post) is null
 * rather than an empty string, so the card renders no preview slot instead of
 * an empty one.
 */
export function toForumExcerpt(body: string | null | undefined): string | null {
  if (!body) return null;
  const { text, isTruncated } = toPlainTextExcerpt(body, FORUM_EXCERPT_MAX);
  if (!text.length) return null;
  return isTruncated ? `${text}…` : text;
}

/**
 * `summary` still names the category and the reply count, and PRD-167 adds
 * the `excerpt` beside it: the OP's own words, which is what a member
 * actually decides on. Both the count and the excerpt come from `card`, read
 * live off `forum_post` for the whole page at once, because the thread row's
 * `replyCount` counts tombstoned replies (ENG-132) and carries no body.
 *
 * `card` is optional so a caller with no `forum_post` read to hand still gets
 * a correct card: it falls back to the thread's stored count and no excerpt,
 * which is exactly the behaviour that shipped before.
 */
export function forumThreadToFeedItem(
  thread: ForumThread,
  author: MemberRef | null,
  card?: ForumThreadCard,
): FeedItem {
  const replyCount = card ? card.replyCount : thread.replyCount;
  const replyWord = replyCount === 1 ? 'reply' : 'replies';
  return {
    id: thread.id,
    type: 'forum_thread',
    createdAt: thread.createdAt.toISOString(),
    title: thread.title,
    summary: `${thread.category} · ${replyCount} ${replyWord}`,
    link: `/thread/${thread.slug}`,
    actor: toAuthorSummary(author),
    excerpt: card ? card.excerpt : null,
    // The feed card shows the count as context; replying still happens in the
    // thread itself, since a forum reply is a threaded post rather than a
    // one-line note.
    replyCount,
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

/**
 * A published magazine piece (PRD-107).
 *
 * TWO article rows, on purpose. `canonical` is the piece as the archive knows
 * it: the row with `translation_of_article_id IS NULL`, and the row whose
 * `(published_at, id)` the whole feed merge orders and paginates on.
 * `displayed` is the row whose WORDS the card shows: the reader-language
 * translation when the desk has published one, and `canonical` itself
 * otherwise. Splitting them is what stops one piece appearing twice on the
 * home screen while still letting a Portuguese reader read it in Portuguese
 * (see `FeedService`'s `magazine_article` candidate case).
 *
 * `createdAt` is the canonical piece's PUBLISH instant, not its `created_at`:
 * a piece drafted in March and published today belongs at the top of today's
 * feed, and `published_at` is what every public magazine read already orders
 * by. It is also why the substitution never moves a row: a translation
 * shipped a week later would otherwise jump the piece back to the top.
 *
 * `link` addresses the DISPLAYED row's slug, so a translated card opens the
 * translation, which is a first-class article at its own address.
 */
export function magazineArticleToFeedItem(
  canonical: { id: string; publishedAt: Date | null },
  displayed: {
    slug: string;
    title: string;
    dek: string;
    kicker: string;
    section: string;
    readMinutes: number;
    heroImageKey: string;
    socialImage: string;
    locale: string;
  },
  byline: MagazineByline | null,
  actor: MemberRef | null,
): FeedItem {
  return {
    id: canonical.id,
    type: 'article',
    // Non-null by construction: the candidate query admits only rows with
    // `published_at IS NOT NULL AND published_at <= now`.
    createdAt: (canonical.publishedAt ?? new Date()).toISOString(),
    title: displayed.title,
    summary: truncate(displayed.dek),
    // `routeMap.ts#article` is `/magazine/article`, read by `?id=<slug>`.
    link: `/magazine/article?id=${encodeURIComponent(displayed.slug)}`,
    actor: toAuthorSummary(actor),
    kicker: displayed.kicker,
    section: displayed.section,
    readMinutes: displayed.readMinutes,
    // Lead art first, share image only as a fallback: they are two separate
    // editorial decisions and the art on the page is the one this card shows.
    // Mirrors `MagazineFrontService`'s precedence exactly.
    imageUrl:
      toImageUrl(displayed.heroImageKey) ?? toImageUrl(displayed.socialImage),
    locale: displayed.locale,
    byline,
  };
}
