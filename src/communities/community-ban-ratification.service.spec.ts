import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { CommunityBanRatificationService } from './community-ban-ratification.service';
import {
  COMMUNITY_BAN_RATIFICATION_WINDOW_HOURS,
  COMMUNITY_BAN_UNRATIFIED_FALLBACK_DAYS,
} from './community-ban-ratification-window';
import {
  COMMUNITY_BAN_AUDIT_ACTION,
  CommunityGovernanceLogService,
} from './community-governance-log.service';
import { CommunityBanRatification } from './entities/community-ban-ratification.entity';
import { CommunityBanRatificationStatus } from './entities/community-ban-ratification.entity';
import { CommunityBan } from './entities/community-ban.entity';
import { GovernanceLogAction } from './entities/community-governance-log.entity';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { Community } from './entities/community.entity';

const COMMUNITY = {
  id: 'c1',
  slug: 'trans-joy',
  name: 'Trans Joy',
  rules: [],
  rulesVersion: 1,
  archivedAt: null,
} as unknown as Community;

const THIRTY_DAYS_MS =
  COMMUNITY_BAN_UNRATIFIED_FALLBACK_DAYS * 24 * 60 * 60 * 1000;

/** A 30-day bar already in force, the state a proposal is always made from. */
const banInForce = (): CommunityBan => ({
  id: 'ban-1',
  communityId: 'c1',
  userId: 'member-1',
  bannedByUserId: 'mod-1',
  reason: 'Harassment',
  expiresAt: new Date(Date.now() + THIRTY_DAYS_MS),
  ruleIndex: null,
  ruleVersion: null,
  ruleText: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
});

const pendingHold = (
  overrides: Partial<CommunityBanRatification> = {},
): CommunityBanRatification => ({
  id: 'hold-1',
  communityId: 'c1',
  targetUserId: 'member-1',
  targetName: 'Ana Silva',
  requestedBy: 'mod-1',
  note: 'Harassment',
  ruleIndex: null,
  ruleVersion: null,
  ruleText: null,
  interimAction: 'removed_and_barred_30_days',
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  status: CommunityBanRatificationStatus.Pending,
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('CommunityBanRatificationService', () => {
  let service: CommunityBanRatificationService;
  let communities: { findOne: jest.Mock };
  let members: { findOne: jest.Mock; count: jest.Mock };
  let bans: { find: jest.Mock; findOne: jest.Mock };
  let ratifications: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let profiles: { findOne: jest.Mock; find: jest.Mock };
  let governanceLog: { log: jest.Mock; logModerationAudit: jest.Mock };
  let notifications: { create: jest.Mock };
  let manager: { update: jest.Mock };

  beforeEach(async () => {
    communities = { findOne: jest.fn().mockResolvedValue(COMMUNITY) };
    members = {
      // `resolveStaffCommunity` reads the caller's roster row. Default: the
      // caller is a moderator of this community.
      findOne: jest
        .fn()
        .mockResolvedValue({ role: RosterRole.Mod, userId: 'mod-2' }),
      // "Is there anybody else who could sign". Default: yes.
      count: jest.fn().mockResolvedValue(1),
    };
    bans = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(banInForce()),
    };
    ratifications = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row: object) => row),
      save: jest.fn((row: object) =>
        Promise.resolve({
          id: 'hold-1',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...row,
        }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    profiles = {
      findOne: jest
        .fn()
        .mockResolvedValue({ firstName: 'Ana', lastName: 'Silva' }),
      find: jest.fn().mockResolvedValue([]),
    };
    governanceLog = {
      log: jest.fn().mockResolvedValue(undefined),
      logModerationAudit: jest.fn().mockResolvedValue(undefined),
    };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    manager = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    const dataSource = {
      transaction: jest.fn(
        async (callback: (m: typeof manager) => Promise<unknown>) =>
          callback(manager),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityBanRatificationService,
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(CommunityMember), useValue: members },
        { provide: getRepositoryToken(CommunityBan), useValue: bans },
        {
          provide: getRepositoryToken(CommunityBanRatification),
          useValue: ratifications,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: DataSource, useValue: dataSource },
        { provide: CommunityGovernanceLogService, useValue: governanceLog },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(CommunityBanRatificationService);
    setImageUrlBase('https://api.test');
  });

  afterEach(() => {
    resetImageUrlBaseForTesting();
  });

  describe('proposePermanentBar', () => {
    it('opens a pending hold with the 72-hour window when somebody else could sign', async () => {
      const before = Date.now();

      const hold = await service.proposePermanentBar({
        community: COMMUNITY,
        ban: banInForce(),
        proposerUserId: 'mod-1',
        reason: 'Harassment',
      });

      expect(hold).not.toBeNull();
      const saved = ratifications.save.mock.calls[0]?.[0] as {
        requestedBy: string;
        status: CommunityBanRatificationStatus;
        expiresAt: Date;
        targetName: string | null;
      };
      expect(saved.requestedBy).toBe('mod-1');
      expect(saved.status).toBe(CommunityBanRatificationStatus.Pending);
      // The name snapshot, so the queue can still say who this is about after
      // the member erases their account.
      expect(saved.targetName).toBe('Ana Silva');
      const windowMs = COMMUNITY_BAN_RATIFICATION_WINDOW_HOURS * 60 * 60 * 1000;
      expect(saved.expiresAt.getTime()).toBeGreaterThanOrEqual(
        before + windowMs - 5000,
      );
      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: 'c1',
          actorUserId: 'mod-1',
          action: GovernanceLogAction.MemberBanProposed,
          targetUserId: 'member-1',
        }),
      );
    });

    // The case the finding is most worried about. No owner carve-out: a
    // community whose only staff member is the person asking cannot bar
    // anybody permanently, and the 30-day bar already on file is the answer.
    it('opens no hold at all when the proposer is the only eligible signatory', async () => {
      members.count.mockResolvedValue(0);

      const hold = await service.proposePermanentBar({
        community: COMMUNITY,
        ban: banInForce(),
        proposerUserId: 'owner-1',
        reason: 'Harassment',
      });

      expect(hold).toBeNull();
      expect(ratifications.save).not.toHaveBeenCalled();
      expect(governanceLog.log).not.toHaveBeenCalled();
    });

    // A second removal of somebody already pending must join the hold on file
    // rather than fork a second race on the same person.
    it('returns the hold already on file rather than opening a second', async () => {
      const existing = pendingHold();
      ratifications.findOne.mockResolvedValue(existing);

      const hold = await service.proposePermanentBar({
        community: COMMUNITY,
        ban: banInForce(),
        proposerUserId: 'mod-1',
        reason: 'Harassment',
      });

      expect(hold).toBe(existing);
      expect(ratifications.save).not.toHaveBeenCalled();
    });
  });

  describe('decide', () => {
    it('makes the bar permanent when a second moderator ratifies', async () => {
      ratifications.findOne.mockResolvedValue(pendingHold());

      const decided = await service.decide('trans-joy', 'mod-2', 'hold-1', {
        decision: 'ratify',
      });

      // The `expires_at` the 30-day bar carried is removed: that is what
      // "permanent" is on this table.
      expect(manager.update).toHaveBeenCalledWith(
        CommunityBan,
        { id: 'ban-1' },
        { expiresAt: null },
      );
      expect(decided.status).toBe(CommunityBanRatificationStatus.Ratified);
      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: GovernanceLogAction.MemberBanRatified,
          actorUserId: 'mod-2',
          targetUserId: 'member-1',
        }),
      );
      // Written in the RATIFIER's name with no duration, so the member's
      // appeal resolves against the PERMANENT bar rather than the 30-day one
      // the removal recorded.
      expect(governanceLog.logModerationAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'mod-2',
          action: COMMUNITY_BAN_AUDIT_ACTION,
          targetUserId: 'member-1',
          duration: null,
        }),
      );
      expect(notifications.create).toHaveBeenCalled();
    });

    // The whole point of the control.
    it('refuses to let the proposer sign their own bar', async () => {
      ratifications.findOne.mockResolvedValue(
        pendingHold({ requestedBy: 'mod-2' }),
      );

      await expect(
        service.decide('trans-joy', 'mod-2', 'hold-1', { decision: 'ratify' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(manager.update).not.toHaveBeenCalled();
      expect(governanceLog.logModerationAudit).not.toHaveBeenCalled();
    });

    it('leaves the 30-day bar exactly as it is on a decline', async () => {
      ratifications.findOne.mockResolvedValue(pendingHold());

      const decided = await service.decide('trans-joy', 'mod-2', 'hold-1', {
        decision: 'decline',
        note: 'Thirty days is enough here.',
      });

      expect(decided.status).toBe(CommunityBanRatificationStatus.Declined);
      // Only the hold row was touched. The bar's own columns are untouched, so
      // the member serves exactly the terms they were told at removal.
      expect(manager.update).toHaveBeenCalledTimes(1);
      expect(manager.update).toHaveBeenCalledWith(
        CommunityBanRatification,
        expect.anything(),
        expect.objectContaining({ decidedBy: 'mod-2' }),
      );
      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: GovernanceLogAction.MemberBanDeclined,
        }),
      );
      // No "your bar changed" message, because it did not.
      expect(notifications.create).not.toHaveBeenCalled();
    });

    // A bar lifted underneath the hold must never be reinstated by a signature
    // nobody told about the lift.
    it('withdraws the hold and refuses when the bar has already been lifted', async () => {
      ratifications.findOne.mockResolvedValue(pendingHold());
      bans.findOne.mockResolvedValue(null);

      await expect(
        service.decide('trans-joy', 'mod-2', 'hold-1', { decision: 'ratify' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(ratifications.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'hold-1' }),
        expect.objectContaining({
          status: CommunityBanRatificationStatus.Withdrawn,
        }),
      );
    });
  });

  describe('expireDueHolds', () => {
    it('settles a hold nobody signed and never touches the bar', async () => {
      const lapsed = pendingHold({
        expiresAt: new Date(Date.now() - 60 * 1000),
      });
      ratifications.find.mockResolvedValue([lapsed]);

      const expired = await service.expireDueHolds('c1');

      expect(expired).toHaveLength(1);
      expect(ratifications.update).toHaveBeenCalledWith(
        { id: 'hold-1', status: CommunityBanRatificationStatus.Pending },
        expect.objectContaining({
          status: CommunityBanRatificationStatus.Expired,
        }),
      );
      // The 30-day term was written at the moment of the removal, so the
      // sanction this lapse settles on is already in force. Writing it again
      // here would be a second authority over the same column.
      expect(manager.update).not.toHaveBeenCalled();
      expect(governanceLog.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: GovernanceLogAction.MemberBanHoldExpired,
          actorUserId: 'mod-1',
          targetUserId: 'member-1',
        }),
      );
    });

    // The conditional `UPDATE ... WHERE status = 'pending'` is what makes this
    // safe to run from any read.
    it('never clobbers a hold signed between the select and the update', async () => {
      ratifications.find.mockResolvedValue([
        pendingHold({ expiresAt: new Date(Date.now() - 60 * 1000) }),
      ]);
      ratifications.update.mockResolvedValue({ affected: 0 });

      const expired = await service.expireDueHolds('c1');

      expect(expired).toHaveLength(0);
      expect(governanceLog.log).not.toHaveBeenCalled();
    });
  });
});
