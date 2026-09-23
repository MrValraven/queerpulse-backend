import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { assertNoForeignUploadIntroduced } from '../storage/assert-no-foreign-upload';
import { CommunitiesService } from './communities.service';
import { CommunityGovernanceLogService } from './community-governance-log.service';
import { CommunityMembershipService } from './community-membership.service';
import {
  CommunityDetailDTO,
  CommunityStats,
  SubcommunityCardDTO,
  toCommunityCard,
} from './community-response';
import {
  COMMUNITY_MEMBER_JOINED,
  CommunityMemberJoinedEvent,
} from './community.events';
import { CommunityFeature } from './dto/create-community.dto';
import { CreateSubcommunityDto } from './dto/create-subcommunity.dto';
import { GovernanceLogAction } from './entities/community-governance-log.entity';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { CommunityPost } from './entities/community-post.entity';
import { Community } from './entities/community.entity';
import {
  isSpaceVisibleTo,
  isTierAtLeastAsStrict,
  SUBCOMMUNITIES_NOT_ALLOWED_CODE,
  SUBCOMMUNITY_TIER_TOO_OPEN_CODE,
} from './subcommunity-rules';

/**
 * The feature set a space opens with: discussion, gatherings, the link shelf
 * and the roster. Rooms stay with the parent. Ids from `COMMUNITY_FEATURES`.
 */
export const SUBCOMMUNITY_FEATURES: CommunityFeature[] = [
  'discussion',
  'events',
  'library',
  'roster',
];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// `CommunitiesService.SUBJECT_TYPE`, which is private there: the
// `content_moderation.subject_type` a community takedown is keyed under, with
// the community slug as its `subject_id`.
const COMMUNITY_MODERATION_SUBJECT_TYPE = 'community';
const MAX_CREATE_ATTEMPTS = 5;

/**
 * `GET`/`POST /communities/:slug/subcommunities`. Spaces are `Community` rows
 * with a `parentId`, so the insert copies the shape of
 * `CommunitiesService.createWithUniqueRef` (sequence ref, de-duped slug,
 * owner roster row in one transaction) and the detail it returns comes from
 * `CommunitiesService.getBySlug`, which already applies every space gate.
 */
@Injectable()
export class SubcommunitiesService {
  private readonly logger = new Logger(SubcommunitiesService.name);

  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(CommunityPost)
    private readonly posts: Repository<CommunityPost>,
    private readonly dataSource: DataSource,
    private readonly communitiesService: CommunitiesService,
    private readonly membership: CommunityMembershipService,
    private readonly governanceLog: CommunityGovernanceLogService,
    private readonly eventEmitter: EventEmitter2,
    private readonly contentModeration: ContentModerationService,
  ) {}

  async create(
    parentSlug: string,
    actorId: string,
    dto: CreateSubcommunityDto,
  ): Promise<CommunityDetailDTO> {
    // 404 for a private parent the caller is outside of, 403 for a plain
    // member, archived parents 404 for everyone.
    const parentId = await this.membership.assertOwnerOrModBySlug(
      parentSlug,
      actorId,
    );
    const parent = await this.communities.findOne({ where: { id: parentId } });
    if (!parent) {
      throw new NotFoundException('Community not found');
    }
    if (parent.parentId !== null || !parent.allowsSubcommunities) {
      throw new ConflictException({
        message: 'This community does not host spaces',
        code: SUBCOMMUNITIES_NOT_ALLOWED_CODE,
      });
    }
    // A space opened under a frozen parent would be born unfrozen and give
    // parent staff a door past a freeze held for review. Same refusal the
    // join path gives a frozen community.
    if (parent.frozenAt) {
      throw new ForbiddenException(
        'This community is frozen while moderators review recent reports',
      );
    }
    // A parent under a moderator takedown opens no new spaces. The caller is
    // always its staff here (who still see it), so this refuses everyone.
    const parentModeration = await this.contentModeration.stateFor(
      COMMUNITY_MODERATION_SUBJECT_TYPE,
      parent.slug,
    );
    if (parentModeration.hidden || parentModeration.removed) {
      throw new ForbiddenException(
        'This community is under moderator review and cannot open spaces',
      );
    }
    if (!isTierAtLeastAsStrict(dto.accessTier, parent.accessTier)) {
      throw new BadRequestException({
        message: 'A space cannot be more open than its parent',
        code: SUBCOMMUNITY_TIER_TOO_OPEN_CODE,
      });
    }
    // Nothing is stored yet, so any upload that is not the caller's own is a
    // new foreign reference.
    assertNoForeignUploadIntroduced(actorId, dto.coverImageUrl, []);
    assertNoForeignUploadIntroduced(actorId, dto.avatarImageUrl, []);

    const space = await this.insertWithUniqueSlug(parent, actorId, dto);

    // After commit, same timing as `CommunitiesService.create`.
    this.eventEmitter.emit(COMMUNITY_MEMBER_JOINED, {
      communityId: space.id,
      userId: actorId,
    } satisfies CommunityMemberJoinedEvent);

    try {
      await this.governanceLog.log({
        communityId: parent.id,
        actorUserId: actorId,
        action: GovernanceLogAction.SubcommunityCreated,
        metadata: { spaceId: space.id },
      });
    } catch (error) {
      this.logger.error(
        `Space ${space.id} was created, but writing the governance log entry on parent ${parent.id} failed: ${String(error)}`,
      );
    }

    return this.communitiesService.getBySlug(space.slug, actorId);
  }

  async list(
    parentSlug: string,
    viewerId: string,
  ): Promise<SubcommunityCardDTO[]> {
    // Every parent view gate (private, takedown, archive, tier) answers here
    // with exactly the status the parent's own detail answers.
    await this.communitiesService.getBySlug(parentSlug, viewerId);
    const parent = await this.communities.findOne({
      where: { slug: parentSlug },
      select: { id: true },
    });
    if (!parent) {
      throw new NotFoundException('Community not found');
    }

    const spaces = await this.communities.find({
      where: { parentId: parent.id, archivedAt: IsNull() },
      order: { name: 'ASC', id: 'ASC' },
    });
    if (!spaces.length) return [];

    const {
      rolesByCommunityId: rolesBySpaceId,
      ownRosterCommunityIds: joinedSpaceIds,
    } = await this.membership.effectiveRolesAndOwnRowsFor(spaces, viewerId);
    // One batched takedown lookup for the whole set. A space under a
    // moderator takedown is withheld from everyone but its staff (direct or
    // inherited from the parent), the same line `getBySlug` draws.
    const moderationBySlug = await this.contentModeration.statesFor(
      COMMUNITY_MODERATION_SUBJECT_TYPE,
      spaces.map((space) => space.slug),
    );
    // The same rule the parent's `subcommunityCount` counts by, so the tab
    // badge and this list always agree.
    const visibleSpaces = spaces.filter((space) => {
      const moderation = moderationBySlug.get(space.slug);
      return isSpaceVisibleTo({
        accessTier: space.accessTier,
        viewerRole: rolesBySpaceId.get(space.id) ?? null,
        isTakenDown:
          moderation !== undefined && (moderation.hidden || moderation.removed),
      });
    });
    if (!visibleSpaces.length) return [];

    const statsBySpaceId = await this.statsForSpaces(visibleSpaces);
    // `myRole` is the effective role (it drives staff-only affordances);
    // `isMember` is the viewer's own space roster row (it drives the joined
    // badge and Join/Leave), so parent staff never read as joined.
    return visibleSpaces.map((space) => ({
      ...toCommunityCard(
        space,
        statsBySpaceId.get(space.id) ?? {
          memberCount: 0,
          activeThisWeek: space.activeThisWeek,
          postsThisWeek: 0,
        },
        rolesBySpaceId.get(space.id) ?? null,
      ),
      isMember: joinedSpaceIds.has(space.id),
    }));
  }

  /**
   * Card stats for a set of spaces. `CommunitiesService.statsForMany` is
   * private, so this runs its own grouped counts: one for roster size and one
   * for posts in the trailing week. `activeThisWeek` reads the hourly
   * denormalised `communities.active_this_week` column, the same number the
   * browse sorts on.
   */
  private async statsForSpaces(
    spaces: Community[],
  ): Promise<Map<string, CommunityStats>> {
    const spaceIds = spaces.map((space) => space.id);
    const statsBySpaceId = new Map<string, CommunityStats>(
      spaces.map((space) => [
        space.id,
        {
          memberCount: 0,
          activeThisWeek: space.activeThisWeek,
          postsThisWeek: 0,
        },
      ]),
    );

    const [memberRows, postRows] = await Promise.all([
      this.members
        .createQueryBuilder('member')
        .select('member.community_id', 'communityId')
        .addSelect('COUNT(*)', 'count')
        .where('member.community_id IN (:...spaceIds)', { spaceIds })
        .groupBy('member.community_id')
        .getRawMany<{ communityId: string; count: string }>(),
      this.posts
        .createQueryBuilder('post')
        .select('post.community_id', 'communityId')
        .addSelect('COUNT(*)', 'count')
        .where('post.community_id IN (:...spaceIds)', { spaceIds })
        .andWhere('post.created_at >= :since', {
          since: new Date(Date.now() - WEEK_MS),
        })
        .groupBy('post.community_id')
        .getRawMany<{ communityId: string; count: string }>(),
    ]);
    for (const row of memberRows) {
      const stats = statsBySpaceId.get(row.communityId);
      if (stats) stats.memberCount = Number(row.count);
    }
    for (const row of postRows) {
      const stats = statsBySpaceId.get(row.communityId);
      if (stats) stats.postsThisWeek = Number(row.count);
    }
    return statsBySpaceId;
  }

  /**
   * The insert, retried whole on a unique violation exactly like
   * `CommunitiesService.createWithUniqueRef`: a 23505 poisons the
   * transaction, so the retry reallocates the slug and runs a fresh one.
   * Spaces share the community slug namespace, since `/communities/:slug`
   * serves both.
   */
  private async insertWithUniqueSlug(
    parent: Community,
    actorId: string,
    dto: CreateSubcommunityDto,
  ): Promise<Community> {
    for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(
        slugify(dto.handle, 'community'),
        (candidate) => this.communities.exists({ where: { slug: candidate } }),
      );
      try {
        return await this.dataSource.transaction(async (manager) => {
          const communitiesRepository = manager.getRepository(Community);
          const membersRepository = manager.getRepository(CommunityMember);

          // Same `communities_ref_seq` allocation `createWithUniqueRef` uses.
          const [refRow] = await manager.query<{ refNumber: string }[]>(
            `SELECT nextval('communities_ref_seq') AS "refNumber"`,
          );
          if (!refRow) {
            throw new Error('communities_ref_seq returned no row');
          }
          const ref = `QP-C-${refRow.refNumber.padStart(4, '0')}`;

          const space = await communitiesRepository.save(
            communitiesRepository.create({
              slug,
              name: dto.name,
              purpose: dto.purpose,
              tagline: dto.tagline,
              whoFor: dto.whoFor ?? parent.whoFor,
              accessTier: dto.accessTier,
              rules: dto.rules,
              coverImageUrl: dto.coverImageUrl || null,
              avatarImageUrl: dto.avatarImageUrl || null,
              // Inherited from the parent: a space meets where its parent
              // meets and speaks its languages.
              type: parent.type,
              city: parent.city,
              area: parent.area,
              isOnline: parent.isOnline,
              languages: [...parent.languages],
              tags: [...parent.tags],
              parentId: parent.id,
              // A space never shows on the signed-out teaser or the
              // featured hero, and always shows its roster.
              isPubliclyListed: false,
              isFeatured: false,
              rosterVisible: true,
              features: [...SUBCOMMUNITY_FEATURES],
              ownerId: actorId,
              ref,
            }),
          );

          const rulesVersion = space.rulesVersion ?? 1;
          await membersRepository.save(
            membersRepository.create({
              communityId: space.id,
              userId: actorId,
              role: RosterRole.Owner,
              // The creator wrote these rules, so they have agreed to them.
              // Empty for a space with no rules of its own, matching
              // `CommunitiesService.rulesAcceptanceStamp`.
              ...(space.rules.length
                ? {
                    rulesAcceptedAt: new Date(),
                    rulesVersionAccepted: rulesVersion,
                  }
                : {}),
            }),
          );

          return space;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          if (attempt < MAX_CREATE_ATTEMPTS) continue;
          throw new ConflictException(
            'Could not allocate a unique community ref',
          );
        }
        throw error;
      }
    }
    throw new ConflictException('Could not allocate a unique community ref');
  }
}
