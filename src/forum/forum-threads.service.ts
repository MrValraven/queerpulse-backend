import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CursorPage, cursorPaginate } from '../common/cursor-pagination';
import { MemberLookup } from '../common/member-ref';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { Profile } from '../users/entities/profile.entity';
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
    private readonly dataSource: DataSource,
  ) {}

  // GET /forum/threads?category=&cursor= — newest-first cursor page.
  async list(
    category: string | undefined,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<ForumThreadResponse>> {
    const qb = this.threads.createQueryBuilder('t');
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
      data: await this.toThreadResponses(rows),
      pageInfo: { nextCursor, hasMore },
    };
  }

  // GET /forum/threads/:slug
  async getBySlug(slug: string): Promise<ForumThreadResponse> {
    const thread = await this.loadOr404(slug);
    const authors = await new MemberLookup(this.profiles).byUserIds([
      thread.authorId,
    ]);
    return toForumThreadResponse(thread, authors.get(thread.authorId) ?? null);
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
    return toForumThreadResponse(thread, authors.get(authorId) ?? null);
  }

  /** Shared with `ForumPostsService` — 404s a thread lookup by slug. */
  async loadOr404(slug: string): Promise<ForumThread> {
    const thread = await this.threads.findOne({ where: { slug } });
    if (!thread) {
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
  ): Promise<ForumThreadResponse[]> {
    if (!rows.length) return [];
    const authorIds = [...new Set(rows.map((t) => t.authorId))];
    const authors = await new MemberLookup(this.profiles).byUserIds(authorIds);
    return rows.map((t) =>
      toForumThreadResponse(t, authors.get(t.authorId) ?? null),
    );
  }
}
