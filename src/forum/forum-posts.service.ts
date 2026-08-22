import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { CursorPage, cursorPaginate } from '../common/cursor-pagination';
import { MemberLookup } from '../common/member-ref';
import {
  ContentModerationService,
  ContentModerationState,
} from '../content-moderation/content-moderation.service';
import { MentionNotificationService } from '../mentions/mention-notification.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import { ForumPostEdit } from './entities/forum-post-edit.entity';
import { ForumPostVote } from './entities/forum-post-vote.entity';
import { ForumPost } from './entities/forum-post.entity';
import { ForumThread } from './entities/forum-thread.entity';
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
    private readonly contentModeration: ContentModerationService,
  ) {}

  // A forum post can be reported (and thus taken down) under either taxonomy
  // code — the thread OP reports as `post`, a nested comment as `reply` — both
  // keyed by the post's uuid. Reads check both.
  private static readonly SUBJECT_TYPES = ['post', 'reply'];

  // Backs the `hasPosted` flag on `GET /forum/threads/counts` (see
  // `ForumController.threadCounts`) — a cheap EXISTS check, backed by
  // `IDX_forum_post_author_id`, for "has this member ever posted." A thread's
  // opening post is itself a `forum_post` row (`ForumThreadsService.create`
  // inserts it alongside the thread), so this single check covers both thread
  // authorship and replies — no separate thread-table lookup needed.
  async hasEverPosted(userId: string): Promise<boolean> {
    return this.posts.exists({ where: { authorId: userId } });
  }

  // GET /forum/threads/:slug/posts?cursor= — OP + replies, oldest-first.
  // `cursorPaginate`'s default keyset is hard-wired to a newest-first
  // `(createdAt, id) DESC` ordering, which doesn't fit this endpoint's
  // contract ("OP is the first post, oldest-first" — see forum.api.ts).
  // `paginateOldestFirst` below still goes through `cursorPaginate`, but via
  // its alternate-keyset path (`CursorKeyset`) so it can swap in an ASC
  // direction on the raw `created_at` column. `ForumPost.createdAt` is
  // `timestamptz(3)` (see
  // `1787600000000-NarrowForumPostCreatedAtPrecision.ts`), so the raw column
  // already matches the millisecond-resolution cursor and needs no
  // `date_trunc(...)` wrapper — ordering/filtering rides
  // `IDX_forum_post_thread_id_created_at_id` directly instead of forcing a
  // Sort on every page.
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

  // Resolves each post's moderation state and applies the read policy: a member
  // never sees a hidden post (dropped from the page), a moderator sees every
  // post flagged, and a removed post is kept but rendered as a tombstone by
  // `toForumPostResponse`. Returns the surviving rows paired with their state.
  private async partitionByModeration(
    rows: ForumPost[],
    viewer: ForumPostViewer,
  ): Promise<Array<{ post: ForumPost; moderation: ContentModerationState }>> {
    if (!rows.length) return [];
    const states = await this.contentModeration.statesForAnyType(
      ForumPostsService.SUBJECT_TYPES,
      rows.map((post) => post.id),
    );
    const visible: Array<{
      post: ForumPost;
      moderation: ContentModerationState;
    }> = [];
    for (const post of rows) {
      const moderation = states.get(post.id) ?? {
        hidden: false,
        removed: false,
      };
      // A hidden-but-not-removed post is withheld from ordinary members; a
      // removed post survives as a tombstone for everyone.
      if (moderation.hidden && !moderation.removed && !viewer.isModerator) {
        continue;
      }
      visible.push({ post, moderation });
    }
    return visible;
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
    // A community-scoped thread takes replies from that community's roster
    // only — same rule `ForumThreadsService.create` applies to starting one
    // (BE-COM-05). `loadOr404` above has already 404'd a Private community's
    // thread for a non-member; this covers the request/invite tiers, whose
    // threads are readable platform-wide but still not writable by outsiders.
    await this.threadsService.assertCanReplyInThread(thread, user.userId);
    if (thread.isLocked) {
      throw new ForbiddenException('This thread is locked');
    }

    const parentPost = parentPostId
      ? await this.loadReplyParentOr400(parentPostId, thread.id)
      : null;

    // One transaction so the reply insert and the parent thread's
    // `replyCount` bump (+ `lastActivityAt` refresh, via `markActivity`)
    // commit together — a crash between the two separate writes previously
    // drifted the denormalized count.
    const saved = await this.posts.manager.transaction(async (manager) => {
      const created = await manager.save(
        manager.create(ForumPost, {
          threadId: thread.id,
          authorId: user.userId,
          body,
          voteCount: 0,
          // A reply is never the OP — that's created alongside the thread in
          // `ForumThreadsService`. Set explicitly (the entity default is also
          // false) so the invariant is visible at the call site and a voted
          // reply never mirrors onto `forum_thread.op_vote_count`.
          isOp: false,
          parentPostId: parentPost?.id ?? null,
        }),
      );
      await this.threadsService.markActivity(thread.id, manager);
      return created;
    });

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

    // A *top-level* reply (no parent post) is a reply to the thread itself —
    // notify the thread's original author with its own `ForumThreadReply` type.
    // Same de-dupe as the parent-reply case: skipped when the reply already
    // `@mentioned` the thread author, so they're never double-notified.
    if (!parentPost && !mentionNotifiedUserIds.has(thread.authorId)) {
      await this.mentions.notifyThreadReply(thread.authorId, user.userId, {
        actorId: user.userId,
        source: 'forum',
        threadSlug,
        postId: saved.id,
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
  //
  // When the voted post is the thread's OP (`is_op`), the thread's
  // denormalized `op_vote_count` is mirrored to the post's *post-toggle*
  // `voteCount` in the SAME transaction, so the thread-list card and the OP
  // post never diverge (and the `top` keyset sort stays correct). The mirror
  // is an assignment to the freshly-read count — not an independent
  // increment — so it self-heals any prior drift and stays exactly consistent
  // with the value this call returns. The atomic `voteCount` increment above
  // holds the post's row lock, which serializes concurrent OP votes, so the
  // last committer writes the final count to both places.
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
      const voteCount = refreshed?.voteCount ?? post.voteCount;

      // Mirror the OP's count onto its thread's denormalized `op_vote_count`
      // within this same transaction, so both commit together. Guarded on
      // `is_op` so ordinary replies never touch the thread row.
      if (post.isOp) {
        await manager.update(
          ForumThread,
          { id: post.threadId },
          { opVoteCount: voteCount },
        );
      }

      return {
        voteCount,
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
      // Stamped with the marker so `assertCanRestore` can tell an author's own
      // delete apart from a moderator takedown (BE-COM-01).
      post.deletedById = user.userId;
      await this.posts.save(post);
    }
    return this.mapOne(post, user);
  }

  // POST /forum/posts/:id/restore — clear the tombstone. Only the actor who
  // set it, or a platform Moderator/Admin (see `assertCanRestore`).
  async restorePost(
    postId: string,
    user: CurrentUserData,
  ): Promise<ForumPostResponse> {
    const post = await this.loadPostOr404(postId);
    this.assertCanModerate(post, user);
    this.assertCanRestore(post, user);
    if (post.deletedAt) {
      post.deletedAt = null;
      // Cleared with the marker so a later delete/restore pair is judged on
      // its own actor, never a stale one.
      post.deletedById = null;
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

  /**
   * Restore authz, on top of `assertCanModerate`'s author-or-moderator gate.
   *
   * A tombstone may only be cleared by the actor who SET it, or by a platform
   * Moderator/Admin. Delete and restore previously shared `assertCanModerate`
   * outright, so a moderator's `DELETE /forum/posts/:id` was undone by the
   * author's `POST /forum/posts/:id/restore` in the very next request —
   * exactly the rule `toForumPostResponse` already documented ("Only an
   * author's own tombstone is restorable through the forum route") but nothing
   * enforced (BE-COM-01).
   *
   * A null `deletedById` is the legacy case (a tombstone written before
   * `AddContentTombstoneActor1793520000000`, or no tombstone at all, where
   * restore is a no-op) — it falls through to `assertCanModerate`'s rule
   * rather than locking legacy content out of restore.
   */
  private assertCanRestore(post: ForumPost, user: CurrentUserData): void {
    if (isModeratorRole(user.role)) return;
    if (post.deletedById === null) return;
    if (post.deletedById !== user.userId) {
      throw new ForbiddenException(
        'Only a moderator can restore a post a moderator removed',
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
    const [vote, moderation] = await Promise.all([
      this.votes.findOne({
        where: { postId: post.id, userId: user.userId },
      }),
      this.contentModeration.statesForAnyType(ForumPostsService.SUBJECT_TYPES, [
        post.id,
      ]),
    ]);
    return toForumPostResponse(
      post,
      authors.get(post.authorId) ?? null,
      vote?.value ?? 0,
      viewerOf(user),
      moderation.get(post.id) ?? { hidden: false, removed: false },
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
    // `ForumPost.createdAt` is `timestamptz(3)`, matching the millisecond
    // resolution of the JS `Date` cursor `cursorPaginate` builds — so the
    // leading column can compare on the raw `created_at` value with no
    // `date_trunc(...)` wrapper (see `CursorKeyset`'s precision contract and
    // `1787600000000-NarrowForumPostCreatedAtPrecision.ts`). `id` stays the
    // ASC tie-breaker, keeping the ordering total.
    return cursorPaginate(qb, cursor, limit, alias, false, {
      columnExpr: `"${alias}"."created_at"`,
      direction: 'ASC',
      kind: 'date',
      getValue: (row) => row.createdAt,
    });
  }

  // Batched mapping for a page of posts: one `IN`-query each for authors and
  // the viewer's own votes across the whole page instead of N+1 per-post
  // lookups (mirrors `CommunityPostsService.toPostDTOs`).
  private async toPostResponses(
    rows: ForumPost[],
    user: CurrentUserData,
  ): Promise<ForumPostResponse[]> {
    if (!rows.length) return [];
    const viewer = viewerOf(user);

    // Drop hidden posts (kept for moderators) and pair the survivors with their
    // takedown state before mapping — so the page fills with visible posts and
    // removed ones render as tombstones.
    const survivors = await this.partitionByModeration(rows, viewer);
    if (!survivors.length) return [];

    const postIds = survivors.map(({ post }) => post.id);
    const authorIds = [...new Set(survivors.map(({ post }) => post.authorId))];

    const [authors, myVoteRows] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds(authorIds),
      this.votes.find({ where: { postId: In(postIds), userId: user.userId } }),
    ]);

    const myVoteByPost = new Map(
      myVoteRows.map((row) => [row.postId, row.value]),
    );

    return survivors.map(({ post, moderation }) =>
      toForumPostResponse(
        post,
        authors.get(post.authorId) ?? null,
        myVoteByPost.get(post.id) ?? 0,
        viewer,
        moderation,
      ),
    );
  }
}
