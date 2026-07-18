import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import {
  CommunityPostDTO,
  CommunityReplyDTO,
  toCommunityPost,
  toCommunityReply,
} from './community-response';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import {
  CommunityPostReaction,
  ReactionKey,
} from './entities/community-post-reaction.entity';
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
  ) {}

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

    return paginate(qb, normalizedPage, (rows) =>
      this.toPostDTOs(rows, viewerId),
    );
  }

  async createPost(
    slug: string,
    authorId: string,
    dto: CreatePostInput,
  ): Promise<CommunityPostDTO> {
    const community = await this.loadCommunityOr404(slug);
    await this.assertMember(community.id, authorId);

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
    return this.buildPostDTO(saved, authorId);
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

    if (dto.body !== undefined || dto.kind !== undefined) {
      if (post.authorId !== actorId) {
        throw new ForbiddenException('Only the author can edit this post');
      }
      if (dto.body !== undefined) post.body = dto.body;
      if (dto.kind !== undefined) post.kind = dto.kind;
    }

    const saved = await this.posts.save(post);
    return this.buildPostDTO(saved, actorId);
  }

  async addReaction(
    slug: string,
    postId: string,
    userId: string,
    key: ReactionKey,
  ): Promise<CommunityPostDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    await this.assertMember(community.id, userId);

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

    return this.buildPostDTO(post, userId);
  }

  async removeReaction(
    slug: string,
    postId: string,
    userId: string,
    key: ReactionKey,
  ): Promise<CommunityPostDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    await this.assertMember(community.id, userId);

    await this.reactions.delete({ postId: post.id, userId, key });

    return this.buildPostDTO(post, userId);
  }

  async addReply(
    slug: string,
    postId: string,
    userId: string,
    text: string,
  ): Promise<CommunityReplyDTO> {
    const community = await this.loadCommunityOr404(slug);
    const post = await this.loadPostOr404(community.id, postId);
    await this.assertMember(community.id, userId);

    const saved = await this.replies.save(
      this.replies.create({ postId: post.id, authorId: userId, text }),
    );
    const authors = await new MemberLookup(this.profiles).byUserIds([userId]);
    return toCommunityReply(saved, authors.get(userId) ?? null);
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

  /**
   * Drops replies whose author the viewer has blocked (either way) or muted.
   *
   * Post-query rather than in-query on purpose, and without the short-page
   * flaw that makes post-query filtering wrong for `listPosts`: replies are a
   * nested collection fetched *whole* per post, with no LIMIT to under-fill —
   * removing rows just shortens a list that was never promised a length. One
   * batched `BlockFilterService.hiddenUserIds` call covers the entire page of
   * posts, so this stays two queries regardless of how many replies there are.
   */
  private async visibleReplies(
    rows: CommunityPostReply[],
    viewerId: string,
  ): Promise<CommunityPostReply[]> {
    if (!rows.length) return rows;
    const hidden = await this.blockFilter.hiddenUserIds(
      viewerId,
      rows.map((r) => r.authorId),
    );
    return hidden.size ? rows.filter((r) => !hidden.has(r.authorId)) : rows;
  }

  private async buildPostDTO(
    post: CommunityPost,
    viewerId: string,
  ): Promise<CommunityPostDTO> {
    const [reactionRows, allReplyRows] = await Promise.all([
      this.reactions.find({ where: { postId: post.id } }),
      this.replies.find({
        where: { postId: post.id },
        order: { createdAt: 'ASC' },
      }),
    ]);
    const replyRows = await this.visibleReplies(allReplyRows, viewerId);

    const authorIds = [post.authorId, ...replyRows.map((r) => r.authorId)];
    const authors = await new MemberLookup(this.profiles).byUserIds(authorIds);

    const replies = replyRows.map((r) =>
      toCommunityReply(r, authors.get(r.authorId) ?? null),
    );
    return toCommunityPost(
      post,
      authors.get(post.authorId) ?? null,
      reactionRows,
      replies,
      viewerId,
    );
  }

  // Batched mapping for a page of posts (`listPosts`): one `IN`-query each for
  // reactions/replies/authors across the whole page instead of N+1 per-post
  // lookups — mirrors `EventsService.summarize` / `CommunitiesService.statsForMany`.
  private async toPostDTOs(
    rows: CommunityPost[],
    viewerId: string,
  ): Promise<CommunityPostDTO[]> {
    if (!rows.length) return [];
    const postIds = rows.map((p) => p.id);

    const [reactionRows, allReplyRows] = await Promise.all([
      this.reactions.find({ where: { postId: In(postIds) } }),
      this.replies.find({
        where: { postId: In(postIds) },
        order: { createdAt: 'ASC' },
      }),
    ]);
    const replyRows = await this.visibleReplies(allReplyRows, viewerId);

    const reactionsByPost = groupBy(reactionRows, (r) => r.postId);
    const repliesByPost = groupBy(replyRows, (r) => r.postId);

    const authorIds = new Set<string>();
    for (const p of rows) authorIds.add(p.authorId);
    for (const r of replyRows) authorIds.add(r.authorId);
    const authors = await new MemberLookup(this.profiles).byUserIds([
      ...authorIds,
    ]);

    return rows.map((post) => {
      const replies = (repliesByPost.get(post.id) ?? []).map((r) =>
        toCommunityReply(r, authors.get(r.authorId) ?? null),
      );
      return toCommunityPost(
        post,
        authors.get(post.authorId) ?? null,
        reactionsByPost.get(post.id) ?? [],
        replies,
        viewerId,
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
