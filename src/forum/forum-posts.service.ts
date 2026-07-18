import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import {
  CursorPage,
  decodeCursor,
  encodeCursor,
} from '../common/cursor-pagination';
import { MemberLookup } from '../common/member-ref';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { ForumPostVote } from './entities/forum-post-vote.entity';
import { ForumPost } from './entities/forum-post.entity';
import { ForumThreadsService } from './forum-threads.service';
import { ForumPostResponse, toForumPostResponse } from './forum-response';

const DEFAULT_LIMIT = 20;

export interface VoteResult {
  voteCount: number;
  myVote: number;
}

@Injectable()
export class ForumPostsService {
  constructor(
    @InjectRepository(ForumPost)
    private readonly posts: Repository<ForumPost>,
    @InjectRepository(ForumPostVote)
    private readonly votes: Repository<ForumPostVote>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly threadsService: ForumThreadsService,
    private readonly blockFilter: BlockFilterService,
  ) {}

  // GET /forum/threads/:slug/posts?cursor= — OP + replies, oldest-first.
  // `cursorPaginate` (src/common/cursor-pagination.ts) is hard-wired to a
  // newest-first `(createdAt, id) DESC` keyset, which doesn't fit this
  // endpoint's contract ("OP is the first post, oldest-first" — see
  // forum.api.ts). `paginateOldestFirst` below reuses the same
  // `encodeCursor`/`decodeCursor` primitives (so the opaque cursor format is
  // identical) but walks `(createdAt, id) ASC` instead.
  async listPosts(
    threadSlug: string,
    viewerId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<ForumPostResponse>> {
    const thread = await this.threadsService.loadOr404(threadSlug, viewerId);

    const qb = this.posts
      .createQueryBuilder('p')
      .where('p.threadId = :threadId', { threadId: thread.id });
    // Posts by a blocked (either way) or muted author are dropped in-query, so
    // the keyset page below fills to `limit` with visible posts instead of
    // coming back short (see `BlockFilterService.excludeHidden`). NB: this can
    // hide the OP itself when the thread author is only *muted* — a muted
    // author's thread is still reachable by direct navigation (see
    // `ForumThreadsService.loadOr404`), but their posts stay silenced, which is
    // exactly what a mute means.
    this.blockFilter.excludeHidden(qb, viewerId, '"p"."author_id"');

    const { rows, nextCursor, hasMore } = await this.paginateOldestFirst(
      qb,
      cursor,
      limit ?? DEFAULT_LIMIT,
      'p',
    );

    return {
      data: await this.toPostResponses(rows, viewerId),
      pageInfo: { nextCursor, hasMore },
    };
  }

  // POST /forum/threads/:slug/posts — a reply (never the OP, which is
  // created alongside the thread by `ForumThreadsService.create`).
  async reply(
    threadSlug: string,
    authorId: string,
    body: string,
  ): Promise<ForumPostResponse> {
    // Passing the replier as viewer 404s the thread when its author is blocked
    // either way — a block is a hard severance, so it has to gate the write
    // path too, not just the reads above.
    const thread = await this.threadsService.loadOr404(threadSlug, authorId);
    if (thread.isLocked) {
      throw new ForbiddenException('This thread is locked');
    }

    const saved = await this.posts.save(
      this.posts.create({ threadId: thread.id, authorId, body, voteCount: 0 }),
    );
    await this.threadsService.markActivity(thread.id);

    const authors = await new MemberLookup(this.profiles).byUserIds([authorId]);
    return toForumPostResponse(saved, authors.get(authorId) ?? null, 0);
  }

  // POST /forum/posts/:id/vote — `value` is +1 (upvote) or 0 (remove vote).
  // Idempotent both ways: voting +1 twice or removing an absent vote is a
  // no-op rather than double-counting/going negative.
  async vote(
    postId: string,
    userId: string,
    value: number,
  ): Promise<VoteResult> {
    const post = await this.posts.findOne({ where: { id: postId } });
    if (!post) {
      throw new NotFoundException('Post not found');
    }

    const existing = await this.votes.findOne({ where: { postId, userId } });

    if (value === 1 && !existing) {
      await this.votes.save(this.votes.create({ postId, userId, value: 1 }));
      post.voteCount += 1;
      await this.posts.save(post);
    } else if (value === 0 && existing) {
      await this.votes.delete({ postId, userId });
      post.voteCount -= 1;
      await this.posts.save(post);
    }

    return { voteCount: post.voteCount, myVote: value };
  }

  // --- internals ---

  private async paginateOldestFirst(
    qb: SelectQueryBuilder<ForumPost>,
    cursor: string | undefined,
    limit: number,
    alias: string,
  ): Promise<{
    rows: ForumPost[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    qb.orderBy(`${alias}.createdAt`, 'ASC').addOrderBy(`${alias}.id`, 'ASC');

    const decoded = cursor ? decodeCursor(cursor) : null;
    if (decoded) {
      qb.andWhere(
        `(${alias}.createdAt, ${alias}.id) > (:cursorCreatedAt, :cursorId)`,
        { cursorCreatedAt: decoded.createdAt, cursorId: decoded.id },
      );
    }

    const rows = await qb.take(limit + 1).getMany();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = page[page.length - 1];

    return {
      rows: page,
      nextCursor: hasMore && lastRow ? encodeCursor(lastRow) : null,
      hasMore,
    };
  }

  // Batched mapping for a page of posts: one `IN`-query each for authors and
  // the viewer's own votes across the whole page instead of N+1 per-post
  // lookups (mirrors `CommunityPostsService.toPostDTOs`).
  private async toPostResponses(
    rows: ForumPost[],
    viewerId: string,
  ): Promise<ForumPostResponse[]> {
    if (!rows.length) return [];
    const postIds = rows.map((p) => p.id);
    const authorIds = [...new Set(rows.map((p) => p.authorId))];

    const [authors, myVoteRows] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds(authorIds),
      this.votes.find({ where: { postId: In(postIds), userId: viewerId } }),
    ]);

    const myVoteByPost = new Map(myVoteRows.map((v) => [v.postId, v.value]));

    return rows.map((post) =>
      toForumPostResponse(
        post,
        authors.get(post.authorId) ?? null,
        myVoteByPost.get(post.id) ?? 0,
      ),
    );
  }
}
