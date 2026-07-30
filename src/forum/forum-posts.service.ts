import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import {
  CursorPage,
  decodeCursor,
  encodeCursor,
} from '../common/cursor-pagination';
import { MemberLookup } from '../common/member-ref';
import { MentionNotificationService } from '../mentions/mention-notification.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import { ForumPostEdit } from './entities/forum-post-edit.entity';
import { ForumPostVote } from './entities/forum-post-vote.entity';
import { ForumPost } from './entities/forum-post.entity';
import { ForumThreadsService } from './forum-threads.service';
import {
  ForumPostHistoryResponse,
  ForumPostResponse,
  ForumPostViewer,
  toForumPostHistoryEntry,
  toForumPostResponse,
} from './forum-response';

const DEFAULT_LIMIT = 20;

export interface VoteResult {
  voteCount: number;
  myVote: number;
}

const MODERATOR_ROLES: readonly string[] = [UserRole.Moderator, UserRole.Admin];

function isModeratorRole(role: string): boolean {
  return MODERATOR_ROLES.includes(role);
}

function viewerOf(user: CurrentUserData): ForumPostViewer {
  return { userId: user.userId, isModerator: isModeratorRole(user.role) };
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
    @InjectRepository(ForumPostEdit)
    private readonly edits: Repository<ForumPostEdit>,
    private readonly mentions: MentionNotificationService,
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
    user: CurrentUserData,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<ForumPostResponse>> {
    const thread = await this.threadsService.loadOr404(threadSlug, user.userId);

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
    this.blockFilter.excludeHidden(qb, user.userId, '"p"."author_id"');

    const { rows, nextCursor, hasMore } = await this.paginateOldestFirst(
      qb,
      cursor,
      limit ?? DEFAULT_LIMIT,
      'p',
    );

    return {
      data: await this.toPostResponses(rows, user),
      pageInfo: { nextCursor, hasMore },
    };
  }

  // POST /forum/threads/:slug/posts — a reply (never the OP, which is
  // created alongside the thread by `ForumThreadsService.create`). An
  // optional `parentPostId` nests this reply under another post in the same
  // thread (a top-level comment on the thread otherwise) — see
  // `ForumPost.parentPostId`'s docstring.
  async reply(
    threadSlug: string,
    user: CurrentUserData,
    body: string,
    parentPostId?: string,
  ): Promise<ForumPostResponse> {
    // Passing the replier as viewer 404s the thread when its author is blocked
    // either way — a block is a hard severance, so it has to gate the write
    // path too, not just the reads above.
    const thread = await this.threadsService.loadOr404(threadSlug, user.userId);
    if (thread.isLocked) {
      throw new ForbiddenException('This thread is locked');
    }

    const parentPost = parentPostId
      ? await this.loadReplyParentOr400(parentPostId, thread.id)
      : null;

    const saved = await this.posts.save(
      this.posts.create({
        threadId: thread.id,
        authorId: user.userId,
        body,
        voteCount: 0,
        parentPostId: parentPost?.id ?? null,
      }),
    );
    await this.threadsService.markActivity(thread.id);

    const mentionNotifiedUserIds = await this.mentions.notify(
      body,
      user.userId,
      {
        actorId: user.userId,
        source: 'forum',
        threadSlug,
        postId: saved.id,
        excerpt: body.slice(0, 140),
      },
    );

    // Notify the parent post's author that their comment got a reply, via its
    // own `ForumReply` notification type — see
    // `MentionNotificationService.notifyParentReply` for the payload shape and
    // the self-reply skip. Skipped when the reply body already `@mentioned`
    // the parent author by name — `notify()` above will have already created
    // a Mention notification for them, and firing this one too would double-
    // notify/double-push the same person for the same reply.
    if (parentPost && !mentionNotifiedUserIds.has(parentPost.authorId)) {
      await this.mentions.notifyParentReply(parentPost.authorId, user.userId, {
        actorId: user.userId,
        source: 'forum',
        threadSlug,
        postId: saved.id,
        parentPostId: parentPost.id,
        excerpt: body.slice(0, 140),
      });
    }

    const authors = await new MemberLookup(this.profiles).byUserIds([
      user.userId,
    ]);
    return toForumPostResponse(
      saved,
      authors.get(user.userId) ?? null,
      0,
      viewerOf(user),
    );
  }

  // POST /forum/posts/:id/vote — `value` is +1 (upvote) or 0 (remove vote).
  // Idempotent both ways: voting +1 twice or removing an absent vote is a
  // no-op rather than double-counting/going negative.
  //
  // Concurrency-safe by construction: the whole toggle runs in one
  // transaction, the insert is `ON CONFLICT DO NOTHING` (`.orIgnore()`) so a
  // racing duplicate upvote can't raise a 23505 unique violation, and the
  // denormalized `voteCount` is only moved via SQL-level atomic
  // increment/decrement (`voteCount = voteCount + 1`) — never a
  // read-modify-write, which would lose updates under concurrent votes. The
  // counter is touched *only* when a row is genuinely inserted/deleted (the
  // insert's `RETURNING` row / the delete's `affected` count), so the two
  // idempotent no-op paths leave it untouched.
  async vote(
    postId: string,
    userId: string,
    value: number,
  ): Promise<VoteResult> {
    return this.posts.manager.transaction(async (manager) => {
      const post = await manager.findOne(ForumPost, { where: { id: postId } });
      if (!post) {
        throw new NotFoundException('Post not found');
      }

      if (value === 1) {
        const inserted = await manager
          .createQueryBuilder()
          .insert()
          .into(ForumPostVote)
          .values({ postId, userId, value: 1 })
          .orIgnore()
          .execute();
        // On conflict the row is skipped and no `RETURNING` row comes back;
        // only bump the count when this call is the one that inserted.
        const insertedRows = inserted.raw as unknown[];
        if (insertedRows.length > 0) {
          await manager.increment(ForumPost, { id: postId }, 'voteCount', 1);
        }
      } else if (value === 0) {
        const deleted = await manager.delete(ForumPostVote, { postId, userId });
        if (deleted.affected && deleted.affected > 0) {
          await manager.decrement(ForumPost, { id: postId }, 'voteCount', 1);
        }
      }

      // Re-read inside the transaction so the returned count reflects this
      // toggle (and any other votes committed before our row lock).
      const refreshed = await manager.findOne(ForumPost, {
        where: { id: postId },
      });
      return {
        voteCount: refreshed?.voteCount ?? post.voteCount,
        myVote: value,
      };
    });
  }

  // PATCH /forum/posts/:id — author-only body edit. Snapshots the pre-edit
  // body to `forum_post_edit`, stamps `editedAt`.
  async updatePostBody(
    postId: string,
    user: CurrentUserData,
    body: string,
  ): Promise<ForumPostResponse> {
    const post = await this.loadPostOr404(postId);
    if (post.deletedAt) {
      throw new NotFoundException('Post not found');
    }
    if (post.authorId !== user.userId) {
      throw new ForbiddenException('Only the author can edit this post');
    }

    // Snapshot the pre-edit body and persist the new one atomically: a partial
    // failure between the two writes would otherwise record a "previous body"
    // for an edit that never landed (a phantom revision).
    const previousBody = post.body;
    post.body = body;
    post.editedAt = new Date();
    await this.posts.manager.transaction(async (manager) => {
      await manager.save(
        manager.create(ForumPostEdit, {
          postId: post.id,
          previousBody,
          previousTitle: null,
          editorId: user.userId,
        }),
      );
      await manager.save(post);
    });

    return this.mapOne(post, user);
  }

  // DELETE /forum/posts/:id — soft tombstone. Author or platform staff.
  async tombstonePost(
    postId: string,
    user: CurrentUserData,
  ): Promise<ForumPostResponse> {
    const post = await this.loadPostOr404(postId);
    this.assertCanModerate(post, user);
    if (!post.deletedAt) {
      post.deletedAt = new Date();
      await this.posts.save(post);
    }
    return this.mapOne(post, user);
  }

  // POST /forum/posts/:id/restore — clear the tombstone. Author or staff.
  async restorePost(
    postId: string,
    user: CurrentUserData,
  ): Promise<ForumPostResponse> {
    const post = await this.loadPostOr404(postId);
    this.assertCanModerate(post, user);
    if (post.deletedAt) {
      post.deletedAt = null;
      await this.posts.save(post);
    }
    return this.mapOne(post, user);
  }

  // GET /forum/posts/:id/history — revisions, newest-first. Author or staff.
  async listHistory(
    postId: string,
    user: CurrentUserData,
  ): Promise<ForumPostHistoryResponse> {
    const post = await this.loadPostOr404(postId);
    this.assertCanModerate(post, user);

    const rows = await this.edits.find({
      where: { postId },
      order: { createdAt: 'DESC' },
    });
    const editorIds = [
      ...new Set(
        rows.map((row) => row.editorId).filter((id): id is string => !!id),
      ),
    ];
    const editors = await new MemberLookup(this.profiles).byUserIds(editorIds);

    return {
      revisions: rows.map((row) =>
        toForumPostHistoryEntry(
          row,
          row.editorId ? (editors.get(row.editorId) ?? null) : null,
        ),
      ),
    };
  }

  private assertCanModerate(post: ForumPost, user: CurrentUserData): void {
    if (post.authorId !== user.userId && !isModeratorRole(user.role)) {
      throw new ForbiddenException(
        'Only the author or a moderator can do that',
      );
    }
  }

  private async loadPostOr404(postId: string): Promise<ForumPost> {
    const post = await this.posts.findOne({ where: { id: postId } });
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    return post;
  }

  // Validates a reply's `parentPostId` before it's persisted: the parent must
  // exist, belong to the *same* thread (a nested reply can't point across
  // threads), and not be a tombstone (no replying to a deleted post).
  private async loadReplyParentOr400(
    parentPostId: string,
    threadId: string,
  ): Promise<ForumPost> {
    const parent = await this.posts.findOne({ where: { id: parentPostId } });
    if (!parent) {
      throw new NotFoundException('Parent post not found');
    }
    if (parent.threadId !== threadId) {
      throw new BadRequestException(
        'Parent post does not belong to this thread',
      );
    }
    if (parent.deletedAt) {
      throw new BadRequestException('Cannot reply to a deleted post');
    }
    return parent;
  }

  private async mapOne(
    post: ForumPost,
    user: CurrentUserData,
  ): Promise<ForumPostResponse> {
    const authors = await new MemberLookup(this.profiles).byUserIds([
      post.authorId,
    ]);
    const vote = await this.votes.findOne({
      where: { postId: post.id, userId: user.userId },
    });
    return toForumPostResponse(
      post,
      authors.get(post.authorId) ?? null,
      vote?.value ?? 0,
      viewerOf(user),
    );
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
    // Mirror `cursorPaginate`'s microsecond-vs-millisecond fix: `created_at` is
    // microsecond-precision `timestamptz`, but the cursor is a ms-resolution JS
    // `Date`. Comparing the ms cursor against the raw µs column would silently
    // drop a same-millisecond, nonzero-microsecond row at the page boundary.
    // Truncate the column to milliseconds in BOTH the ORDER BY and the WHERE
    // tuple so both sides match the cursor's resolution (see cursor-pagination.ts).
    const createdAtExpr = `date_trunc('milliseconds', "${alias}"."created_at")`;

    qb.orderBy(createdAtExpr, 'ASC').addOrderBy(`${alias}.id`, 'ASC');

    const decoded = cursor ? decodeCursor(cursor) : null;
    if (decoded) {
      qb.andWhere(
        `(${createdAtExpr}, ${alias}.id) > (:cursorCreatedAt, :cursorId)`,
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
    user: CurrentUserData,
  ): Promise<ForumPostResponse[]> {
    if (!rows.length) return [];
    const postIds = rows.map((post) => post.id);
    const authorIds = [...new Set(rows.map((post) => post.authorId))];

    const [authors, myVoteRows] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds(authorIds),
      this.votes.find({ where: { postId: In(postIds), userId: user.userId } }),
    ]);

    const myVoteByPost = new Map(
      myVoteRows.map((row) => [row.postId, row.value]),
    );
    const viewer = viewerOf(user);

    return rows.map((post) =>
      toForumPostResponse(
        post,
        authors.get(post.authorId) ?? null,
        myVoteByPost.get(post.id) ?? 0,
        viewer,
      ),
    );
  }
}
