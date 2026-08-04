import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { DataSource, In, Repository } from 'typeorm';
import { handleFormatError, normalizeHandle } from '../common/handles';
import { toImageUrl } from '../common/image-url';
import { ConnectionsService } from '../connections/connections.service';
import { ConnectionStatus } from '../connections/entities/connection.entity';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { escapeLikeTerm } from '../common/like-escape';
import { HandlesService } from '../handles/handles.service';
import { BlockFilterService } from '../social/block-filter.service';
import { StorageService } from '../storage/storage.service';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { UserRole, UserStatus } from '../users/entities/user.entity';
import { VouchService } from '../vouch/vouch.service';
import {
  AccessTier,
  Community,
  CommunityType,
} from '../communities/entities/community.entity';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { ListMembersQuery, MemberSort } from './dto/list-members.query';
import { SocialLinkDto } from './dto/replace-socials.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { WorkItemDto } from './dto/replace-work.dto';
import {
  FeaturedCommunityRefView,
  communityTypeLabel,
} from './featured-communities';
import { ProfileFeaturedCommunity } from './entities/profile-featured-community.entity';
import { labelsForFacets, pruneDiscoverable } from './identities';
import { normalizeOpenTo } from './open-to';
import { Activity } from './entities/activity.entity';
import { BoardPost } from './entities/board-post.entity';
import { Group } from './entities/group.entity';
import { GroupMembership } from './entities/group-membership.entity';
import { Shaping } from './entities/shaping.entity';
import { Skill } from './entities/skill.entity';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';
import {
  BoardView,
  FullProfileResponse,
  GroupView,
  LimitedProfileResponse,
  MemberCard,
  ProfileCard,
  ProfileRelations,
  SocialLinkView,
  WorkView,
  sortShapings,
  toFullProfile,
  toLimitedProfile,
  toMemberCard,
  toProfileCard,
} from './profile-response';

const PAGE_SIZE = 20;
const RELATED_LIMIT = 4;
const ACTIVITY_LIMIT = 6;

// Comma-separated query param -> trimmed, non-empty values.
function csv(raw: string | undefined): string[] {
  return raw
    ? raw
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    : [];
}

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  // A member is reported (and taken down) under the `member` subject type,
  // keyed by EITHER the member's slug OR their raw userId (see
  // `Report.subjectId`'s doc) — the read gate below checks both.
  private static readonly MEMBER_SUBJECT_TYPE = 'member';

  private static isStaffRole(role: string | undefined): boolean {
    return role === UserRole.Admin || role === UserRole.Moderator;
  }

  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(SocialLink)
    private readonly socialLinks: Repository<SocialLink>,
    @InjectRepository(WorkItem)
    private readonly workItems: Repository<WorkItem>,
    @InjectRepository(Skill) private readonly skills: Repository<Skill>,
    @InjectRepository(BoardPost)
    private readonly boardPosts: Repository<BoardPost>,
    @InjectRepository(Shaping) private readonly shapings: Repository<Shaping>,
    @InjectRepository(Activity)
    private readonly activities: Repository<Activity>,
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    @InjectRepository(GroupMembership)
    private readonly groupMemberships: Repository<GroupMembership>,
    @InjectRepository(ProfileFeaturedCommunity)
    private readonly featuredCommunities: Repository<ProfileFeaturedCommunity>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    private readonly dataSource: DataSource,
    private readonly vouchService: VouchService,
    private readonly connectionsService: ConnectionsService,
    private readonly blockFilter: BlockFilterService,
    private readonly handles: HandlesService,
    private readonly storage: StorageService,
    private readonly contentModeration: ContentModerationService,
  ) {}

  /**
   * The caller's own profile. `CurrentUserData` carries no slug, so resolve it
   * from the profile row first and delegate — the viewer is themselves, so
   * `canViewFull` always passes and this is always the full response.
   *
   * The extra `findOne` is deliberate: duplicating `getBySlug`'s assembly to
   * save one indexed primary-key lookup would be two code paths that must stay
   * identical forever, which is exactly the drift the bootstrap payload cannot
   * afford.
   */
  async getMine(
    userId: string,
  ): Promise<FullProfileResponse | LimitedProfileResponse> {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    // The viewer IS the owner here, so the moderation gate short-circuits on the
    // owner arm regardless of role — the passed role never matters for `getMine`.
    return this.getBySlug(profile.slug, userId);
  }

  async getBySlug(
    slug: string,
    viewerUserId: string,
    viewerRole?: string,
  ): Promise<FullProfileResponse | LimitedProfileResponse> {
    const profile = await this.profiles.findOne({ where: { slug } });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    // Block-gate the lookup (P1-3): never surface a member's profile to someone
    // they've blocked, or who has blocked them — the same 404 subprofiles and
    // flatmate profiles already return, so a block is indistinguishable from a
    // non-existent slug. `isBlockedEitherWay` short-circuits to false for the
    // viewer's own profile (equal ids), so `getMine` is unaffected.
    if (
      await this.blockFilter.isBlockedEitherWay(viewerUserId, profile.userId)
    ) {
      throw new NotFoundException('Profile not found');
    }
    // Moderator takedown gate. A `hide_content`/`remove_content` on this member
    // 404s the profile for everyone but the member themselves and platform
    // staff (admin/moderator) — the same don't-leak-existence posture as a
    // block above and `CommunitiesService.getBySlug`. The member subject is
    // addressed by slug OR userId, so both are checked.
    const isOwner = profile.userId === viewerUserId;
    if (!isOwner && !ProfilesService.isStaffRole(viewerRole)) {
      await this.assertNotTakenDown(profile.slug, profile.userId);
    }
    const vouchCount = await this.vouchService.getVouchCount(profile.userId);
    if (!(await this.canViewFull(profile, viewerUserId))) {
      return toLimitedProfile(profile, vouchCount);
    }
    return this.buildFullProfile(
      profile,
      vouchCount,
      profile.userId === viewerUserId,
    );
  }

  private async buildFullProfile(
    profile: Profile,
    vouchCount: number,
    // Owner-only private fields (Interests) are included only when true.
    isOwner: boolean,
  ): Promise<FullProfileResponse> {
    const userId = profile.userId;
    const [
      socials,
      work,
      board,
      skills,
      shapings,
      activity,
      groups,
      related,
      featuredCommunities,
    ] = await Promise.all([
      this.socialLinks.find({
        where: { userId },
        order: { position: 'ASC' },
      }),
      this.workItems.find({ where: { userId }, order: { position: 'ASC' } }),
      this.boardPosts.find({ where: { userId }, order: { position: 'ASC' } }),
      this.skills.find({ where: { userId }, order: { position: 'ASC' } }),
      this.shapings.find({ where: { userId } }),
      this.activities.find({
        where: { userId },
        order: { occurredAt: 'DESC' },
        take: ACTIVITY_LIMIT,
      }),
      this.loadGroups(userId),
      this.loadRelated(profile),
      this.loadFeaturedCommunities(userId),
    ]);
    const rels: ProfileRelations = {
      socials,
      work,
      board,
      skills,
      groups,
      shapings,
      activity,
      related,
      featuredCommunities,
    };
    return toFullProfile(profile, rels, vouchCount, isOwner);
  }

  private async loadGroups(userId: string): Promise<GroupView[]> {
    const rows = await this.groupMemberships
      .createQueryBuilder('gm')
      .innerJoin(Group, 'g', 'g.id = gm.group_id')
      .select('g.name', 'name')
      .addSelect('gm.role', 'role')
      .where('gm.user_id = :userId', { userId })
      .orderBy('g.name', 'ASC')
      .getRawMany<{ name: string; role: string }>();
    return rows.map((r) => ({ name: r.name, role: r.role }));
  }

  /**
   * Resolve the member's featured-community pins for display, in pin order. The
   * pin table stores only (community, position); name/type/role/count are joined
   * live here so a pin stays truthful as things change:
   *
   *  - The INNER JOIN to `community_members` (on the PROFILE OWNER's membership)
   *    means a pin the member has since LEFT drops out entirely — role comes
   *    from that same row, so it always reflects their current standing.
   *  - Private-tier communities are excluded, mirroring the picker: a profile
   *    never advertises that its owner is in a private community, even if the
   *    tier changed to private after the pin was made.
   *
   * `countLabel` is the community's live roster size (`community_members` count).
   */
  private async loadFeaturedCommunities(
    userId: string,
  ): Promise<FeaturedCommunityRefView[]> {
    const rows = await this.featuredCommunities
      .createQueryBuilder('pin')
      .innerJoin(Community, 'c', 'c.id = pin.community_id')
      .innerJoin(
        CommunityMember,
        'cm',
        'cm.community_id = c.id AND cm.user_id = :userId',
        { userId },
      )
      .where('pin.user_id = :userId', { userId })
      .andWhere('c.access_tier != :private', { private: AccessTier.Private })
      .select('c.id', 'communityId')
      .addSelect('c.slug', 'slug')
      .addSelect('c.name', 'name')
      .addSelect('c.tagline', 'tagline')
      .addSelect('c.type', 'type')
      .addSelect('cm.role', 'role')
      .orderBy('pin.position', 'ASC')
      .getRawMany<{
        communityId: string;
        slug: string;
        name: string;
        tagline: string;
        type: CommunityType;
        role: RosterRole;
      }>();

    if (rows.length === 0) {
      return [];
    }

    // One grouped count across all pinned communities — the live roster size
    // each `countLabel` renders (avoids a per-pin count query).
    const countRows = await this.communityMembers
      .createQueryBuilder('cm')
      .select('cm.community_id', 'communityId')
      .addSelect('COUNT(*)', 'count')
      .where('cm.community_id IN (:...ids)', {
        ids: rows.map((r) => r.communityId),
      })
      .groupBy('cm.community_id')
      .getRawMany<{ communityId: string; count: string }>();
    const memberCountById = new Map(
      countRows.map((r) => [r.communityId, Number(r.count)]),
    );

    return rows.map((r) => {
      const memberCount = memberCountById.get(r.communityId) ?? 0;
      return {
        slug: r.slug,
        name: r.name,
        tagline: r.tagline,
        type: r.type,
        typeLabel: communityTypeLabel(r.type),
        countLabel: `${memberCount} members`,
        role: r.role,
      };
    });
  }

  private async loadRelated(profile: Profile): Promise<ProfileCard[]> {
    const hasTags = profile.tags.length > 0;
    const hasLocation = !!profile.location;
    if (!hasTags && !hasLocation) {
      return [];
    }
    const qb = this.profiles
      .createQueryBuilder('p')
      .innerJoin('p.user', 'u', 'u.status = :active', {
        active: UserStatus.Active,
      })
      .where('p.user_id != :self', { self: profile.userId });
    const conds: string[] = [];
    const params: Record<string, unknown> = {};
    if (hasTags) {
      conds.push('p.tags && :tags');
      params.tags = profile.tags;
    }
    if (hasLocation) {
      conds.push('p.location = :loc');
      params.loc = profile.location;
    }
    qb.andWhere(`(${conds.join(' OR ')})`, params)
      .orderBy('p.firstName', 'ASC')
      .take(RELATED_LIMIT);
    const rows = await qb.getMany();
    const counts = await this.vouchService.getVouchCounts(
      rows.map((r) => r.userId),
    );
    return rows.map((r) => toProfileCard(r, counts.get(r.userId) ?? 0));
  }

  private async canViewFull(
    profile: Profile,
    viewerUserId: string,
  ): Promise<boolean> {
    if (profile.userId === viewerUserId) {
      return true; // owner
    }
    if (profile.visibility === ProfileVisibility.Open) {
      return true;
    }
    if (profile.visibility === ProfileVisibility.Network) {
      // network: accepted connections see the full profile.
      return this.connectionsService.areConnected(viewerUserId, profile.userId);
    }
    return false; // private → limited card to everyone but the owner
  }

  /**
   * 404s the profile when a moderator has hidden or removed this member. The
   * member subject can be keyed by either the slug or the userId in a report
   * (`Report.subjectId`), so both are checked and the strongest state wins —
   * either a hide or a removal takes the profile down for a non-staff,
   * non-owner viewer (callers gate the owner/staff bypass before calling).
   */
  private async assertNotTakenDown(
    slug: string,
    userId: string,
  ): Promise<void> {
    const subjectIds = [slug, userId];
    const states = await this.contentModeration.statesForAnyType(
      [ProfilesService.MEMBER_SUBJECT_TYPE],
      subjectIds,
    );
    const takenDown = subjectIds.some((subjectId) => {
      const state = states.get(subjectId);
      return !!state && (state.hidden || state.removed);
    });
    if (takenDown) {
      throw new NotFoundException('Profile not found');
    }
  }

  async updateMe(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<FullProfileResponse> {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    // `now` and `openTo` are pulled out of the blanket assign because both need
    // an explicit `undefined` check: `{ now: '' }` CLEARS the status and
    // `{ openTo: [] }` clears the chips, so neither empty value may be treated
    // as "field omitted". `openTo` is a full replace, not a merge.
    const { now, openTo, featuredCommunities, ...rest } = dto;
    // Snapshot the avatar the profile pointed at BEFORE `Object.assign` overwrites
    // it, so a replaced/cleared upload can be deleted from the bucket afterwards.
    const previousAvatarUrl = profile.avatarUrl;
    // Resolve + validate the featured-community pins BEFORE any write, so an
    // ineligible slug rejects the WHOLE patch (400) rather than half-applying
    // it — the profile fields and the pins move together. `undefined` = the
    // client omitted the field (leave pins alone); `[]` = clear all pins.
    const featuredCommunityIds =
      featuredCommunities !== undefined
        ? await this.resolveFeaturedCommunityIds(userId, featuredCommunities)
        : undefined;
    Object.assign(profile, rest);
    if (openTo !== undefined) {
      profile.openTo = normalizeOpenTo(openTo);
    }
    if (now !== undefined) {
      // An empty status normalises to NULL so a cleared Now reads back absent
      // rather than as an empty string.
      profile.now = now.trim() || null;
    }
    // RETRACTION. `rest` may have just replaced `identities`, and anything the
    // member dropped from it must stop being published in the SAME write —
    // otherwise un-declaring "Disabled or chronically ill" leaves them still
    // findable by it, which is the precise opposite of what retracting a
    // disclosure means, and the member has no way to see it lingering.
    //
    // Unconditional rather than gated on `dto.identities !== undefined`: it is
    // idempotent when nothing changed, and a conditional here is one refactor
    // away from being wrong. The DB CHECK would reject the row anyway — this is
    // what turns that 500 into correct behaviour.
    profile.discoverableIdentities = pruneDiscoverable(
      profile.discoverableIdentities ?? [],
      profile.identities ?? [],
    );
    await this.profiles.save(profile);
    if (featuredCommunityIds !== undefined) {
      await this.writeFeaturedCommunities(userId, featuredCommunityIds);
    }
    // Delete-on-replace: once the new avatar has committed, the object the old
    // `avatarUrl` referenced is orphaned (avatar keys are per-upload unique).
    // Only when it actually changed AND was one of our bucket objects — an
    // external Google/Unsplash URL is never ours to delete. Best-effort +
    // post-commit: a storage hiccup must never fail the profile update.
    if (previousAvatarUrl && previousAvatarUrl !== profile.avatarUrl) {
      try {
        await this.storage.deleteObjectByReference(previousAvatarUrl);
      } catch (error) {
        this.logger.warn(
          `Failed to delete replaced avatar object for member ${userId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const vouchCount = await this.vouchService.getVouchCount(userId);
    return this.buildFullProfile(profile, vouchCount, true);
  }

  /**
   * Map an ordered list of community slugs to their ids, validating that each
   * is eligible to feature: a NON-PRIVATE community the member is actually on
   * the roster of. Rejects duplicates and unknown/ineligible slugs with 400
   * (mirrors `replaceGroups`), so the client can't pin a community it doesn't
   * belong to or a private one. Order is preserved — it becomes `position`.
   */
  private async resolveFeaturedCommunityIds(
    userId: string,
    slugs: string[],
  ): Promise<string[]> {
    if (slugs.length === 0) {
      return [];
    }
    const seen = new Set<string>();
    for (const slug of slugs) {
      if (seen.has(slug)) {
        throw new BadRequestException(`Duplicate community: ${slug}`);
      }
      seen.add(slug);
    }
    const rows = await this.communities
      .createQueryBuilder('c')
      .innerJoin(
        CommunityMember,
        'cm',
        'cm.community_id = c.id AND cm.user_id = :userId',
        { userId },
      )
      .where('c.slug IN (:...slugs)', { slugs })
      .andWhere('c.access_tier != :private', { private: AccessTier.Private })
      .select('c.id', 'id')
      .addSelect('c.slug', 'slug')
      .getRawMany<{ id: string; slug: string }>();
    const idBySlug = new Map(rows.map((r) => [r.slug, r.id]));
    return slugs.map((slug) => {
      const id = idBySlug.get(slug);
      if (!id) {
        throw new BadRequestException(
          `Unknown or ineligible community: ${slug}`,
        );
      }
      return id;
    });
  }

  /** Full REPLACE of the member's featured-community pins, in the given order. */
  private async writeFeaturedCommunities(
    userId: string,
    communityIds: string[],
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(ProfileFeaturedCommunity, { userId });
      if (communityIds.length === 0) {
        return;
      }
      const rows = communityIds.map((communityId, position) =>
        manager.create(ProfileFeaturedCommunity, {
          userId,
          communityId,
          position,
        }),
      );
      await manager.save(rows);
    });
  }

  // Set/rename the caller's mandatory global @username. The username IS the
  // profile `slug` and doubles as its entry in the ONE global handle namespace
  // (design plan PART C / UC4): rename in the `handles` registry and update
  // `profiles.slug` atomically. Collisions surface as 409; bad format/reserved
  // as 422.
  async updateUsername(
    userId: string,
    rawUsername: string,
  ): Promise<FullProfileResponse> {
    const username = normalizeHandle(rawUsername);
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    // No-op if it already resolves to the current username.
    if (username === profile.slug) {
      const vouchCount = await this.vouchService.getVouchCount(userId);
      return this.buildFullProfile(profile, vouchCount, true);
    }

    const fmt = handleFormatError(username);
    if (fmt === 'invalid') {
      throw new UnprocessableEntityException({
        code: 'HANDLE_INVALID',
        message: 'That username contains characters that are not allowed.',
        reason: 'invalid',
      });
    }
    if (fmt === 'reserved') {
      throw new UnprocessableEntityException({
        code: 'HANDLE_RESERVED',
        message: 'That username is reserved.',
        reason: 'reserved',
      });
    }

    const currentSlug = profile.slug;
    try {
      await this.dataSource.transaction(async (m) => {
        // Releases the old registry name and claims the new one; a taken name
        // throws ConflictException (→ 409), which bubbles unchanged.
        await this.handles.rename(m, currentSlug, username, {
          kind: 'profile',
          userId,
        });
        await m.update(Profile, { userId }, { slug: username });
      });
    } catch (err) {
      // The `profiles.slug` unique index can also lose the race.
      if (isUniqueViolation(err)) {
        throw new ConflictException('That username is already taken');
      }
      throw err;
    }

    const updated = await this.profiles.findOne({ where: { userId } });
    const vouchCount = await this.vouchService.getVouchCount(userId);
    return this.buildFullProfile(updated ?? profile, vouchCount, true);
  }

  async replaceSocials(
    userId: string,
    items: SocialLinkDto[],
  ): Promise<SocialLinkView[]> {
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(SocialLink, { userId });
      const rows = items.map((it, index) =>
        manager.create(SocialLink, {
          userId,
          platform: it.platform,
          urlOrHandle: it.urlOrHandle,
          position: index,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });
    const saved = await this.socialLinks.find({
      where: { userId },
      order: { position: 'ASC' },
    });
    return saved.map((s) => ({
      platform: s.platform,
      urlOrHandle: s.urlOrHandle,
      position: s.position,
    }));
  }

  async replaceWork(userId: string, items: WorkItemDto[]): Promise<WorkView[]> {
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(WorkItem, { userId });
      const rows = items.map((it, index) =>
        manager.create(WorkItem, {
          userId,
          category: it.category,
          title: it.title,
          year: it.year,
          imageUrl: it.imageUrl ?? null,
          position: index,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });
    const saved = await this.workItems.find({
      where: { userId },
      order: { position: 'ASC' },
    });
    return saved.map((workItem) => ({
      category: workItem.category,
      title: workItem.title,
      year: workItem.year,
      imageUrl: toImageUrl(workItem.imageUrl),
      position: workItem.position,
    }));
  }

  async replaceSkills(
    userId: string,
    items: { name: string; meta: string }[],
  ): Promise<{ name: string; meta: string }[]> {
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(Skill, { userId });
      const rows = items.map((it, index) =>
        manager.create(Skill, {
          userId,
          name: it.name,
          meta: it.meta,
          position: index,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });
    const saved = await this.skills.find({
      where: { userId },
      order: { position: 'ASC' },
    });
    return saved.map((s) => ({ name: s.name, meta: s.meta }));
  }

  async replaceBoard(
    userId: string,
    items: { kind: BoardPost['kind']; title: string; slug: string }[],
  ): Promise<BoardView[]> {
    // board_posts has a unique (userId, slug); reject in-payload duplicates up
    // front so the whole replace fails cleanly rather than tripping the DB
    // constraint mid-transaction.
    const seenSlugs = new Set<string>();
    for (const item of items) {
      if (seenSlugs.has(item.slug)) {
        throw new BadRequestException(`Duplicate board slug: ${item.slug}`);
      }
      seenSlugs.add(item.slug);
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(BoardPost, { userId });
      const rows = items.map((item, index) =>
        manager.create(BoardPost, {
          userId,
          kind: item.kind,
          title: item.title,
          slug: item.slug,
          position: index,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });
    const saved = await this.boardPosts.find({
      where: { userId },
      order: { position: 'ASC' },
    });
    return saved.map((boardPost) => ({
      kind: boardPost.kind,
      title: boardPost.title,
      slug: boardPost.slug,
    }));
  }

  async replaceShapings(
    userId: string,
    items: { kind: Shaping['kind']; title: string; note: string }[],
  ): Promise<{ kind: string; title: string; note: string }[]> {
    const seen = new Set<string>();
    for (const it of items) {
      if (seen.has(it.kind)) {
        throw new BadRequestException(`Duplicate shaping kind: ${it.kind}`);
      }
      seen.add(it.kind);
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(Shaping, { userId });
      const rows = items.map((it) =>
        manager.create(Shaping, {
          userId,
          kind: it.kind,
          title: it.title,
          note: it.note,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });
    const saved = await this.shapings.find({ where: { userId } });
    return sortShapings(saved).map((s) => ({
      kind: s.kind,
      title: s.title,
      note: s.note,
    }));
  }

  async replaceGroups(
    userId: string,
    items: { groupSlug: string; role: string }[],
  ): Promise<GroupView[]> {
    const slugs = items.map((i) => i.groupSlug);
    const found = slugs.length
      ? await this.groups.find({ where: { slug: In(slugs) } })
      : [];
    const bySlug = new Map(found.map((g) => [g.slug, g]));
    for (const it of items) {
      if (!bySlug.has(it.groupSlug)) {
        throw new BadRequestException(`Unknown group: ${it.groupSlug}`);
      }
    }
    const seenSlugs = new Set<string>();
    for (const it of items) {
      if (seenSlugs.has(it.groupSlug)) {
        throw new BadRequestException(`Duplicate group: ${it.groupSlug}`);
      }
      seenSlugs.add(it.groupSlug);
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(GroupMembership, { userId });
      const rows = items.map((it) =>
        manager.create(GroupMembership, {
          userId,
          groupId: bySlug.get(it.groupSlug)!.id,
          role: it.role,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });
    return this.loadGroups(userId);
  }

  async searchMembers(
    q: ListMembersQuery,
    viewerUserId: string,
  ): Promise<{
    items: MemberCard[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = q.page && q.page > 0 ? q.page : 1;
    const qb = this.profiles
      .createQueryBuilder('p')
      .innerJoin('p.user', 'u', 'u.status = :active', {
        active: UserStatus.Active,
      });
    // Blocked-either-way members (in either direction) never surface in the
    // directory (spec §2). `p`'s primary key is `user_id` (snake_case, per
    // SnakeNamingStrategy) — matches this query builder's alias.
    this.blockFilter.excludeBlocked(qb, viewerUserId, '"p"."user_id"');

    if (q.query) {
      // Escape LIKE metacharacters (\ % _) so a user-supplied term is matched
      // literally and can't inject wildcards. Postgres treats backslash as the
      // default LIKE escape character.
      const term = `%${escapeLikeTerm(q.query)}%`;
      qb.andWhere(
        '(p.firstName ILIKE :term OR p.lastName ILIKE :term OR p.slug ILIKE :term OR p.tagline ILIKE :term)',
        { term },
      );
    }

    const tags = csv(q.tags);
    if (tags.length) {
      qb.andWhere('p.tags && :tags', { tags });
    }

    // Identity filter. Reads `discoverable_identities` — the subset each member
    // OPTED IN to publishing — and never `identities`, which is private (see the
    // entity, and AddDiscoverableIdentities1782800770000 for why pointing this
    // at `identities` would be a special-category-data leak).
    //
    // The query param carries the directory's coarse facet ids
    // (`transNonBinary`), the column stores the member's own interest labels
    // ('Trans', 'Genderfluid', …), so facets expand to their label sets here.
    // Unknown facet ids expand to nothing; if EVERY id was unknown the caller
    // asked for a facet that cannot exist, and returning the unfiltered
    // directory instead would be a silently wrong answer — so match nothing.
    const facets = csv(q.identities);
    if (facets.length) {
      const identityLabels = labelsForFacets(facets);
      if (!identityLabels.length) {
        qb.andWhere('1 = 0');
      } else {
        qb.andWhere('p.discoverable_identities && :identityLabels', {
          identityLabels,
        });
      }
    }

    // Ordering. Applied here rather than on the client because the directory is
    // paginated — the client only ever holds one page and cannot sort across the
    // whole set. Every branch ends with a `p.slug` tiebreaker so pages stay
    // deterministic when the primary key ties (otherwise the same member could
    // straddle a page boundary).
    switch (q.sort) {
      case MemberSort.AToZ:
        qb.orderBy('p.firstName', 'ASC').addOrderBy('p.lastName', 'ASC');
        break;
      case MemberSort.MostVouched:
        // Correlated count of vouches received; ties fall back to name order.
        // The count is added as an aliased select and ordered by that alias
        // rather than being passed to `orderBy` as a raw subquery: this query
        // paginates over a join, and on that path TypeORM rewrites everything
        // into a DISTINCT-id subquery, re-parsing each ORDER BY term as
        // `alias.column`. A raw subquery contains dots, so it gets mistaken for
        // an alias ("alias was not found. Maybe you forgot to join it?"). A
        // dot-free alias sidesteps the parser.
        qb.addSelect(
          '(SELECT COUNT(*) FROM vouches vc WHERE vc.vouchee_id = p.user_id AND vc.withdrawn_at IS NULL)',
          'received_vouch_count',
        )
          .orderBy('received_vouch_count', 'DESC')
          .addOrderBy('p.firstName', 'ASC');
        break;
      case MemberSort.ClosestMutuals: {
        // Rank by how many of the viewer's own accepted connections each
        // candidate is also connected to. With no connections of your own,
        // nobody shares any — the ranking would be a uniform zero, so fall back
        // to newest-joined rather than returning an arbitrary order.
        const viewerConnectionIds =
          await this.connectionsService.getAcceptedConnectionUserIds(
            viewerUserId,
          );
        if (viewerConnectionIds.length) {
          // Build a named placeholder per id: raw ORDER BY fragments don't get
          // TypeORM's `:...list` array expansion, so expand it ourselves.
          const placeholders = viewerConnectionIds
            .map((_, index) => `:mutual${index}`)
            .join(', ');
          const parameters: Record<string, string> = {
            mutualAccepted: ConnectionStatus.Accepted,
          };
          viewerConnectionIds.forEach((id, index) => {
            parameters[`mutual${index}`] = id;
          });
          // Rank via an aliased scalar subquery rather than a raw ORDER BY
          // expression: this query paginates over a join, so TypeORM rewrites it
          // into a DISTINCT-id subquery and re-parses each ORDER BY term as
          // `alias.column`. A raw subquery's dots (mc.status, p.user_id) get
          // mistaken for an alias and it throws "alias was not found". Selecting
          // the count under a dot-free alias and ordering by that alias avoids
          // the parser entirely; the count query resets its select, so
          // getManyAndCount stays unaffected.
          qb.addSelect(
            `(SELECT COUNT(*) FROM connections mc
                WHERE mc.status = :mutualAccepted
                  AND ((mc.requester_id = p.user_id AND mc.addressee_id IN (${placeholders}))
                    OR (mc.addressee_id = p.user_id AND mc.requester_id IN (${placeholders}))))`,
            'mutual_connection_count',
          )
            .setParameters(parameters)
            .orderBy('mutual_connection_count', 'DESC')
            .addOrderBy('p.joinedAt', 'DESC');
        } else {
          qb.orderBy('p.joinedAt', 'DESC');
        }
        break;
      }
      case MemberSort.RecentlyJoined:
      default:
        qb.orderBy('p.joinedAt', 'DESC');
        break;
    }

    qb.addOrderBy('p.slug', 'ASC')
      .skip((page - 1) * PAGE_SIZE)
      .take(PAGE_SIZE);

    const [rows, total] = await qb.getManyAndCount();
    const counts = await this.vouchService.getVouchCounts(
      rows.map((r) => r.userId),
    );
    return {
      items: rows.map((r) => toMemberCard(r, counts.get(r.userId) ?? 0)),
      total,
      page,
      pageSize: PAGE_SIZE,
    };
  }
}
