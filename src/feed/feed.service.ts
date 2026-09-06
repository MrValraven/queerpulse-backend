import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import {
  CursorPage,
  cursorPaginate,
  decodeCursor,
  encodeCursor,
} from '../common/cursor-pagination';
import { toImageUrl } from '../common/image-url';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { ConnectionsService } from '../connections/connections.service';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { ForumPost } from '../forum/entities/forum-post.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import {
  ArticleLocale,
  DEFAULT_ARTICLE_LOCALE,
  MagazineArticle,
} from '../magazine/entities/magazine-article.entity';
import { MagazineAuthor } from '../magazine/entities/magazine-author.entity';
import { toArticleLocale } from '../magazine/magazine-locale';
import { BlockFilterService } from '../social/block-filter.service';
import { HiddenFromService } from '../social/hidden-from.service';
import { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { TopicFollow } from '../topics/entities/topic-follow.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { FeedTab } from './dto/get-feed.query';
import {
  AffinityFacts,
  FeedReason,
  interleaveByAffinity,
  isEmptyGraph,
  matchedTopicSlug,
  scoreAffinity,
  ViewerGraph,
} from './feed-affinity';
import {
  EMPTY_POST_INTERACTIONS,
  FeedInteractionsService,
  FeedPostInteractions,
} from './feed-interactions.service';
import {
  excludedContentTags,
  ExcludedContentTags,
  NO_EXCLUDED_CONTENT_TAGS,
} from './content-sensitivity';
import {
  MutedFeedSources,
  NO_MUTED_SOURCES,
  FeedMuteService,
} from './feed-mute.service';
import { decodeRankedCursor, encodeRankedCursor } from './feed-ranked-cursor';
import {
  communityNewMemberToFeedItem,
  communityPostToFeedItem,
  eventToFeedItem,
  FeedItem,
  FeedItemSignals,
  FeedItemSource,
  forumThreadToFeedItem,
  ForumThreadCard,
  magazineArticleToFeedItem,
  MagazineByline,
  newMemberToFeedItem,
  toForumExcerpt,
} from './feed-response';

const DEFAULT_LIMIT = 20;

/**
 * How many pages' worth of chronological candidates the "All" tab ranks at
 * once (SOC-04). Three keeps the extra read small (61 rows per source instead
 * of 21) while giving the affinity lane enough depth to actually reorder
 * something. See `feed-ranked-cursor.ts` for why ranking needs a window at
 * all.
 */
const RANK_WINDOW_PAGES = 3;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Bounds on WHEN a candidate may have happened, threaded through every source
 * query so they narrow the candidate set in the database rather than after
 * the merge (a post-merge trim would under-fill the page, which is the same
 * argument the mute and content-sensitivity filters are made in-query for).
 */
interface FeedTimeBounds {
  /**
   * The ranked "All" tab's window ceiling (ENG-134): no candidate created
   * after this instant may enter the window, so re-materialising the window
   * for page two returns the same rows page one was ranked from. See
   * `feed-ranked-cursor.ts`.
   */
  createdAtAtMost?: Date;
  /**
   * A floor on the two new-member sources only (PRD-168). The sidebar's "New
   * this week" widget is fed by the People-tab query, which returns the
   * newest active members with no date bound at all: on a quiet week it
   * showed people who joined months ago under a heading that says "this
   * week". With this set the source returns only members who joined since the
   * given instant, and an honest empty list when nobody did. The People tab
   * itself passes nothing and keeps its unbounded behaviour.
   */
  joinedSince?: Date;
}

const NO_TIME_BOUNDS: FeedTimeBounds = {};

/** The underlying stores this read-time aggregation unions. `new_member`
 * (recently-joined active members, for the "People" tab) reads `profiles`
 * directly rather than a dedicated feed table — same "no new table" idiom the
 * other sources follow. `community_new_member` (Task 5) is the same idea
 * scoped to communities the viewer belongs to ("X joined {community}"); it
 * reads `community_members` directly and is unioned into the `communities`
 * tab alongside the other three sources, each additionally membership-scoped
 * there (Task 6 — see `sourcesForTab` and the `membershipScoped` branches in
 * `fetchCandidates`). Its candidates map to a FINAL `FeedItem.type` of
 * `'new_member'` too (see `communityNewMemberToFeedItem`'s docstring) —
 * `'community_new_member'` only exists as this internal discriminator.
 *
 * `magazine_article` (PRD-107) is the desk's own published journalism, read
 * straight off `magazine_article` on the same "no new table" idiom. It is the
 * one source with no member author and no community behind it: its byline is
 * a `magazine_author` row, which may or may not be linked to an account. It
 * is unioned into the `all` tab only — see `sourcesForTab`. */
type SourceKind =
  | 'community_post'
  | 'forum_thread'
  | 'gathering'
  | 'new_member'
  | 'community_new_member'
  | 'magazine_article';

/**
 * A row from any one source, reduced to just what the cross-source merge
 * needs (identity, ordering key, the author to block-filter/resolve by) plus
 * the original row so `toFeedItems` can map it once merging/filtering is
 * done.
 */
interface Candidate {
  id: string;
  createdAt: Date;
  type: SourceKind;
  // Null for a `community_post` whose author's account was erased — the
  // post itself is preserved (tombstoned), so it still surfaces here; there's
  // just no author to block-check or resolve a byline for.
  authorId: string | null;
  row:
    | CommunityPost
    | ForumThread
    | Event
    | Profile
    | CommunityMember
    | MagazineArticle;
  /** `magazine_article` only (PRD-107). Resolved in `fetchCandidates` rather
   *  than in `toFeedItems` because the byline is also what `authorId` above is
   *  derived from, and the block filter needs that BEFORE the mapping runs. */
  magazine?: MagazineCandidate;
}

/**
 * What a `magazine_article` candidate carries beyond its canonical row
 * (PRD-107).
 *
 * `displayed` is the row whose words the card shows: the reader-language
 * translation when the desk has published one, and the canonical piece
 * itself otherwise. `Candidate.row` stays the CANONICAL piece, so the merge
 * orders and paginates on one stable `(published_at, id)` per piece however
 * many languages it exists in.
 */
interface MagazineCandidate {
  displayed: MagazineArticle;
  /** Null only when the byline row has vanished, which the FK makes
   *  impossible in practice; the card then credits nobody rather than
   *  guessing. */
  byline: MagazineAuthor | null;
}

/** Same ordering `cursorPaginate` applies per-source: newest first, `id`
 * descending as a deterministic tie-break (matters once rows from different
 * sources can share a millisecond). */
function compareCandidatesDesc(a: Candidate, b: Candidate): number {
  const diff = b.createdAt.getTime() - a.createdAt.getTime();
  if (diff !== 0) return diff;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** A candidate's identity ACROSS sources. Ids alone aren't enough: a
 *  `new_member` candidate is keyed by the member's user id and a
 *  `community_new_member` by a membership id, so the source discriminator has
 *  to be part of the key for the ranked interleave to dedupe correctly. */
function candidateKey(candidate: Candidate): string {
  return `${candidate.type}:${candidate.id}`;
}

/** The community a candidate belongs to, or null. Used both to collect the
 *  batched community lookup and to score membership affinity. */
function communityIdOf(candidate: Candidate): string | null {
  switch (candidate.type) {
    case 'community_post':
      return (candidate.row as CommunityPost).communityId;
    case 'forum_thread':
      return (candidate.row as ForumThread).communityId;
    case 'gathering':
      return (candidate.row as Event).communityId;
    case 'community_new_member':
      return (candidate.row as CommunityMember).communityId;
    case 'new_member':
      return null;
    // A magazine piece belongs to an ISSUE, never to a community, so there is
    // no room behind it to score membership on or to mute.
    case 'magazine_article':
      return null;
  }
}

/** Every distinct community id a candidate list references, for one batched
 *  `IN` lookup instead of a per-candidate one. */
function collectCommunityIds(candidates: Candidate[]): string[] {
  return [
    ...new Set(
      candidates
        .map(communityIdOf)
        .filter((communityId): communityId is string => communityId !== null),
    ),
  ];
}

/**
 * The three facts `scoreAffinity` is allowed to look at, read off a
 * candidate. `tags` is whatever the item's own subject publishes: a
 * community's curated tags for a post scoped to it, a thread's freeform tags,
 * a new member's public profile tags. A gathering has no tags column, so it
 * can only ever score on membership or connection.
 */
function affinityFactsOf(
  candidate: Candidate,
  communityById: Map<string, Community>,
): AffinityFacts {
  const communityId = communityIdOf(candidate);
  const community = communityId
    ? (communityById.get(communityId) ?? null)
    : null;
  let tags: string[] = [];
  if (candidate.type === 'forum_thread') {
    tags = (candidate.row as ForumThread).tags ?? [];
  } else if (candidate.type === 'new_member') {
    tags = (candidate.row as Profile).tags ?? [];
  } else if (candidate.type === 'community_post') {
    tags = community?.tags ?? [];
  } else if (candidate.type === 'magazine_article') {
    // PRD-107: a piece carries its own editorial tags, so it can score on a
    // followed topic exactly the way a forum thread does.
    tags = (candidate.row as MagazineArticle).tags ?? [];
  }
  return { communityId, authorId: candidate.authorId, tags };
}

/**
 * `GET /feed?tab=&cursor=` — read-time aggregation over `community_posts`,
 * `forum_thread`, `events` (the "gathering" the frontend's `FeedItem` union
 * calls it), and `profiles` (recently-joined active members, "new_member" —
 * backs the "People" tab). No new table: every page is assembled by querying
 * each included source, merging, and re-paginating in memory.
 *
 * CURSOR / MERGE STRATEGY: for a page of size `limit`, we ask each included
 * source for its own top `limit + 1` rows after the cursor (via
 * `cursorPaginate`, which already knows how to decode/apply the
 * `(createdAt, id) < cursor` keyset predicate — `CommunityPost`,
 * `ForumThread`, and `Event` all satisfy its `{ id: string; createdAt: Date }`
 * constraint; `Profile`'s PK is `userId` rather than `id`, so its
 * `new_member` case builds the same `(createdAt, id) < cursor` predicate by
 * hand instead of going through `cursorPaginate`). This is enough to
 * guarantee correctness: the true global top-`(limit + 1)` rows across all
 * sources, restricted to any single source, can't rank worse than
 * `limit + 1` *within that source* — so if we fetch each source's own top
 * `limit + 1`, the merged set is guaranteed to contain the true global top
 * `limit + 1`. Sorting the merged candidates and taking the first
 * `limit + 1` therefore gives an exact answer, not an approximation.
 *
 * The cursor/`hasMore` for the *next* request is anchored to this raw,
 * pre-block-filter boundary (the `limit`-th candidate) — block/mute filtering
 * happens strictly after that boundary is fixed, so a page can come back
 * with fewer than `limit` items when some of its authors are blocked or
 * muted, but the next page's cursor never skips a row: it always continues
 * exactly where this page's underlying merge left off.
 */
@Injectable()
export class FeedService {
  constructor(
    @InjectRepository(CommunityPost)
    private readonly communityPosts: Repository<CommunityPost>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(ForumThread)
    private readonly forumThreads: Repository<ForumThread>,
    // ENG-132 / PRD-167: the feed reads `forum_post` for exactly two things,
    // both batched once per page in `forumThreadCards` — the live count of a
    // thread's non-deleted replies (the denormalized `forum_thread.reply_count`
    // counts tombstoned ones) and the opening post's body, for the card's
    // excerpt. Read-only, through the same redundant `forFeature`
    // registration every other borrowed repository here uses.
    @InjectRepository(ForumPost)
    private readonly forumPosts: Repository<ForumPost>,
    @InjectRepository(Event)
    private readonly events: Repository<Event>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    @InjectRepository(TopicFollow)
    private readonly topicFollows: Repository<TopicFollow>,
    // PRD-10: the viewer's own content-sensitivity switches. Registered
    // read-only through the same redundant `forFeature` idiom every other
    // borrowed repository here uses, so `FeedModule` never has to import
    // `PreferencesModule` and no module edge is added in either direction.
    @InjectRepository(MemberPreferences)
    private readonly memberPreferences: Repository<MemberPreferences>,
    // PRD-107: the magazine's published archive and its bylines, registered
    // read-only through the same redundant `forFeature` idiom every other
    // borrowed repository here uses, so `FeedModule` never has to import
    // `MagazineModule` (which it could not do without a cycle, and which
    // exports no repository anyway). Every write to both tables stays with
    // the desk's own services.
    @InjectRepository(MagazineArticle)
    private readonly magazineArticles: Repository<MagazineArticle>,
    @InjectRepository(MagazineAuthor)
    private readonly magazineAuthors: Repository<MagazineAuthor>,
    private readonly blockFilter: BlockFilterService,
    // ENG-131: "hide my profile from this person". The member directory
    // applies it in-query (`ProfilesService.directoryBaseQuery`); the feed's
    // two new-member sources announce the same people, so they have to apply
    // the identical gate or the feed becomes the way around it.
    private readonly hiddenFrom: HiddenFromService,
    private readonly connectionsService: ConnectionsService,
    private readonly feedInteractions: FeedInteractionsService,
    private readonly feedMutes: FeedMuteService,
  ) {}

  /**
   * Takedown subject codes, matching what each domain's OWN read path already
   * filters on so the feed can never disagree with the surface it links to:
   * `event` (`EventsService.SUBJECT_TYPE`), and `post`/`reply` for community
   * posts and forum OPs (`CommunityPostsService.SUBJECT_TYPES` /
   * `ForumPostsService.SUBJECT_TYPES` — a forum thread is reported through its
   * OP *post*, keyed by that post's uuid, which is why the thread predicate
   * below goes through `forum_post` rather than the thread id).
   */
  private static readonly EVENT_SUBJECT_TYPES = ['event'];
  private static readonly POST_SUBJECT_TYPES = ['post', 'reply'];

  /**
   * Drops rows whose subject carries a moderator takedown — hidden OR removed.
   *
   * BOTH states are excluded, unlike `ContentModerationService.excludeHidden`
   * (which keeps removed rows so a thread can render them as `[removed]`): the
   * aggregated feed has no tombstone rendering, so a removed item would surface
   * with its real title, summary and deep link. Same shape and same reasoning as
   * `EventsService.excludeModeratedEvents`, applied in-query so a fixed-size
   * candidate page isn't under-filled and the merge boundary stays exact.
   *
   * `subjectIdColumn` is spliced verbatim into raw SQL — pass a literal alias
   * reference, never user input. It is cast to `text` because
   * `content_moderation.subject_id` is `varchar` while every candidate id is a
   * `uuid`. Call at most once per query builder (fixed bound-parameter name).
   */
  private excludeModerated<E extends ObjectLiteral>(
    qb: SelectQueryBuilder<E>,
    subjectTypes: readonly string[],
    subjectIdColumn: string,
  ): void {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "content_moderation" "feed_cm"
        WHERE "feed_cm"."subject_type" IN (:...feedModerationSubjectTypes)
          AND "feed_cm"."subject_id" = ${subjectIdColumn}::text
          AND ("feed_cm"."hidden_at" IS NOT NULL OR "feed_cm"."removed_at" IS NOT NULL)
      )`,
      { feedModerationSubjectTypes: [...subjectTypes] },
    );
  }

  /**
   * The forum variant of {@link excludeModerated}: a thread has no
   * `content_moderation` row of its own — moderators take down its OPENING
   * POST (`forum_post.is_op`), which is what the client reports and what
   * `ForumPostsService` reads. A thread whose OP is hidden or removed is
   * therefore dropped from the feed, where only its title and category would
   * have shown anyway (with a deep link straight into the withheld body).
   */
  private excludeModeratedForumThreads(
    qb: SelectQueryBuilder<ForumThread>,
  ): void {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "forum_post" "feed_op"
        JOIN "content_moderation" "feed_cm"
          ON "feed_cm"."subject_type" IN (:...feedModerationSubjectTypes)
         AND "feed_cm"."subject_id" = "feed_op"."id"::text
        WHERE "feed_op"."thread_id" = t.id
          AND "feed_op"."is_op" = true
          AND ("feed_cm"."hidden_at" IS NOT NULL OR "feed_cm"."removed_at" IS NOT NULL)
      )`,
      { feedModerationSubjectTypes: [...FeedService.POST_SUBJECT_TYPES] },
    );
  }

  /**
   * `joinedWithinDays` (PRD-168) bounds the two new-member sources to members
   * who joined within that many days, and nothing else: a post or a gathering
   * is never filtered by it. It exists for the sidebar's "New this week"
   * widget, which asks the People tab for its rows and so used to render the
   * newest members whenever they joined, months ago included, under a heading
   * that promises this week. The People TAB passes nothing and is unchanged.
   *
   * `lang` (PRD-107) is the reader's chosen language, narrowed by
   * `toArticleLocale`. It only ever affects the `magazine_article` source,
   * where a piece with a published translation in that language is SHOWN in
   * it. Anything the magazine does not publish in is a missing preference
   * rather than an error, exactly as `MagazineService` treats it.
   */
  async getFeed(
    viewerId: string,
    tab: FeedTab | undefined,
    cursor: string | undefined,
    limit: number = DEFAULT_LIMIT,
    joinedWithinDays?: number,
    lang?: string,
  ): Promise<CursorPage<FeedItem>> {
    const resolvedTab = tab ?? 'all';
    const readerLocale = toArticleLocale(lang);
    const joinedSince =
      joinedWithinDays && joinedWithinDays > 0
        ? new Date(Date.now() - joinedWithinDays * MILLISECONDS_PER_DAY)
        : undefined;
    // SOC-18: "show me less of this" applies to every tab, including the
    // scoped ones — a member who turned a community down should not meet it
    // again by tapping Communities. One small indexed read per request.
    // PRD-10: the content-sensitivity switches, resolved once per request
    // alongside the mutes and applied in exactly the same place, for exactly
    // the same reason. Filtering these out AFTER the merge would under-fill
    // the page and make a member pay for their own filter with content from
    // everywhere else.
    //
    // EVERY TAB, including `communities`, matching how SOC-18 decided the same
    // question for mutes. A member who switched a category off is asking for a
    // quieter feed rather than a quieter "All" tab, and finding the thing they
    // filtered by tapping Communities would read as the filter being broken.
    // Their membership is untouched: the room, its own page, its threads and
    // every direct link work exactly as before.
    const [mutedSources, excludedTags] = await Promise.all([
      this.feedMutes.mutedSources(viewerId),
      this.excludedContentTagsFor(viewerId),
    ]);
    if (resolvedTab === 'all') {
      return this.getRankedAllFeed(
        viewerId,
        cursor,
        limit,
        mutedSources,
        excludedTags,
        joinedSince,
        readerLocale,
      );
    }
    const sources = this.sourcesForTab(resolvedTab);
    // Personalizes the community_post/gathering/forum_thread source cases to
    // the viewer's own memberships when serving the `communities` tab (Task
    // 6) — see the per-case `if (membershipScoped)` branches below.
    // `community_new_member` needs no branch: it's already inherently
    // viewer-scoped (Task 5).
    const membershipScoped = resolvedTab === 'communities';
    // DISC-2: personalizes the same three author-bearing sources to the
    // viewer's ACCEPTED connections when serving the `connections` tab —
    // orthogonal to `membershipScoped` (never both true at once, since each
    // is tied to its own tab). `null` means "not scoped this way" (every
    // other tab); resolved once per request rather than per source, since
    // all three branches below filter against the exact same id set.
    const connectionAuthorIds =
      resolvedTab === 'connections'
        ? await this.connectionsService.allAcceptedConnectionUserIds(viewerId)
        : null;

    const perSourceLimit = limit + 1;
    const candidateLists = await Promise.all(
      sources.map((source) =>
        this.fetchCandidates(
          source,
          viewerId,
          cursor,
          perSourceLimit,
          membershipScoped,
          connectionAuthorIds,
          mutedSources,
          excludedTags,
          { joinedSince },
          readerLocale,
        ),
      ),
    );
    const merged = candidateLists.flat().sort(compareCandidatesDesc);

    const globalPage = merged.slice(0, limit + 1);
    const hasMore = globalPage.length > limit;
    const pageCandidates = hasMore ? globalPage.slice(0, limit) : globalPage;
    const lastCandidate = pageCandidates[pageCandidates.length - 1];
    const nextCursor =
      hasMore && lastCandidate ? encodeCursor(lastCandidate) : null;

    const visible = await this.dropBlocked(viewerId, pageCandidates);
    const data = await this.toFeedItems(visible, viewerId);

    return { data, pageInfo: { nextCursor, hasMore } };
  }

  /**
   * The "All" tab (SOC-04). Same union of sources and the same visibility
   * rules as before; what changes is the ORDER, and only for a member who has
   * actually joined, connected or followed something.
   *
   * A chronological WINDOW of `limit * RANK_WINDOW_PAGES` candidates is
   * fetched, ranked, and served one page at a time out of that window. The
   * cursor carries the window's chronological boundary plus how far into its
   * ranked order we already are — see `feed-ranked-cursor.ts` for why ranking
   * cannot reuse a plain keyset cursor, and why re-ranking the same window on
   * the next request is guaranteed to reproduce the same order.
   *
   * A member with no memberships, no accepted connections and no followed
   * topics skips ranking entirely (`isEmptyGraph`): they get the identical
   * reverse-chronological feed that existed before this, at the old cost.
   *
   * ENG-134: the window is ANCHORED. The first request stamps `anchorAt` and
   * every source query bounds itself to `createdAt <= anchorAt`, so page two
   * re-materialises the same window instead of re-reading whatever the top of
   * the table has become. Before this, the first window had no ceiling at all
   * (`windowCursor` is undefined on a first request), so a post made between
   * two taps of "Load more" pushed into the window, shifted the ranked order
   * under the offset already served, and the member saw a card twice or lost
   * one. The cursor also carries the last key served, so a row LEAVING the
   * window (deleted, muted, its author blocked) cannot shuffle the offset
   * either. See `feed-ranked-cursor.ts`.
   */
  private async getRankedAllFeed(
    viewerId: string,
    cursor: string | undefined,
    limit: number,
    mutedSources: MutedFeedSources,
    excludedTags: ExcludedContentTags,
    joinedSince: Date | undefined,
    readerLocale: ArticleLocale | null,
  ): Promise<CursorPage<FeedItem>> {
    const { windowCursor, offset, anchorAt, lastKey } =
      decodeRankedCursor(cursor);
    const graph = await this.viewerGraph(viewerId);
    const windowSize = limit * RANK_WINDOW_PAGES;
    // A first request (and a legacy cursor, which carries no anchor) stamps
    // its own. Every later page in the same scroll carries this exact instant
    // back, which is what makes the window a stable set of rows.
    const windowAnchorAt = anchorAt ?? new Date();

    const candidateLists = await Promise.all(
      this.sourcesForTab('all').map((source) =>
        this.fetchCandidates(
          source,
          viewerId,
          windowCursor,
          windowSize + 1,
          false,
          null,
          mutedSources,
          excludedTags,
          { createdAtAtMost: windowAnchorAt, joinedSince },
          readerLocale,
        ),
      ),
    );
    const merged = candidateLists.flat().sort(compareCandidatesDesc);

    const windowSlice = merged.slice(0, windowSize + 1);
    const hasMoreBeyondWindow = windowSlice.length > windowSize;
    const windowCandidates = hasMoreBeyondWindow
      ? windowSlice.slice(0, windowSize)
      : windowSlice;
    const windowBoundary = windowCandidates[windowCandidates.length - 1];

    // Community rows for the whole window: a post's followed-topic match is
    // made against its COMMUNITY's tags, so they have to be resolved before
    // ranking rather than during the final mapping. The map is handed on to
    // `toFeedItems` so the page costs one `IN` query, not two.
    const communityById = await this.communitiesByIds(
      collectCommunityIds(windowCandidates),
    );

    const scoreByCandidate = new Map<string, number>();
    const reasonByCandidate = new Map<string, FeedReason>();
    const topicByCandidate = new Map<string, string | null>();
    for (const candidate of windowCandidates) {
      const facts = affinityFactsOf(candidate, communityById);
      const { score, reason } = scoreAffinity(facts, graph);
      const key = candidateKey(candidate);
      scoreByCandidate.set(key, score);
      reasonByCandidate.set(key, reason);
      topicByCandidate.set(key, matchedTopicSlug(facts.tags, graph));
    }

    const ranked = isEmptyGraph(graph)
      ? windowCandidates
      : interleaveByAffinity(
          windowCandidates,
          (candidate) => scoreByCandidate.get(candidateKey(candidate)) ?? 0,
          compareCandidatesDesc,
        );

    // Where this page actually starts. The offset is the fallback, not the
    // authority: if the last card the previous page served is still in the
    // re-ranked window we continue from immediately after it, which stays
    // correct even when a row left the window between the two requests (and
    // would otherwise have pulled an unseen card up into the slot the offset
    // skips past). A last key that is gone falls back to the raw offset.
    const startIndex = lastKey
      ? (() => {
          const foundIndex = ranked.findIndex(
            (candidate) => candidateKey(candidate) === lastKey,
          );
          return foundIndex === -1 ? offset : foundIndex + 1;
        })()
      : offset;

    const pageCandidates = ranked.slice(startIndex, startIndex + limit);
    const nextOffset = startIndex + limit;
    const pageBoundary = pageCandidates[pageCandidates.length - 1];
    let nextCursor: string | null = null;
    if (nextOffset < ranked.length) {
      // Still inside this window: advance the offset, keep the window and its
      // anchor, and record the boundary this page ended on. That boundary is
      // the RAW (pre-block-filter) last candidate, matching how the
      // chronological tabs anchor their own cursor.
      nextCursor = encodeRankedCursor(
        windowCursor,
        nextOffset,
        windowAnchorAt,
        pageBoundary ? candidateKey(pageBoundary) : undefined,
      );
    } else if (hasMoreBeyondWindow && windowBoundary) {
      // Window exhausted: seek past its chronological boundary and start a
      // fresh ranked window from offset zero. The anchor rides along so the
      // NEXT window is stable for its own pages too; it can only ever be
      // above the new window cursor, so it never excludes a row that window
      // would otherwise have contained.
      nextCursor = encodeRankedCursor(
        encodeCursor(windowBoundary),
        0,
        windowAnchorAt,
        undefined,
      );
    }
    const hasMore = nextCursor !== null;

    const visible = await this.dropBlocked(viewerId, pageCandidates);
    const data = await this.toFeedItems(visible, viewerId, {
      communityById,
      reasonByCandidate,
      topicByCandidate,
    });

    return { data, pageInfo: { nextCursor, hasMore } };
  }

  /**
   * The three explicit graph facts the "All" tab ranks on (SOC-04), resolved
   * once per request. Every one of them is something the member did on
   * purpose and can undo: leave the community, remove the connection, unfollow
   * the topic. Nothing here is derived from what they looked at.
   */
  private async viewerGraph(viewerId: string): Promise<ViewerGraph> {
    const [memberships, connectionUserIds, follows] = await Promise.all([
      this.communityMembers.find({ where: { userId: viewerId } }),
      this.connectionsService.allAcceptedConnectionUserIds(viewerId),
      this.topicFollows.find({ where: { userId: viewerId } }),
    ]);
    return {
      communityIds: new Set(
        memberships.map((membership) => membership.communityId),
      ),
      connectionUserIds: new Set(connectionUserIds),
      followedTopicSlugs: new Set(follows.map((follow) => follow.topicSlug)),
    };
  }

  // --- internals ---

  /**
   * The viewer's own content-sensitivity switches, resolved into the tag sets
   * the candidate queries exclude on (PRD-10).
   *
   * NO ROW MEANS DEFAULTS, and the default is "show me everything": a member
   * who has never opened Settings has no `member_preferences` row at all, and
   * `PreferencesService` synthesises one rather than 404ing. Reading it
   * directly here keeps that contract without a service dependency, and a
   * missing row short-circuits to the shared empty value, so the overwhelming
   * majority of requests add one primary-key lookup and no predicates.
   */
  private async excludedContentTagsFor(
    viewerId: string,
  ): Promise<ExcludedContentTags> {
    const row = await this.memberPreferences.findOne({
      where: { userId: viewerId },
      select: {
        hideDatingContent: true,
        hideMentalHealthContent: true,
        hideSexualityIdentityContent: true,
      },
    });
    return excludedContentTags(row);
  }

  /**
   * "This item's community carries a tag the viewer opted out of."
   *
   * `&&` is the array-overlap operator, served by the GIN index
   * `IDX_communities_tags` that `AddCommunityTags` created for exactly this
   * shape of predicate. Written as a correlated `NOT EXISTS` rather than a
   * join for the reason every other gate in this method is: `cursorPaginate`
   * runs `.take() + getMany()`, and TypeORM's join path cannot emit the raw
   * ORDER BY those queries need.
   *
   * A flat/global item has no community and therefore no tags to be judged
   * on, so `IS NULL` keeps it. That is the honest answer rather than a
   * convenient one: nothing about an untagged item says it belongs to the
   * category the member switched off.
   *
   * `communityIdColumn` is spliced verbatim into raw SQL. Pass a literal
   * alias reference, never user input. Call at most once per query builder
   * (fixed bound-parameter name).
   */
  private excludeSensitiveCommunities<E extends ObjectLiteral>(
    qb: SelectQueryBuilder<E>,
    communityIdColumn: string,
    communityTags: string[],
  ): void {
    qb.andWhere(
      `(${communityIdColumn} IS NULL OR NOT EXISTS (
        SELECT 1 FROM "communities" "feed_sensitive_com"
        WHERE "feed_sensitive_com"."id" = ${communityIdColumn}
          AND "feed_sensitive_com"."tags" && :feedExcludedCommunityTags
      ))`,
      { feedExcludedCommunityTags: communityTags },
    );
  }

  /**
   * The ranked window's ceiling (ENG-134), applied to whichever column that
   * source orders on. No-op when there is no anchor, which is every
   * chronological tab: they seek on a real keyset cursor and never drift.
   *
   * `createdAtColumn` is spliced verbatim into raw SQL, so pass a literal
   * alias reference, never user input. Call at most once per query builder
   * (fixed bound-parameter name).
   */
  private applyWindowCeiling<E extends ObjectLiteral>(
    qb: SelectQueryBuilder<E>,
    createdAtColumn: string,
    createdAtAtMost: Date | undefined,
  ): void {
    if (!createdAtAtMost) return;
    qb.andWhere(`${createdAtColumn} <= :feedWindowAnchor`, {
      feedWindowAnchor: createdAtAtMost,
    });
  }

  /** `tab` -> which sources are unioned. `people` unions just `new_member`;
   * `all` includes it alongside the other three, so recently-joined members
   * surface in the unfiltered feed too. `communities` unions all four
   * membership-scoped sources (Task 6) — note it uses
   * `community_new_member`, NOT the global `new_member` that `all`/`people`
   * use, since this tab is personalized to the viewer's own communities.
   * `connections` (DISC-2) unions the three author-bearing sources —
   * `community_post`, `forum_thread`, `gathering` — each additionally
   * author-scoped to the viewer's accepted connections in `fetchCandidates`
   * (the `connectionAuthorIds` branches below). It deliberately excludes
   * `new_member`/`community_new_member`: those sources surface a PROFILE as
   * the candidate itself (the newly-joined member), not something a member
   * AUTHORED, so "from your connections" doesn't apply to them.
   *
   * PRD-107 adds `magazine_article` to `all` ONLY, and the other five tabs
   * each say why on their own terms rather than by omission:
   *  - `communities` and `connections` are personalizations, and a magazine
   *    piece has neither a community roster nor a member author to be scoped
   *    by. Its byline is a `magazine_author` row that frequently belongs to
   *    no account at all, so "posted by someone you are connected to" has
   *    nothing to test.
   *  - `gatherings` and `people` are single-source tabs naming exactly what
   *    they hold.
   *  - `posts` unions the two things a MEMBER writes into a shared room. A
   *    commissioned, edited and published piece is not one of those, and
   *    folding it in would make the tab's name untrue.
   * The magazine's own front (`/magazine`) remains where a reader browses the
   * archive; this puts published work on the home screen, which is what it
   * never reached. */
  private sourcesForTab(tab: FeedTab): SourceKind[] {
    switch (tab) {
      case 'communities':
        return [
          'community_post',
          'gathering',
          'forum_thread',
          'community_new_member',
        ];
      case 'connections':
        return ['community_post', 'forum_thread', 'gathering'];
      case 'gatherings':
        return ['gathering'];
      case 'posts':
        return ['community_post', 'forum_thread'];
      case 'people':
        return ['new_member'];
      case 'all':
      default:
        return [
          'community_post',
          'forum_thread',
          'gathering',
          'new_member',
          'magazine_article',
        ];
    }
  }

  private async fetchCandidates(
    kind: SourceKind,
    viewerId: string,
    cursor: string | undefined,
    limit: number,
    membershipScoped: boolean,
    // DISC-2: non-null on the `connections` tab only. An empty array means
    // the viewer has zero accepted connections — short-circuit to no
    // candidates rather than issuing an `IN ()` query (invalid SQL, and a
    // wasted round-trip either way).
    connectionAuthorIds: string[] | null = null,
    // SOC-18: the sources this viewer asked their feed to show less of.
    // Applied here, alongside the block filter's spiritual sibling, so a
    // muted room never even reaches the merge: filtering it out afterwards
    // would under-fill the page and let the mute cost the member content
    // from everywhere else.
    mutedSources: MutedFeedSources = NO_MUTED_SOURCES,
    // PRD-10: the tag sets this viewer's content-sensitivity switches exclude
    // on. Applied here for the same reason the mutes are: an opted-out item
    // must never enter the merge, or the filter costs the member a slot on
    // their page instead of a card they did not want.
    excludedTags: ExcludedContentTags = NO_EXCLUDED_CONTENT_TAGS,
    // ENG-134 / PRD-168: when a candidate may have happened. Both bounds are
    // applied in-query for the same reason every other gate here is, so a
    // fixed-size candidate page is never under-filled by a filter that runs
    // after the merge.
    timeBounds: FeedTimeBounds = NO_TIME_BOUNDS,
    // PRD-107: the reader's language, used by the `magazine_article` source
    // alone to swap a piece for its published translation. `null` means "no
    // preference expressed", which serves every piece as written.
    readerLocale: ArticleLocale | null = null,
  ): Promise<Candidate[]> {
    if (connectionAuthorIds !== null && connectionAuthorIds.length === 0) {
      return [];
    }
    const { communityIds: mutedCommunityIds, forumThreadIds: mutedThreadIds } =
      mutedSources;
    const { communityTags: excludedCommunityTags, itemTags: excludedItemTags } =
      excludedTags;
    const { createdAtAtMost, joinedSince } = timeBounds;
    switch (kind) {
      case 'community_post': {
        // Soft-deleted posts are tombstoned in-place in a community's own feed
        // (they render as "[deleted]"), but the aggregated feed has no
        // tombstone rendering — so surfacing one would leak its original
        // `body`. Redact it from the feed entirely.
        //
        // Access-tier / membership gate (mirrors the gathering branch's "don't
        // leak non-public content into a general feed" intent): a post scoped
        // to a community only surfaces when that community isn't `private`, OR
        // the viewer is a member of it — otherwise a private, invite-only
        // community's post bodies and deep links would leak to non-members via
        // the feed. A flat/global post (`community_id IS NULL`, see
        // `CommunityPost.communityId`) is scoped to no community's roster and
        // stays visible to everyone.
        //
        // Expressed as correlated EXISTS subqueries rather than an innerJoin
        // for the same reason the `new_member` branch below is join-free:
        // `cursorPaginate` runs `.take() + getMany()` with a raw
        // `date_trunc(...)` ORDER BY, and TypeORM's `.take()`+join "distinct
        // pagination" path can't emit that raw expression correctly.
        const qb = this.communityPosts
          .createQueryBuilder('cp')
          .where('cp.deletedAt IS NULL');
        // A moderator takedown outranks every visibility rule below it: a
        // hidden/removed post must not reach the feed, which has no tombstone
        // rendering and would surface its real title, 220-char body excerpt
        // and deep link.
        this.excludeModerated(qb, FeedService.POST_SUBJECT_TYPES, '"cp"."id"');
        if (membershipScoped) {
          // `communities` tab (Task 6): drop the access-tier gate entirely
          // and restrict to communities the viewer belongs to — this also
          // drops flat/global posts (`community_id IS NULL`), which have no
          // community roster to be a member of.
          qb.andWhere(
            `cp.community_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM "community_members" "mem"
               WHERE "mem"."community_id" = cp.community_id AND "mem"."user_id" = :viewerId)`,
            { viewerId },
          );
        } else {
          qb.andWhere(
            `(
              cp.community_id IS NULL
              OR EXISTS (
                SELECT 1 FROM "communities" "com"
                WHERE "com"."id" = cp.community_id
                  AND "com"."access_tier" != :privateTier
              )
              OR EXISTS (
                SELECT 1 FROM "community_members" "mem"
                WHERE "mem"."community_id" = cp.community_id
                  AND "mem"."user_id" = :viewerId
              )
            )`,
            { privateTier: AccessTier.Private, viewerId },
          );
        }
        if (mutedCommunityIds.length) {
          // A muted community is silenced whole: its posts, and (below) its
          // threads, its gatherings and its new-member rows. A flat/global
          // post has no community to mute, so `IS NULL` keeps it.
          qb.andWhere(
            '(cp.community_id IS NULL OR cp.community_id NOT IN (:...mutedCommunityIds))',
            { mutedCommunityIds },
          );
        }
        if (excludedCommunityTags.length) {
          // PRD-10: a post scoped to a community whose curated tags carry a
          // sensitivity the viewer switched off. A flat/global post has no
          // community to classify, so it stays.
          this.excludeSensitiveCommunities(
            qb,
            'cp.community_id',
            excludedCommunityTags,
          );
        }
        if (connectionAuthorIds !== null) {
          // `connections` tab (DISC-2): on top of whichever visibility gate
          // above applied, restrict to posts authored by one of the
          // viewer's accepted connections. Stacked, not swapped-in — a
          // connection's post in a private community the viewer hasn't
          // joined must still stay hidden.
          qb.andWhere('cp.author_id IN (:...connectionAuthorIds)', {
            connectionAuthorIds,
          });
        }
        // `true`: `CommunityPost.createdAt` is migrated to `timestamptz(3)`
        // (see `1785001400000-NarrowCursorCreatedAtPrecision.ts`), so
        // `cursorPaginate` orders/filters on the raw column instead of
        // wrapping it in a non-indexable `date_trunc(...)` — served by
        // `IDX_community_posts_created_at_id`
        // (`1785001500000-AddFeedCursorIndexes.ts`).
        this.applyWindowCeiling(qb, '"cp"."created_at"', createdAtAtMost);
        const { rows } = await cursorPaginate(qb, cursor, limit, 'cp', true);
        return rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          type: 'community_post' as const,
          authorId: row.authorId,
          row,
        }));
      }
      case 'forum_thread': {
        const qb = this.forumThreads.createQueryBuilder('t');
        // Takedown of the thread's OP: see `excludeModeratedForumThreads`.
        this.excludeModeratedForumThreads(qb);
        // Contract C2 (PRD-160). "Delete" on a thread soft-deletes the THREAD
        // and tombstones its opening post; the feed filtered neither, so a
        // deleted thread stayed on the home screen with its full title and a
        // live link into a 404. Both predicates are here rather than one:
        // `forum_thread.deleted_at` is the thread-level delete, and
        // `forum_post.deleted_at` on the OP catches a thread whose opening
        // post was tombstoned on its own (which leaves the feed card
        // pointing at "[deleted]" with the real title still showing, since
        // the feed has no tombstone rendering).
        //
        // Written as raw column references rather than through the entity's
        // properties, so the feed's gate does not depend on the shape of
        // `ForumThread`'s own mapping. The columns are `forum_thread.
        // deleted_at` and `forum_post.deleted_at`, both owned by the forum's
        // delete paths; `SnakeNamingStrategy` names them exactly this way.
        qb.andWhere('"t"."deleted_at" IS NULL');
        qb.andWhere(
          `NOT EXISTS (
            SELECT 1 FROM "forum_post" "feed_deleted_op"
            WHERE "feed_deleted_op"."thread_id" = t.id
              AND "feed_deleted_op"."is_op" = true
              AND "feed_deleted_op"."deleted_at" IS NOT NULL
          )`,
        );
        if (membershipScoped) {
          // `communities` tab (Task 6): restrict to threads posted in
          // communities the viewer belongs to.
          qb.andWhere(
            `t.community_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM "community_members" "mem"
               WHERE "mem"."community_id" = t.community_id AND "mem"."user_id" = :viewerId)`,
            { viewerId },
          );
        } else {
          // Access-tier / membership gate, mirroring the `community_post`
          // branch above (and `ForumThreadsService`'s read paths): a thread
          // scoped to a Private community only surfaces when the viewer is on
          // its roster — otherwise a private community's thread titles and deep
          // links would leak to non-members via the general feed. A
          // flat/global thread (`community_id IS NULL`) and threads in
          // non-Private communities stay visible to everyone.
          qb.andWhere(
            `(
              t.community_id IS NULL
              OR EXISTS (
                SELECT 1 FROM "communities" "com"
                WHERE "com"."id" = t.community_id
                  AND "com"."access_tier" != :privateTier
              )
              OR EXISTS (
                SELECT 1 FROM "community_members" "mem"
                WHERE "mem"."community_id" = t.community_id
                  AND "mem"."user_id" = :viewerId
              )
            )`,
            { privateTier: AccessTier.Private, viewerId },
          );
        }
        if (mutedThreadIds.length) {
          // Per-thread mute: the one conversation, wherever it lives.
          qb.andWhere('t.id NOT IN (:...mutedThreadIds)', { mutedThreadIds });
        }
        if (mutedCommunityIds.length) {
          qb.andWhere(
            '(t.community_id IS NULL OR t.community_id NOT IN (:...mutedCommunityIds))',
            { mutedCommunityIds },
          );
        }
        if (excludedCommunityTags.length) {
          this.excludeSensitiveCommunities(
            qb,
            't.community_id',
            excludedCommunityTags,
          );
        }
        if (excludedItemTags.length) {
          // PRD-10, and this is the branch that reaches flat/global threads:
          // a thread carries its OWN freeform tags, so it can be classified
          // without belonging to a community at all. `&&` overlap, served by
          // `IDX_forum_thread_tags`. The set includes the hyphen-free
          // spellings, so a thread tagged `#mentalhealth` is caught alongside
          // one tagged `#mental-health`.
          qb.andWhere('NOT (t.tags && :excludedItemTags)', {
            excludedItemTags,
          });
        }
        if (connectionAuthorIds !== null) {
          // `connections` tab (DISC-2): see the matching branch in
          // `community_post` above — same stacked-not-swapped rationale.
          qb.andWhere('t.author_id IN (:...connectionAuthorIds)', {
            connectionAuthorIds,
          });
        }
        // `true`: `ForumThread.createdAt` is migrated to `timestamptz(3)`
        // (see `1785001400000-NarrowCursorCreatedAtPrecision.ts`), so the
        // keyset ORDER BY can use the existing `IDX_forum_thread_created_at_id`
        // (`1782800210000-AddForum.ts`) instead of the non-indexable
        // `date_trunc(...)` wrapper. The access-tier gate above narrows the
        // scan with correlated EXISTS subqueries rather than a join, keeping
        // the single-query keyset-pagination path (same reasoning as the
        // `community_post` branch).
        this.applyWindowCeiling(qb, '"t"."created_at"', createdAtAtMost);
        const { rows } = await cursorPaginate(qb, cursor, limit, 't', true);
        return rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          type: 'forum_thread' as const,
          authorId: row.authorId,
          row,
        }));
      }
      case 'gathering': {
        // Only surface events a general/unpersonalized feed reasonably can:
        // published (not draft/cancelled) and not invite-only (an
        // invite-only event's existence shouldn't leak to non-invitees via
        // the feed — that would need a per-viewer invite check this
        // aggregation doesn't do). The general feed's set is exactly
        // public/members — unchanged. The `communities` tab (membershipScoped
        // below) ALSO admits `community`-visibility gatherings: fix round 2
        // (Task B) — the membership EXISTS check right below already proves
        // the viewer is on that exact community's roster, so a `community`
        // -visibility event hosted under it is provably theirs to see; it was
        // simply never in the base visibility set for this case to widen.
        // `network`/`extended_network`/`invite_only` are deliberately NOT
        // added here — those aren't "provably visible because of THIS
        // community membership" the way `community` is; they need the real
        // per-event/per-viewer connection or invite check
        // (`EventAudienceGateService`), which this read-time aggregation
        // doesn't run (same reasoning invite_only was already excluded for).
        const visibilities = membershipScoped
          ? [
              EventVisibility.Public,
              EventVisibility.Members,
              EventVisibility.Community,
            ]
          : [EventVisibility.Public, EventVisibility.Members];
        const qb = this.events
          .createQueryBuilder('e')
          .where('e.status = :status', { status: EventStatus.Published })
          .andWhere('e.visibility IN (:...visibilities)', { visibilities });
        // Same takedown exclusion `EventsService.excludeModeratedEvents`
        // applies to browse + search, so a moderator-hidden gathering can no
        // longer be reached through the feed instead.
        this.excludeModerated(qb, FeedService.EVENT_SUBJECT_TYPES, '"e"."id"');
        if (membershipScoped) {
          // `communities` tab (Task 6): restrict to gatherings hosted by
          // communities the viewer belongs to.
          qb.andWhere(
            `e.community_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM "community_members" "mem"
               WHERE "mem"."community_id" = e.community_id AND "mem"."user_id" = :viewerId)`,
            { viewerId },
          );
        }
        if (mutedCommunityIds.length) {
          qb.andWhere(
            '(e.community_id IS NULL OR e.community_id NOT IN (:...mutedCommunityIds))',
            { mutedCommunityIds },
          );
        }
        if (excludedCommunityTags.length) {
          // PRD-10. A gathering has no tags column of its own, so the only
          // thing that can classify it is the community hosting it. One
          // hosted by nobody stays: see `excludeSensitiveCommunities`.
          this.excludeSensitiveCommunities(
            qb,
            'e.community_id',
            excludedCommunityTags,
          );
        }
        if (connectionAuthorIds !== null) {
          // `connections` tab (DISC-2): restrict to gatherings hosted by one
          // of the viewer's accepted connections. The base public/members
          // visibility set above still applies underneath — a connection
          // hosting a private/invite-only gathering doesn't leak it here.
          qb.andWhere('e.host_id IN (:...connectionAuthorIds)', {
            connectionAuthorIds,
          });
        }
        // `true`: `Event.createdAt` is migrated to `timestamptz(3)` (see
        // `1785001400000-NarrowCursorCreatedAtPrecision.ts`), so the general
        // feed's `status`+`visibility` filter (public/members) can be served
        // by the partial index `IDX_events_feed_created_at_id`
        // (`1785001500000-AddFeedCursorIndexes.ts`), which was built to match
        // that exact predicate. The `membershipScoped` branch's WIDENED set
        // (adds `community`) no longer matches the index's own
        // `visibility IN ('public','members')` predicate — a query admitting
        // `community` rows is no longer a subset of what the index covers, so
        // Postgres can't use it for this branch (fix round 2, Task B: noted,
        // not fixed here — the `communities` tab is a much smaller
        // per-viewer slice than the open feed, and the query still has
        // `e.community_id IS NOT NULL AND EXISTS(...)` plus
        // `IDX_events_community_id` to fall back on; revisit only if a
        // measurement shows this tab is actually slow).
        this.applyWindowCeiling(qb, '"e"."created_at"', createdAtAtMost);
        const { rows } = await cursorPaginate(qb, cursor, limit, 'e', true);
        return rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          type: 'gathering' as const,
          authorId: row.hostId,
          row,
        }));
      }
      case 'new_member': {
        // Recently-joined ACTIVE members, newest-first. Reads `profiles`
        // directly (no dedicated feed table, same idiom as the other three
        // sources). `Profile`'s PK is `userId` (not `id`), so it can't
        // satisfy `cursorPaginate`'s generic constraint — the same
        // `(createdAt, id) < cursor` keyset predicate is built by hand here
        // instead, mirroring `cursor-pagination.ts`'s millisecond-truncated
        // comparison so same-millisecond rows can't fall through the page
        // boundary. Excludes the viewer's own profile (mirrors
        // `ProfilesService#loadRelated`'s `p.user_id != :self`) — you
        // already know you joined, so you shouldn't see yourself as a "new
        // member" in your own feed.
        // NB: the active-user filter is a correlated EXISTS rather than an
        // innerJoin on purpose. TypeORM's `.take()` + join combination forces
        // getMany() down its two-query "distinct pagination" path, which can't
        // handle the raw `date_trunc(...)` ORDER BY below (it splits the
        // expression on '.' and treats a fragment as an alias name). Keeping
        // this join-free preserves the simple single-query path where the raw
        // ORDER BY is emitted verbatim.
        const qb = this.profiles
          .createQueryBuilder('p')
          .where('p.user_id != :viewerId', { viewerId })
          .andWhere(
            `EXISTS (SELECT 1 FROM "users" "u" WHERE "u"."id" = "p"."user_id" AND "u"."status" = :active)`,
            { active: UserStatus.Active },
          );

        // ENG-131. The member directory refuses to show two kinds of member,
        // and this source announces exactly the same people with their name,
        // tagline or bio and a link to the profile the directory would not
        // hand over. Both gates are copied predicate-for-predicate from
        // `ProfilesService.directoryBaseQuery`, and applied IN-QUERY like
        // that one so a page still fills to `limit` instead of coming back
        // short.
        //
        // "Hide me for 24 hours": a live `hidden_until` takes the member out
        // of every viewer's results, so it is not scoped to `viewerId`. They
        // can still reach their own profile directly, which is the owner
        // exception `findBySlugOrThrow` owns.
        qb.andWhere(
          '("p"."hidden_until" IS NULL OR "p"."hidden_until" <= now())',
        );
        // "Hide my profile from this person": directional, so it drops the
        // row only for the viewer the member hid from.
        this.hiddenFrom.excludeHiddenFrom(qb, viewerId, '"p"."user_id"');

        if (joinedSince) {
          // PRD-168: "New this week" means this week. Bounding the source
          // rather than trimming the page keeps the widget honest AND keeps
          // the answer cheap: nobody joined, nothing comes back.
          qb.andWhere('"p"."created_at" >= :feedJoinedSince', {
            feedJoinedSince: joinedSince,
          });
        }
        this.applyWindowCeiling(qb, '"p"."created_at"', createdAtAtMost);

        const createdAtExpr = `date_trunc('milliseconds', "p"."created_at")`;
        qb.orderBy(createdAtExpr, 'DESC').addOrderBy('p.user_id', 'DESC');

        const decoded = cursor ? decodeCursor(cursor) : null;
        if (decoded) {
          qb.andWhere(
            `(${createdAtExpr}, p.user_id) < (:cursorCreatedAt, :cursorId)`,
            { cursorCreatedAt: decoded.createdAt, cursorId: decoded.id },
          );
        }

        // PRD-10 deliberately does NOT filter this source. A new member is a
        // person, and `profiles.tags` holds the skills they listed rather than
        // subject matter, so there is nothing here a content-sensitivity
        // switch could honestly classify. Filtering people by an identity tag
        // would be a different feature with a much worse name.
        const rows = await qb.take(limit).getMany();
        return rows.map((row) => ({
          id: row.userId,
          createdAt: row.createdAt,
          type: 'new_member' as const,
          authorId: row.userId,
          row,
        }));
      }
      case 'community_new_member': {
        // Recently-joined ACTIVE members of communities the VIEWER also
        // belongs to, newest-first ("X joined {community}" — Task 5; not
        // unioned into any tab yet, see the `SourceKind` docstring).
        // `CommunityMember`'s PK IS `id` (unlike `Profile`'s `userId`-keyed
        // PK above), so this could in principle go through `cursorPaginate`
        // — but it's kept hand-rolled and join-free for the same reason the
        // `new_member` case above is: the membership+active-user filters
        // below are correlated EXISTS subqueries, and TypeORM's `.take()`
        // forces an innerJoin down the two-query "distinct pagination" path,
        // which can't emit the raw `date_trunc(...)` ORDER BY verbatim.
        //
        // `m.user_id != :viewerId` excludes the viewer's own membership rows
        // (mirrors `new_member`'s `p.user_id != :viewerId` — you already
        // know you joined). The first EXISTS restricts to memberships of
        // communities the viewer is ALSO a member of (a self-join on
        // `community_members` by `community_id`); the second is the same
        // active-user gate `new_member` applies.
        const qb = this.communityMembers
          .createQueryBuilder('m')
          .where('m.user_id != :viewerId', { viewerId })
          .andWhere(
            `EXISTS (
              SELECT 1 FROM "community_members" "self"
              WHERE "self"."community_id" = m.community_id
                AND "self"."user_id" = :viewerId
            )`,
            { viewerId },
          )
          .andWhere(
            `EXISTS (SELECT 1 FROM "users" "u" WHERE "u"."id" = "m"."user_id" AND "u"."status" = :active)`,
            { active: UserStatus.Active },
          );

        // ENG-131, the same two profile privacy gates the `new_member` source
        // above applies. This source's candidate row is a MEMBERSHIP rather
        // than a profile, so the self-hide has to reach across to `profiles`
        // by the joining member's user id; the hidden-from filter takes that
        // same column and is otherwise identical. "X joined {community}"
        // carries the member's name and a link to their profile, so a member
        // who hid themself (or hid from this one viewer) must not be
        // announced here either.
        qb.andWhere(
          `NOT EXISTS (
            SELECT 1 FROM "profiles" "feed_hidden_profile"
            WHERE "feed_hidden_profile"."user_id" = "m"."user_id"
              AND "feed_hidden_profile"."hidden_until" > now()
          )`,
        );
        this.hiddenFrom.excludeHiddenFrom(qb, viewerId, '"m"."user_id"');

        if (joinedSince) {
          // PRD-168: the same "recently joined" bound the global new-member
          // source takes, so a caller asking for a dated window gets one from
          // whichever new-member source its tab unions.
          qb.andWhere('"m"."joined_at" >= :feedJoinedSince', {
            feedJoinedSince: joinedSince,
          });
        }
        this.applyWindowCeiling(qb, '"m"."joined_at"', createdAtAtMost);

        if (mutedCommunityIds.length) {
          qb.andWhere('m.community_id NOT IN (:...mutedCommunityIds)', {
            mutedCommunityIds,
          });
        }
        if (excludedCommunityTags.length) {
          // PRD-10: "X joined {community}" names the room in the card, so a
          // member who asked not to see a category should not meet it as a
          // join announcement either. `m.community_id` is NOT NULL here, so
          // the helper's flat-item branch never fires.
          this.excludeSensitiveCommunities(
            qb,
            'm.community_id',
            excludedCommunityTags,
          );
        }

        const joinedAtExpr = `date_trunc('milliseconds', "m"."joined_at")`;
        qb.orderBy(joinedAtExpr, 'DESC').addOrderBy('m.id', 'DESC');

        const decoded = cursor ? decodeCursor(cursor) : null;
        if (decoded) {
          qb.andWhere(
            `(${joinedAtExpr}, m.id) < (:cursorCreatedAt, :cursorId)`,
            { cursorCreatedAt: decoded.createdAt, cursorId: decoded.id },
          );
        }

        const rows = await qb.take(limit).getMany();
        return rows.map((row) => ({
          id: row.id,
          createdAt: row.joinedAt,
          type: 'community_new_member' as const,
          authorId: row.userId,
          row,
        }));
      }
      case 'magazine_article': {
        // PRD-107. Published magazine journalism, newest-published first.
        //
        // VISIBILITY is exactly the predicate every public magazine read
        // already uses (`MagazineService.listArticles`,
        // `MagazineFrontService.resolveRunOrder`, `getArticleBySlug`):
        // `published_at` set, and not in the future. Nothing else gates it.
        // In particular `lifecycle` deliberately does NOT: an archived or
        // superseded piece is still a piece a member may read, which is the
        // whole point of the lifecycle states (see `MagazineArticle.
        // lifecycle`), and one publishes with a `published_at` old enough
        // that it cannot crowd the top of a feed anyway. There is also no
        // takedown gate to apply here: `content_moderation` has no
        // `magazine_article` subject type, because the desk retires a piece
        // by unpublishing it, which this predicate already respects.
        //
        // ORDERED BY `published_at`, not `created_at`: a piece drafted in
        // March and shipped today belongs at the top of today's feed. That
        // also makes the source's own keyset a different column from the
        // default one `cursorPaginate` knows, so the same hand-rolled
        // `(column, id) < cursor` predicate the two new-member sources build
        // is built here — on the RAW column rather than through a
        // `date_trunc('milliseconds', ...)` wrapper, because
        // `magazine_article.published_at` is only ever written from a JS
        // `Date` (`MagazinePieceService.setArticlePublishState`, the seed) and
        // is therefore already at the cursor's own millisecond resolution.
        // Keeping it raw is what lets the partial index
        // `IDX_magazine_article_published_at`
        // (`("published_at" DESC) WHERE "published_at" IS NOT NULL`) serve
        // both the ORDER BY and the seek; no new index is needed, and one on
        // `(published_at, id)` would be redundant with it.
        const qb = this.magazineArticles
          .createQueryBuilder('article')
          // Project only what the candidate and its card read. The full row
          // carries the block-editor `blocks` jsonb, the legacy `body` text
          // and `contentNotes` — the heaviest rows in the module, and none of
          // them reach a feed card. Same projection discipline as
          // `MagazineService.listArticles`.
          .select([
            'article.id',
            'article.slug',
            'article.title',
            'article.dek',
            'article.kicker',
            'article.section',
            'article.readMinutes',
            'article.heroImageKey',
            'article.socialImage',
            'article.publishedAt',
            'article.authorId',
            'article.tags',
            'article.locale',
            'article.translationOfArticleId',
          ])
          .where('article.published_at IS NOT NULL')
          .andWhere('article.published_at <= :magazineNow', {
            magazineNow: new Date(),
          })
          // CON-16: only CANONICAL pieces are candidates. A translation is a
          // first-class published row with its own slug, so without this one
          // piece would occupy two feed slots, in two languages, one above
          // the other. The reader's language is honoured by SUBSTITUTION
          // below instead, which is the same answer the archive gives.
          .andWhere('article.translation_of_article_id IS NULL');
        if (excludedItemTags.length) {
          // PRD-10, the same branch the forum thread source uses and for the
          // same reason: a piece carries its own editorial tags, so it can be
          // classified without belonging to a community at all.
          qb.andWhere('NOT (article.tags && :excludedItemTags)', {
            excludedItemTags,
          });
        }
        // Neither mute set can name a magazine piece: `feed_source_mutes`
        // holds community ids and forum thread ids, and a piece has neither.
        // Nor can `excludedCommunityTags`, for the same reason. The only
        // reader-side filter that reaches this source is the item-tag one
        // above, plus the block filter applied after the merge.
        this.applyWindowCeiling(
          qb,
          '"article"."published_at"',
          createdAtAtMost,
        );

        const publishedAtExpr = '"article"."published_at"';
        qb.orderBy(publishedAtExpr, 'DESC').addOrderBy('article.id', 'DESC');
        const decoded = cursor ? decodeCursor(cursor) : null;
        if (decoded) {
          qb.andWhere(
            `(${publishedAtExpr}, article.id) < (:cursorCreatedAt, :cursorId)`,
            { cursorCreatedAt: decoded.createdAt, cursorId: decoded.id },
          );
        }

        const canonicalRows = await qb.take(limit).getMany();
        if (!canonicalRows.length) {
          return [];
        }
        // Two batched lookups for the whole candidate list, never one per
        // piece: the bylines (which is also where `authorId` comes from, so
        // the block filter has something to check) and, only when the reader
        // asked for a language the archive is not written in, the published
        // translations that displace them.
        const [bylineByAuthorId, displayedByCanonicalId] = await Promise.all([
          this.magazineBylinesFor(canonicalRows),
          this.magazineTranslationsFor(canonicalRows, readerLocale),
        ]);
        return canonicalRows.flatMap((row) => {
          const publishedAt = row.publishedAt;
          // Unreachable: the predicate above admits no NULL. Written as a
          // guard rather than an assertion so a future change to that
          // predicate cannot produce an `Invalid Date` cursor.
          if (!publishedAt) return [];
          const byline = bylineByAuthorId.get(row.authorId) ?? null;
          return [
            {
              id: row.id,
              createdAt: publishedAt,
              type: 'magazine_article' as const,
              // The byline's linked MEMBER, when it has one. A contributor
              // credited by name only has no account to block, exactly like
              // the erased author of a tombstoned post.
              authorId: byline?.userId ?? null,
              row,
              magazine: {
                displayed: displayedByCanonicalId.get(row.id) ?? row,
                byline,
              },
            },
          ];
        });
      }
    }
  }

  /**
   * PRD-107: the `magazine_author` row behind each candidate piece, in one
   * `IN` query for the whole list.
   *
   * Resolved during candidate fetching rather than during mapping because
   * `MagazineAuthor.userId` is what a magazine candidate's `authorId` is, and
   * `dropBlocked` runs before `toFeedItems`. A card whose byline belongs to
   * someone the viewer blocked must never reach the home screen, byline
   * included.
   */
  private async magazineBylinesFor(
    articles: MagazineArticle[],
  ): Promise<Map<string, MagazineAuthor>> {
    const authorIds = [...new Set(articles.map((article) => article.authorId))];
    if (!authorIds.length) return new Map();
    const rows = await this.magazineAuthors.find({
      where: { id: In(authorIds) },
    });
    return new Map(rows.map((author) => [author.id, author]));
  }

  /**
   * PRD-107 / CON-16: canonical article id -> the published translation in
   * the reader's language, where the desk has shipped one.
   *
   * A SUBSTITUTION, matching `MagazineService.preferTranslations` exactly: an
   * issue is almost never translated all at once, so filtering to
   * `locale = 'pt'` would hand a Portuguese reader a near-empty feed and hide
   * journalism from them. Substituting gives them everything, in Portuguese
   * where it exists and in English where it does not, and each item states
   * its own `locale` so the card can say which it got.
   *
   * The substitution changes only what the card SHOWS. The row's position in
   * the feed stays the canonical piece's `(published_at, id)`, so a
   * translation shipped a week after the original cannot pull the piece back
   * to the top of the feed for a Portuguese reader, and the merge boundary
   * means the same thing for every reader.
   *
   * NO query at all on the default locale (every original is already in it)
   * or with no preference expressed, which is the overwhelming majority of
   * requests.
   */
  private async magazineTranslationsFor(
    articles: MagazineArticle[],
    readerLocale: ArticleLocale | null,
  ): Promise<Map<string, MagazineArticle>> {
    if (
      !readerLocale ||
      readerLocale === DEFAULT_ARTICLE_LOCALE ||
      !articles.length
    ) {
      return new Map();
    }
    const translations = await this.magazineArticles
      .createQueryBuilder('article')
      // Same projection as the candidate query, so a substituted row maps
      // through `magazineArticleToFeedItem` identically to a canonical one.
      .select([
        'article.id',
        'article.slug',
        'article.title',
        'article.dek',
        'article.kicker',
        'article.section',
        'article.readMinutes',
        'article.heroImageKey',
        'article.socialImage',
        'article.publishedAt',
        'article.authorId',
        'article.tags',
        'article.locale',
        'article.translationOfArticleId',
      ])
      .where('article.translation_of_article_id IN (:...canonicalIds)', {
        canonicalIds: articles.map((article) => article.id),
      })
      .andWhere('article.locale = :readerLocale', { readerLocale })
      // A translation still in draft is not something a reader can open, so
      // it never displaces the original they CAN read.
      .andWhere('article.published_at IS NOT NULL')
      .andWhere('article.published_at <= :magazineNow', {
        magazineNow: new Date(),
      })
      .getMany();
    const byCanonicalId = new Map<string, MagazineArticle>();
    for (const translation of translations) {
      if (translation.translationOfArticleId) {
        byCanonicalId.set(translation.translationOfArticleId, translation);
      }
    }
    return byCanonicalId;
  }

  /** Drops candidates whose author is blocked either way relative to the
   * viewer (spec §2), OR whom the viewer has muted (I10 —
   * `BlockFilterService.isMutedBy`'s docstring says a muted author's content
   * should be "hidden from feeds/lists"; unlike a block, a mute is
   * one-directional and never affects what the muted author themself sees).
   * Dedupes the author list first so a prolific author with several items on
   * the page is only checked once. */
  private async dropBlocked(
    viewerId: string,
    candidates: Candidate[],
  ): Promise<Candidate[]> {
    if (!candidates.length) return [];
    const authorIds = [
      ...new Set(
        candidates
          .map((c) => c.authorId)
          .filter((authorId): authorId is string => authorId !== null),
      ),
    ];
    const hiddenAuthorIds = await this.blockFilter.hiddenUserIds(
      viewerId,
      authorIds,
    );
    // A null `authorId` (erased author, tombstoned post) has no one to
    // block-check against, so it's never hidden on that basis.
    return candidates.filter(
      (c) => c.authorId === null || !hiddenAuthorIds.has(c.authorId),
    );
  }

  /** Batched community lookup shared by the ranking window and the final
   *  mapping, so a ranked page resolves its communities exactly once. */
  private async communitiesByIds(
    communityIds: string[],
  ): Promise<Map<string, Community>> {
    if (!communityIds.length) return new Map();
    const rows = await this.communities.find({
      where: { id: In(communityIds) },
    });
    return new Map(rows.map((community) => [community.id, community]));
  }

  /**
   * The two things a forum card needs that the `forum_thread` row cannot tell
   * it, for a whole page in ONE grouped query (ENG-132 and PRD-167).
   *
   * `forum_thread.reply_count` is incremented when a reply is created and
   * never decremented when one is tombstoned, so a thread whose three replies
   * were all deleted still advertised "3 replies" on its card. Counting live
   * here is the cheaper of the two corrections available: the excerpt below
   * needs a `forum_post` read for this exact set of threads anyway, so the
   * count rides along in the same aggregate for no extra round trip, and the
   * answer stays right no matter what the denormalized column does.
   *
   * The excerpt is the opening post's body (PRD-167): the forum card was the
   * only feed card with no content preview at all.
   *
   * `deleted_at IS NULL` covers both halves at once: a tombstoned reply is
   * not counted, and a tombstoned OP yields no body, so the excerpt is null
   * rather than the withheld text. The aggregate is keyed on `thread_id`,
   * which `IDX_forum_post_thread_id_created_at_id` leads on, and it runs once
   * per page rather than once per thread.
   */
  private async forumThreadCards(
    threadIds: string[],
  ): Promise<Map<string, ForumThreadCard>> {
    const cards = new Map<string, ForumThreadCard>();
    if (!threadIds.length) return cards;

    const rows = await this.forumPosts
      .createQueryBuilder('fp')
      .select('"fp"."thread_id"', 'thread_id')
      .addSelect('MAX(CASE WHEN "fp"."is_op" THEN "fp"."body" END)', 'op_body')
      .addSelect('COUNT(*) FILTER (WHERE NOT "fp"."is_op")', 'reply_count')
      .where('"fp"."thread_id" IN (:...threadIds)', { threadIds })
      .andWhere('"fp"."deleted_at" IS NULL')
      .groupBy('"fp"."thread_id"')
      .getRawMany<{
        thread_id: string;
        op_body: string | null;
        reply_count: string;
      }>();

    for (const row of rows) {
      cards.set(row.thread_id, {
        excerpt: toForumExcerpt(row.op_body),
        // Postgres returns `count(*)` as bigint, which the driver hands back
        // as a string so a value past 2^53 cannot silently lose precision.
        replyCount: Number(row.reply_count),
      });
    }
    return cards;
  }

  /**
   * What ranking worked out about this page, threaded into the mapping so the
   * response can say WHY each item is here (SOC-04). Absent on every tab but
   * `all`, where the tab itself is the explanation.
   */
  private static readonly NO_RANKING: {
    communityById: Map<string, Community>;
    reasonByCandidate: Map<string, FeedReason>;
    topicByCandidate: Map<string, string | null>;
  } | null = null;

  /** Batched mapping for a page of merged candidates: one `IN`-query for
   * authors, one for communities and one pair for interaction counts across
   * the whole page, mirroring `ForumThreadsService.toThreadResponses`'s
   * batched-lookup idiom. */
  private async toFeedItems(
    candidates: Candidate[],
    viewerId: string,
    ranking: {
      communityById: Map<string, Community>;
      reasonByCandidate: Map<string, FeedReason>;
      topicByCandidate: Map<string, string | null>;
    } | null = FeedService.NO_RANKING,
  ): Promise<FeedItem[]> {
    if (!candidates.length) return [];

    const authorIds = [
      ...new Set(
        candidates
          .map((c) => c.authorId)
          .filter((authorId): authorId is string => authorId !== null),
      ),
    ];

    // Both `community_post` (nullable `communityId` — a flat/global post has
    // none) and `community_new_member` (always scoped to a community) need a
    // community row resolved, and a ranked page also needs the community
    // behind a thread or gathering to name its "you're in X" reason. Reuses
    // the ranking window's map when there is one, so the page never issues
    // the same `IN` query twice.
    // SOC-04: the interaction counts that let a `community_post` card react
    // and reply inline, two grouped queries for the whole page.
    const postIds = candidates
      .filter((c) => c.type === 'community_post')
      .map((c) => c.id);
    // ENG-132/PRD-167: the live reply count and the OP excerpt for every
    // forum card on this page, one grouped query alongside the others.
    const threadIds = candidates
      .filter((c) => c.type === 'forum_thread')
      .map((c) => c.id);
    const [authors, communityById, interactionsByPostId, threadCards] =
      await Promise.all([
        new MemberLookup(this.profiles).byUserIds(authorIds),
        ranking
          ? Promise.resolve(ranking.communityById)
          : this.communitiesByIds(collectCommunityIds(candidates)),
        this.feedInteractions.forPosts(postIds, viewerId),
        this.forumThreadCards(threadIds),
      ]);

    /**
     * The source this card came from, so its menu can offer "show me less of
     * this" (SOC-18). A forum thread names ITSELF rather than the community
     * it sits in: the card is one conversation, and quieting the whole room
     * from it would be a bigger act than the member asked for. Everything
     * else names its community, and a flat/global item names nothing.
     */
    const sourceFor = (
      candidate: Candidate,
      community: Community | null,
    ): FeedItemSource | null => {
      if (candidate.type === 'forum_thread') {
        const thread = candidate.row as ForumThread;
        return { kind: 'forum_thread', id: thread.id, name: thread.title };
      }
      if (!community) return null;
      return { kind: 'community', id: community.id, name: community.name };
    };

    /** The reason line for one candidate, resolved to something a member can
     *  read: the community's name, the actor's name, or the topic slug they
     *  follow. Only present on a ranked ("All") page; `source` is present
     *  everywhere. */
    const signalsFor = (
      candidate: Candidate,
      author: MemberRef | null,
      community: Community | null,
    ): FeedItemSignals => {
      const source = sourceFor(candidate, community);
      if (!ranking) return { source };
      const key = candidateKey(candidate);
      const reason = ranking.reasonByCandidate.get(key) ?? 'recent';
      let reasonSubject: string | null = null;
      if (reason === 'membership') {
        reasonSubject = community?.name ?? null;
      } else if (reason === 'connection') {
        reasonSubject = author
          ? `${author.firstName} ${author.lastName}`.trim()
          : null;
      } else if (reason === 'topic') {
        reasonSubject = ranking.topicByCandidate.get(key) ?? null;
      }
      return { source, reason, reasonSubject };
    };

    /** Reaction/reply state for a `community_post`, defaulting to the empty
     *  seed for a post nobody has touched yet. */
    const interactionsFor = (postId: string): FeedPostInteractions =>
      interactionsByPostId.get(postId) ?? EMPTY_POST_INTERACTIONS;

    return candidates.map((c) => {
      const author: MemberRef | null = c.authorId
        ? (authors.get(c.authorId) ?? null)
        : null;
      const communityId = communityIdOf(c);
      const community = communityId
        ? (communityById.get(communityId) ?? null)
        : null;
      const signals = signalsFor(c, author, community);
      switch (c.type) {
        case 'community_post': {
          const post = c.row as CommunityPost;
          const { reactionCount, replyCount, myReaction } = interactionsFor(
            post.id,
          );
          return {
            ...communityPostToFeedItem(post, community, author),
            ...signals,
            reactionCount,
            replyCount,
            myReaction,
          };
        }
        case 'forum_thread': {
          const thread = c.row as ForumThread;
          // A thread with no `forum_post` rows left at all (every post
          // tombstoned) has no card entry; the mapper's own fallback then
          // reports zero replies and no excerpt rather than the stale count.
          const card: ForumThreadCard = threadCards.get(thread.id) ?? {
            excerpt: null,
            replyCount: 0,
          };
          return {
            ...forumThreadToFeedItem(thread, author, card),
            ...signals,
          };
        }
        case 'gathering':
          return { ...eventToFeedItem(c.row as Event, author), ...signals };
        case 'new_member':
          return {
            ...newMemberToFeedItem(c.row as Profile, author),
            ...signals,
          };
        case 'community_new_member':
          return {
            ...communityNewMemberToFeedItem(
              c.id,
              c.createdAt,
              author,
              community,
            ),
            ...signals,
          };
        case 'magazine_article': {
          const canonical = c.row as MagazineArticle;
          // Resolved during candidate fetching (the byline is where this
          // candidate's `authorId` came from), so the mapping adds no query
          // of its own. The fallback keeps a piece readable rather than
          // dropping it if its byline row ever went missing.
          const magazine = c.magazine ?? {
            displayed: canonical,
            byline: null,
          };
          const byline: MagazineByline | null = magazine.byline
            ? {
                name: magazine.byline.name,
                slug: magazine.byline.slug,
                avatarUrl: toImageUrl(magazine.byline.avatarUrl),
              }
            : null;
          return {
            ...magazineArticleToFeedItem(
              canonical,
              magazine.displayed,
              byline,
              author,
            ),
            ...signals,
          };
        }
      }
    });
  }
}
