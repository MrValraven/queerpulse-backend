import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsNull } from 'typeorm';
import { CommunityPreferencesService } from './community-preferences.service';
import {
  CommunityMember,
  CommunityNotificationLevel,
  RosterRole,
} from './entities/community-member.entity';
import {
  AccessTier,
  Community,
  CommunityType,
} from './entities/community.entity';

/**
 * Covers the existence-oracle guard inside `loadOwnMembership` only. This
 * endpoint asks for no standing beyond a signed-in account, which made a 403
 * from it the cheapest probe on the platform: one request per guessed slug,
 * with a real `private` slug answering differently from an unknown one. The
 * response-shaping paths (`toResponse`, the rules-version dance) are not this
 * file's subject.
 */
describe('CommunityPreferencesService community existence gate', () => {
  let service: CommunityPreferencesService;
  let communities: { findOne: jest.Mock };
  let members: { findOne: jest.Mock; update: jest.Mock };

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
    avatarImageUrl: null,
    city: null,
    area: null,
    isOnline: false,
    languages: [],
    activeThisWeek: 0,
    activityCountedAt: null,
    isPubliclyListed: false,
  };

  const PRIVATE_COMMUNITY: Community = {
    ...COMMUNITY,
    accessTier: AccessTier.Private,
  };

  /**
   * The tiers whose existence is public knowledge: a `request`- or
   * `invite`-tier community is listed in discover with its tier on its card,
   * so a 403 from those is correct and must not become a 404.
   */
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

  beforeEach(async () => {
    communities = { findOne: jest.fn() };
    members = { findOne: jest.fn(), update: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityPreferencesService,
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(CommunityMember), useValue: members },
      ],
    }).compile();

    service = module.get(CommunityPreferencesService);
  });

  it('throws NotFoundException when the community is missing or archived', async () => {
    communities.findOne.mockResolvedValue(null);

    await expect(
      service.getPreferences('unknown-slug', 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(communities.findOne).toHaveBeenCalledWith({
      where: { slug: 'unknown-slug', archivedAt: IsNull() },
    });
    expect(members.findOne).not.toHaveBeenCalled();
  });

  it('throws NotFoundException for a private-tier caller with no roster row', async () => {
    communities.findOne.mockResolvedValue(PRIVATE_COMMUNITY);
    members.findOne.mockResolvedValue(null);

    await expect(
      service.getPreferences('queer-devs', 'stranger-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(NON_PRIVATE_TIER_CASES)(
    'still throws ForbiddenException for a non-member on a %s-tier community',
    async (_tierName: string, accessTier: AccessTier) => {
      communities.findOne.mockResolvedValue({ ...COMMUNITY, accessTier });
      members.findOne.mockResolvedValue(null);

      await expect(
        service.getPreferences('queer-devs', 'stranger-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('still answers a private-tier roster member normally', async () => {
    // A member's behaviour must not change on any tier.
    communities.findOne.mockResolvedValue(PRIVATE_COMMUNITY);
    members.findOne.mockResolvedValue(MEMBERSHIP);

    const preferences = await service.getPreferences('queer-devs', 'user-1');

    expect(preferences.communitySlug).toBe('queer-devs');
    expect(preferences.notificationLevel).toBe(
      CommunityNotificationLevel.Announcements,
    );
  });
});
