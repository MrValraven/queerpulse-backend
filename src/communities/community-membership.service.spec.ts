import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator, In, IsNull } from 'typeorm';
import { CommunityMembershipService } from './community-membership.service';
import {
  CommunityMember,
  CommunityNotificationLevel,
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
  let communities: { findOne: jest.Mock; find: jest.Mock };
  let members: { findOne: jest.Mock; find: jest.Mock };
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
    frozenReason: null,
    frozenNote: null,
    frozenByUserId: null,
    parentId: null,
    allowsSubcommunities: false,
    archivedWithParent: false,
    rulesVersion: 1,
    welcomeMessage: null,
    nowReading: null,
    avatarImageUrl: null,
    city: null,
    area: null,
    isOnline: false,
    languages: [],
    activeThisWeek: 0,
    activityCountedAt: null,
    isPubliclyListed: false,
  };

  /**
   * The same community at the `private` tier, whose existence is the secret
   * the tier keeps. Only this tier answers 404 to a caller with no roster row;
   * `request` and `invite` are listed in discover with their tier on their
   * card, so a 403 from those is the correct, more useful answer and is pinned
   * below.
   */
  const PRIVATE_COMMUNITY: Community = {
    ...COMMUNITY,
    accessTier: AccessTier.Private,
  };

  /** The tiers whose existence is public knowledge, so they keep the 403. */
  const NON_PRIVATE_TIER_CASES: ReadonlyArray<[string, AccessTier]> = [
    ['public', AccessTier.Public],
    ['request', AccessTier.Request],
    ['invite', AccessTier.Invite],
  ];

  const MEMBERSHIP: CommunityMember = {
    id: 'membership-1',
    communityId: 'community-1',
    userId: 'user-1',
    role: RosterRole.Member,
    joinedAt: new Date('2026-01-02T00:00:00.000Z'),
    notificationLevel: CommunityNotificationLevel.Announcements,
    rulesAcceptedAt: null,
    rulesVersionAccepted: null,
    welcomeSeenAt: null,
  };

  /**
   * Matches one `where` value against a row field: a plain value compares
   * equal, an `In(...)` operator checks membership.
   */
  function matchesWhereValue(expected: unknown, actual: unknown): boolean {
    if (expected === undefined) return true;
    if (expected instanceof FindOperator) {
      return (expected.value as unknown[]).includes(actual);
    }
    return expected === actual;
  }

  /**
   * Seeds the roster the service reads. Every roster read goes through
   * `members.find` now (the effective-role lookup batches own and parent
   * rows), so the mock filters the seeded rows by the `where` it is given.
   */
  function givenRoster(rows: CommunityMember[]): void {
    members.find.mockImplementation(
      ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          rows.filter(
            (row) =>
              matchesWhereValue(where.communityId, row.communityId) &&
              matchesWhereValue(where.userId, row.userId) &&
              matchesWhereValue(where.role, row.role),
          ),
        ),
    );
  }

  /** Seeds the communities `communities.find` resolves by id or parent id. */
  function givenCommunities(rows: Community[]): void {
    communities.find.mockImplementation(
      ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          rows.filter(
            (row) =>
              matchesWhereValue(where.id, row.id) &&
              matchesWhereValue(where.parentId, row.parentId),
          ),
        ),
    );
    communities.findOne.mockImplementation(
      ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          rows.find(
            (row) =>
              matchesWhereValue(where.id, row.id) &&
              matchesWhereValue(where.slug, row.slug),
          ) ?? null,
        ),
    );
  }

  beforeEach(async () => {
    communities = { findOne: jest.fn(), find: jest.fn() };
    members = { findOne: jest.fn(), find: jest.fn() };
    givenRoster([]);
    givenCommunities([]);
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
      givenRoster([MEMBERSHIP]);

      const communityId = await service.assertMemberBySlug(
        'queer-devs',
        'user-1',
      );

      expect(communityId).toBe('community-1');
      expect(communities.findOne).toHaveBeenCalledWith({
        where: { slug: 'queer-devs', archivedAt: IsNull() },
      });
      expect(members.find).toHaveBeenCalledWith({
        where: { communityId: In(['community-1']), userId: 'user-1' },
        select: { communityId: true, role: true },
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
      expect(members.find).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when the caller is not on the roster', async () => {
      communities.findOne.mockResolvedValue(COMMUNITY);
      givenRoster([]);

      await expect(
        service.assertMemberBySlug('queer-devs', 'stranger-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    // The existence oracle this helper used to be: a real `private` slug
    // answered 403 where an unknown slug answered 404, so one request per
    // guessed slug confirmed whether the community was there. Roughly a dozen
    // call sites across events, forum, volunteering, membership cards and
    // community pulse come through here, so the fix belongs at this door.
    it('throws NotFoundException for a private-tier caller with no roster row', async () => {
      communities.findOne.mockResolvedValue(PRIVATE_COMMUNITY);
      givenRoster([]);

      await expect(
        service.assertMemberBySlug('queer-devs', 'stranger-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each(NON_PRIVATE_TIER_CASES)(
      'still throws ForbiddenException on a %s-tier community',
      async (_tierName: string, accessTier: AccessTier) => {
        communities.findOne.mockResolvedValue({ ...COMMUNITY, accessTier });
        givenRoster([]);

        await expect(
          service.assertMemberBySlug('queer-devs', 'stranger-1'),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
    );

    it('still resolves normally for a private-tier roster member', async () => {
      // A member's behaviour must not change on any tier.
      communities.findOne.mockResolvedValue(PRIVATE_COMMUNITY);
      givenRoster([MEMBERSHIP]);

      await expect(
        service.assertMemberBySlug('queer-devs', 'user-1'),
      ).resolves.toBe('community-1');
    });
  });

  describe('assertOwnerOrModBySlug', () => {
    it.each([RosterRole.Owner, RosterRole.Mod])(
      'returns the community id when the caller is %s',
      async (role) => {
        communities.findOne.mockResolvedValue(COMMUNITY);
        givenRoster([{ ...MEMBERSHIP, role }]);

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
      expect(members.find).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when the caller is not on the roster', async () => {
      communities.findOne.mockResolvedValue(COMMUNITY);
      givenRoster([]);

      await expect(
        service.assertOwnerOrModBySlug('queer-devs', 'stranger-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws ForbiddenException when the caller is only a plain member', async () => {
      communities.findOne.mockResolvedValue(COMMUNITY);
      givenRoster([MEMBERSHIP]);

      await expect(
        service.assertOwnerOrModBySlug('queer-devs', 'user-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws NotFoundException for a private-tier caller with no roster row', async () => {
      communities.findOne.mockResolvedValue(PRIVATE_COMMUNITY);
      givenRoster([]);

      await expect(
        service.assertOwnerOrModBySlug('queer-devs', 'stranger-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // THE case that proves the existence guard tests `!membership` and not the
    // role: a plain `Member` of a private community already knows it exists,
    // so turning their 403 into a 404 would hide nothing and only confuse
    // them.
    it('still throws ForbiddenException for a private-tier PLAIN MEMBER', async () => {
      communities.findOne.mockResolvedValue(PRIVATE_COMMUNITY);
      givenRoster([MEMBERSHIP]);

      await expect(
        service.assertOwnerOrModBySlug('queer-devs', 'user-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each(NON_PRIVATE_TIER_CASES)(
      'still throws ForbiddenException for a non-member on a %s-tier community',
      async (_tierName: string, accessTier: AccessTier) => {
        communities.findOne.mockResolvedValue({ ...COMMUNITY, accessTier });
        givenRoster([]);

        await expect(
          service.assertOwnerOrModBySlug('queer-devs', 'stranger-1'),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
    );

    it.each([RosterRole.Owner, RosterRole.Mod])(
      'still returns the community id for a private-tier %s',
      async (role) => {
        communities.findOne.mockResolvedValue(PRIVATE_COMMUNITY);
        givenRoster([{ ...MEMBERSHIP, role }]);

        await expect(
          service.assertOwnerOrModBySlug('queer-devs', 'user-1'),
        ).resolves.toBe('community-1');
      },
    );
  });

  // Backs moderation's community-mod dismiss carve-out
  // (`ModerationService.assertCanActOnReport`): a boolean owner/mod check by
  // community id, no slug resolution, no throw.
  describe('isOwnerOrMod', () => {
    beforeEach(() => {
      givenCommunities([COMMUNITY]);
    });

    it.each([RosterRole.Owner, RosterRole.Mod])(
      'returns true when the caller is %s on the roster',
      async (role) => {
        givenRoster([{ ...MEMBERSHIP, role }]);

        await expect(
          service.isOwnerOrMod('community-1', 'user-1'),
        ).resolves.toBe(true);
      },
    );

    it('returns false for a plain member', async () => {
      givenRoster([MEMBERSHIP]);

      await expect(service.isOwnerOrMod('community-1', 'user-1')).resolves.toBe(
        false,
      );
    });

    it('returns false when the caller is not on the roster at all', async () => {
      givenRoster([]);

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

  describe('spaces', () => {
    const SPACE: Community = {
      ...COMMUNITY,
      id: 'space-1',
      slug: 'space',
      parentId: COMMUNITY.id,
    };

    const PARENT_MOD_ROW: CommunityMember = {
      ...MEMBERSHIP,
      id: 'membership-parent-mod',
      communityId: COMMUNITY.id,
      role: RosterRole.Mod,
    };

    const SPACE_MEMBER_ROW: CommunityMember = {
      ...MEMBERSHIP,
      id: 'membership-space-member',
      communityId: SPACE.id,
      role: RosterRole.Member,
    };

    const SPACE_MOD_ROW: CommunityMember = {
      ...MEMBERSHIP,
      id: 'membership-space-mod',
      communityId: SPACE.id,
      role: RosterRole.Mod,
    };

    const PARENT_MEMBER_ROW: CommunityMember = {
      ...MEMBERSHIP,
      id: 'membership-parent-member',
      communityId: COMMUNITY.id,
      role: RosterRole.Member,
    };

    beforeEach(() => {
      givenCommunities([COMMUNITY, SPACE]);
    });

    it('treats a parent mod with no space row as owner-or-mod of the space', async () => {
      givenRoster([PARENT_MOD_ROW]);

      await expect(service.isOwnerOrMod(SPACE.id, 'user-1')).resolves.toBe(
        true,
      );
    });

    it('treats a parent mod with no space row as a member of the space', async () => {
      givenRoster([PARENT_MOD_ROW]);

      await expect(service.isMember(SPACE.id, 'user-1')).resolves.toBe(true);
    });

    it('refuses a space member whose parent row is gone', async () => {
      givenRoster([SPACE_MEMBER_ROW]);

      await expect(service.isMember(SPACE.id, 'user-1')).resolves.toBe(false);
    });

    it('answers 403 on assertMemberBySlug for a space member whose parent row is gone', async () => {
      givenRoster([SPACE_MEMBER_ROW]);

      await expect(
        service.assertMemberBySlug('space', 'user-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('resolves assertMemberBySlug for a space member who is also a parent member', async () => {
      givenRoster([SPACE_MEMBER_ROW, PARENT_MEMBER_ROW]);

      await expect(service.assertMemberBySlug('space', 'user-1')).resolves.toBe(
        SPACE.id,
      );
    });

    it('does not let a space mod act as owner-or-mod of the parent', async () => {
      givenRoster([SPACE_MOD_ROW, PARENT_MEMBER_ROW]);

      await expect(service.isOwnerOrMod(COMMUNITY.id, 'user-1')).resolves.toBe(
        false,
      );
    });

    it('includes the space id in ownerOrModCommunityIdsForUser for a parent mod', async () => {
      givenRoster([PARENT_MOD_ROW]);

      const staffIds = await service.ownerOrModCommunityIdsForUser('user-1');

      expect(staffIds).toEqual(
        expect.arrayContaining([COMMUNITY.id, SPACE.id]),
      );
    });

    it('drops a space id from communityIdsForUser when the parent row is gone', async () => {
      givenRoster([SPACE_MEMBER_ROW]);

      await expect(service.communityIdsForUser('user-1')).resolves.toEqual([]);
    });

    it('keeps a space id in communityIdsForUser alongside its parent row', async () => {
      givenRoster([SPACE_MEMBER_ROW, PARENT_MEMBER_ROW]);

      const communityIds = await service.communityIdsForUser('user-1');

      expect(communityIds).toEqual(
        expect.arrayContaining([COMMUNITY.id, SPACE.id]),
      );
    });

    it('batches effectiveRolesFor into one roster query', async () => {
      givenRoster([PARENT_MOD_ROW, SPACE_MEMBER_ROW]);

      const roles = await service.effectiveRolesFor(
        [COMMUNITY, SPACE],
        'user-1',
      );

      expect(members.find).toHaveBeenCalledTimes(1);
      expect(roles.get(COMMUNITY.id)).toBe(RosterRole.Mod);
      expect(roles.get(SPACE.id)).toBe(RosterRole.Mod);
    });
  });
});
