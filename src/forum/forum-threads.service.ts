import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { CursorPage, cursorPaginate } from '../common/cursor-pagination';
import { MemberLookup } from '../common/member-ref';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
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

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } };
  return e?.code === '23505' || e?.driverError?.code === '23505';
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

    const { rows, nextCursor, hasMore } = await cursorPaginate(
      qb,
      cursor,
      limit ?? DEFAULT_LIMIT,
      't',
    );

    return {
      data: await this.toThreadResponses(rows, viewerId),
      pageInfo: { nextCursor, hasMore },
    };
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
    await this.threads.increment({ id: threadId }, 'replyCount', 1);
    await this.threads.update({ id: threadId }, { lastActivityAt: new Date() });
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
    if (opPost) {
      await this.edits.save(
        this.edits.create({
          postId: opPost.id,
          previousBody: opPost.body,
          previousTitle: thread.title,
          editorId: user.userId,
        }),
      );
      opPost.editedAt = new Date();
      await this.posts.save(opPost);
    }

    thread.title = title;
    await this.threads.save(thread);

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
