import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ContentModerationService,
  ContentModerationState,
} from '../content-moderation/content-moderation.service';
import {
  COMMUNITY_POST_CREATED,
  CommunityPostCreatedEvent,
} from './community.events';
import { StorageService } from '../storage/storage.service';
import { MemberLookup } from '../common/member-ref';
import {
  PAGE_SIZE,
  normalizePage,
  paginate,
  Paginated,
} from '../common/pagination';
import { MentionNotificationService } from '../mentions/mention-notification.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import {
  CommunityPostDTO,
  CommunityPostHistoryResponse,
  CommunityReplyDTO,
  CommunityReplyHistoryResponse,
  ReactionAggregate,
  toCommunityPost,
  toCommunityPostHistoryEntry,
  toCommunityReply,
  toCommunityReplyHistoryEntry,
} from './community-response';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { CommunityPostEdit } from './entities/community-post-edit.entity';
import {
  CommunityPostReaction,
  ReactionKey,
} from './entities/community-post-reaction.entity';
import { CommunityPostReplyEdit } from './entities/community-post-reply-edit.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { CommunityPost, PostKind } from './entities/community-post.entity';
import { AccessTier, Community } from './entities/community.entity';

export interface CreatePostInput {
  body: string;
  image?: string | null;
  kind?: PostKind;
}

/** Input for the flat `POST /community-posts` alias (see `createFlatPost`). */
export interface CreateFlatPostInput {
  body: string;
  communitySlug?: string;
}

// `pinned` is deliberately the only field that maps to a moderator-only
// check (see `updatePost`) — `body`/`kind` stay author-only, per the spec's
// `PATCH posts/:id | author; pin ⇒ mod` guard column.
export type UpdatePostInput = Partial<CreatePostInput> & {
  pinned?: boolean;
};

@Injectable()
export class CommunityPostsService {
  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(CommunityPost)
    private readonly posts: Repository<CommunityPost>,
    @InjectRepository(CommunityPostReaction)
    private readonly reactions: Repository<CommunityPostReaction>,
    @InjectRepository(CommunityPostReply)
    private readonly replies: Repository<CommunityPostReply>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly blockFilter: BlockFilterService,
    @InjectRepository(CommunityPostEdit)
    private readonly postEdits: Repository<CommunityPostEdit>,
    @InjectRepository(CommunityPostReplyEdit)
    private readonly replyEdits: Repository<CommunityPostReplyEdit>,
    private readonly mentions: MentionNotificationService,
    private readonly contentModeration: ContentModerationService,
    private readonly storage: StorageService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private readonly logger = new Logger(CommunityPostsService.name);

  // A community post/reply can be taken down under either taxonomy code
  // (`post` / `reply`), keyed by the row's uuid — reads check both.
  private static readonly SUBJECT_TYPES = ['post', 'reply'];

  // Owner/mod see moderated content (flagged); ordinary members/non-members do
  // not receive hidden content.
  private static isStaffRole(viewerRole: RosterRole | null): boolean {
    return viewerRole === RosterRole.Owner || viewerRole === RosterRole.Mod;
  }

  private static readonly VISIBLE: ContentModerationState = {
    hidden: false,
    removed: false,
  };

  async listPosts(
    slug: string,
    viewerId: string,
    page?: number,
  ): Promise<Paginated<CommunityPostDTO>> {
    const community = await this.loadCommunityOr404(slug);
    await this.assertViewable(community, viewerId);
    const normalizedPage = normalizePage(page);

    const qb = this.posts
      .createQueryBuilder('p')
      .where('p.community_id = :communityId', { communityId: community.id })
      .orderBy('p.pinned', 'DESC')
      .addOrderBy('p.created_at', 'DESC');
    // Blocked-either-way and muted authors' posts are excluded in-query, so
    // `paginate`'s LIMIT/OFFSET and its `total` both count only visible posts.
    // Filtering the fetched rows instead would under-fill every page *and*
    // report a `total` the caller can never page through.
    this.blockFilter.excludeHidden(qb, viewerId, '"p"."author_id"');

    const viewerRole = await this.viewerRoleIn(community.id, viewerId);
    return paginate(qb, normalizedPage, (rows) =>
      this.toPostDTOs(rows, viewerId, viewerRole),
    );
  }

  async createPost(
    slug: string,
    authorId: string,
    dto: CreatePostInput,
  ): Promise<CommunityPostDTO> {
    const community = await this.loadCommunityOr404(slug);
    const membership = await this.assertMember(community.id, authorId);
    this.assertNotFrozen(community, membership);

    const saved = await this.posts.save(
      this.posts.create({
        communityId: community.id,
        authorId,
        body: dto.body,
        image: dto.image ?? null,
        kind: dto.kind ?? PostKind.Post,
        pinned: false,
      }),
    );
    await this.mentions.notify(dto.body, authorId, {
      actorId: authorId,
      source: 'community',
      communitySlug: slug,
      postId: saved.id,
      excerpt: dto.body.slice(0, 140),
    });
    // Record the post as public profile activity — but only for PUBLIC
    // communities; the listener drops request/invite/private ones (the
    // `accessTier` is carried so that gate happens off the platform's own
    // visibility model, not a guess). Fire-and-forget: a listener failure must
    // never affect posting.
    this.eventEmitter.emit(COMMUNITY_POST_CREATED, {
      authorId,
      communitySlug: slug,
      communityName: community.name,
      accessTier: community.accessTier,
      postId: saved.id,
      excerpt: dto.body.slice(0, 80),
    } satisfies CommunityPostCreatedEvent);
    return this.buildPostDTO(saved, authorId, membership.role);
  }

  async updatePost(
    slug: string,
    postId: string,
    actorId: string,
    dto: UpdatePostInput,
  ): Promise<CommunityPostDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const membership = await this.assertMember(community.id, actorId);

    if (dto.pinned !== undefined) {
      if (
        membership.role !== RosterRole.Owner &&
        membership.role !== RosterRole.Mod
      ) {
        throw new ForbiddenException('Only a moderator can pin a post');
      }
      post.pinned = dto.pinned;
    }

    // Built if the body actually changes, then persisted alongside the post in
    // one transaction below — never as a separate write, or a failure would
    // record a "previous body" for an edit that never landed (phantom revision).
    let pendingEdit: CommunityPostEdit | null = null;
    // Captured only when the image is genuinely swapped/cleared, so the object
    // the post USED to reference can be deleted after the write commits.
    let replacedImage: string | null = null;
    if (
      dto.body !== undefined ||
      dto.kind !== undefined ||
      dto.image !== undefined
    ) {
      if (post.deletedAt) {
        throw new NotFoundException('Post not found');
      }
      if (post.authorId !== actorId) {
        throw new ForbiddenException('Only the author can edit this post');
      }
      if (dto.body !== undefined && dto.body !== post.body) {
        pendingEdit = this.postEdits.create({
          postId: post.id,
          previousBody: post.body,
          editorId: actorId,
        });
        post.body = dto.body;
        post.editedAt = new Date();
      }
      if (dto.kind !== undefined) post.kind = dto.kind;
      if (dto.image !== undefined) {
        // `''`/`null` both clear the image (matches the DTO doc). Only when the
        // value truly changes do we mark the old object for deletion.
        const nextImage = dto.image || null;
        if (nextImage !== post.image) {
          replacedImage = post.image;
          post.image = nextImage;
        }
      }
    }

    const saved = await this.posts.manager.transaction(async (manager) => {
      if (pendingEdit) {
        await manager.save(pendingEdit);
      }
      return manager.save(post);
    });
    // Delete-on-replace, post-commit + best-effort: the superseded image object
    // is orphaned once the new value has committed. A non-key value (external
    // URL) no-ops; a storage failure must never fail the edit.
    if (replacedImage) {
      try {
        await this.storage.deleteObjectByReference(replacedImage);
      } catch (error) {
        this.logger.warn(
          `Failed to delete replaced image for post ${saved.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return this.buildPostDTO(saved, actorId, membership.role);
  }

  // DELETE /communities/:slug/posts/:id — soft tombstone. Author or owner/mod.
  async deletePost(
    slug: string,
    postId: string,
    actorId: string,
  ): Promise<CommunityPostDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const membership = await this.assertMember(community.id, actorId);
    this.assertAuthorOrOwnerMod(post.authorId, membership);

    if (!post.deletedAt) {
      post.deletedAt = new Date();
      await this.posts.save(post);
    }
    return this.buildPostDTO(post, actorId, membership.role);
  }

  // POST /communities/:slug/posts/:id/restore — clear the tombstone.
  async restorePost(
    slug: string,
    postId: string,
    actorId: string,
  ): Promise<CommunityPostDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const membership = await this.assertMember(community.id, actorId);
    this.assertAuthorOrOwnerMod(post.authorId, membership);

    if (post.deletedAt) {
      post.deletedAt = null;
      await this.posts.save(post);
    }
    return this.buildPostDTO(post, actorId, membership.role);
  }

  // GET /communities/:slug/posts/:id/history — revisions, newest-first.
  async listPostHistory(
    slug: string,
    postId: string,
    actorId: string,
  ): Promise<CommunityPostHistoryResponse> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const membership = await this.assertMember(community.id, actorId);
    this.assertAuthorOrOwnerMod(post.authorId, membership);

    const rows = await this.postEdits.find({
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
        toCommunityPostHistoryEntry(
          row,
          row.editorId ? (editors.get(row.editorId) ?? null) : null,
        ),
      ),
    };
  }

  // PATCH /communities/:slug/posts/:id/replies/:replyId — author-only text
  // edit. Snapshots the pre-edit text to `community_post_reply_edit`, stamps
  // editedAt.
  async updateReply(
    slug: string,
    postId: string,
    replyId: string,
    actorId: string,
    text: string,
  ): Promise<CommunityReplyDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const reply = await this.loadReplyOr404(post.id, replyId);
    const membership = await this.assertMember(community.id, actorId);

    if (reply.deletedAt) {
      throw new NotFoundException('Reply not found');
    }
    if (reply.authorId !== actorId) {
      throw new ForbiddenException('Only the author can edit this reply');
    }
    if (text !== reply.text) {
      await this.replyEdits.save(
        this.replyEdits.create({
          replyId: reply.id,
          previousText: reply.text,
          editorId: actorId,
        }),
      );
      reply.text = text;
      reply.editedAt = new Date();
      await this.replies.save(reply);
    }
    return this.mapReply(reply, actorId, membership.role);
  }

  // DELETE /communities/:slug/posts/:id/replies/:replyId — soft tombstone.
  async deleteReply(
    slug: string,
    postId: string,
    replyId: string,
    actorId: string,
  ): Promise<CommunityReplyDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const reply = await this.loadReplyOr404(post.id, replyId);
    const membership = await this.assertMember(community.id, actorId);
    this.assertAuthorOrOwnerMod(reply.authorId, membership);

    if (!reply.deletedAt) {
      reply.deletedAt = new Date();
      await this.replies.save(reply);
    }
    return this.mapReply(reply, actorId, membership.role);
  }

  // POST /communities/:slug/posts/:id/replies/:replyId/restore — clear
  // tombstone.
  async restoreReply(
    slug: string,
    postId: string,
    replyId: string,
    actorId: string,
  ): Promise<CommunityReplyDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const reply = await this.loadReplyOr404(post.id, replyId);
    const membership = await this.assertMember(community.id, actorId);
    this.assertAuthorOrOwnerMod(reply.authorId, membership);

    if (reply.deletedAt) {
      reply.deletedAt = null;
      await this.replies.save(reply);
    }
    return this.mapReply(reply, actorId, membership.role);
  }

  // GET /communities/:slug/posts/:id/replies/:replyId/history —
  // newest-first.
  async listReplyHistory(
    slug: string,
    postId: string,
    replyId: string,
    actorId: string,
  ): Promise<CommunityReplyHistoryResponse> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const reply = await this.loadReplyOr404(post.id, replyId);
    const membership = await this.assertMember(community.id, actorId);
    this.assertAuthorOrOwnerMod(reply.authorId, membership);

    const rows = await this.replyEdits.find({
      where: { replyId },
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
        toCommunityReplyHistoryEntry(
          row,
          row.editorId ? (editors.get(row.editorId) ?? null) : null,
        ),
      ),
    };
  }

  // Resolve a single reply's author and map it (with the actor's role) so the
  // returned DTO's flags are correct for the actor.
  private async mapReply(
    reply: CommunityPostReply,
    viewerId: string,
    viewerRole: RosterRole | null,
  ): Promise<CommunityReplyDTO> {
    const [authors, states] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds([reply.authorId]),
      this.contentModeration.statesForAnyType(
        CommunityPostsService.SUBJECT_TYPES,
        [reply.id],
      ),
    ]);
    return toCommunityReply(
      reply,
      authors.get(reply.authorId) ?? null,
      viewerId,
      viewerRole,
      states.get(reply.id) ?? CommunityPostsService.VISIBLE,
    );
  }

  async addReaction(
    slug: string,
    postId: string,
    userId: string,
    key: ReactionKey,
  ): Promise<CommunityPostDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const membership = await this.assertMember(community.id, userId);
    this.assertNotFrozen(community, membership);

    // Idempotent per (post,user,key): `ON CONFLICT DO NOTHING` absorbs a
    // re-react (or a race between two concurrent ones) without a pre-check +
    // 23505 — mirrors `EventsService.addCohost`'s insert idiom.
    await this.reactions
      .createQueryBuilder()
      .insert()
      .into(CommunityPostReaction)
      .values({ postId: post.id, userId, key })
      .orIgnore()
      .execute();

    return this.buildPostDTO(post, userId, membership.role);
  }

  async removeReaction(
    slug: string,
    postId: string,
    userId: string,
    key: ReactionKey,
  ): Promise<CommunityPostDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const membership = await this.assertMember(community.id, userId);

    await this.reactions.delete({ postId: post.id, userId, key });

    return this.buildPostDTO(post, userId, membership.role);
  }

  async addReply(
    slug: string,
    postId: string,
    userId: string,
    text: string,
  ): Promise<CommunityReplyDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const membership = await this.assertMember(community.id, userId);
    this.assertNotFrozen(community, membership);

    const saved = await this.replies.save(
      this.replies.create({ postId: post.id, authorId: userId, text }),
    );
    const replyPayload = {
      actorId: userId,
      source: 'community',
      communitySlug: slug,
      postId: post.id,
      replyId: saved.id,
      excerpt: text.slice(0, 140),
    };
    const mentioned = await this.mentions.notify(text, userId, replyPayload);
    // Tell the post's author their post got a reply — unless the reply already
    // `@mentioned` them (they'd then get one notification, not two).
    if (!mentioned.has(post.authorId)) {
      await this.mentions.notifyPostReply(post.authorId, userId, replyPayload);
    }
    const authors = await new MemberLookup(this.profiles).byUserIds([userId]);
    return toCommunityReply(
      saved,
      authors.get(userId) ?? null,
      userId,
      membership.role,
    );
  }

  // GET /communities/:slug/posts/:id/replies?page= — every reply beyond the
  // bounded preview a post already embeds (`toPostDTOs`/`buildPostDTO` cap the
  // preview at `PAGE_SIZE`, oldest-first). `page=1` here is deliberately the
  // SAME window as that preview (same `PAGE_SIZE`, same `created_at ASC, id
  // ASC` order), so a "load more" click just requests `page=2` onward — no
  // separate cursor to keep in sync between the embedded preview and this
  // endpoint. Offset pagination (not keyset) is the right fit: this is a
  // single post's own reply thread, browsed forward-only and rarely deep —
  // see `nestjs-and-queries.md`'s keyset-vs-offset guidance.
  async listReplies(
    slug: string,
    postId: string,
    viewerId: string,
    page?: number,
  ): Promise<Paginated<CommunityReplyDTO>> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    const viewerRole = await this.viewerRoleIn(community.id, viewerId);
    const viewerIsStaff = CommunityPostsService.isStaffRole(viewerRole);
    const normalizedPage = normalizePage(page);

    const qb = this.replies
      .createQueryBuilder('r')
      .where('r.post_id = :postId', { postId: post.id })
      .orderBy('r.created_at', 'ASC')
      .addOrderBy('r.id', 'ASC');
    // In-query (not post-query) so a page of `PAGE_SIZE` replies comes back
    // full instead of silently short — mirrors `listPosts`'s own use of
    // `excludeHidden` for exactly this reason.
    this.blockFilter.excludeHidden(qb, viewerId, '"r"."author_id"');
    // Same reasoning for moderator takedowns, and it matters MORE here than
    // for block/mute: this is OFFSET pagination, so filtering hidden replies
    // out AFTER the fixed-size fetch (as this used to) doesn't just under-fill
    // page N — page N+1's offset is computed from the RAW row order, so the
    // reply just past the hidden one would never be served on ANY page. A
    // staff viewer (owner/mod) still sees hidden-but-not-removed replies, so
    // this is skipped for them, mirroring `isStaffRole` everywhere else here.
    if (!viewerIsStaff) {
      this.contentModeration.excludeHidden(
        qb,
        CommunityPostsService.SUBJECT_TYPES,
        '"r"."id"',
      );
    }

    return paginate(qb, normalizedPage, async (rows) => {
      if (!rows.length) return [];
      // No post-fetch moderation filter here anymore — `excludeHidden` above
      // already means every fetched row is one this viewer may see, so
      // `total`/the page's offset math stay correct across pages.
      const states = await this.moderationStatesFor(
        [],
        rows.map((row) => row.id),
      );
      const authors = await new MemberLookup(this.profiles).byUserIds(
        rows.map((row) => row.authorId),
      );
      return rows.map((row) =>
        toCommunityReply(
          row,
          authors.get(row.authorId) ?? null,
          viewerId,
          viewerRole,
          states.get(row.id) ?? CommunityPostsService.VISIBLE,
        ),
      );
    });
  }

  // --- flat aliases (`POST /community-posts*` — see `CommunityPostsController`) ---
  //
  // These reuse the same `community_posts`/`community_post_reactions`/
  // `community_post_replies` store as the nested `/communities/:slug/posts*`
  // routes above, just addressed by post id instead of (slug, id). A post
  // created without a `communitySlug` gets `communityId: null` — a "global"
  // post, per `CommunityPost.communityId`'s doc comment.

  /**
   * `POST /community-posts` — create a post, optionally inside a community.
   * With `communitySlug`, this is exactly `createPost` (same 404-on-unknown-
   * slug + roster-member-only checks). Without one, it's a global post any
   * active member may create (guarded only by `ActiveMemberGuard` at the
   * controller) — there's no community roster to be a member of.
   */
  async createFlatPost(
    authorId: string,
    dto: CreateFlatPostInput,
  ): Promise<{ id: string }> {
    let communityId: string | null = null;
    if (dto.communitySlug) {
      const community = await this.loadCommunityOr404(dto.communitySlug);
      await this.assertMember(community.id, authorId);
      communityId = community.id;
    }

    const saved = await this.posts.save(
      this.posts.create({
        communityId,
        authorId,
        body: dto.body,
        image: null,
        kind: PostKind.Post,
        pinned: false,
      }),
    );
    await this.mentions.notify(dto.body, authorId, {
      actorId: authorId,
      source: 'community',
      postId: saved.id,
      communitySlug: dto.communitySlug,
      excerpt: dto.body.slice(0, 140),
    });
    return { id: saved.id };
  }

  /**
   * `POST /community-posts/:id/like` — idempotent like/unlike toggle over the
   * reserved `ReactionKey.Like` key (same `orIgnore` insert / `delete` idiom
   * as `addReaction`/`removeReaction`). For a community-scoped post, only a
   * roster member may like it (mirrors the nested reaction routes); a global
   * post (`communityId: null`) has no roster, so any active member may.
   */
  async likeFlatPost(
    postId: string,
    userId: string,
    liked: boolean,
  ): Promise<{ liked: boolean; likeCount: number }> {
    const post = await this.loadPostByIdOr404(postId);
    if (post.communityId) {
      await this.assertMember(post.communityId, userId);
    }

    if (liked) {
      await this.reactions
        .createQueryBuilder()
        .insert()
        .into(CommunityPostReaction)
        .values({ postId: post.id, userId, key: ReactionKey.Like })
        .orIgnore()
        .execute();
    } else {
      await this.reactions.delete({
        postId: post.id,
        userId,
        key: ReactionKey.Like,
      });
    }

    const likeCount = await this.reactions.count({
      where: { postId: post.id, key: ReactionKey.Like },
    });
    return { liked, likeCount };
  }

  /**
   * `POST /community-posts/:id/replies` — reply to a post by id (same
   * membership rule as `likeFlatPost` above; reuses the same
   * `community_post_replies` insert as `addReply`).
   */
  async addFlatReply(
    postId: string,
    userId: string,
    text: string,
  ): Promise<{ id: string }> {
    const post = await this.loadPostByIdOr404(postId);
    if (post.communityId) {
      await this.assertMember(post.communityId, userId);
    }

    const saved = await this.replies.save(
      this.replies.create({ postId: post.id, authorId: userId, text }),
    );
    const community = post.communityId
      ? await this.communities.findOne({ where: { id: post.communityId } })
      : null;
    const replyPayload = {
      actorId: userId,
      source: 'community',
      postId: post.id,
      replyId: saved.id,
      ...(community ? { communitySlug: community.slug } : {}),
      excerpt: text.slice(0, 140),
    };
    const mentioned = await this.mentions.notify(text, userId, replyPayload);
    if (!mentioned.has(post.authorId)) {
      await this.mentions.notifyPostReply(post.authorId, userId, replyPayload);
    }
    return { id: saved.id };
  }

  // --- internals ---

  private async loadCommunityOr404(slug: string): Promise<Community> {
    const community = await this.communities.findOne({ where: { slug } });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    return community;
  }

  private async loadPostOr404(
    communityId: string,
    postId: string,
  ): Promise<CommunityPost> {
    const post = await this.posts.findOne({
      where: { id: postId, communityId },
    });
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    return post;
  }

  // Used by the flat by-id aliases above, which have no `slug` to scope the
  // lookup with (a global post has no community at all).
  private async loadPostByIdOr404(postId: string): Promise<CommunityPost> {
    const post = await this.posts.findOne({ where: { id: postId } });
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    return post;
  }

  private async loadReplyOr404(
    postId: string,
    replyId: string,
  ): Promise<CommunityPostReply> {
    const reply = await this.replies.findOne({
      where: { id: replyId, postId },
    });
    if (!reply) {
      throw new NotFoundException('Reply not found');
    }
    return reply;
  }

  private async assertMember(
    communityId: string,
    userId: string,
  ): Promise<CommunityMember> {
    const membership = await this.members.findOne({
      where: { communityId, userId },
    });
    if (!membership) {
      throw new ForbiddenException('Only roster members can do that');
    }
    return membership;
  }

  /**
   * A frozen community (auto-frozen pending report review — see
   * `Community.frozenAt`) takes no new content from plain members: new posts,
   * replies and reactions are blocked. Owner/mods are exempt so they can still
   * post a note and moderate. Reads and edits/deletes of existing content are
   * unaffected — freezing halts new activity, it doesn't hide the community.
   */
  private assertNotFrozen(
    community: Community,
    membership: CommunityMember,
  ): void {
    if (
      community.frozenAt != null &&
      !CommunityPostsService.isStaffRole(membership.role)
    ) {
      throw new ForbiddenException(
        'This community is frozen while moderators review recent reports',
      );
    }
  }

  // The viewer's roster role in a community, or null if they aren't a member.
  // Used to compute the DTO's delete/restore/history flags for feed reads,
  // where the viewer may be a non-member on a non-private tier.
  private async viewerRoleIn(
    communityId: string,
    userId: string,
  ): Promise<RosterRole | null> {
    const membership = await this.members.findOne({
      where: { communityId, userId },
    });
    return membership?.role ?? null;
  }

  // Delete / restore / history authz: the author, or the community's owner/mod.
  // (Editing stays author-only and is checked inline, NOT here.)
  private assertAuthorOrOwnerMod(
    authorId: string,
    membership: CommunityMember,
  ): void {
    const isAuthor = authorId === membership.userId;
    const isOwnerMod =
      membership.role === RosterRole.Owner ||
      membership.role === RosterRole.Mod;
    if (!isAuthor && !isOwnerMod) {
      throw new ForbiddenException(
        'Only the author or a community owner/mod can do that',
      );
    }
  }

  // Private communities are 404 (not 403) to a non-member, mirroring
  // `CommunitiesService.getBySlug` — existence isn't leaked. Non-private
  // tiers' post feeds are viewable without membership; only mutating actions
  // (`createPost`/`addReaction`/`addReply`/pin) require a roster row.
  private async assertViewable(
    community: Community,
    viewerId: string,
  ): Promise<void> {
    if (community.accessTier !== AccessTier.Private) return;
    const membership = await this.members.findOne({
      where: { communityId: community.id, userId: viewerId },
    });
    if (!membership) {
      throw new NotFoundException('Community not found');
    }
  }

  // States for a page of posts + their replies, keyed by row id. One query for
  // the whole set (post ids and reply ids never collide — both are uuids).
  private async moderationStatesFor(
    postIds: string[],
    replyIds: string[],
  ): Promise<Map<string, ContentModerationState>> {
    return this.contentModeration.statesForAnyType(
      CommunityPostsService.SUBJECT_TYPES,
      [...postIds, ...replyIds],
    );
  }

  /**
   * Bounded, batched reply preview for a page of posts: at most `limit`
   * replies per post (oldest-first, matching `listReplies`'s own window),
   * resolved in ONE query for the whole page via a `ROW_NUMBER() OVER
   * (PARTITION BY post_id ...)` top-N-per-group — not `limit` separate
   * per-post queries, which would reintroduce the N+1 shape this file
   * otherwise avoids (see `nestjs-and-queries.md` rule 1). This is the fix for
   * the structural gap this service used to have: a post's `replies` used to
   * be `this.replies.find({ where: { postId } })` with no LIMIT at all — a
   * viral post's entire reply history rode along on every feed page it
   * appeared on. Blocked (either way) / muted authors are excluded IN-QUERY
   * (mirrors `listPosts`'s use of `excludeHidden`), so a post's preview fills
   * with `limit` visible replies instead of coming back short.
   *
   * `excludeModerationHidden` is opt-in (not folded in unconditionally) so
   * `buildPostDTO`'s mutation echo can keep its deliberate, pre-existing
   * choice to show the acting viewer every reply regardless of moderation
   * state, while `toPostDTOs`'s feed listing (which DOES need to withhold
   * hidden replies from non-staff) can ask for it. Pass `true` only when the
   * caller is about to withhold hidden rows anyway — mirrors `listReplies`'s
   * own `!viewerIsStaff` gate on `ContentModerationService.excludeHidden`.
   */
  private async topRepliesByPost(
    postIds: string[],
    viewerId: string,
    limit: number,
    excludeModerationHidden: boolean,
  ): Promise<Map<string, CommunityPostReply[]>> {
    const repliesByPost = new Map<string, CommunityPostReply[]>();
    if (!postIds.length) return repliesByPost;

    const rankedRows = await this.replies.manager
      .createQueryBuilder()
      .select('ranked.id', 'id')
      .addSelect('ranked."postId"', 'postId')
      .addSelect('ranked."authorId"', 'authorId')
      .addSelect('ranked.text', 'text')
      .addSelect('ranked."createdAt"', 'createdAt')
      .addSelect('ranked."editedAt"', 'editedAt')
      .addSelect('ranked."deletedAt"', 'deletedAt')
      .from((subQuery) => {
        const inner = subQuery
          .select('r.id', 'id')
          .addSelect('r.post_id', 'postId')
          .addSelect('r.author_id', 'authorId')
          .addSelect('r.text', 'text')
          .addSelect('r.created_at', 'createdAt')
          .addSelect('r.edited_at', 'editedAt')
          .addSelect('r.deleted_at', 'deletedAt')
          .addSelect(
            'ROW_NUMBER() OVER (PARTITION BY r.post_id ORDER BY r.created_at ASC, r.id ASC)',
            'rn',
          )
          .from(CommunityPostReply, 'r')
          .where('r.post_id IN (:...postIds)', { postIds });
        this.blockFilter.excludeHidden(inner, viewerId, '"r"."author_id"');
        if (excludeModerationHidden) {
          this.contentModeration.excludeHidden(
            inner,
            CommunityPostsService.SUBJECT_TYPES,
            '"r"."id"',
          );
        }
        return inner;
      }, 'ranked')
      .where('ranked.rn <= :limit', { limit })
      .orderBy('ranked."postId"', 'ASC')
      .addOrderBy('ranked."createdAt"', 'ASC')
      .getRawMany<{
        id: string;
        postId: string;
        authorId: string;
        text: string;
        createdAt: Date;
        editedAt: Date | null;
        deletedAt: Date | null;
      }>();

    for (const row of rankedRows) {
      const reply: CommunityPostReply = {
        id: row.id,
        postId: row.postId,
        authorId: row.authorId,
        text: row.text,
        createdAt: new Date(row.createdAt),
        editedAt: row.editedAt ? new Date(row.editedAt) : null,
        deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
      };
      const list = repliesByPost.get(reply.postId);
      if (list) list.push(reply);
      else repliesByPost.set(reply.postId, [reply]);
    }
    return repliesByPost;
  }

  /**
   * The TRUE total reply count per post, independent of `topRepliesByPost`'s
   * bounded preview — so `CommunityPostDTO.replyCount` still reflects every
   * reply even though `replies` is capped. Same block/mute exclusion as the
   * preview and `listReplies`, so the count matches what a "load more" click
   * can actually page through, not a count of rows the viewer could never
   * reach anyway. Same moderation exclusion too (gated on `viewerIsStaff`,
   * exactly like `listReplies`'s own count via `paginate()`'s
   * `getManyAndCount()`) — otherwise a page of moderator-hidden replies would
   * inflate this count past what `listReplies` can ever actually return,
   * making "load more" appear when every remaining page is entirely hidden.
   */
  private async replyCountByPost(
    postIds: string[],
    viewerId: string,
    viewerIsStaff: boolean,
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!postIds.length) return counts;

    const qb = this.replies
      .createQueryBuilder('r')
      .select('r.post_id', 'postId')
      .addSelect('COUNT(*)', 'count')
      .where('r.post_id IN (:...postIds)', { postIds })
      .groupBy('r.post_id');
    this.blockFilter.excludeHidden(qb, viewerId, '"r"."author_id"');
    if (!viewerIsStaff) {
      this.contentModeration.excludeHidden(
        qb,
        CommunityPostsService.SUBJECT_TYPES,
        '"r"."id"',
      );
    }

    const rows = await qb.getRawMany<{ postId: string; count: string }>();
    for (const row of rows) counts.set(row.postId, Number(row.count));
    return counts;
  }

  /**
   * Reaction summary data, batched AND bounded: an aggregate `COUNT` per
   * (post, key) instead of fetching every reaction row — a post with
   * thousands of reactions used to mean thousands of rows over the wire just
   * to compute 4 numbers. `mine` is resolved separately, scoped to the
   * viewer's own rows (at most 4 per post, per `UQ_community_post_reactions`)
   * rather than pulled out of the full row set.
   */
  private async reactionAggregatesByPost(
    postIds: string[],
    viewerId: string,
  ): Promise<Map<string, ReactionAggregate>> {
    const aggregatesByPost = new Map<string, ReactionAggregate>();
    if (!postIds.length) return aggregatesByPost;

    const aggregateFor = (postId: string): ReactionAggregate => {
      const existing = aggregatesByPost.get(postId);
      if (existing) return existing;
      const created: ReactionAggregate = {
        counts: new Map(),
        mine: new Set(),
      };
      aggregatesByPost.set(postId, created);
      return created;
    };

    const [countRows, mineRows] = await Promise.all([
      this.reactions
        .createQueryBuilder('rx')
        .select('rx.post_id', 'postId')
        .addSelect('rx.key', 'key')
        .addSelect('COUNT(*)', 'count')
        .where('rx.post_id IN (:...postIds)', { postIds })
        .groupBy('rx.post_id')
        .addGroupBy('rx.key')
        .getRawMany<{ postId: string; key: ReactionKey; count: string }>(),
      this.reactions.find({
        where: { postId: In(postIds), userId: viewerId },
        select: { postId: true, key: true },
      }),
    ]);

    for (const row of countRows) {
      aggregateFor(row.postId).counts.set(row.key, Number(row.count));
    }
    for (const row of mineRows) {
      aggregateFor(row.postId).mine.add(row.key);
    }
    return aggregatesByPost;
  }

  private async buildPostDTO(
    post: CommunityPost,
    viewerId: string,
    viewerRole: RosterRole | null,
  ): Promise<CommunityPostDTO> {
    // `replyCount` still uses the viewer's real staff-ness (it drives the
    // client's "load more" trigger against `listReplies`, which DOES withhold
    // hidden replies from non-staff), even though the echoed `replies` preview
    // below deliberately does not (see the comment further down).
    const viewerIsStaff = CommunityPostsService.isStaffRole(viewerRole);
    const [repliesByPost, replyCountByPost, reactionsByPost] =
      await Promise.all([
        this.topRepliesByPost([post.id], viewerId, PAGE_SIZE, false),
        this.replyCountByPost([post.id], viewerId, viewerIsStaff),
        this.reactionAggregatesByPost([post.id], viewerId),
      ]);
    const replyRows = repliesByPost.get(post.id) ?? [];

    const authorIds = [post.authorId, ...replyRows.map((r) => r.authorId)];
    const [authors, states] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds(authorIds),
      this.moderationStatesFor(
        [post.id],
        replyRows.map((r) => r.id),
      ),
    ]);

    // This is a mutation echo (create/react/delete/restore returns the acted-on
    // post to the actor), so it reflects moderation state via the mappers but
    // does not drop hidden rows — the actor is operating on the post directly.
    const replies = replyRows.map((r) =>
      toCommunityReply(
        r,
        authors.get(r.authorId) ?? null,
        viewerId,
        viewerRole,
        states.get(r.id) ?? CommunityPostsService.VISIBLE,
      ),
    );
    return toCommunityPost(
      post,
      authors.get(post.authorId) ?? null,
      reactionsByPost.get(post.id) ?? { counts: new Map(), mine: new Set() },
      replies,
      replyCountByPost.get(post.id) ?? replies.length,
      viewerId,
      viewerRole,
      states.get(post.id) ?? CommunityPostsService.VISIBLE,
    );
  }

  // Batched mapping for a page of posts (`listPosts`): one query each for
  // reply previews/counts/reactions/authors across the whole page instead of
  // N+1 per-post lookups — mirrors `EventsService.summarize` /
  // `CommunitiesService.statsForMany`.
  private async toPostDTOs(
    rows: CommunityPost[],
    viewerId: string,
    viewerRole: RosterRole | null,
  ): Promise<CommunityPostDTO[]> {
    if (!rows.length) return [];
    const postIds = rows.map((p) => p.id);
    const viewerIsStaff = CommunityPostsService.isStaffRole(viewerRole);

    const [repliesByPostPreview, replyCountByPost, reactionsByPost] =
      await Promise.all([
        // Fold moderation-hidden exclusion into the SQL window itself (when
        // non-staff) — post-filtering it afterward (as this used to) could
        // under-fill a post's reply preview below `PAGE_SIZE` even when
        // enough later-ranked visible replies existed to fill it.
        this.topRepliesByPost(postIds, viewerId, PAGE_SIZE, !viewerIsStaff),
        this.replyCountByPost(postIds, viewerId, viewerIsStaff),
        this.reactionAggregatesByPost(postIds, viewerId),
      ]);
    const allReplyRows = [...repliesByPostPreview.values()].flat();

    const states = await this.moderationStatesFor(
      postIds,
      allReplyRows.map((r) => r.id),
    );
    const isWithheld = (id: string): boolean => {
      const state = states.get(id);
      // Hidden-but-not-removed content is withheld from non-staff; removed
      // content stays (as a tombstone) for everyone.
      return !!state && state.hidden && !state.removed && !viewerIsStaff;
    };

    // Drop hidden posts from a member's feed entirely — pre-existing,
    // post-level pagination behavior; out of scope for this fix (the same
    // fixed-fetch-then-filter shape exists for `listPosts`'s own page/total,
    // untouched here).
    const visiblePosts = rows.filter((post) => !isWithheld(post.id));
    // Reply rows are already moderation-filtered in SQL by `topRepliesByPost`
    // above (when non-staff), so this is now harmless defense-in-depth, not
    // the primary filter.
    const replyRows = allReplyRows.filter((reply) => !isWithheld(reply.id));

    const repliesByPost = groupBy(replyRows, (r) => r.postId);

    const authorIds = new Set<string>();
    for (const p of visiblePosts) authorIds.add(p.authorId);
    for (const r of replyRows) authorIds.add(r.authorId);
    const authors = await new MemberLookup(this.profiles).byUserIds([
      ...authorIds,
    ]);

    return visiblePosts.map((post) => {
      const replies = (repliesByPost.get(post.id) ?? []).map((r) =>
        toCommunityReply(
          r,
          authors.get(r.authorId) ?? null,
          viewerId,
          viewerRole,
          states.get(r.id) ?? CommunityPostsService.VISIBLE,
        ),
      );
      return toCommunityPost(
        post,
        authors.get(post.authorId) ?? null,
        reactionsByPost.get(post.id) ?? { counts: new Map(), mine: new Set() },
        replies,
        replyCountByPost.get(post.id) ?? replies.length,
        viewerId,
        viewerRole,
        states.get(post.id) ?? CommunityPostsService.VISIBLE,
      );
    });
  }
}

function groupBy<T>(rows: T[], keyOf: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}
