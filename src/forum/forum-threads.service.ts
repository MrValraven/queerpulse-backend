import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import {
  DataSource,
  EntityManager,
  In,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { FORUM_THREAD_CREATED, ForumThreadCreatedEvent } from './forum.events';
import {
  CursorKeyset,
  CursorPage,
  cursorPaginate,
} from '../common/cursor-pagination';
import { escapeLikeTerm } from '../common/like-escape';
import { MemberLookup } from '../common/member-ref';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { MentionNotificationService } from '../mentions/mention-notification.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import { ForumPostEdit } from './entities/forum-post-edit.entity';
import { ForumPostVote } from './entities/forum-post-vote.entity';
import { ForumPost } from './entities/forum-post.entity';
import { ForumThread } from './entities/forum-thread.entity';
import {
  ForumThreadResponse,
  ForumThreadViewer,
  toForumThreadResponse,
} from './forum-response';

const DEFAULT_LIMIT = 20;
const MAX_SLUG_ATTEMPTS = 5;
const MAX_TAGS = 5;

// A `GET /forum/threads` sort mode (mirrors `ListThreadsQuery.sort`). `new`
// (default) and `unanswered` both page the `(createdAt, id)` keyset; `top` and
// `active` swap the leading keyset column (see `keysetForSort`).
export type ThreadSort = 'new' | 'top' | 'active' | 'unanswered';

// Per-category visible-thread counts plus an `all` total — the
// `GET /forum/threads/counts` shape (`{ all } & Record<category, number>`).
export type ThreadCategoryCounts = Record<string, number>;

// The moderator predicate `ForumPostsService` uses (a `CurrentUserData.role`,
// derived from the JWT, of `moderator` or `admin`). Replicated here rather than
// imported — it isn't exported from that sibling service — so lock/unlock gate
// on exactly the same roles. Keep the two in sync.
const MODERATOR_ROLES: readonly string[] = [UserRole.Moderator, UserRole.Admin];
// Exported so `ForumController` threads the exact same moderator predicate into
// the read paths (`list`/`getBySlug`/`create`) that need the viewer's role to
// compute the OP card's moderation/lock flags — one source of truth.
export function isModeratorRole(role: string): boolean {
  return MODERATOR_ROLES.includes(role);
}

// Normalizes author-supplied tags for storage: trim, lowercase, strip a leading
// `#`, drop empties, dedupe (first-wins), cap at `MAX_TAGS`. Applied on create +
// update so `forum_thread.tags` is always clean and matches the same shape the
// `:tag = ANY(t.tags)` filter normalizes a query tag to (`normalizeTag`).
function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase().replace(/^#+/, '').trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// Normalizes a single filter tag to the same shape `normalizeTags` stores, so
// `?tag=%23Housing` matches a persisted `housing`.
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/^#+/, '').trim();
}

export interface CreateThreadInput {
  title: string;
  body: string;
  category: string;
  tags?: string[];
}

@Injectable()
export class ForumThreadsService {
  constructor(
    @InjectRepository(ForumThread)
    private readonly threads: Repository<ForumThread>,
    @InjectRepository(ForumPost)
    private readonly posts: Repository<ForumPost>,
    @InjectRepository(ForumPostVote)
    private readonly votes: Repository<ForumPostVote>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(ForumPostEdit)
    private readonly edits: Repository<ForumPostEdit>,
    private readonly dataSource: DataSource,
    private readonly blockFilter: BlockFilterService,
    private readonly mentions: MentionNotificationService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // GET /forum/threads?category=&cursor=&sort=&tag=&q= — a cursor page ordered
  // by `sort` (default `new`), narrowed by category/tag/text.
  async list(
    viewerId: string,
    category: string | undefined,
    cursor: string | undefined,
    limit: number | undefined,
    sort?: ThreadSort,
    tag?: string,
    q?: string,
    viewerIsModerator = false,
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
    // `q`/`tag` fold in AFTER the block filter (spec §Backend): same visibility
    // rules first, then narrow the visible set by title text / tag membership.
    this.applyTextAndTagFilters(qb, q, tag);
    // `unanswered` is not a distinct sort column — it's the default
    // `(createdAt, id)` keyset narrowed to reply-less threads, so it keeps
    // `keysetForSort` returning undefined below.
    if (sort === 'unanswered') {
      qb.andWhere('t.reply_count = 0');
    }

    // `keyset` swaps the leading sort column for `top`/`active`; for
    // `new`/`unanswered` it's undefined, so `cursorPaginate` uses its default
    // `(createdAt, id)` keyset with the `true` millisecond-precision flag.
    // `ForumThread.createdAt` is migrated to `timestamptz(3)` (see
    // `1785001400000-NarrowCursorCreatedAtPrecision.ts`), so that default path
    // uses the existing `IDX_forum_thread_created_at_id` btree instead of a
    // full scan + in-memory sort; the `top`/`active` keysets are backed by
    // their own DESC composite indexes (`AddForumOpDenormalization`).
    const keyset = this.keysetForSort(sort);
    const { rows, nextCursor, hasMore } = await cursorPaginate(
      qb,
      cursor,
      limit ?? DEFAULT_LIMIT,
      't',
      true,
      keyset,
    );

    return {
      data: await this.toThreadResponses(rows, viewerId, viewerIsModerator),
      pageInfo: { nextCursor, hasMore },
    };
  }

  // GET /forum/threads/counts?q=&tag= — per-category visible-thread counts plus
  // an `all` total, honoring the same block filter + q/tag narrowing as
  // `list()`. One `GROUP BY category` query, never a per-category round-trip.
  async counts(
    viewerId: string,
    q: string | undefined,
    tag: string | undefined,
  ): Promise<ThreadCategoryCounts> {
    const qb = this.threads
      .createQueryBuilder('t')
      .select('t.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .groupBy('t.category');
    this.blockFilter.excludeHidden(qb, viewerId, '"t"."author_id"');
    this.applyTextAndTagFilters(qb, q, tag);

    const rows = await qb.getRawMany<{ category: string; count: string }>();
    // Accumulate per-category counts and the running `all` total in one pass.
    // `COUNT(*)` comes back as a string (pg bigint). `{ all }` is spread last so
    // an empty result still returns `{ all: 0 }`.
    const perCategory: Record<string, number> = {};
    let all = 0;
    for (const row of rows) {
      const count = Number(row.count);
      perCategory[row.category] = count;
      all += count;
    }
    return { ...perCategory, all };
  }

  // POST /forum/threads/:slug/lock|unlock — moderator-only lock toggle. The
  // role gate isn't resource-scoped, so a non-moderator gets 403 up front,
  // before the slug is even resolved. Idempotent: re-locking a locked thread is
  // a no-op write-wise but still echoes the current state.
  async setLocked(
    slug: string,
    user: CurrentUserData,
    locked: boolean,
  ): Promise<ForumThreadResponse> {
    if (!isModeratorRole(user.role)) {
      throw new ForbiddenException('Only a moderator can lock threads');
    }
    const thread = await this.loadOr404(slug, user.userId);
    if (thread.isLocked !== locked) {
      thread.isLocked = locked;
      await this.threads.save(thread);
    }
    const [authors, op] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds([thread.authorId]),
      this.resolveOp(thread.id, user.userId),
    ]);
    // The role gate above already proved the caller is a moderator.
    return toForumThreadResponse(
      thread,
      authors.get(thread.authorId) ?? null,
      { userId: user.userId, isModerator: isModeratorRole(user.role) },
      op.opPost,
      op.myVote,
    );
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
    // Search cards don't surface OP moderation actions; the caller
    // (`SearchService`) has only the viewer id, so treat as non-moderator.
    return this.toThreadResponses(rows, viewerId, false);
  }

  // GET /forum/threads/:slug
  async getBySlug(
    slug: string,
    viewerId: string,
    viewerIsModerator = false,
  ): Promise<ForumThreadResponse> {
    const thread = await this.loadOr404(slug, viewerId);
    const [authors, op] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds([thread.authorId]),
      this.resolveOp(thread.id, viewerId),
    ]);
    return toForumThreadResponse(
      thread,
      authors.get(thread.authorId) ?? null,
      { userId: viewerId, isModerator: viewerIsModerator },
      op.opPost,
      op.myVote,
    );
  }

  // POST /forum/threads — creates the thread row *and* its OP post (the
  // oldest `ForumPost` for the thread) atomically, with a unique slug
  // allocated from `title` (mirrors `EventsService.saveWithUniqueSlug` /
  // `CommunitiesService.createWithUniqueRef`'s retry-on-23505 loop).
  async create(
    authorId: string,
    input: CreateThreadInput,
    viewerIsModerator = false,
  ): Promise<ForumThreadResponse> {
    const { thread, opPost } = await this.createWithUniqueSlug(authorId, input);
    // After the thread has committed: record it as public profile activity for
    // the author. Fire-and-forget on the event bus — a listener failure must
    // never affect thread creation (see profiles `ActivityListener`).
    this.eventEmitter.emit(FORUM_THREAD_CREATED, {
      authorId,
      threadSlug: thread.slug,
      title: thread.title,
    } satisfies ForumThreadCreatedEvent);
    await this.mentions.notify(input.body, authorId, {
      actorId: authorId,
      source: 'forum',
      threadSlug: thread.slug,
      excerpt: input.body.slice(0, 140),
    });
    const authors = await new MemberLookup(this.profiles).byUserIds([authorId]);
    // The author has just created the OP and cannot have voted on it yet, so
    // `myVote` is 0 by construction — no vote lookup needed for this echo. The
    // fresh OP is live (not tombstoned/edited), so its card flags follow from
    // authorship + the viewer's own moderator role.
    return toForumThreadResponse(
      thread,
      authors.get(authorId) ?? null,
      { userId: authorId, isModerator: viewerIsModerator },
      opPost,
      0,
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
  async markActivity(
    threadId: string,
    existingManager?: EntityManager,
  ): Promise<void> {
    // Atomic SQL increment (never a read-modify-write, which would lose bumps
    // under concurrent replies) plus a `lastActivityAt` refresh — the two
    // fields the "recently active" sort/badge depend on.
    const run = async (manager: EntityManager): Promise<void> => {
      await manager.increment(ForumThread, { id: threadId }, 'replyCount', 1);
      await manager.update(
        ForumThread,
        { id: threadId },
        { lastActivityAt: new Date() },
      );
    };
    // Run inside the caller's transaction when given one — `reply()` passes
    // its manager so the reply insert and this count bump commit together (a
    // crash between them would otherwise drift `replyCount`). Standalone
    // callers get their own one-shot transaction.
    if (existingManager) {
      await run(existingManager);
      return;
    }
    await this.dataSource.transaction(run);
  }

  // PATCH /forum/threads/:slug — author-only title edit. The title lives on the
  // thread; edit-history is anchored to the OP post (the oldest `ForumPost`),
  // so a title change is snapshotted there with `previousTitle` set.
  async updateThreadTitle(
    slug: string,
    user: CurrentUserData,
    title: string,
    tags?: string[],
  ): Promise<ForumThreadResponse> {
    const thread = await this.loadOr404(slug, user.userId);
    if (thread.authorId !== user.userId) {
      throw new ForbiddenException('Only the author can edit this thread');
    }

    // The OP is the `is_op` post — one source of truth with every other path
    // (`resolveOp`/`toThreadResponses`/create), not a separate
    // oldest-by-`createdAt` lookup.
    const opPost = await this.posts.findOne({
      where: { threadId: thread.id, isOp: true },
    });
    // Snapshot the pre-edit title and persist the new one atomically: the edit
    // record, the OP post's `editedAt`, and the thread's title must all land
    // together, or a failure leaves a phantom revision for an edit that never
    // committed. `previousTitle` is captured before mutating `thread.title`.
    const previousTitle = thread.title;
    thread.title = title;
    // `tags` is an optional replacement set: only touch the column when the
    // caller sent the field (an explicit `[]` clears them; omitting it leaves
    // the existing tags untouched).
    if (tags !== undefined) {
      thread.tags = normalizeTags(tags);
    }
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
    // `opPost` (oldest post) is the OP; reuse it rather than a second lookup.
    const myVote = opPost
      ? ((
          await this.votes.findOne({
            where: { postId: opPost.id, userId: user.userId },
          })
        )?.value ?? 0)
      : 0;
    return toForumThreadResponse(
      thread,
      authors.get(thread.authorId) ?? null,
      { userId: user.userId, isModerator: isModeratorRole(user.role) },
      opPost,
      myVote,
    );
  }

  // --- internals ---

  private async createWithUniqueSlug(
    authorId: string,
    input: CreateThreadInput,
  ): Promise<{ thread: ForumThread; opPost: ForumPost }> {
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
              tags: normalizeTags(input.tags),
              // Explicit 0 (not just the DB default) so the create echo returns
              // a number even before a reload — the OP starts with no votes.
              opVoteCount: 0,
              replyCount: 0,
              lastActivityAt: now,
            }),
          );

          const opPost = await postsRepo.save(
            postsRepo.create({
              threadId: thread.id,
              authorId,
              body: input.body,
              voteCount: 0,
              // Mark this as the thread's opening post: lets the list page
              // batch-load every OP in one `WHERE is_op AND thread_id IN (...)`
              // query and lets `ForumPostsService.vote` mirror the OP's count
              // onto `forum_thread.op_vote_count`.
              isOp: true,
            }),
          );

          return { thread, opPost };
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

  // Folds the text (`q` → title ILIKE) and tag (`:tag = ANY(t.tags)`) filters
  // onto a query builder. Shared by `list()` + `counts()` so both narrow the
  // visible set identically. Both filters are no-ops when their term is empty.
  private applyTextAndTagFilters(
    qb: SelectQueryBuilder<ForumThread>,
    q: string | undefined,
    tag: string | undefined,
  ): void {
    const term = q?.trim();
    if (term) {
      // `escapeLikeTerm` neutralizes `%`/`_` so they match literally.
      qb.andWhere('t.title ILIKE :q', { q: `%${escapeLikeTerm(term)}%` });
    }
    const normalizedTag = tag ? normalizeTag(tag) : '';
    if (normalizedTag) {
      qb.andWhere(':tag = ANY(t.tags)', { tag: normalizedTag });
    }
  }

  // Maps a `sort` to its `cursorPaginate` keyset. `top`/`active` swap the
  // leading column (both DESC, `id` tie-break); `new`/`unanswered` return
  // undefined so the default `(createdAt, id)` keyset is used. Column exprs +
  // their backing DESC indexes are documented on the `ForumThread` entity.
  //
  // `op_vote_count`/`last_activity_at` are MUTABLE sort keys (a vote or a reply
  // changes a thread's position mid-scroll), so the keyset can skip or repeat a
  // thread across page boundaries as it moves. That trade-off is intentional and
  // accepted for infinite scroll — the alternative (a stable snapshot cursor) is
  // not worth the complexity here.
  private keysetForSort(
    sort: ThreadSort | undefined,
  ): CursorKeyset<ForumThread> | undefined {
    if (sort === 'top') {
      return {
        columnExpr: '"t"."op_vote_count"',
        direction: 'DESC',
        kind: 'number',
        getValue: (row) => row.opVoteCount,
      };
    }
    if (sort === 'active') {
      return {
        columnExpr: '"t"."last_activity_at"',
        direction: 'DESC',
        kind: 'date',
        getValue: (row) => row.lastActivityAt,
      };
    }
    return undefined;
  }

  // Resolves a single thread's OP post + the viewer's vote on it, for the
  // single-thread echoes (getBySlug/lock) that don't run through the batched
  // `toThreadResponses`. Two point lookups; `null`/0 when the OP is missing.
  // The caller derives `opPostId` and the OP card flags from the returned post.
  private async resolveOp(
    threadId: string,
    viewerId: string,
  ): Promise<{ opPost: ForumPost | null; myVote: number }> {
    const op = await this.posts.findOne({ where: { threadId, isOp: true } });
    if (!op) return { opPost: null, myVote: 0 };
    const vote = await this.votes.findOne({
      where: { postId: op.id, userId: viewerId },
    });
    return { opPost: op, myVote: vote?.value ?? 0 };
  }

  // Batched mapping for a page of threads. Three queries total regardless of
  // page size (no N+1): authors, the page's OP posts
  // (`WHERE is_op AND thread_id IN (...)`), and the viewer's votes on those OP
  // posts (`WHERE user_id = viewer AND post_id IN (opIds)`). `opPostId`/`myVote`
  // are threaded into each response; `opVoteCount`/`tags` ride on the row.
  private async toThreadResponses(
    rows: ForumThread[],
    viewerId: string,
    viewerIsModerator: boolean,
  ): Promise<ForumThreadResponse[]> {
    if (!rows.length) return [];
    const viewer: ForumThreadViewer = {
      userId: viewerId,
      isModerator: viewerIsModerator,
    };
    const authorIds = [...new Set(rows.map((t) => t.authorId))];
    const threadIds = rows.map((t) => t.id);

    const [authors, opPosts] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds(authorIds),
      this.posts.find({ where: { isOp: true, threadId: In(threadIds) } }),
    ]);
    const opByThread = new Map(opPosts.map((post) => [post.threadId, post]));

    const opIds = opPosts.map((post) => post.id);
    const myVoteRows = opIds.length
      ? await this.votes.find({
          where: { postId: In(opIds), userId: viewerId },
        })
      : [];
    const myVoteByPost = new Map(
      myVoteRows.map((row) => [row.postId, row.value]),
    );

    return rows.map((t) => {
      const op = opByThread.get(t.id) ?? null;
      return toForumThreadResponse(
        t,
        authors.get(t.authorId) ?? null,
        viewer,
        op,
        op ? (myVoteByPost.get(op.id) ?? 0) : 0,
      );
    });
  }
}
