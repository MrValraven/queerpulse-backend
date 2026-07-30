import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DataSource, Repository } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { CursorPage, cursorPaginate } from '../common/cursor-pagination';
import { escapeLikeTerm } from '../common/like-escape';
import { MemberLookup } from '../common/member-ref';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { MentionNotificationService } from '../mentions/mention-notification.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { ForumPostEdit } from './entities/forum-post-edit.entity';
import { ForumPost } from './entities/forum-post.entity';
import { ForumThread } from './entities/forum-thread.entity';
import { ForumThreadResponse, toForumThreadResponse } from './forum-response';

const DEFAULT_LIMIT = 20;
const MAX_SLUG_ATTEMPTS = 5;

export interface CreateThreadInput {
  title: string;
  body: string;
  category: string;
}

@Injectable()
export class ForumThreadsService {
  constructor(
    @InjectRepository(ForumThread)
    private readonly threads: Repository<ForumThread>,
    @InjectRepository(ForumPost)
    private readonly posts: Repository<ForumPost>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(ForumPostEdit)
    private readonly edits: Repository<ForumPostEdit>,
    private readonly dataSource: DataSource,
    private readonly blockFilter: BlockFilterService,
    private readonly mentions: MentionNotificationService,
  ) {}

  // GET /forum/threads?category=&cursor= — newest-first cursor page.
  async list(
    viewerId: string,
    category: string | undefined,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<ForumThreadResponse>> {
    const qb = this.threads.createQueryBuilder('t');
    // Threads by a member blocked either way, or one the viewer has muted,
    // never enter the page (spec §2). Applied to the query rather than to the
    // fetched rows so `cursorPaginate`'s `LIMIT` counts only visible threads —
    // post-query filtering (`FeedService.dropBlocked`) returns short pages.
    // `t`'s author column is `author_id` under `SnakeNamingStrategy`.
    this.blockFilter.excludeHidden(qb, viewerId, '"t"."author_id"');
    if (category) {
      qb.andWhere('t.category = :category', { category });
    }

    // `true`: `ForumThread.createdAt` is migrated to `timestamptz(3)` (see
    // `1785001400000-NarrowCursorCreatedAtPrecision.ts`), so the default
    // (no-`category`) listing can finally use the existing
    // `IDX_forum_thread_created_at_id` (`1782800210000-AddForum.ts`) instead
    // of a full scan + in-memory sort — that index was already shaped
    // correctly but unusable while this query's ORDER BY/WHERE went through
    // the non-indexable `date_trunc(...)` wrapper. Same index also serves
    // `FeedService`'s `forum_thread` branch, since both order the same
    // unfiltered `(created_at, id)` keyset.
    const { rows, nextCursor, hasMore } = await cursorPaginate(
      qb,
      cursor,
      limit ?? DEFAULT_LIMIT,
      't',
      true,
    );

    return {
      data: await this.toThreadResponses(rows, viewerId),
      pageInfo: { nextCursor, hasMore },
    };
  }

  // Cross-entity global search (SearchService) — ILIKE over thread `title`
  // only (post-body search is deferred). Reuses the same block filter as
  // `list()`. Most-recently-active first.
  async searchByText(
    viewerId: string,
    term: string,
    limit: number,
  ): Promise<ForumThreadResponse[]> {
    const pattern = `%${escapeLikeTerm(term)}%`;
    const qb = this.threads
      .createQueryBuilder('t')
      .where('t.title ILIKE :pattern', { pattern });
    this.blockFilter.excludeHidden(qb, viewerId, '"t"."author_id"');
    const rows = await qb
      .orderBy('t.last_activity_at', 'DESC')
      .take(limit)
      .getMany();
    return this.toThreadResponses(rows, viewerId);
  }

  // GET /forum/threads/:slug
  async getBySlug(
    slug: string,
    viewerId: string,
  ): Promise<ForumThreadResponse> {
    const thread = await this.loadOr404(slug, viewerId);
    const authors = await new MemberLookup(this.profiles).byUserIds([
      thread.authorId,
    ]);
    return toForumThreadResponse(
      thread,
      authors.get(thread.authorId) ?? null,
      viewerId,
    );
  }

  // POST /forum/threads — creates the thread row *and* its OP post (the
  // oldest `ForumPost` for the thread) atomically, with a unique slug
  // allocated from `title` (mirrors `EventsService.saveWithUniqueSlug` /
  // `CommunitiesService.createWithUniqueRef`'s retry-on-23505 loop).
  async create(
    authorId: string,
    input: CreateThreadInput,
  ): Promise<ForumThreadResponse> {
    const thread = await this.createWithUniqueSlug(authorId, input);
    await this.mentions.notify(input.body, authorId, {
      actorId: authorId,
      source: 'forum',
      threadSlug: thread.slug,
      excerpt: input.body.slice(0, 140),
    });
    const authors = await new MemberLookup(this.profiles).byUserIds([authorId]);
    return toForumThreadResponse(
      thread,
      authors.get(authorId) ?? null,
      authorId,
    );
  }

  /**
   * Shared with `ForumPostsService` — 404s a thread lookup by slug.
   *
   * When `viewerId` is supplied, a thread whose author is blocked in either
   * direction is also 404 — the same "don't leak existence" shape
   * `CommunityPostsService.assertViewable` uses for private communities, so a
   * blocked author's thread can't be reached by guessing its slug either.
   *
   * Deliberately checks blocks only, not mutes: a mute is a soft silence that
   * keeps content out of feeds and lists (see `BlockFilterService.isMutedBy`),
   * not a hard severance — a muted member's thread stays reachable if the
   * viewer navigates to it directly.
   */
  async loadOr404(slug: string, viewerId?: string): Promise<ForumThread> {
    const thread = await this.threads.findOne({ where: { slug } });
    if (!thread) {
      throw new NotFoundException('Thread not found');
    }
    if (
      viewerId &&
      (await this.blockFilter.isBlockedEitherWay(viewerId, thread.authorId))
    ) {
      throw new NotFoundException('Thread not found');
    }
    return thread;
  }

  /**
   * Called by `ForumPostsService.reply` on every new reply: bumps
   * `replyCount` (atomic increment) and refreshes `lastActivityAt` to now —
   * the two fields the frontend's "recently active" thread sort and reply
   * badge depend on.
   */
  async markActivity(threadId: string): Promise<void> {
    // One transaction so a reply never bumps `replyCount` without also
    // refreshing `lastActivityAt` (the two fields the sort/badge depend on).
    await this.dataSource.transaction(async (manager) => {
      await manager.increment(ForumThread, { id: threadId }, 'replyCount', 1);
      await manager.update(
        ForumThread,
        { id: threadId },
        { lastActivityAt: new Date() },
      );
    });
  }

  // PATCH /forum/threads/:slug — author-only title edit. The title lives on the
  // thread; edit-history is anchored to the OP post (the oldest `ForumPost`),
  // so a title change is snapshotted there with `previousTitle` set.
  async updateThreadTitle(
    slug: string,
    user: CurrentUserData,
    title: string,
  ): Promise<ForumThreadResponse> {
    const thread = await this.loadOr404(slug, user.userId);
    if (thread.authorId !== user.userId) {
      throw new ForbiddenException('Only the author can edit this thread');
    }

    const opPost = await this.posts.findOne({
      where: { threadId: thread.id },
      order: { createdAt: 'ASC' },
    });
    // Snapshot the pre-edit title and persist the new one atomically: the edit
    // record, the OP post's `editedAt`, and the thread's title must all land
    // together, or a failure leaves a phantom revision for an edit that never
    // committed. `previousTitle` is captured before mutating `thread.title`.
    const previousTitle = thread.title;
    thread.title = title;
    await this.dataSource.transaction(async (manager) => {
      if (opPost) {
        await manager.save(
          manager.create(ForumPostEdit, {
            postId: opPost.id,
            previousBody: opPost.body,
            previousTitle,
            editorId: user.userId,
          }),
        );
        opPost.editedAt = new Date();
        await manager.save(opPost);
      }
      await manager.save(thread);
    });

    const authors = await new MemberLookup(this.profiles).byUserIds([
      thread.authorId,
    ]);
    return toForumThreadResponse(
      thread,
      authors.get(thread.authorId) ?? null,
      user.userId,
    );
  }

  // --- internals ---

  private async createWithUniqueSlug(
    authorId: string,
    input: CreateThreadInput,
  ): Promise<ForumThread> {
    for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(
        slugify(input.title, 'thread'),
        (s) => this.threads.exists({ where: { slug: s } }),
      );

      try {
        return await this.dataSource.transaction(async (manager) => {
          const threadsRepo = manager.getRepository(ForumThread);
          const postsRepo = manager.getRepository(ForumPost);

          const now = new Date();
          const thread = await threadsRepo.save(
            threadsRepo.create({
              slug,
              title: input.title,
              authorId,
              category: input.category,
              isPinned: false,
              isLocked: false,
              replyCount: 0,
              lastActivityAt: now,
            }),
          );

          await postsRepo.save(
            postsRepo.create({
              threadId: thread.id,
              authorId,
              body: input.body,
              voteCount: 0,
            }),
          );

          return thread;
        });
      } catch (err) {
        if (isUniqueViolation(err) && attempt < MAX_SLUG_ATTEMPTS) {
          continue; // lost the slug race — regenerate and retry
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns a saved thread or rethrows.
    throw new ConflictException('Could not allocate a unique thread slug');
  }

  // Batched mapping for a page of threads: one `IN`-query for authors across
  // the whole page instead of N+1 per-thread lookups (mirrors
  // `CommunityPostsService.toPostDTOs`).
  private async toThreadResponses(
    rows: ForumThread[],
    viewerId: string,
  ): Promise<ForumThreadResponse[]> {
    if (!rows.length) return [];
    const authorIds = [...new Set(rows.map((t) => t.authorId))];
    const authors = await new MemberLookup(this.profiles).byUserIds(authorIds);
    return rows.map((t) =>
      toForumThreadResponse(t, authors.get(t.authorId) ?? null, viewerId),
    );
  }
}
