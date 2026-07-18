import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { CursorPage, cursorPaginate } from '../common/cursor-pagination';
import { BlockFilterService } from '../social/block-filter.service';
import { TopicPost } from './entities/topic-post.entity';
import { Topic } from './entities/topic.entity';
import { TopicPostResponse, toTopicPostResponse } from './topic-post-response';
import {
  RelatedTopicResponse,
  TopicDetailResponse,
  TopicResponse,
  toTopicDetailResponse,
  toTopicResponse,
} from './topic-response';

const DEFAULT_POSTS_LIMIT = 20;
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

  // GET /topics/:slug — the topic meta `TopicHeader`/`TopicSidebar` need.
  // `slug` is the topic's `tag` — the frontend has no separate slug field
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

  // GET /topics/:slug/posts?cursor= — the topic's post feed, newest first.
  //
  // Block/mute filtered in-query, like every other post surface, now that
  // `1782800720000-AddTopicPostAuthor` has given `topic_post` an `author_id`.
  //
  // Two things worth stating explicitly:
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
  //    two-query "distinct pagination" path — see the note at
  //    `src/feed/feed.service.ts:221-227`. Keeping this join-free preserves the
  //    single-query path and the keyset ORDER BY.
  //
  // In-query rather than post-query filtering so the keyset page fills to
  // `limit` with visible rows instead of coming back short.
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

    const { rows, nextCursor, hasMore } = await cursorPaginate(
      qb,
      cursor,
      limit ?? DEFAULT_POSTS_LIMIT,
      'tp',
    );

    return {
      data: rows.map(toTopicPostResponse),
      pageInfo: { nextCursor, hasMore },
    };
  }

  // --- internals ---

  private async loadOr404(slug: string): Promise<Topic> {
    const topic = await this.topics.findOne({
      where: { tag: slug.replace(/^#/, '').toLowerCase() },
    });
    if (!topic) {
      throw new NotFoundException('Topic not found');
    }
    return topic;
  }

  /** Other topics ranked by post volume, excluding self — generalizes the
   *  same rule the frontend's `getTopic()` fallback already applies for
   *  un-curated tags (`topics.data.tsx`: "the most-followed topics... as
   *  fallback related links") into the backend's related-topics rule for
   *  every topic, rather than a bespoke curated list per topic. */
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
