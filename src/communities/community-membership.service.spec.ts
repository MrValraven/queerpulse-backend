import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsNull } from 'typeorm';
import { CommunityMembershipService } from './community-membership.service';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { CommunityPost } from './entities/community-post.entity';
import {
  AccessTier,
  Community,
  CommunityType,
} from './entities/community.entity';

describe('CommunityMembershipService', () => {
  let service: CommunityMembershipService;
  let communities: { findOne: jest.Mock };
  let members: { findOne: jest.Mock };
  let posts: { findOne: jest.Mock };
  let replies: { findOne: jest.Mock };

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
    requiresSecondVouch: false,
    autoFreezeOnReports: false,
    features: [],
    rules: [],
    tags: [],
    coverImageUrl: null,
    ownerId: 'owner-1',
    ref: 'QP-C-0001',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    archivedAt: null,
    frozenAt: null,
    isFeatured: false,
    needsOwnerReviewAt: null,
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
    posts = { findOne: jest.fn() };
    replies = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityMembershipService,
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(CommunityMember), useValue: members },
        { provide: getRepositoryToken(CommunityPost), useValue: posts },
        { provide: getRepositoryToken(CommunityPostReply), useValue: replies },
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

  describe('assertOwnerOrModBySlug', () => {
    it.each([RosterRole.Owner, RosterRole.Mod])(
      'returns the community id when the caller is %s',
      async (role) => {
        communities.findOne.mockResolvedValue(COMMUNITY);
        members.findOne.mockResolvedValue({ ...MEMBERSHIP, role });

        const communityId = await service.assertOwnerOrModBySlug(
          'queer-devs',
          'user-1',
        );

        expect(communityId).toBe('community-1');
      },
    );

    it('throws NotFoundException when the community is missing or archived', async () => {
      communities.findOne.mockResolvedValue(null);

      await expect(
        service.assertOwnerOrModBySlug('unknown-slug', 'user-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(members.findOne).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when the caller is not on the roster', async () => {
      communities.findOne.mockResolvedValue(COMMUNITY);
      members.findOne.mockResolvedValue(null);

      await expect(
        service.assertOwnerOrModBySlug('queer-devs', 'stranger-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws ForbiddenException when the caller is only a plain member', async () => {
      communities.findOne.mockResolvedValue(COMMUNITY);
      members.findOne.mockResolvedValue(MEMBERSHIP);

      await expect(
        service.assertOwnerOrModBySlug('queer-devs', 'user-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // Backs moderation's community-mod dismiss carve-out
  // (`ModerationService.assertCanActOnReport`): a boolean owner/mod check by
  // community id, no slug resolution, no throw.
  describe('isOwnerOrMod', () => {
    it.each([RosterRole.Owner, RosterRole.Mod])(
      'returns true when the caller is %s on the roster',
      async (role) => {
        members.findOne.mockResolvedValue({ ...MEMBERSHIP, role });

        await expect(
          service.isOwnerOrMod('community-1', 'user-1'),
        ).resolves.toBe(true);
      },
    );

    it('returns false for a plain member', async () => {
      members.findOne.mockResolvedValue(MEMBERSHIP);

      await expect(service.isOwnerOrMod('community-1', 'user-1')).resolves.toBe(
        false,
      );
    });

    it('returns false when the caller is not on the roster at all', async () => {
      members.findOne.mockResolvedValue(null);

      await expect(
        service.isOwnerOrMod('community-1', 'stranger-1'),
      ).resolves.toBe(false);
    });
  });

  describe('communityIdForPost', () => {
    it('resolves the owning community id for a real post', async () => {
      posts.findOne.mockResolvedValue({ communityId: 'community-1' });

      await expect(
        service.communityIdForPost('11111111-1111-1111-1111-111111111111'),
      ).resolves.toBe('community-1');
      expect(posts.findOne).toHaveBeenCalledWith({
        where: { id: '11111111-1111-1111-1111-111111111111' },
        select: { communityId: true },
      });
    });

    it('resolves null for a flat (non-community) post', async () => {
      posts.findOne.mockResolvedValue({ communityId: null });

      await expect(
        service.communityIdForPost('11111111-1111-1111-1111-111111111111'),
      ).resolves.toBeNull();
    });

    it('resolves null for a non-uuid id without querying the repository', async () => {
      await expect(
        service.communityIdForPost('not-a-uuid'),
      ).resolves.toBeNull();
      expect(posts.findOne).not.toHaveBeenCalled();
    });

    it('resolves null for an unknown post id', async () => {
      posts.findOne.mockResolvedValue(null);

      await expect(
        service.communityIdForPost('11111111-1111-1111-1111-111111111111'),
      ).resolves.toBeNull();
    });
  });

  describe('communityIdForReply', () => {
    it("resolves the owning community id via the reply's parent post", async () => {
      replies.findOne.mockResolvedValue({
        postId: '22222222-2222-2222-2222-222222222222',
      });
      posts.findOne.mockResolvedValue({ communityId: 'community-1' });

      await expect(
        service.communityIdForReply('33333333-3333-3333-3333-333333333333'),
      ).resolves.toBe('community-1');
      expect(replies.findOne).toHaveBeenCalledWith({
        where: { id: '33333333-3333-3333-3333-333333333333' },
        select: { postId: true },
      });
      expect(posts.findOne).toHaveBeenCalledWith({
        where: { id: '22222222-2222-2222-2222-222222222222' },
        select: { communityId: true },
      });
    });

    it('resolves null for a non-uuid id without querying the repository', async () => {
      await expect(
        service.communityIdForReply('not-a-uuid'),
      ).resolves.toBeNull();
      expect(replies.findOne).not.toHaveBeenCalled();
    });

    it('resolves null for an unknown reply id', async () => {
      replies.findOne.mockResolvedValue(null);

      await expect(
        service.communityIdForReply('33333333-3333-3333-3333-333333333333'),
      ).resolves.toBeNull();
      expect(posts.findOne).not.toHaveBeenCalled();
    });
  });
});
