import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { CommunityPost } from './entities/community-post.entity';
import { AccessTier, Community } from './entities/community.entity';
import { resolveEffectiveRole } from './subcommunity-rules';

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
   * resolved-but-non-member caller gets a 403, except on a `private`
   * community, where it gets the same 404 (see
   * `assert404IfPrivateOutsiderOfCommunity`). Returns the community's id for
   * the caller to scope its own write with.
   */
  async assertMemberBySlug(slug: string, userId: string): Promise<string> {
    const community = await this.communities.findOne({
      where: { slug, archivedAt: IsNull() },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    const role = await this.effectiveRole(community, userId);
    this.assert404IfPrivateOutsiderOfCommunity(community, role);
    if (role === null) {
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
   *
   * A plain `Member` of a `private` community therefore keeps its 403: the
   * existence guard below turns on having NO roster row at all, never on the
   * role, and somebody already on the roster knows the community is there.
   */
  async assertOwnerOrModBySlug(slug: string, userId: string): Promise<string> {
    const community = await this.communities.findOne({
      where: { slug, archivedAt: IsNull() },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    const role = await this.effectiveRole(community, userId);
    this.assert404IfPrivateOutsiderOfCommunity(community, role);
    if (role === null || !STANDING_ROLES.includes(role)) {
      throw new ForbiddenException(
        'Only the community owner or a moderator can do that',
      );
    }
    return community.id;
  }

  /**
   * The existence-oracle guard both `*BySlug` asserts run between resolving
   * the roster row and refusing the caller: a `private` community plus NO
   * roster row answers 404, the same 404 an unknown slug produces, so one
   * request per guessed slug can no longer confirm that a private community
   * is there. Without it a real private slug answered 403 where an unknown
   * slug answered 404, and the difference between those two responses IS the
   * disclosure a `private` tier exists to prevent.
   *
   * Mirrors `CommunitiesService.assert404IfPrivateOutsider`, which does the
   * same job for the `loadOr404` call sites inside the communities module;
   * this service is the shared door the other feature modules (events, forum,
   * volunteering, membership cards, community pulse) come through, so the rule
   * has to be enforced at both.
   *
   * Two deliberate limits:
   *
   *  - the test is "no effective role at all" and never which role. A plain
   *    `Member` refused by `assertOwnerOrModBySlug` still gets a 403, because
   *    a member already knows the community exists and a 404 would only
   *    confuse them. Parent staff reaching a private space through an
   *    inherited role count as knowing it exists too.
   *  - only `private` is gated. A `request`- or `invite`-tier community is
   *    listed in discover and carries its tier on its card, so its existence
   *    is not the secret and a 403 there is the correct, more useful answer
   *    (see `isGatedTier` and `membersOnlyException` in `./community-gate`).
   */
  private assert404IfPrivateOutsiderOfCommunity(
    community: Community,
    role: RosterRole | null,
  ): void {
    if (role !== null) return;
    if (community.accessTier !== AccessTier.Private) return;
    throw new NotFoundException('Community not found');
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
    const role = await this.effectiveRoleById(communityId, userId);
    return role !== null;
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
    const role = await this.effectiveRoleById(communityId, userId);
    return role !== null && STANDING_ROLES.includes(role);
  }

  /**
   * The caller's effective role in one community (see `resolveEffectiveRole`
   * in `./subcommunity-rules`): their own roster role at top level; inside a
   * space, nothing without a parent roster row, otherwise the higher of their
   * own space role and the one inherited from parent staff.
   */
  async effectiveRole(
    community: Pick<Community, 'id' | 'parentId'>,
    userId: string,
  ): Promise<RosterRole | null> {
    const roles = await this.effectiveRolesFor([community], userId);
    return roles.get(community.id) ?? null;
  }

  /**
   * Batched `effectiveRole`: one roster query over every community id plus
   * every parent id. Communities where the caller holds no effective role are
   * absent from the map.
   */
  async effectiveRolesFor(
    communities: Pick<Community, 'id' | 'parentId'>[],
    userId: string,
  ): Promise<Map<string, RosterRole>> {
    const { rolesByCommunityId } = await this.effectiveRolesAndOwnRowsFor(
      communities,
      userId,
    );
    return rolesByCommunityId;
  }

  /**
   * `effectiveRolesFor` plus the ids among `communities` where the caller
   * holds their OWN roster row, from the same single query. The own-row set
   * backs the "joined" flags, which must not read as true off an inherited
   * role (parent staff hold no space row).
   */
  async effectiveRolesAndOwnRowsFor(
    communities: Pick<Community, 'id' | 'parentId'>[],
    userId: string,
  ): Promise<{
    rolesByCommunityId: Map<string, RosterRole>;
    ownRosterCommunityIds: Set<string>;
  }> {
    if (!communities.length) {
      return {
        rolesByCommunityId: new Map(),
        ownRosterCommunityIds: new Set(),
      };
    }
    const lookupIds = new Set<string>();
    for (const community of communities) {
      lookupIds.add(community.id);
      if (community.parentId) lookupIds.add(community.parentId);
    }
    const rows = await this.members.find({
      where: { communityId: In([...lookupIds]), userId },
      select: { communityId: true, role: true },
    });
    const ownRoleById = new Map(rows.map((row) => [row.communityId, row.role]));
    const rolesByCommunityId = new Map<string, RosterRole>();
    const ownRosterCommunityIds = new Set<string>();
    for (const community of communities) {
      if (ownRoleById.has(community.id)) {
        ownRosterCommunityIds.add(community.id);
      }
      const role = resolveEffectiveRole({
        isSpace: community.parentId !== null,
        ownRole: ownRoleById.get(community.id) ?? null,
        parentRole: community.parentId
          ? (ownRoleById.get(community.parentId) ?? null)
          : null,
      });
      if (role !== null) rolesByCommunityId.set(community.id, role);
    }
    return { rolesByCommunityId, ownRosterCommunityIds };
  }

  /**
   * Whether a community id names a space (a row with a parent). The features
   * a space leaves out in v1 (volunteering attribution, membership cards)
   * refuse one with this. An unknown id answers false.
   */
  async isSubcommunity(communityId: string): Promise<boolean> {
    return this.communities.exists({
      where: { id: communityId, parentId: Not(IsNull()) },
    });
  }

  /** `effectiveRole` for callers holding only an id; unknown id is null. */
  private async effectiveRoleById(
    communityId: string,
    userId: string,
  ): Promise<RosterRole | null> {
    const community = await this.communities.findOne({
      where: { id: communityId },
      select: { id: true, parentId: true },
    });
    if (!community) return null;
    return this.effectiveRole(community, userId);
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
   *
   * A space id is kept only when the parent's id is in the set too: a space
   * row left behind after the caller left the parent grants nothing.
   */
  async communityIdsForUser(userId: string): Promise<string[]> {
    const memberships = await this.members.find({
      where: { userId },
      select: { communityId: true },
    });
    const rosterIds = memberships.map((membership) => membership.communityId);
    if (!rosterIds.length) return rosterIds;
    // The full roster is in hand, so a parent missing from it has no row and
    // the helper skips its roster query.
    const orphanedSpaceIds = await this.spaceIdsWithoutParentRow(
      rosterIds,
      new Set(rosterIds),
      userId,
      false,
    );
    return rosterIds.filter(
      (communityId) => !orphanedSpaceIds.has(communityId),
    );
  }

  /**
   * Every community id the given user holds STANDING in (owner, co-owner, or
   * mod), as opposed to `communityIdsForUser`'s full roster. Backs
   * volunteering's community co-manage tier
   * (`VolunteeringService.listMine` and the signups roster/decide guards):
   * an opportunity attributed to a community can only have been attributed
   * by someone with standing there (`resolveCommunityId` asserts it), so the
   * same tier is what may review its applicants.
   *
   * Parent staff inherit standing in every space under the parent, so those
   * space ids are included. A space's own staff whose parent roster row is
   * gone hold no effective role there, so that space id is dropped.
   */
  async ownerOrModCommunityIdsForUser(userId: string): Promise<string[]> {
    const memberships = await this.members.find({
      where: { userId, role: In([...STANDING_ROLES]) },
      select: { communityId: true },
    });
    const staffIds = memberships.map((membership) => membership.communityId);
    if (!staffIds.length) return staffIds;
    const staffIdSet = new Set(staffIds);
    const orphanedSpaceIds = await this.spaceIdsWithoutParentRow(
      staffIds,
      staffIdSet,
      userId,
      true,
    );
    const inheritedSpaces = await this.communities.find({
      where: { parentId: In(staffIds) },
      select: { id: true },
    });
    return [
      ...new Set([
        ...staffIds.filter((communityId) => !orphanedSpaceIds.has(communityId)),
        ...inheritedSpaces.map((space) => space.id),
      ]),
    ];
  }

  /**
   * Of `communityIds`, the spaces whose parent the user has no roster row
   * in. `knownParentIds` are ids already known to carry a row. With
   * `shouldQueryUnknownParents` false the caller vouches that the known set
   * is the user's whole roster, so no roster query runs.
   */
  private async spaceIdsWithoutParentRow(
    communityIds: string[],
    knownParentIds: Set<string>,
    userId: string,
    shouldQueryUnknownParents: boolean,
  ): Promise<Set<string>> {
    const rows = await this.communities.find({
      where: { id: In(communityIds) },
      select: { id: true, parentId: true },
    });
    const spaces = rows.filter(
      (community): community is typeof community & { parentId: string } =>
        community.parentId !== null,
    );
    const uncheckedParentIds = [
      ...new Set(
        spaces
          .map((space) => space.parentId)
          .filter((parentId) => !knownParentIds.has(parentId)),
      ),
    ];
    const parentIdsWithRow = new Set(knownParentIds);
    if (shouldQueryUnknownParents && uncheckedParentIds.length) {
      const parentRows = await this.members.find({
        where: { userId, communityId: In(uncheckedParentIds) },
        select: { communityId: true },
      });
      for (const parentRow of parentRows) {
        parentIdsWithRow.add(parentRow.communityId);
      }
    }
    return new Set(
      spaces
        .filter((space) => !parentIdsWithRow.has(space.parentId))
        .map((space) => space.id),
    );
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
