import { HttpException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CommunityGovernanceLogService } from '../communities/community-governance-log.service';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { GovernanceLogAction } from '../communities/entities/community-governance-log.entity';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { SUBCOMMUNITY_FEATURE_UNAVAILABLE_CODE } from '../communities/subcommunity-rules';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { CommunityBadgeAwardingService } from './community-badge-awarding.service';
import { CommunityBadgeRuleType } from './community-badges.catalog';
import {
  CommunityBadgesService,
  HOLDER_COUNTS_SQL,
  LOCK_COMMUNITY_FOR_BADGES_SQL,
  SET_WORN_BADGE_SQL,
} from './community-badges.service';
import { CommunityBadgeAward } from './entities/community-badge-award.entity';
import { CommunityBadge } from './entities/community-badge.entity';

const BADGE_ONE_ID = '1b2c3d4e-0000-4000-8000-000000000001';
const BADGE_TWO_ID = '1b2c3d4e-0000-4000-8000-000000000002';
const CREATED_AT = new Date('2026-11-01T10:00:00.000Z');
const UPDATED_AT = new Date('2026-11-02T10:00:00.000Z');

/** A badge row of community c1 with these overrides. */
function badgeFixture(overrides: Partial<CommunityBadge> = {}): CommunityBadge {
  return {
    id: BADGE_ONE_ID,
    communityId: 'c1',
    starterKey: 'regular',
    name: 'Regular',
    iconKey: 'calendar',
    tint: 'jade',
    ruleType: CommunityBadgeRuleType.EventsCheckedIn,
    threshold: 3,
    isEnabled: true,
    createdById: null,
    backfillRequestedAt: null,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe('CommunityBadgesService', () => {
  let service: CommunityBadgesService;
  let communities: { findOne: jest.Mock };
  let members: { findOne: jest.Mock };
  let badges: {
    find: jest.Mock;
    findOne: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let awards: { find: jest.Mock; exists: jest.Mock };
  let manager: { query: jest.Mock; getRepository: jest.Mock };
  let dataSource: { transaction: jest.Mock; query: jest.Mock };
  let membership: { effectiveRole: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };
  let governanceLog: { log: jest.Mock };
  let awarding: { memberCounts: jest.Mock };
  let holderRows: { badge_id: string; holder_count: number | string }[];

  /** Answers the holder count statement with `holderRows` and every other
   *  statement with no rows. */
  function answerQuery(sql: string): Promise<unknown[]> {
    return Promise.resolve(sql === HOLDER_COUNTS_SQL ? holderRows : []);
  }

  /** Make the slug resolve to community c1 with these overrides, and the
   *  caller to this effective role. A lookup filtered on `archivedAt`
   *  misses an archived community, as `loadActiveCommunityOr404` does. */
  function stageCommunity(
    overrides: Partial<Community>,
    role: RosterRole | null,
  ): void {
    const community = {
      id: 'c1',
      slug: 'night-swim',
      archivedAt: null,
      parentId: null,
      accessTier: AccessTier.Public,
      ...overrides,
    };
    communities.findOne.mockImplementation(
      ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          'archivedAt' in where && community.archivedAt !== null
            ? null
            : community,
        ),
    );
    membership.effectiveRole.mockResolvedValue(role);
  }

  /** The response body of a rejected call. */
  async function rejectionBody(
    promise: Promise<unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      return (error as HttpException).getResponse() as Record<string, unknown>;
    }
    throw new Error('Expected the call to reject');
  }

  async function rejectionCode(promise: Promise<unknown>): Promise<unknown> {
    return (await rejectionBody(promise)).code;
  }

  beforeEach(async () => {
    holderRows = [];
    communities = { findOne: jest.fn() };
    members = { findOne: jest.fn().mockResolvedValue(null) };
    badges = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((value: Partial<CommunityBadge>) => value),
      save: jest.fn((value: Partial<CommunityBadge>) => Promise.resolve(value)),
      delete: jest.fn().mockResolvedValue({ affected: 1, raw: [] }),
    };
    awards = {
      find: jest.fn().mockResolvedValue([]),
      exists: jest.fn().mockResolvedValue(true),
    };
    manager = {
      query: jest.fn(answerQuery),
      getRepository: jest.fn((entity: unknown) => {
        if (entity === CommunityBadge) return badges;
        throw new Error(
          `unexpected entity in getRepository: ${String(entity)}`,
        );
      }),
    };
    dataSource = {
      transaction: jest.fn(
        async (callback: (transactionManager: typeof manager) => unknown) =>
          callback(manager),
      ),
      query: jest.fn(answerQuery),
    };
    membership = { effectiveRole: jest.fn() };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
    governanceLog = { log: jest.fn().mockResolvedValue(undefined) };
    awarding = { memberCounts: jest.fn() };
    stageCommunity({}, RosterRole.Owner);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityBadgesService,
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(CommunityMember), useValue: members },
        { provide: getRepositoryToken(CommunityBadge), useValue: badges },
        { provide: getRepositoryToken(CommunityBadgeAward), useValue: awards },
        { provide: DataSource, useValue: dataSource },
        { provide: CommunityMembershipService, useValue: membership },
        { provide: ContentModerationService, useValue: contentModeration },
        { provide: CommunityGovernanceLogService, useValue: governanceLog },
        { provide: CommunityBadgeAwardingService, useValue: awarding },
      ],
    }).compile();
    service = module.get(CommunityBadgesService);
  });

  describe('listForViewer', () => {
    it('gives a member progress, earned dates and the worn badge', async () => {
      stageCommunity({}, RosterRole.Member);
      members.findOne.mockResolvedValue({
        id: 'row-1',
        wornBadgeId: BADGE_ONE_ID,
      });
      badges.find.mockResolvedValue([
        badgeFixture(),
        badgeFixture({
          id: BADGE_TWO_ID,
          starterKey: 'old_friend',
          name: 'Old friend',
          ruleType: CommunityBadgeRuleType.TenureDays,
          threshold: 365,
        }),
      ]);
      awarding.memberCounts.mockResolvedValue({
        tenureDays: 40,
        eventsCheckedIn: 2,
        volunteerHours: 0,
        postsAndReplies: 1,
      });
      const awardedAt = new Date('2026-11-10T08:00:00.000Z');
      awards.find.mockResolvedValue([{ badgeId: BADGE_ONE_ID, awardedAt }]);

      const response = await service.listForViewer('night-swim', 'u1');

      expect(badges.find).toHaveBeenCalledWith({
        where: { communityId: 'c1', isEnabled: true },
        order: { createdAt: 'ASC', id: 'ASC' },
      });
      expect(awarding.memberCounts).toHaveBeenCalledWith('c1', 'u1');
      expect(response.isMember).toBe(true);
      expect(response.wornBadgeId).toBe(BADGE_ONE_ID);
      expect(response.badges).toEqual([
        expect.objectContaining({
          id: BADGE_ONE_ID,
          progress: 2,
          earnedAt: awardedAt.toISOString(),
        }),
        expect.objectContaining({
          id: BADGE_TWO_ID,
          progress: 40,
          earnedAt: null,
        }),
      ]);
    });

    it('hides the worn id when that badge is disabled', async () => {
      stageCommunity({}, RosterRole.Member);
      members.findOne.mockResolvedValue({
        id: 'row-1',
        wornBadgeId: BADGE_TWO_ID,
      });
      badges.find.mockResolvedValue([badgeFixture()]);
      awarding.memberCounts.mockResolvedValue({
        tenureDays: 40,
        eventsCheckedIn: 3,
        volunteerHours: 0,
        postsAndReplies: 0,
      });
      awards.find.mockResolvedValue([
        { badgeId: BADGE_TWO_ID, awardedAt: CREATED_AT },
      ]);

      const response = await service.listForViewer('night-swim', 'u1');

      expect(response.wornBadgeId).toBeNull();
      expect(response.badges.map((badge) => badge.id)).toEqual([BADGE_ONE_ID]);
    });

    it('gives a visitor of a public community the list with no progress', async () => {
      stageCommunity({ accessTier: AccessTier.Public }, null);
      badges.find.mockResolvedValue([badgeFixture()]);

      const response = await service.listForViewer('night-swim', 'visitor-1');

      expect(response.isMember).toBe(false);
      expect(response.wornBadgeId).toBeNull();
      expect(response.badges).toHaveLength(1);
      expect(
        response.badges.every(
          (badge) => badge.progress === null && badge.earnedAt === null,
        ),
      ).toBe(true);
      expect(awarding.memberCounts).not.toHaveBeenCalled();
      expect(awards.find).not.toHaveBeenCalled();
    });

    it('answers a space with the space code after the access check', async () => {
      stageCommunity({ parentId: 'parent-1' }, RosterRole.Member);

      expect(
        await rejectionCode(service.listForViewer('night-swim', 'u1')),
      ).toBe(SUBCOMMUNITY_FEATURE_UNAVAILABLE_CODE);
      expect(membership.effectiveRole).toHaveBeenCalled();
      expect(badges.find).not.toHaveBeenCalled();
    });
  });

  describe('listForStaff', () => {
    it('lets a mod read every badge with holder counts and no manage right', async () => {
      stageCommunity({}, RosterRole.Mod);
      badges.find.mockResolvedValue([
        badgeFixture(),
        badgeFixture({ id: BADGE_TWO_ID, name: 'Quiet', isEnabled: false }),
      ]);
      holderRows = [{ badge_id: BADGE_ONE_ID, holder_count: '4' }];

      const response = await service.listForStaff('night-swim', 'mod-1');

      expect(badges.find).toHaveBeenCalledWith({
        where: { communityId: 'c1' },
        order: { createdAt: 'ASC', id: 'ASC' },
      });
      expect(dataSource.query).toHaveBeenCalledWith(HOLDER_COUNTS_SQL, ['c1']);
      expect(response.canManage).toBe(false);
      expect(response.limit).toBe(12);
      expect(response.badges).toEqual([
        expect.objectContaining({
          id: BADGE_ONE_ID,
          holderCount: 4,
          isEnabled: true,
        }),
        expect.objectContaining({
          id: BADGE_TWO_ID,
          holderCount: 0,
          isEnabled: false,
        }),
      ]);
    });

    it('refuses a plain member with badge_settings_staff_only', async () => {
      stageCommunity({}, RosterRole.Member);

      expect(
        await rejectionCode(service.listForStaff('night-swim', 'u1')),
      ).toBe('badge_settings_staff_only');
      expect(badges.find).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    const createBody = {
      name: 'Night owls',
      iconKey: 'moon',
      tint: 'plum',
      ruleType: 'events_checked_in',
      threshold: 2,
    };

    it('creates a badge, requests a backfill and logs badge_created', async () => {
      badges.count.mockResolvedValue(4);
      badges.save.mockImplementation((value: Partial<CommunityBadge>) =>
        Promise.resolve({
          ...value,
          id: 'badge-new',
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        }),
      );

      const response = await service.create('night-swim', 'owner-1', {
        ...createBody,
      });

      expect(manager.query).toHaveBeenCalledWith(
        LOCK_COMMUNITY_FOR_BADGES_SQL,
        ['c1'],
      );
      expect(badges.save).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: 'c1',
          name: 'Night owls',
          threshold: 2,
          createdById: 'owner-1',
          backfillRequestedAt: expect.any(Date),
          isEnabled: true,
        }),
      );
      expect(governanceLog.log).toHaveBeenCalledWith(
        {
          communityId: 'c1',
          actorUserId: 'owner-1',
          action: GovernanceLogAction.BadgeCreated,
          metadata: { badgeId: 'badge-new', badgeName: 'Night owls' },
        },
        manager,
      );
      expect(response).toEqual(
        expect.objectContaining({
          id: 'badge-new',
          holderCount: 0,
          isEnabled: true,
        }),
      );
    });

    it('refuses the thirteenth badge with the limit', async () => {
      badges.count.mockResolvedValue(12);

      const body = await rejectionBody(
        service.create('night-swim', 'owner-1', { ...createBody }),
      );

      expect(body).toEqual(
        expect.objectContaining({ code: 'badge_limit_reached', limit: 12 }),
      );
      expect(manager.query).toHaveBeenCalledWith(
        LOCK_COMMUNITY_FOR_BADGES_SQL,
        ['c1'],
      );
      expect(manager.query.mock.invocationCallOrder[0]).toBeLessThan(
        badges.count.mock.invocationCallOrder[0] ?? -1,
      );
      expect(badges.save).not.toHaveBeenCalled();
      expect(governanceLog.log).not.toHaveBeenCalled();
    });

    it('maps a name clash to badge_name_taken', async () => {
      badges.save.mockRejectedValue({
        code: '23505',
        constraint: 'UQ_community_badges_community_name',
      });

      expect(
        await rejectionCode(
          service.create('night-swim', 'owner-1', { ...createBody }),
        ),
      ).toBe('badge_name_taken');
      expect(governanceLog.log).not.toHaveBeenCalled();
    });

    it('refuses a mod with badge_manage_owner_only', async () => {
      stageCommunity({}, RosterRole.Mod);

      expect(
        await rejectionCode(
          service.create('night-swim', 'mod-1', { ...createBody }),
        ),
      ).toBe('badge_manage_owner_only');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('answers an empty patch with the badge and writes nothing', async () => {
      badges.findOne.mockResolvedValue(badgeFixture());
      holderRows = [{ badge_id: BADGE_ONE_ID, holder_count: 3 }];

      const response = await service.update(
        'night-swim',
        'owner-1',
        BADGE_ONE_ID,
        {},
      );

      expect(response).toEqual(
        expect.objectContaining({
          id: BADGE_ONE_ID,
          threshold: 3,
          holderCount: 3,
        }),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(badges.save).not.toHaveBeenCalled();
      expect(governanceLog.log).not.toHaveBeenCalled();
    });

    it('answers an unchanged patch from the locked row and writes nothing', async () => {
      badges.findOne.mockResolvedValue(badgeFixture());
      holderRows = [{ badge_id: BADGE_ONE_ID, holder_count: 3 }];

      const response = await service.update(
        'night-swim',
        'owner-1',
        BADGE_ONE_ID,
        { threshold: 3, name: 'Regular' },
      );

      expect(response).toEqual(
        expect.objectContaining({
          id: BADGE_ONE_ID,
          threshold: 3,
          holderCount: 3,
        }),
      );
      expect(badges.findOne).toHaveBeenLastCalledWith({
        where: { id: BADGE_ONE_ID, communityId: 'c1' },
        lock: { mode: 'pessimistic_write' },
      });
      expect(badges.save).not.toHaveBeenCalled();
      expect(governanceLog.log).not.toHaveBeenCalled();
    });

    it('computes the change from the locked row and keeps its cleared backfill', async () => {
      badges.findOne
        .mockResolvedValueOnce(
          badgeFixture({ backfillRequestedAt: new Date(), threshold: 4 }),
        )
        .mockResolvedValueOnce(
          badgeFixture({ backfillRequestedAt: null, threshold: 2 }),
        );

      await service.update('night-swim', 'owner-1', BADGE_ONE_ID, {
        name: 'Familiar face',
        threshold: 2,
      });

      expect(badges.findOne).toHaveBeenCalledTimes(2);
      expect(badges.save).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Familiar face',
          threshold: 2,
          backfillRequestedAt: null,
        }),
      );
      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            badgeId: BADGE_ONE_ID,
            badgeName: 'Familiar face',
            changes: { name: { from: 'Regular', to: 'Familiar face' } },
          },
        }),
        manager,
      );
    });

    it('answers badge_not_found when the badge is gone under the lock', async () => {
      badges.findOne
        .mockResolvedValueOnce(badgeFixture())
        .mockResolvedValueOnce(null);

      expect(
        await rejectionCode(
          service.update('night-swim', 'owner-1', BADGE_ONE_ID, {
            threshold: 2,
          }),
        ),
      ).toBe('badge_not_found');
      expect(badges.save).not.toHaveBeenCalled();
      expect(governanceLog.log).not.toHaveBeenCalled();
    });

    it('maps a name clash to badge_name_taken', async () => {
      badges.findOne.mockResolvedValue(badgeFixture());
      badges.save.mockRejectedValue({
        code: '23505',
        constraint: 'UQ_community_badges_community_name',
      });

      expect(
        await rejectionCode(
          service.update('night-swim', 'owner-1', BADGE_ONE_ID, {
            name: 'Old friend',
          }),
        ),
      ).toBe('badge_name_taken');
      expect(governanceLog.log).not.toHaveBeenCalled();
    });

    it('requests a backfill when the threshold goes down and logs the diff', async () => {
      badges.findOne.mockResolvedValue(badgeFixture());

      const response = await service.update(
        'night-swim',
        'owner-1',
        BADGE_ONE_ID,
        { threshold: 2 },
      );

      expect(badges.save).toHaveBeenCalledWith(
        expect.objectContaining({
          threshold: 2,
          backfillRequestedAt: expect.any(Date),
        }),
      );
      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: 'c1',
          actorUserId: 'owner-1',
          action: GovernanceLogAction.BadgeUpdated,
          metadata: {
            badgeId: BADGE_ONE_ID,
            badgeName: 'Regular',
            changes: { threshold: { from: 3, to: 2 } },
          },
        }),
        manager,
      );
      expect(response.threshold).toBe(2);
    });

    it('requests no backfill when the threshold goes up', async () => {
      badges.findOne.mockResolvedValue(badgeFixture());

      await service.update('night-swim', 'owner-1', BADGE_ONE_ID, {
        threshold: 5,
      });

      expect(badges.save).toHaveBeenCalledWith(
        expect.objectContaining({ threshold: 5, backfillRequestedAt: null }),
      );
      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            changes: { threshold: { from: 3, to: 5 } },
          }),
        }),
        manager,
      );
    });

    it('requests a backfill when a disabled badge is switched on', async () => {
      badges.findOne.mockResolvedValue(badgeFixture({ isEnabled: false }));

      await service.update('night-swim', 'owner-1', BADGE_ONE_ID, {
        isEnabled: true,
      });

      expect(badges.save).toHaveBeenCalledWith(
        expect.objectContaining({
          isEnabled: true,
          backfillRequestedAt: expect.any(Date),
        }),
      );
      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            changes: { isEnabled: { from: false, to: true } },
          }),
        }),
        manager,
      );
    });

    it('logs the name after a rename', async () => {
      badges.findOne.mockResolvedValue(badgeFixture());

      await service.update('night-swim', 'owner-1', BADGE_ONE_ID, {
        name: 'Familiar face',
      });

      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            badgeId: BADGE_ONE_ID,
            badgeName: 'Familiar face',
            changes: { name: { from: 'Regular', to: 'Familiar face' } },
          },
        }),
        manager,
      );
    });

    it('refuses a patch carrying ruleType with badge_rule_locked', async () => {
      badges.findOne.mockResolvedValue(badgeFixture());

      expect(
        await rejectionCode(
          service.update('night-swim', 'owner-1', BADGE_ONE_ID, {
            ruleType: 'tenure_days',
          }),
        ),
      ).toBe('badge_rule_locked');
      expect(badges.save).not.toHaveBeenCalled();
    });

    it('answers badge_not_found for a malformed id and for another community', async () => {
      expect(
        await rejectionCode(
          service.update('night-swim', 'owner-1', 'abc', { threshold: 2 }),
        ),
      ).toBe('badge_not_found');
      expect(badges.findOne).not.toHaveBeenCalled();

      badges.findOne.mockResolvedValue(badgeFixture({ communityId: 'c2' }));
      expect(
        await rejectionCode(
          service.update('night-swim', 'owner-1', BADGE_ONE_ID, {
            threshold: 2,
          }),
        ),
      ).toBe('badge_not_found');
      expect(badges.save).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes the badge and logs the holder count taken just before', async () => {
      badges.findOne.mockResolvedValue(badgeFixture());
      holderRows = [
        { badge_id: BADGE_ONE_ID, holder_count: 4 },
        { badge_id: BADGE_TWO_ID, holder_count: 9 },
      ];

      const response = await service.remove(
        'night-swim',
        'owner-1',
        BADGE_ONE_ID,
      );

      expect(response).toEqual({ id: BADGE_ONE_ID, holderCount: 4 });
      expect(manager.query).toHaveBeenCalledWith(HOLDER_COUNTS_SQL, ['c1']);
      expect(manager.query.mock.invocationCallOrder[0]).toBeLessThan(
        badges.delete.mock.invocationCallOrder[0] ?? -1,
      );
      expect(badges.delete).toHaveBeenCalledWith({
        id: BADGE_ONE_ID,
        communityId: 'c1',
      });
      expect(governanceLog.log).toHaveBeenCalledWith(
        {
          communityId: 'c1',
          actorUserId: 'owner-1',
          action: GovernanceLogAction.BadgeDeleted,
          metadata: {
            badgeId: BADGE_ONE_ID,
            badgeName: 'Regular',
            holderCount: 4,
          },
        },
        manager,
      );
    });

    it('logs the name of the locked row', async () => {
      badges.findOne
        .mockResolvedValueOnce(badgeFixture())
        .mockResolvedValueOnce(badgeFixture({ name: 'Familiar face' }));

      await service.remove('night-swim', 'owner-1', BADGE_ONE_ID);

      expect(badges.findOne).toHaveBeenLastCalledWith({
        where: { id: BADGE_ONE_ID, communityId: 'c1' },
        lock: { mode: 'pessimistic_write' },
      });
      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            badgeId: BADGE_ONE_ID,
            badgeName: 'Familiar face',
            holderCount: 0,
          },
        }),
        manager,
      );
    });

    it('answers badge_not_found when the delete removes no row', async () => {
      badges.findOne.mockResolvedValue(badgeFixture());
      badges.delete.mockResolvedValue({ affected: 0, raw: [] });

      expect(
        await rejectionCode(
          service.remove('night-swim', 'owner-1', BADGE_ONE_ID),
        ),
      ).toBe('badge_not_found');
      expect(governanceLog.log).not.toHaveBeenCalled();
    });

    it('refuses a mod with badge_manage_owner_only', async () => {
      stageCommunity({}, RosterRole.Mod);

      expect(
        await rejectionCode(
          service.remove('night-swim', 'mod-1', BADGE_ONE_ID),
        ),
      ).toBe('badge_manage_owner_only');
      expect(badges.delete).not.toHaveBeenCalled();
    });
  });

  describe('setFlair', () => {
    beforeEach(() => {
      stageCommunity({}, RosterRole.Member);
    });

    it('wears an earned enabled badge', async () => {
      badges.findOne.mockResolvedValue(badgeFixture());

      const response = await service.setFlair('night-swim', 'u1', {
        badgeId: BADGE_ONE_ID,
      });

      expect(awards.exists).toHaveBeenCalledWith({
        where: { badgeId: BADGE_ONE_ID, userId: 'u1' },
      });
      expect(dataSource.query).toHaveBeenCalledWith(SET_WORN_BADGE_SQL, [
        'c1',
        'u1',
        BADGE_ONE_ID,
      ]);
      expect(response).toEqual({
        wornBadgeId: BADGE_ONE_ID,
        flair: {
          name: 'Regular',
          starterKey: 'regular',
          iconKey: 'calendar',
          tint: 'jade',
        },
      });
    });

    it('answers badge_not_found when the badge is deleted before the write', async () => {
      badges.findOne.mockResolvedValue(badgeFixture());
      dataSource.query.mockRejectedValue({
        code: '23503',
        constraint: 'FK_community_members_worn_badge_id',
      });

      expect(
        await rejectionCode(
          service.setFlair('night-swim', 'u1', { badgeId: BADGE_ONE_ID }),
        ),
      ).toBe('badge_not_found');
    });

    it('stops wearing on null', async () => {
      const response = await service.setFlair('night-swim', 'u1', {
        badgeId: null,
      });

      expect(dataSource.query).toHaveBeenCalledWith(SET_WORN_BADGE_SQL, [
        'c1',
        'u1',
        null,
      ]);
      expect(response).toEqual({ wornBadgeId: null, flair: null });
      expect(badges.findOne).not.toHaveBeenCalled();
    });

    it.each([
      [
        'flair_badge_disabled',
        () => {
          badges.findOne.mockResolvedValue(badgeFixture({ isEnabled: false }));
        },
      ],
      [
        'flair_badge_not_earned',
        () => {
          badges.findOne.mockResolvedValue(badgeFixture());
          awards.exists.mockResolvedValue(false);
        },
      ],
      [
        'badge_not_found',
        () => {
          badges.findOne.mockResolvedValue(null);
        },
      ],
    ])('refuses with %s', async (code, stageRefusal) => {
      stageRefusal();

      expect(
        await rejectionCode(
          service.setFlair('night-swim', 'u1', { badgeId: BADGE_ONE_ID }),
        ),
      ).toBe(code);
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('answers flair_badge_id_invalid for a value that is no badge id', async () => {
      expect(
        await rejectionCode(
          service.setFlair('night-swim', 'u1', { badgeId: 'badge-1' }),
        ),
      ).toBe('flair_badge_id_invalid');
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('answers COMMUNITY_MEMBERS_ONLY to a non-member of a public community', async () => {
      stageCommunity({ accessTier: AccessTier.Public }, null);

      expect(
        await rejectionCode(
          service.setFlair('night-swim', 'visitor-1', { badgeId: null }),
        ),
      ).toBe('COMMUNITY_MEMBERS_ONLY');
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('404s an archived community on a write', async () => {
      stageCommunity(
        { archivedAt: new Date('2026-10-01T00:00:00.000Z') },
        RosterRole.Member,
      );

      await expect(
        service.setFlair('night-swim', 'u1', { badgeId: null }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(membership.effectiveRole).not.toHaveBeenCalled();
      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });
});
