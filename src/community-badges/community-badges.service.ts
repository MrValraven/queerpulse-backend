import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type EntityManager, Repository } from 'typeorm';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db-errors';
import { CommunityGovernanceLogService } from '../communities/community-governance-log.service';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { isCommunityOwnerLevelRole } from '../communities/community-staff-access';
import { GovernanceLogAction } from '../communities/entities/community-governance-log.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import {
  type CommunityBadgeAccess,
  type CommunityBadgeAccessDeps,
  resolveForBoardRead,
  resolveForRole,
} from './community-badge-access';
import { CommunityBadgeAwardingService } from './community-badge-awarding.service';
import { progressForRule } from './community-badge-counts';
import {
  type NormalizedBadgeUpdate,
  isCommunityBadgeUuid,
  normalizeBadgeCreate,
  normalizeBadgeUpdate,
  normalizeFlairBadgeId,
} from './community-badge-input';
import {
  type CommunityBadgeAdminDTO,
  type CommunityBadgeAdminResponse,
  type CommunityBadgesResponse,
  type CommunityFlairResponse,
  toCommunityBadgeAdminDTO,
  toCommunityBadgeDTO,
  toCommunityFlairDTO,
} from './community-badge-response';
import { COMMUNITY_BADGE_LIMIT } from './community-badges.catalog';
import { communityBadgeError } from './community-badges.constants';
import type {
  CreateCommunityBadgeDto,
  SetCommunityFlairDto,
  UpdateCommunityBadgeDto,
} from './dto/community-badges.dto';
import { CommunityBadgeAward } from './entities/community-badge-award.entity';
import { CommunityBadge } from './entities/community-badge.entity';

/**
 * Award holders per badge of one community, counting only holders who still
 * hold a roster row there (a banned or departed holder is off the roster).
 * Parameters: `[communityId]`.
 */
export const HOLDER_COUNTS_SQL = `SELECT "a"."badge_id", count(*)::int AS "holder_count" FROM "community_badge_awards" "a" JOIN "community_members" "m" ON "m"."community_id" = "a"."community_id" AND "m"."user_id" = "a"."user_id" WHERE "a"."community_id" = $1 GROUP BY "a"."badge_id"`;

/**
 * Sets or clears the badge a member wears in one community. The column is
 * `update: false` on the entity, so this raw statement is its only writer.
 * Parameters: `[communityId, userId, badgeId | null]`.
 */
export const SET_WORN_BADGE_SQL = `UPDATE "community_members" SET "worn_badge_id" = $3 WHERE "community_id" = $1 AND "user_id" = $2`;

/**
 * Locks the community row so two badge creates in one community count and
 * insert one after the other. Parameters: `[communityId]`.
 */
export const LOCK_COMMUNITY_FOR_BADGES_SQL = `SELECT "id" FROM "communities" WHERE "id" = $1 FOR UPDATE`;

/** The unique index that keeps badge names distinct per community. */
const BADGE_NAME_UNIQUE_CONSTRAINT = 'UQ_community_badges_community_name';

/** The foreign key from a roster row's worn badge to the badge. */
const WORN_BADGE_FOREIGN_KEY = 'FK_community_members_worn_badge_id';

/** A row as `HOLDER_COUNTS_SQL` returns it. */
interface HolderCountRow {
  badge_id: string;
  holder_count: number | string;
}

/** The query surface the holder count needs, a transaction manager or the pool. */
type HolderCountQueryRunner = Pick<EntityManager, 'query'>;

/** The badge fields an owner can edit, in the order the log lists them. */
const EDITABLE_BADGE_FIELDS = [
  'name',
  'iconKey',
  'tint',
  'threshold',
  'isEnabled',
] as const;

/** One edited field as the `badge_updated` log records it. */
interface BadgeFieldChange {
  from: string | number | boolean;
  to: string | number | boolean;
}

/**
 * Community badges, routes 1 to 6: the member and visitor badge list, the
 * staff list, create, update and delete for owner-level staff, and the worn
 * flair write. Every refusal carries its reason code. A frozen community
 * passes every route. Badges never touch recognition.
 */
@Injectable()
export class CommunityBadgesService {
  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(CommunityBadge)
    private readonly badges: Repository<CommunityBadge>,
    @InjectRepository(CommunityBadgeAward)
    private readonly awards: Repository<CommunityBadgeAward>,
    private readonly dataSource: DataSource,
    private readonly membership: CommunityMembershipService,
    private readonly contentModeration: ContentModerationService,
    private readonly governanceLog: CommunityGovernanceLogService,
    private readonly awarding: CommunityBadgeAwardingService,
  ) {}

  /** The collaborators the access functions read. */
  private get accessDeps(): CommunityBadgeAccessDeps {
    return {
      communities: this.communities,
      membership: this.membership,
      contentModeration: this.contentModeration,
    };
  }

  /**
   * Route 1: the enabled badges of a community for anyone who can read its
   * board. A member also gets their progress, earned dates and the badge
   * they wear (null when that badge is switched off). A visitor gets the
   * list with no progress.
   */
  async listForViewer(
    slug: string,
    userId: string,
  ): Promise<CommunityBadgesResponse> {
    const { community } = await resolveForBoardRead(this.accessDeps, {
      slug,
      userId,
    });
    const [rosterRow, enabledBadges] = await Promise.all([
      this.members.findOne({
        where: { communityId: community.id, userId },
        select: { id: true, wornBadgeId: true },
      }),
      this.badges.find({
        where: { communityId: community.id, isEnabled: true },
        order: { createdAt: 'ASC', id: 'ASC' },
      }),
    ]);
    if (!rosterRow) {
      return {
        isMember: false,
        wornBadgeId: null,
        badges: enabledBadges.map((badge) =>
          toCommunityBadgeDTO(badge, null, null),
        ),
      };
    }
    const [counts, callerAwards] = await Promise.all([
      this.awarding.memberCounts(community.id, userId),
      this.awards.find({
        where: { communityId: community.id, userId },
        select: { badgeId: true, awardedAt: true },
      }),
    ]);
    const awardedAtByBadgeId = new Map(
      callerAwards.map((award) => [award.badgeId, award.awardedAt]),
    );
    const isWornBadgeListed = enabledBadges.some(
      (badge) => badge.id === rosterRow.wornBadgeId,
    );
    return {
      isMember: true,
      wornBadgeId: isWornBadgeListed ? rosterRow.wornBadgeId : null,
      badges: enabledBadges.map((badge) =>
        toCommunityBadgeDTO(
          badge,
          counts ? progressForRule(counts, badge.ruleType) : null,
          awardedAtByBadgeId.get(badge.id) ?? null,
        ),
      ),
    };
  }

  /**
   * Route 2: every badge of a community, enabled or not, with live holder
   * counts, for the owner, a co-owner or a moderator. Only owner-level staff
   * may manage them.
   */
  async listForStaff(
    slug: string,
    userId: string,
  ): Promise<CommunityBadgeAdminResponse> {
    const { community, role } = await resolveForRole(this.accessDeps, {
      slug,
      userId,
      isWrite: false,
      tier: 'staff',
      refusalCode: 'badge_settings_staff_only',
    });
    const [allBadges, holderCounts] = await Promise.all([
      this.badges.find({
        where: { communityId: community.id },
        order: { createdAt: 'ASC', id: 'ASC' },
      }),
      this.holderCountsFor(this.dataSource, community.id),
    ]);
    return {
      canManage: role !== null && isCommunityOwnerLevelRole(role),
      limit: COMMUNITY_BADGE_LIMIT,
      badges: allBadges.map((badge) =>
        toCommunityBadgeAdminDTO(badge, holderCounts.get(badge.id) ?? 0),
      ),
    };
  }

  /**
   * Route 3: create a badge. The community row is locked while the badge
   * count is checked against the limit, the new badge requests a silent
   * backfill, and `badge_created` is logged in the same transaction.
   */
  async create(
    slug: string,
    userId: string,
    body: CreateCommunityBadgeDto,
  ): Promise<CommunityBadgeAdminDTO> {
    const { community } = await this.resolveOwnerLevelWrite(slug, userId);
    const fields = normalizeBadgeCreate(body);
    try {
      const created = await this.dataSource.transaction(async (manager) => {
        await manager.query(LOCK_COMMUNITY_FOR_BADGES_SQL, [community.id]);
        const badgeRepository = manager.getRepository(CommunityBadge);
        const badgeCount = await badgeRepository.count({
          where: { communityId: community.id },
        });
        if (badgeCount >= COMMUNITY_BADGE_LIMIT) {
          throw communityBadgeError('badge_limit_reached', {
            limit: COMMUNITY_BADGE_LIMIT,
          });
        }
        const saved = await badgeRepository.save(
          badgeRepository.create({
            communityId: community.id,
            starterKey: null,
            name: fields.name,
            iconKey: fields.iconKey,
            tint: fields.tint,
            ruleType: fields.ruleType,
            threshold: fields.threshold,
            isEnabled: fields.isEnabled,
            createdById: userId,
            backfillRequestedAt: new Date(),
          }),
        );
        await this.governanceLog.log(
          {
            communityId: community.id,
            actorUserId: userId,
            action: GovernanceLogAction.BadgeCreated,
            metadata: { badgeId: saved.id, badgeName: saved.name },
          },
          manager,
        );
        return saved;
      });
      return toCommunityBadgeAdminDTO(created, 0);
    } catch (error) {
      if (isUniqueViolation(error, BADGE_NAME_UNIQUE_CONSTRAINT)) {
        throw communityBadgeError('badge_name_taken');
      }
      throw error;
    }
  }

  /**
   * Route 4: edit a badge. The badge row is re-read under a write lock inside
   * the transaction, so the changes, the backfill request and the save all
   * follow the current row and two editors apply one after the other. Only
   * fields whose value changes are written and logged; an empty or unchanged
   * patch answers the badge as it stands. A lowered threshold or a badge
   * switched on requests a silent backfill. Raising a threshold or switching
   * a badge off keeps every award and every worn badge.
   */
  async update(
    slug: string,
    userId: string,
    badgeId: string,
    body: UpdateCommunityBadgeDto,
  ): Promise<CommunityBadgeAdminDTO> {
    const { community } = await this.resolveOwnerLevelWrite(slug, userId);
    const badge = await this.loadBadgeOfCommunity(community, badgeId);
    const patch = normalizeBadgeUpdate(body, badge.ruleType);
    if (!Object.keys(patch).length) {
      const holderCounts = await this.holderCountsFor(
        this.dataSource,
        community.id,
      );
      return toCommunityBadgeAdminDTO(badge, holderCounts.get(badge.id) ?? 0);
    }
    try {
      return await this.dataSource.transaction(async (manager) => {
        const lockedBadge = await this.lockBadgeOfCommunity(
          manager,
          community.id,
          badge.id,
        );
        const changes = this.changedFields(lockedBadge, patch);
        if (!Object.keys(changes).length) {
          const holderCounts = await this.holderCountsFor(
            manager,
            community.id,
          );
          return toCommunityBadgeAdminDTO(
            lockedBadge,
            holderCounts.get(lockedBadge.id) ?? 0,
          );
        }
        const shouldRequestBackfill =
          (patch.threshold !== undefined &&
            patch.threshold < lockedBadge.threshold) ||
          (patch.isEnabled === true && !lockedBadge.isEnabled);
        for (const field of EDITABLE_BADGE_FIELDS) {
          if (changes[field] !== undefined) {
            Object.assign(lockedBadge, { [field]: patch[field] });
          }
        }
        if (shouldRequestBackfill) {
          lockedBadge.backfillRequestedAt = new Date();
        }
        const saved = await manager
          .getRepository(CommunityBadge)
          .save(lockedBadge);
        await this.governanceLog.log(
          {
            communityId: community.id,
            actorUserId: userId,
            action: GovernanceLogAction.BadgeUpdated,
            metadata: { badgeId: saved.id, badgeName: saved.name, changes },
          },
          manager,
        );
        const holderCounts = await this.holderCountsFor(manager, community.id);
        return toCommunityBadgeAdminDTO(saved, holderCounts.get(saved.id) ?? 0);
      });
    } catch (error) {
      if (isUniqueViolation(error, BADGE_NAME_UNIQUE_CONSTRAINT)) {
        throw communityBadgeError('badge_name_taken');
      }
      throw error;
    }
  }

  /**
   * Route 5: delete a badge. The badge row is re-read under a write lock
   * inside the transaction, so the logged name is the current one. Its
   * awards go with it through the cascade and every member wearing it stops
   * through the foreign key. The holder count taken just before the delete
   * is answered and logged with `badge_deleted`.
   */
  async remove(
    slug: string,
    userId: string,
    badgeId: string,
  ): Promise<{ id: string; holderCount: number }> {
    const { community } = await this.resolveOwnerLevelWrite(slug, userId);
    const badge = await this.loadBadgeOfCommunity(community, badgeId);
    return this.dataSource.transaction(async (manager) => {
      const lockedBadge = await this.lockBadgeOfCommunity(
        manager,
        community.id,
        badge.id,
      );
      const holderCounts = await this.holderCountsFor(manager, community.id);
      const holderCount = holderCounts.get(lockedBadge.id) ?? 0;
      const deleteResult = await manager
        .getRepository(CommunityBadge)
        .delete({ id: lockedBadge.id, communityId: community.id });
      if (deleteResult.affected === 0) {
        throw communityBadgeError('badge_not_found');
      }
      await this.governanceLog.log(
        {
          communityId: community.id,
          actorUserId: userId,
          action: GovernanceLogAction.BadgeDeleted,
          metadata: {
            badgeId: lockedBadge.id,
            badgeName: lockedBadge.name,
            holderCount,
          },
        },
        manager,
      );
      return { id: lockedBadge.id, holderCount };
    });
  }

  /**
   * Route 6: choose the badge a member wears beside their name, or stop
   * wearing one with null. The badge must belong to this community, be
   * switched on and be awarded to the caller.
   */
  async setFlair(
    slug: string,
    userId: string,
    body: SetCommunityFlairDto,
  ): Promise<CommunityFlairResponse> {
    const { community } = await resolveForRole(this.accessDeps, {
      slug,
      userId,
      isWrite: true,
      tier: 'member',
      refusalCode: 'COMMUNITY_MEMBERS_ONLY',
    });
    const requestedBadgeId = normalizeFlairBadgeId(body.badgeId);
    if (requestedBadgeId === null) {
      await this.dataSource.query(SET_WORN_BADGE_SQL, [
        community.id,
        userId,
        null,
      ]);
      return { wornBadgeId: null, flair: null };
    }
    const badge = await this.loadBadgeOfCommunity(community, requestedBadgeId);
    if (!badge.isEnabled) {
      throw communityBadgeError('flair_badge_disabled');
    }
    const hasEarnedBadge = await this.awards.exists({
      where: { badgeId: badge.id, userId },
    });
    if (!hasEarnedBadge) {
      throw communityBadgeError('flair_badge_not_earned');
    }
    try {
      await this.dataSource.query(SET_WORN_BADGE_SQL, [
        community.id,
        userId,
        badge.id,
      ]);
    } catch (error) {
      // The badge was deleted between the check and the write.
      if (isForeignKeyViolation(error, WORN_BADGE_FOREIGN_KEY)) {
        throw communityBadgeError('badge_not_found');
      }
      throw error;
    }
    return { wornBadgeId: badge.id, flair: toCommunityFlairDTO(badge) };
  }

  /** Access for the three owner-level writes (routes 3, 4 and 5). */
  private resolveOwnerLevelWrite(
    slug: string,
    userId: string,
  ): Promise<CommunityBadgeAccess> {
    return resolveForRole(this.accessDeps, {
      slug,
      userId,
      isWrite: true,
      tier: 'owner_level',
      refusalCode: 'badge_manage_owner_only',
    });
  }

  /** A badge of this community by id. A malformed id, an unknown id and a
   *  badge of another community all answer `badge_not_found`. */
  private async loadBadgeOfCommunity(
    community: Community,
    badgeId: unknown,
  ): Promise<CommunityBadge> {
    if (!isCommunityBadgeUuid(badgeId)) {
      throw communityBadgeError('badge_not_found');
    }
    const badge = await this.badges.findOne({
      where: { id: badgeId.toLowerCase() },
    });
    if (!badge || badge.communityId !== community.id) {
      throw communityBadgeError('badge_not_found');
    }
    return badge;
  }

  /** The badge row of this community re-read under a write lock inside a
   *  transaction, or `badge_not_found` when it is gone. */
  private async lockBadgeOfCommunity(
    manager: EntityManager,
    communityId: string,
    badgeId: string,
  ): Promise<CommunityBadge> {
    const lockedBadge = await manager.getRepository(CommunityBadge).findOne({
      where: { id: badgeId, communityId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!lockedBadge) {
      throw communityBadgeError('badge_not_found');
    }
    return lockedBadge;
  }

  /** Live holder counts by badge id for one community. */
  private async holderCountsFor(
    queryRunner: HolderCountQueryRunner,
    communityId: string,
  ): Promise<Map<string, number>> {
    const rows: HolderCountRow[] = await queryRunner.query(HOLDER_COUNTS_SQL, [
      communityId,
    ]);
    return new Map(rows.map((row) => [row.badge_id, Number(row.holder_count)]));
  }

  /** The `{ from, to }` of every patched field whose value differs. */
  private changedFields(
    badge: CommunityBadge,
    patch: NormalizedBadgeUpdate,
  ): Partial<Record<(typeof EDITABLE_BADGE_FIELDS)[number], BadgeFieldChange>> {
    const changes: Partial<
      Record<(typeof EDITABLE_BADGE_FIELDS)[number], BadgeFieldChange>
    > = {};
    for (const field of EDITABLE_BADGE_FIELDS) {
      const nextValue = patch[field];
      if (nextValue !== undefined && nextValue !== badge[field]) {
        changes[field] = { from: badge[field], to: nextValue };
      }
    }
    return changes;
  }
}
