import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { normalizePage, paginate, Paginated } from '../common/pagination';
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

  private async buildPostDTO(
    post: CommunityPost,
    viewerId: string,
  ): Promise<CommunityPostDTO> {
    const [reactionRows, replyRows] = await Promise.all([
      this.reactions.find({ where: { postId: post.id } }),
      this.replies.find({
        where: { postId: post.id },
        order: { createdAt: 'ASC' },
      }),
    ]);

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

    const [reactionRows, replyRows] = await Promise.all([
      this.reactions.find({ where: { postId: In(postIds) } }),
      this.replies.find({
        where: { postId: In(postIds) },
        order: { createdAt: 'ASC' },
      }),
    ]);

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
