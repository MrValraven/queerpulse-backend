import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { CommunityPost } from './entities/community-post.entity';
import { Community } from './entities/community.entity';

// Loose enough to guard a uuid-typed lookup from a Postgres "invalid input
// syntax for type uuid" error when a non-post/reply id (a slug, a member id,
// ...) is checked against a `uuid` column — mirrors
// `CommunityAutoFreezeService`/`CommunityPostsService`'s own copy of this
// pattern (report `subjectId` is a varchar carrying anything).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The roster roles that carry standing to speak or act for a community, as
 * opposed to merely belonging to it. `CoOwner` sits here alongside `Owner`
 * because a co-owner holds owner-level powers by design: leaving it out would
 * silently refuse a co-owner in every cross-feature caller of this service
 * (volunteering's `communitySlug` link, the events audience gate, moderation's
 * community-mod dismiss carve-out) while the communities module itself let
 * them through, which is the worst kind of permission drift.
 *
 * The three owner-only powers (transferring ownership, archiving, and changing
 * another owner's or co-owner's role) are enforced in `CommunitiesService` and
 * deliberately do NOT read this list.
 */
const STANDING_ROLES: readonly RosterRole[] = [
  RosterRole.Owner,
  RosterRole.CoOwner,
  RosterRole.Mod,
];

/**
 * Shared "resolve a community by slug, then assert the caller is on its
 * roster" step, reused by feature modules (events, forum threads, ...) that
 * need this exact check without importing the whole `CommunitiesModule` or
 * duplicating `CommunityPostsService`'s own private `loadCommunityOr404` /
 * `assertMember` pair. Kept read-only and dependency-light on purpose: this
 * module only registers `Community`/`CommunityMember`/`CommunityPost`/
 * `CommunityPostReply` via `TypeOrmModule.forFeature`.
 */
@Injectable()
export class CommunityMembershipService {
  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(CommunityPost)
    private readonly posts: Repository<CommunityPost>,
    @InjectRepository(CommunityPostReply)
    private readonly replies: Repository<CommunityPostReply>,
  ) {}

  /**
   * Resolve a community by slug and assert the given user is on its roster.
   * A missing or archived community 404s (existence isn't leaked); a
   * resolved-but-non-member caller gets a 403. Returns the community's id for
   * the caller to scope its own write with.
   */
  async assertMemberBySlug(slug: string, userId: string): Promise<string> {
    const community = await this.communities.findOne({
      where: { slug, archivedAt: IsNull() },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    const membership = await this.members.findOne({
      where: { communityId: community.id, userId },
    });
    if (!membership) {
      throw new ForbiddenException('Only roster members can do that');
    }
    return community.id;
  }

  /**
   * Resolve a community by slug and assert the given user owns or moderates
   * it. Same 404/403 shape as `assertMemberBySlug`, but a resolved-and-member
   * caller who is only a plain `Member` still gets a 403 — for callers that
   * let a member attribute something they're posting to a community (e.g.
   * volunteering's `communitySlug` link), which should require standing to
   * speak for that community, not just membership in it.
   */
  async assertOwnerOrModBySlug(slug: string, userId: string): Promise<string> {
    const community = await this.communities.findOne({
      where: { slug, archivedAt: IsNull() },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    const membership = await this.members.findOne({
      where: { communityId: community.id, userId },
    });
    if (!membership || !STANDING_ROLES.includes(membership.role)) {
      throw new ForbiddenException(
        'Only the community owner or a moderator can do that',
      );
    }
    return community.id;
  }

  /**
   * Plain boolean roster check by community id (no slug resolution, no throw)
   * — backs `EventVisibility.Community`'s tier check
   * (`EventAudienceGateService.assertViewable`, shared by
   * `EventsService.assertCanView` and `RsvpService`'s RSVP gate), which
   * already has the event's `communityId` and just needs "is this viewer on
   * the roster?".
   */
  async isMember(communityId: string, userId: string): Promise<boolean> {
    return this.members.exists({ where: { communityId, userId } });
  }

  /**
   * Plain boolean owner-or-mod roster check by community id (no slug
   * resolution, no throw) — mirrors `isMember`'s shape but for the
   * owner-or-mod tier. Backs moderation's community-mod dismiss carve-out
   * (`ModerationService.actOnReport`): a caller that already resolved a
   * report's community id via `communityIdForPost`/`communityIdForReply` just
   * needs a boolean, not a 403.
   */
  async isOwnerOrMod(communityId: string, userId: string): Promise<boolean> {
    const membership = await this.members.findOne({
      where: { communityId, userId },
    });
    return !!membership && STANDING_ROLES.includes(membership.role);
  }

  /**
   * Resolve a community post's owning community id, or `null` for a flat
   * (non-community) post or an id that can't be a post at all. Mirrors
   * `CommunityAutoFreezeService.communityForPostId`'s uuid-guard + lookup, for
   * callers outside `CommunitiesModule` that need "which community owns this
   * post" without pulling in `CommunityPostsService`. A garbage id (e.g. a
   * report's `subjectId` when the report isn't actually about a post) must
   * not 500 a uuid-typed lookup, so it's filtered before any query.
   */
  async communityIdForPost(postId: string): Promise<string | null> {
    if (!UUID_RE.test(postId)) return null;
    const post = await this.posts.findOne({
      where: { id: postId },
      select: { communityId: true },
    });
    return post?.communityId ?? null;
  }

  /**
   * Resolve a community reply's owning community id via its parent post.
   * Same uuid-guard + null-soft shape as `communityIdForPost`.
   */
  async communityIdForReply(replyId: string): Promise<string | null> {
    if (!UUID_RE.test(replyId)) return null;
    const reply = await this.replies.findOne({
      where: { id: replyId },
      select: { postId: true },
    });
    return reply ? this.communityIdForPost(reply.postId) : null;
  }

  /**
   * The author of a community post, or `null` for an unknown id, an id that
   * can't be a post at all, or a post whose author erased their account
   * (`author_id` is `SET NULL` on erasure).
   *
   * Backs moderation's conflict-of-interest check on the community-mod
   * `dismiss` carve-out (`ModerationService.assertCanActOnReport`): a
   * community moderator must not be able to close a report filed about their
   * OWN post (BE-COM-03). Same uuid-guard + null-soft shape as
   * `communityIdForPost`, so a garbage `subjectId` can't 500 a uuid lookup.
   */
  async authorIdForPost(postId: string): Promise<string | null> {
    if (!UUID_RE.test(postId)) return null;
    const post = await this.posts.findOne({
      where: { id: postId },
      select: { authorId: true },
    });
    return post?.authorId ?? null;
  }

  /** Author of a community reply. Same contract as `authorIdForPost`. */
  async authorIdForReply(replyId: string): Promise<string | null> {
    if (!UUID_RE.test(replyId)) return null;
    const reply = await this.replies.findOne({
      where: { id: replyId },
      select: { authorId: true },
    });
    return reply?.authorId ?? null;
  }

  /**
   * Every community id the given user is on the roster of — backs the
   * `community` OR-in predicate on the gatherings browse/search queries
   * (`EventsService.list`/`searchByText`), computed once per request via the
   * indexed `IDX_community_members_user_id` lookup.
   */
  async communityIdsForUser(userId: string): Promise<string[]> {
    const memberships = await this.members.find({
      where: { userId },
      select: { communityId: true },
    });
    return memberships.map((membership) => membership.communityId);
  }

  /**
   * Resolve a community id straight to its slug — a plain display lookup, no
   * roster/archived check. Backs `EventDetail.communitySlug`
   * (`EventsService.buildDetail`): the edit UI needs the slug (not just the
   * id already on `EventSummary`/`EventDetail` as `communityId`) to offer the
   * `community` audience-scope tier for an event that already has one.
   * Returns `null` for an unknown id (shouldn't happen for a real
   * `event.communityId`, but this is a display convenience, not a guard, so
   * it fails soft rather than throwing).
   */
  async slugById(communityId: string): Promise<string | null> {
    const community = await this.communities.findOne({
      where: { id: communityId },
      select: { slug: true },
    });
    return community?.slug ?? null;
  }

  /**
   * Batched community-id -> `{slug,name}` ref lookup (mirrors
   * `PartnersService.refsByIds`'s shape) for feature modules (volunteering,
   * ...) resolving embedded community refs on a list/detail view in one
   * query instead of N+1. No archived/roster gate, same "display
   * convenience, not a guard" reasoning as `slugById`.
   */
  async refsByIds(
    ids: string[],
  ): Promise<Map<string, { slug: string; name: string }>> {
    const map = new Map<string, { slug: string; name: string }>();
    if (!ids.length) return map;

    const rows = await this.communities.find({
      where: { id: In(ids) },
      select: { id: true, slug: true, name: true },
    });
    for (const row of rows) {
      map.set(row.id, { slug: row.slug, name: row.name });
    }
    return map;
  }
}
