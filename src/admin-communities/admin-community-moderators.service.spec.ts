import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { Profile } from '../users/entities/profile.entity';
import { CommunityGovernanceLogService } from '../communities/community-governance-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AdminCommunityModeratorsService } from './admin-community-moderators.service';

function makeCommunity(overrides: Partial<Community> = {}): Community {
  return {
    id: 'community-1',
    slug: 'circle-of-care',
    ownerId: 'user-owner',
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as Community;
}

function makeMember(overrides: Partial<CommunityMember> = {}): CommunityMember {
  return {
    id: 'member-1',
    communityId: 'community-1',
    userId: 'user-plain',
    role: RosterRole.Member,
    joinedAt: new Date('2024-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    userId: 'user-plain',
    slug: 'plain-pat',
    firstName: 'Pat',
    lastName: 'Plain',
    avatarUrl: null,
    ...overrides,
  } as unknown as Profile;
}

describe('AdminCommunityModeratorsService', () => {
  let service: AdminCommunityModeratorsService;
  let communities: { findOne: jest.Mock };
  let communityMembers: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
  };
  let profiles: { find: jest.Mock };
  let governanceLog: { log: jest.Mock };
  let notifications: { create: jest.Mock };

  beforeEach(async () => {
    communities = { findOne: jest.fn() };
    communityMembers = { find: jest.fn(), findOne: jest.fn(), save: jest.fn() };
    profiles = { find: jest.fn() };
    governanceLog = { log: jest.fn() };
    notifications = { create: jest.fn() };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        AdminCommunityModeratorsService,
        { provide: getRepositoryToken(Community), useValue: communities },
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: communityMembers,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        // BE-COM-19 — a staff promotion/demotion now writes a
        // `community_governance_log` row and notifies the member; both are
        // best-effort side effects, stubbed here so the role-transition
        // assertions below stay the subject of these specs.
        { provide: CommunityGovernanceLogService, useValue: governanceLog },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = moduleRef.get(AdminCommunityModeratorsService);
  });

  describe('addModerator', () => {
    it('404s when the community does not exist', async () => {
      communities.findOne.mockResolvedValue(null);
      await expect(
        service.addModerator('missing', 'user-plain', 'admin-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s when the target is not on the roster', async () => {
      communities.findOne.mockResolvedValue(makeCommunity());
      communityMembers.findOne.mockResolvedValue(null);
      await expect(
        service.addModerator('circle-of-care', 'user-nobody', 'admin-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects promoting the owner (founder is already a moderator)', async () => {
      communities.findOne.mockResolvedValue(makeCommunity());
      communityMembers.findOne.mockResolvedValue(
        makeMember({ userId: 'user-owner', role: RosterRole.Owner }),
      );
      await expect(
        service.addModerator('circle-of-care', 'user-owner', 'admin-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(communityMembers.save).not.toHaveBeenCalled();
    });

    it('promotes a plain member to moderator and returns the DTO', async () => {
      communities.findOne.mockResolvedValue(makeCommunity());
      const membership = makeMember();
      communityMembers.findOne.mockResolvedValue(membership);
      profiles.find.mockResolvedValue([makeProfile()]);

      const result = await service.addModerator(
        'circle-of-care',
        'user-plain',
        'admin-1',
      );

      expect(communityMembers.save).toHaveBeenCalledWith(
        expect.objectContaining({ role: RosterRole.Mod }),
      );
      expect(result).toEqual({
        userId: 'user-plain',
        slug: 'plain-pat',
        name: 'Pat Plain',
        initials: 'PP',
        // The roster renders faces, falling back to initials when a
        // moderator has no avatar.
        avatarUrl: null,
        role: 'mod',
        joinedAt: membership.joinedAt.toISOString(),
      });
    });

    it('is idempotent: re-adding an existing mod does not write', async () => {
      communities.findOne.mockResolvedValue(makeCommunity());
      communityMembers.findOne.mockResolvedValue(
        makeMember({ role: RosterRole.Mod }),
      );
      profiles.find.mockResolvedValue([makeProfile()]);

      const result = await service.addModerator(
        'circle-of-care',
        'user-plain',
        'admin-1',
      );

      expect(communityMembers.save).not.toHaveBeenCalled();
      expect(result.role).toBe('mod');
    });
  });

  describe('removeModerator', () => {
    it('404s when the target is not on the roster', async () => {
      communities.findOne.mockResolvedValue(makeCommunity());
      communityMembers.findOne.mockResolvedValue(null);
      await expect(
        service.removeModerator('circle-of-care', 'user-nobody', 'admin-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects removing the owner/founder (last-owner guard)', async () => {
      communities.findOne.mockResolvedValue(makeCommunity());
      communityMembers.findOne.mockResolvedValue(
        makeMember({ userId: 'user-owner', role: RosterRole.Owner }),
      );
      await expect(
        service.removeModerator('circle-of-care', 'user-owner', 'admin-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(communityMembers.save).not.toHaveBeenCalled();
    });

    it('rejects removing a plain member (nothing to demote)', async () => {
      communities.findOne.mockResolvedValue(makeCommunity());
      communityMembers.findOne.mockResolvedValue(makeMember());
      await expect(
        service.removeModerator('circle-of-care', 'user-plain', 'admin-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(communityMembers.save).not.toHaveBeenCalled();
    });

    it('demotes a moderator back to a plain member', async () => {
      communities.findOne.mockResolvedValue(makeCommunity());
      communityMembers.findOne.mockResolvedValue(
        makeMember({ role: RosterRole.Mod }),
      );

      await service.removeModerator('circle-of-care', 'user-plain', 'admin-1');

      expect(communityMembers.save).toHaveBeenCalledWith(
        expect.objectContaining({ role: RosterRole.Member }),
      );
    });
  });

  describe('listCandidates', () => {
    it('returns the promotable plain members', async () => {
      communities.findOne.mockResolvedValue(makeCommunity());
      communityMembers.find.mockResolvedValue([makeMember()]);
      profiles.find.mockResolvedValue([makeProfile()]);

      const result = await service.listCandidates('circle-of-care');

      expect(communityMembers.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { communityId: 'community-1', role: RosterRole.Member },
        }),
      );
      expect(result).toEqual([
        {
          userId: 'user-plain',
          slug: 'plain-pat',
          name: 'Pat Plain',
          initials: 'PP',
        },
      ]);
    });
  });
});
