import { ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MoreThanOrEqual } from 'typeorm';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { CommunityBanRatificationService } from './community-ban-ratification.service';
import { CommunityBansService } from './community-bans.service';
import { CommunityGovernanceLogService } from './community-governance-log.service';
import {
  CommunityBanRatification,
  CommunityBanRatificationStatus,
} from './entities/community-ban-ratification.entity';
import { CommunityBan } from './entities/community-ban.entity';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { AccessTier, Community } from './entities/community.entity';

/** The community row `resolveStaffCommunity` and the placer check read. */
interface CommunityFixture {
  id: string;
  slug: string;
  name: string;
  ownerId: string;
  parentId: string | null;
  accessTier: AccessTier;
  archivedAt: Date | null;
  rules: string[];
  rulesVersion: number;
}

/** The mutable state each test arranges before calling the service. */
interface BansSpecState {
  community: CommunityFixture;
  /** Effective role per user id; a missing entry means no roster row. */
  rolesByUserId: Map<string, RosterRole>;
  ban: CommunityBan;
  ratifiedHoldCount: number;
  /** Platform role per user id; a missing entry means no `users` row. */
  platformRolesByUserId: Map<string, UserRole>;
}

const ACTOR_ID = 'actor-1';
const OWNER_ID = 'owner-1';
const CO_OWNER_ID = 'co-owner-1';
const MOD_PEER_ID = 'mod-peer-1';
const TARGET_ID = 'target-1';
const BAN_CREATED_AT = new Date('2026-11-01T00:00:00.000Z');

const makeBan = (overrides: Partial<CommunityBan> = {}): CommunityBan => ({
  id: 'ban-1',
  communityId: 'community-1',
  userId: TARGET_ID,
  bannedByUserId: MOD_PEER_ID,
  reason: 'reason',
  expiresAt: new Date('2027-01-01T00:00:00.000Z'),
  ruleIndex: null,
  ruleVersion: null,
  ruleText: null,
  createdAt: BAN_CREATED_AT,
  ...overrides,
});

describe('CommunityBansService (SEC-40)', () => {
  let service: CommunityBansService;
  let state: BansSpecState;
  let bans: { findOne: jest.Mock; delete: jest.Mock; update: jest.Mock };
  let ratifications: { count: jest.Mock };

  beforeEach(async () => {
    state = {
      community: {
        id: 'community-1',
        slug: 'queer-devs',
        name: 'Queer Devs',
        ownerId: OWNER_ID,
        parentId: null,
        accessTier: AccessTier.Public,
        archivedAt: null,
        rules: [],
        rulesVersion: 1,
      },
      rolesByUserId: new Map([
        [ACTOR_ID, RosterRole.Mod],
        [OWNER_ID, RosterRole.Owner],
        [CO_OWNER_ID, RosterRole.CoOwner],
        [MOD_PEER_ID, RosterRole.Mod],
      ]),
      ban: makeBan(),
      ratifiedHoldCount: 0,
      platformRolesByUserId: new Map([
        [ACTOR_ID, UserRole.Member],
        [OWNER_ID, UserRole.Member],
        [CO_OWNER_ID, UserRole.Member],
        [MOD_PEER_ID, UserRole.Member],
      ]),
    };

    const communities = {
      findOne: jest.fn(() => Promise.resolve(state.community)),
    };
    const members = {
      findOne: jest.fn(
        ({ where }: { where: { communityId: string; userId: string } }) => {
          const role = state.rolesByUserId.get(where.userId);
          return Promise.resolve(
            role
              ? { communityId: where.communityId, userId: where.userId, role }
              : null,
          );
        },
      ),
    };
    bans = {
      findOne: jest.fn(() => Promise.resolve(state.ban)),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const profiles = {
      findOne: jest.fn().mockResolvedValue({ userId: TARGET_ID }),
      find: jest.fn().mockResolvedValue([]),
    };
    ratifications = {
      count: jest.fn(() => Promise.resolve(state.ratifiedHoldCount)),
    };
    const users = {
      findOne: jest.fn(({ where }: { where: { id: string } }) => {
        const role = state.platformRolesByUserId.get(where.id);
        return Promise.resolve(role ? { id: where.id, role } : null);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityBansService,
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(CommunityMember), useValue: members },
        { provide: getRepositoryToken(CommunityBan), useValue: bans },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(User), useValue: users },
        {
          provide: getRepositoryToken(CommunityBanRatification),
          useValue: ratifications,
        },
        {
          provide: CommunityGovernanceLogService,
          useValue: {
            log: jest.fn().mockResolvedValue(undefined),
            logModerationAudit: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: NotificationsService,
          useValue: { create: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: CommunityBanRatificationService,
          useValue: {
            withdrawPendingHold: jest.fn().mockResolvedValue(undefined),
            pendingHoldIdsByTargetUser: jest.fn().mockResolvedValue(new Map()),
            hasSecondEligibleSignatory: jest.fn().mockResolvedValue(true),
            proposePermanentBar: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    service = module.get(CommunityBansService);
  });

  describe('liftBan', () => {
    it('lets a moderator lift a ban a fellow moderator placed', async () => {
      await expect(
        service.liftBan('queer-devs', ACTOR_ID, 'target'),
      ).resolves.toEqual({ ok: true });
      expect(bans.delete).toHaveBeenCalledWith({ id: 'ban-1' });
    });

    it('lets a moderator lift a permanent bar that predates the second signature', async () => {
      state.ban = makeBan({ expiresAt: null });

      await expect(
        service.liftBan('queer-devs', ACTOR_ID, 'target'),
      ).resolves.toEqual({ ok: true });
    });

    it('refuses a moderator lifting a ratified permanent bar', async () => {
      state.ban = makeBan({ expiresAt: null });
      state.ratifiedHoldCount = 1;

      const refusal = service.liftBan('queer-devs', ACTOR_ID, 'target');

      await expect(refusal).rejects.toBeInstanceOf(ForbiddenException);
      await expect(refusal).rejects.toMatchObject({
        response: { code: 'RATIFIED_BAR_NEEDS_OWNER_LEVEL' },
      });
      expect(bans.delete).not.toHaveBeenCalled();
    });

    it.each([OWNER_ID, CO_OWNER_ID])(
      'refuses a moderator lifting a ban placed by %s',
      async (placerId) => {
        state.ban = makeBan({ bannedByUserId: placerId });

        const refusal = service.liftBan('queer-devs', ACTOR_ID, 'target');

        await expect(refusal).rejects.toMatchObject({
          response: { code: 'OWNER_PLACED_BAN_NEEDS_OWNER_LEVEL' },
        });
        expect(bans.delete).not.toHaveBeenCalled();
      },
    );

    it('reads the owner of record as owner-level without a roster row', async () => {
      state.rolesByUserId.delete(OWNER_ID);
      state.ban = makeBan({ bannedByUserId: OWNER_ID });

      await expect(
        service.liftBan('queer-devs', ACTOR_ID, 'target'),
      ).rejects.toMatchObject({
        response: { code: 'OWNER_PLACED_BAN_NEEDS_OWNER_LEVEL' },
      });
    });

    it.each([RosterRole.Owner, RosterRole.CoOwner])(
      'lets the %s lift a ratified bar the owner placed',
      async (role) => {
        state.rolesByUserId.set(ACTOR_ID, role);
        state.ban = makeBan({ bannedByUserId: OWNER_ID, expiresAt: null });
        state.ratifiedHoldCount = 1;

        await expect(
          service.liftBan('queer-devs', ACTOR_ID, 'target'),
        ).resolves.toEqual({ ok: true });
      },
    );

    // A permanent bar platform staff wrote from the admin console has no
    // ratification row and a placer off the roster, so the placer's platform
    // role keeps it owner-level to lift.
    it.each([UserRole.Moderator, UserRole.Admin])(
      'refuses a moderator lifting a permanent bar a platform %s placed',
      async (platformRole) => {
        state.platformRolesByUserId.set('platform-staff-1', platformRole);
        state.ban = makeBan({
          bannedByUserId: 'platform-staff-1',
          expiresAt: null,
        });

        const refusal = service.liftBan('queer-devs', ACTOR_ID, 'target');

        await expect(refusal).rejects.toBeInstanceOf(ForbiddenException);
        await expect(refusal).rejects.toMatchObject({
          response: { code: 'STAFF_PLACED_BAN_NEEDS_OWNER_LEVEL' },
        });
        expect(bans.delete).not.toHaveBeenCalled();
      },
    );

    it('lets a moderator lift a timed ban platform staff placed', async () => {
      state.platformRolesByUserId.set('platform-staff-1', UserRole.Admin);
      state.ban = makeBan({ bannedByUserId: 'platform-staff-1' });

      await expect(
        service.liftBan('queer-devs', ACTOR_ID, 'target'),
      ).resolves.toEqual({ ok: true });
    });

    it('lets the platform staff member who placed a permanent bar lift it', async () => {
      state.platformRolesByUserId.set(ACTOR_ID, UserRole.Admin);
      state.ban = makeBan({ bannedByUserId: ACTOR_ID, expiresAt: null });

      await expect(
        service.liftBan('queer-devs', ACTOR_ID, 'target'),
      ).resolves.toEqual({ ok: true });
    });

    it('lets the owner lift a permanent bar platform staff placed', async () => {
      state.rolesByUserId.set(ACTOR_ID, RosterRole.Owner);
      state.platformRolesByUserId.set('platform-staff-1', UserRole.Admin);
      state.ban = makeBan({
        bannedByUserId: 'platform-staff-1',
        expiresAt: null,
      });

      await expect(
        service.liftBan('queer-devs', ACTOR_ID, 'target'),
      ).resolves.toEqual({ ok: true });
    });

    it('treats a ban whose placer has left as ordinary', async () => {
      state.ban = makeBan({ bannedByUserId: 'gone-co-owner' });

      await expect(
        service.liftBan('queer-devs', ACTOR_ID, 'target'),
      ).resolves.toEqual({ ok: true });
    });

    it('only counts a ratification decided since this ban was written', async () => {
      state.ban = makeBan({ expiresAt: null });

      await service.liftBan('queer-devs', ACTOR_ID, 'target');

      expect(ratifications.count).toHaveBeenCalledWith({
        where: {
          communityId: 'community-1',
          targetUserId: TARGET_ID,
          status: CommunityBanRatificationStatus.Ratified,
          decidedAt: MoreThanOrEqual(BAN_CREATED_AT),
        },
      });
    });
  });

  describe('updateBan', () => {
    it('refuses a moderator giving a ratified permanent bar an end date', async () => {
      state.ban = makeBan({ expiresAt: null });
      state.ratifiedHoldCount = 1;

      await expect(
        service.updateBan('queer-devs', ACTOR_ID, 'target', { banDays: 7 }),
      ).rejects.toMatchObject({
        response: { code: 'RATIFIED_BAR_NEEDS_OWNER_LEVEL' },
      });
      expect(bans.update).not.toHaveBeenCalled();
    });

    it('refuses a moderator shortening an owner-placed ban', async () => {
      state.ban = makeBan({ bannedByUserId: OWNER_ID });

      await expect(
        service.updateBan('queer-devs', ACTOR_ID, 'target', { banDays: 1 }),
      ).rejects.toMatchObject({
        response: { code: 'OWNER_PLACED_BAN_NEEDS_OWNER_LEVEL' },
      });
      expect(bans.update).not.toHaveBeenCalled();
    });

    it('refuses a moderator giving a permanent bar platform staff placed an end date', async () => {
      state.platformRolesByUserId.set('platform-staff-1', UserRole.Moderator);
      state.ban = makeBan({
        bannedByUserId: 'platform-staff-1',
        expiresAt: null,
      });

      await expect(
        service.updateBan('queer-devs', ACTOR_ID, 'target', { banDays: 7 }),
      ).rejects.toMatchObject({
        response: { code: 'STAFF_PLACED_BAN_NEEDS_OWNER_LEVEL' },
      });
      expect(bans.update).not.toHaveBeenCalled();
    });

    it('lets a moderator extend an owner-placed ban', async () => {
      state.ban = makeBan({
        bannedByUserId: OWNER_ID,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      await service.updateBan('queer-devs', ACTOR_ID, 'target', {
        banDays: 90,
      });

      expect(bans.update).toHaveBeenCalled();
    });

    it('lets a moderator reword an owner-placed ban', async () => {
      state.ban = makeBan({ bannedByUserId: OWNER_ID });

      await service.updateBan('queer-devs', ACTOR_ID, 'target', {
        reason: 'clearer reason',
      });

      expect(bans.update).toHaveBeenCalledWith(
        { id: 'ban-1' },
        { reason: 'clearer reason' },
      );
    });

    it('lets a moderator shorten a ban a fellow moderator placed', async () => {
      await service.updateBan('queer-devs', ACTOR_ID, 'target', {
        banDays: 1,
      });

      expect(bans.update).toHaveBeenCalled();
    });
  });
});
