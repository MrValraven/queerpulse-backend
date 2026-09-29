import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  CommunityMember,
  CommunityNotificationLevel,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { Profile } from '../users/entities/profile.entity';
import { CommunityGovernanceLogService } from '../communities/community-governance-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  AdminCommunityModeratorsService,
  MODERATOR_CANDIDATE_LIMIT,
} from './admin-community-moderators.service';

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
    notificationLevel: CommunityNotificationLevel.Announcements,
    rulesAcceptedAt: null,
    rulesVersionAccepted: null,
    welcomeSeenAt: null,
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
    createQueryBuilder: jest.Mock;
  };
  let profiles: { find: jest.Mock };
  let governanceLog: { log: jest.Mock };
  let notifications: { create: jest.Mock };

  beforeEach(async () => {
    communities = { findOne: jest.fn() };
    communityMembers = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
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
    /** A chainable stand-in for the candidates query builder, recording every
     *  clause so the specs can assert the cap, the order and the search. */
    function mockCandidateQuery(rows: CommunityMember[]) {
      const candidateQuery = {
        innerJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        addOrderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(rows),
      };
      communityMembers.createQueryBuilder.mockReturnValue(candidateQuery);
      return candidateQuery;
    }

    it('returns the promotable plain members', async () => {
      communities.findOne.mockResolvedValue(makeCommunity());
      const candidateQuery = mockCandidateQuery([makeMember()]);
      profiles.find.mockResolvedValue([makeProfile()]);

      const result = await service.listCandidates('circle-of-care');

      expect(candidateQuery.where).toHaveBeenCalledWith(
        expect.stringContaining('community_id'),
        { communityId: 'community-1' },
      );
      expect(candidateQuery.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('role'),
        { memberRole: RosterRole.Member },
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

    it('caps the answer in SQL and orders it by name', async () => {
      communities.findOne.mockResolvedValue(makeCommunity());
      const candidateQuery = mockCandidateQuery([]);

      await service.listCandidates('circle-of-care');

      expect(candidateQuery.limit).toHaveBeenCalledWith(
        MODERATOR_CANDIDATE_LIMIT,
      );
      expect(MODERATOR_CANDIDATE_LIMIT).toBe(25);
      expect(candidateQuery.orderBy).toHaveBeenCalledWith(
        '"profile"."first_name"',
        'ASC',
      );
    });

    it('looks up profiles only for the capped page', async () => {
      communities.findOne.mockResolvedValue(makeCommunity());
      const cappedPage = Array.from(
        { length: MODERATOR_CANDIDATE_LIMIT },
        (_unused, index) => makeMember({ userId: `user-${index}` }),
      );
      mockCandidateQuery(cappedPage);
      profiles.find.mockResolvedValue([]);

      await service.listCandidates('circle-of-care');

      expect(profiles.find).toHaveBeenCalledTimes(1);
      const [lookupOptions] = profiles.find.mock.calls[0] as [
        { where: { userId: { value: string[] } } },
      ];
      const lookupWhere = lookupOptions.where;
      expect(lookupWhere.userId.value).toHaveLength(MODERATOR_CANDIDATE_LIMIT);
    });

    it('skips the search clause when q is absent or blank', async () => {
      communities.findOne.mockResolvedValue(makeCommunity());
      const candidateQuery = mockCandidateQuery([]);

      await service.listCandidates('circle-of-care', '   ');

      // Only the role clause: no LIKE was added for a blank search.
      expect(candidateQuery.andWhere).toHaveBeenCalledTimes(1);
    });

    it('matches q through the accent-folded haystack, escaped and trimmed', async () => {
      communities.findOne.mockResolvedValue(makeCommunity());
      const candidateQuery = mockCandidateQuery([]);

      await service.listCandidates('circle-of-care', '  Jo%ao ');

      const searchCall = candidateQuery.andWhere.mock.calls.find(
        ([clause]: [string]) => clause.includes('LIKE'),
      ) as [string, { searchTerm: string }];
      expect(searchCall).toBeDefined();
      // `translate(lower(...))` is the shared folding, on both sides of LIKE.
      expect(searchCall[0]).toContain('translate(lower(');
      expect(searchCall[0]).toContain('"profile"."first_name"');
      expect(searchCall[0]).toContain('"profile"."slug"');
      expect(searchCall[0]).toContain(':searchTerm');
      expect(searchCall[1]).toEqual({ searchTerm: '%Jo\\%ao%' });
    });

    it('returns an empty list without a profile lookup when nobody matches', async () => {
      communities.findOne.mockResolvedValue(makeCommunity());
      mockCandidateQuery([]);

      const result = await service.listCandidates('circle-of-care', 'zzz');

      expect(result).toEqual([]);
      expect(profiles.find).not.toHaveBeenCalled();
    });
  });
});
