import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { CursorPage, cursorPaginate } from '../common/cursor-pagination';
import { escapeLikeTerm } from '../common/like-escape';
import { foldedHaystack, foldedSearchTerm } from '../search/search-text';
import { AccessTier } from '../communities/entities/community.entity';
import { ownRosterRowCountsSql } from '../communities/subcommunity-rules';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { forumThreadVisibleSql } from '../forum/forum-threads.service';
import { BlockFilterService } from '../social/block-filter.service';
import { TopicPost } from './entities/topic-post.entity';
import { Topic } from './entities/topic.entity';
import {
  TopicPostAuthorMask,
  TopicPostResponse,
  maskTopicPostAuthor,
  toTopicPostResponse,
  topicPostAuthorMaskFor,
} from './topic-post-response';
import { ERASED_AUTHOR_TOPIC_BYLINE } from './topic-post-link.service';
import {
  RelatedTopicResponse,
  TopicDetailResponse,
  TopicResponse,
  TopicSearchRow,
  toTopicDetailResponse,
  toTopicResponse,
  toTopicSearchRow,
} from './topic-response';

const DEFAULT_POSTS_LIMIT = 20;

/**
 * `content_moderation.subject_type` values a forum post can be filed under,
 * the same pair `FeedService.POST_SUBJECT_TYPES` and
 * `ForumPostsService.SUBJECT_TYPES` hold (both are private to their services).
 */
const TOPIC_POST_OP_MODERATION_SUBJECT_TYPES: readonly string[] = [
  'post',
  'reply',
];

/**
 * The `listPosts` gate on a row's linked forum thread, as one `andWhere`
 * string. `viewerParam` is the bound viewer id parameter name without its
 * colon; the caller also binds `:topicPostPublicTier` to `AccessTier.Public`
 * and `:...topicPostModerationSubjectTypes` to
 * `TOPIC_POST_OP_MODERATION_SUBJECT_TYPES`.
 *
 * `topic_post.body` is a write-time copy of the thread's opening post, so the
 * gate also drops a row whose opening post was tombstoned by its author or
 * hidden or removed by a moderator. Those are the feed's two opening-post
 * predicates (`FeedService`'s deleted-OP `NOT EXISTS` and
 * `excludeModeratedForumThreads`), copied here so a topic page stops serving
 * text the author retracted or staff took down, as the feed and search do.
 *
 * The community arms are the forum-wide test (no community, cross-posted, or
 * a public, top-level, unarchived community) plus the viewer's own roster row
 * counting (`ownRosterRowCountsSql`), so a member of a gated community still
 * finds that community's threads under the topics they are tagged with.
 */
function linkedThreadReadableSql(viewerParam: string): string {
  return `(
    "tp"."forum_thread_id" IS NULL
    OR EXISTS (
      SELECT 1 FROM "forum_thread" "t"
      WHERE "t"."id" = "tp"."forum_thread_id"
        AND "t"."deleted_at" IS NULL
        AND ${forumThreadVisibleSql('t')}
        AND NOT EXISTS (
          SELECT 1 FROM "forum_post" "topic_deleted_op"
          WHERE "topic_deleted_op"."thread_id" = "t"."id"
            AND "topic_deleted_op"."is_op" = true
            AND "topic_deleted_op"."deleted_at" IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM "forum_post" "topic_op"
          JOIN "content_moderation" "topic_cm"
            ON "topic_cm"."subject_type" IN (:...topicPostModerationSubjectTypes)
           AND "topic_cm"."subject_id" = "topic_op"."id"::text
          WHERE "topic_op"."thread_id" = "t"."id"
            AND "topic_op"."is_op" = true
            AND ("topic_cm"."hidden_at" IS NOT NULL OR "topic_cm"."removed_at" IS NOT NULL)
        )
        AND (
          "t"."community_id" IS NULL
          OR "t"."cross_posted" = true
          OR EXISTS (
            SELECT 1 FROM "communities" "topic_com"
            WHERE "topic_com"."id" = "t"."community_id"
              AND "topic_com"."access_tier" = :topicPostPublicTier
              AND "topic_com"."parent_id" IS NULL
              AND "topic_com"."archived_at" IS NULL
          )
          OR EXISTS (
            SELECT 1 FROM "community_members" "topic_mem"
            WHERE "topic_mem"."community_id" = "t"."community_id"
              AND "topic_mem"."user_id" = :${viewerParam}
              AND ${ownRosterRowCountsSql('"t"."community_id"', viewerParam)}
          )
        )
    )
  )`;
}
const RELATED_TOPICS_LIMIT = 6;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class TopicsService {
  constructor(
    @InjectRepository(Topic)
    private readonly topics: Repository<Topic>,
    @InjectRepository(TopicPost)
    private readonly topicPosts: Repository<TopicPost>,
    private readonly blockFilter: BlockFilterService,
  ) {}

  /** The full topic directory, most-posted first. */
  async list(): Promise<TopicResponse[]> {
    const rows = await this.topics.find({ order: { totalPosts: 'DESC' } });
    return rows.map(toTopicResponse);
  }

  // GET /topics/:slug: the topic meta `TopicHeader`/`TopicSidebar` need.
  // `slug` is the topic's `tag`; the frontend has no separate slug field
  // for topics (`topicPath()` in routeMap.ts routes on the tag directly).
  async getBySlug(slug: string): Promise<TopicDetailResponse> {
    const topic = await this.loadOr404(slug);

    const [relatedTopics, postsThisWeek] = await Promise.all([
      this.relatedTopics(topic),
      this.topicPosts.count({
        where: {
          topicId: topic.id,
          createdAt: MoreThanOrEqual(new Date(Date.now() - WEEK_MS)),
        },
      }),
    ]);

    return toTopicDetailResponse(topic, relatedTopics, postsThisWeek);
  }

  // GET /topics/:slug/posts?cursor=: the topic's post feed, newest first.
  //
  // Block/mute filtered in-query, like every other post surface, now that
  // `1782800720000-AddTopicPostAuthor` has given `topic_post` an `author_id`.
  //
  // Four things worth stating explicitly:
  //
  // 1. NULL-authored rows stay VISIBLE. Every seeded row has `author_id IS
  //    NULL` (the migration explains why no name-matching backfill was run),
  //    and `excludeHidden` is NULL-safe by construction: its correlated
  //    `NOT EXISTS` compares `blocked_id`/`muted_id` against `"tp"."author_id"`,
  //    and `<uuid> = NULL` is never true, so the subquery matches nothing and
  //    `NOT EXISTS` is TRUE. The filter therefore silences real members without
  //    swallowing the editorial seed content.
  // 2. `andWhere` only, no joins. `cursorPaginate` calls `getMany()` with
  //    `.take()`, and TypeORM's `.take()` + join combination switches to its
  //    two-query "distinct pagination" path (see the note at
  //    `src/feed/feed.service.ts:221-227`). Keeping this join-free preserves
  //    the single-query path and the keyset ORDER BY.
  // 3. A row linked to a forum thread shows only while that thread is one the
  //    viewer could open from the forum itself: not deleted, published and
  //    through review (`forumThreadVisibleSql`), and either forum-wide or in
  //    a community whose roster counts the viewer (`linkedThreadReadableSql`).
  //    Its opening post must also still stand: not tombstoned, and not hidden
  //    or removed by a moderator, since the row's body is a copy of it.
  //    Editorial rows (`forum_thread_id IS NULL`) pass untouched.
  // 4. A thread's byline flags are read fresh for the page and masked on the
  //    way out (`maskTopicPostAuthor`), which heals rows written with the
  //    writer's real name before `linkThread` masked them at write time.
  //
  // The filtering happens in-query so the keyset page fills to `limit` with
  // visible rows and never comes back short.
  async listPosts(
    slug: string,
    viewerId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<TopicPostResponse>> {
    const topic = await this.loadOr404(slug);

    const qb = this.topicPosts
      .createQueryBuilder('tp')
      .where('tp.topicId = :topicId', { topicId: topic.id });
    this.blockFilter.excludeHidden(qb, viewerId, '"tp"."author_id"');
    qb.andWhere(linkedThreadReadableSql('topicPostViewerId'), {
      topicPostPublicTier: AccessTier.Public,
      topicPostViewerId: viewerId,
      topicPostModerationSubjectTypes: [
        ...TOPIC_POST_OP_MODERATION_SUBJECT_TYPES,
      ],
    });

    const { rows, nextCursor, hasMore } = await cursorPaginate(
      qb,
      cursor,
      limit ?? DEFAULT_POSTS_LIMIT,
      'tp',
    );

    const { masks, erasedAuthorThreadIds } =
      await this.authorMasksByThreadId(rows);
    return {
      data: rows.map((row) => {
        const response = maskTopicPostAuthor(
          toTopicPostResponse(row),
          row.forumThreadId ? (masks.get(row.forumThreadId) ?? null) : null,
        );
        // ENG-494: a thread whose author erased their account shows the
        // generic byline, which also heals a row still carrying the stored
        // name from before the erasure scrub existed.
        if (
          !row.forumThreadId ||
          !erasedAuthorThreadIds.has(row.forumThreadId)
        ) {
          return response;
        }
        return {
          ...response,
          author: ERASED_AUTHOR_TOPIC_BYLINE.authorName,
          authorInitials: ERASED_AUTHOR_TOPIC_BYLINE.authorInitials,
          authorTone: ERASED_AUTHOR_TOPIC_BYLINE.authorTone,
        };
      }),
      pageInfo: { nextCursor, hasMore },
    };
  }

  // Global search (`SearchService`, `search/search.query.ts`'s `topic` type):
  // one accent-folded haystack over tag/label/description, the same
  // `search-text.ts` vocabulary the other `*.searchByText` methods on the
  // search fan-out use (e.g. `resources.service.ts`), so "saude" finds
  // "Saúde". Ordered by post volume like `list()` so a broad
  // query surfaces the most active topics first.
  async searchByText(term: string, limit: number): Promise<TopicSearchRow[]> {
    const pattern = `%${escapeLikeTerm(term)}%`;
    const rows = await this.topics
      .createQueryBuilder('topic')
      .where(
        `${foldedHaystack('topic', ['tag', 'label', 'description'])} LIKE ${foldedSearchTerm('pattern')} ESCAPE '\\'`,
        { pattern },
      )
      .orderBy('topic.totalPosts', 'DESC')
      .take(limit)
      .getMany();
    return rows.map(toTopicSearchRow);
  }

  // --- internals ---

  /**
   * The byline mask for each forum thread a page of topic posts links to, in
   * one batched read of the two flags and the author column. A thread with a
   * plain byline is absent from `masks`. `erasedAuthorThreadIds` holds the
   * unmasked threads whose author erased their account (ENG-494); a masked
   * thread keeps its mask, which already names nobody.
   */
  private async authorMasksByThreadId(rows: TopicPost[]): Promise<{
    masks: Map<string, TopicPostAuthorMask>;
    erasedAuthorThreadIds: Set<string>;
  }> {
    const threadIds = [
      ...new Set(
        rows
          .map((row) => row.forumThreadId)
          .filter((threadId): threadId is string => threadId !== null),
      ),
    ];
    const masks = new Map<string, TopicPostAuthorMask>();
    const erasedAuthorThreadIds = new Set<string>();
    if (!threadIds.length) return { masks, erasedAuthorThreadIds };
    const threads = await this.topicPosts.manager
      .createQueryBuilder(ForumThread, 'thread')
      .select([
        'thread.id',
        'thread.isAnonymous',
        'thread.isOfficial',
        'thread.authorId',
      ])
      .where('thread.id IN (:...threadIds)', { threadIds })
      .getMany();
    for (const thread of threads) {
      const mask = topicPostAuthorMaskFor(thread);
      if (mask) {
        masks.set(thread.id, mask);
      } else if (thread.authorId === null) {
        erasedAuthorThreadIds.add(thread.id);
      }
    }
    return { masks, erasedAuthorThreadIds };
  }

  private async loadOr404(slug: string): Promise<Topic> {
    const topic = await this.topics.findOne({
      where: { tag: slug.replace(/^#/, '').toLowerCase() },
    });
    if (!topic) {
      throw new NotFoundException('Topic not found');
    }
    return topic;
  }

  /** Other topics ranked by post volume, excluding self. Generalizes the
   *  same rule the frontend's `getTopic()` fallback already applies for
   *  un-curated tags (`topics.data.tsx`: "the most-followed topics... as
   *  fallback related links") into the backend's related-topics rule for
   *  every topic, so no topic needs a bespoke curated list. */
  private async relatedTopics(topic: Topic): Promise<RelatedTopicResponse[]> {
    const rows = await this.topics.find({
      order: { totalPosts: 'DESC' },
      take: RELATED_TOPICS_LIMIT + 1,
    });
    return rows
      .filter((t) => t.id !== topic.id)
      .slice(0, RELATED_TOPICS_LIMIT)
      .map((t) => ({ tag: t.tag, count: t.totalPosts }));
  }
}
