import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsNull } from 'typeorm';
import { CommunityMembershipService } from './community-membership.service';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import {
  AccessTier,
  Community,
  CommunityType,
} from './entities/community.entity';

describe('CommunityMembershipService', () => {
  let service: CommunityMembershipService;
  let communities: { findOne: jest.Mock };
  let members: { findOne: jest.Mock };

  const COMMUNITY: Community = {
    id: 'community-1',
    slug: 'queer-devs',
    name: 'Queer Devs',
    purpose: 'purpose',
    type: CommunityType.Professional,
    whoFor: 'who-for',
    tagline: 'tagline',
    accessTier: AccessTier.Public,
    rosterVisible: true,
    features: [],
    rules: [],
    ownerId: 'owner-1',
    ref: 'QP-C-0001',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    archivedAt: null,
  };

  const MEMBERSHIP: CommunityMember = {
    id: 'membership-1',
    communityId: 'community-1',
    userId: 'user-1',
    role: RosterRole.Member,
    joinedAt: new Date('2026-01-02T00:00:00.000Z'),
  };

  beforeEach(async () => {
    communities = { findOne: jest.fn() };
    members = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityMembershipService,
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(CommunityMember), useValue: members },
      ],
    }).compile();

    service = module.get(CommunityMembershipService);
  });

  describe('assertMemberBySlug', () => {
    it('returns the community id when the caller is a roster member', async () => {
      communities.findOne.mockResolvedValue(COMMUNITY);
      members.findOne.mockResolvedValue(MEMBERSHIP);

      const communityId = await service.assertMemberBySlug(
        'queer-devs',
        'user-1',
      );

      expect(communityId).toBe('community-1');
      expect(communities.findOne).toHaveBeenCalledWith({
        where: { slug: 'queer-devs', archivedAt: IsNull() },
      });
      expect(members.findOne).toHaveBeenCalledWith({
        where: { communityId: 'community-1', userId: 'user-1' },
      });
    });

    // Covers both a slug that resolves to no row at all, and one whose row
    // is filtered out by the `archivedAt: IsNull()` clause — from this
    // service's point of view they're the same "not found" outcome, and
    // `communities.findOne` is mocked at that same boundary either way.
    it('throws NotFoundException when the community is missing or archived', async () => {
      communities.findOne.mockResolvedValue(null);

      await expect(
        service.assertMemberBySlug('unknown-slug', 'user-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(members.findOne).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when the caller is not on the roster', async () => {
      communities.findOne.mockResolvedValue(COMMUNITY);
      members.findOne.mockResolvedValue(null);

      await expect(
        service.assertMemberBySlug('queer-devs', 'stranger-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
