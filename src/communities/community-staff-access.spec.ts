import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { IsNull } from 'typeorm';
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
import {
  resolveMemberCommunity,
  resolveMemberCommunityInterior,
  resolveStaffCommunity,
} from './community-staff-access';

describe('community-staff-access', () => {
  let communities: { findOne: jest.Mock };
  let members: { findOne: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };

  const LIVE_COMMUNITY: Community = {
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

  const ARCHIVED_COMMUNITY: Community = {
    ...LIVE_COMMUNITY,
    archivedAt: new Date('2026-02-01T00:00:00.000Z'),
  };

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

  beforeEach(() => {
    communities = { findOne: jest.fn() };
    members = { findOne: jest.fn() };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
  });

  describe('resolveMemberCommunity', () => {
    it('admits a roster member of an archived community', async () => {
      communities.findOne.mockResolvedValue(ARCHIVED_COMMUNITY);
      members.findOne.mockResolvedValue(MEMBERSHIP);

      const access = await resolveMemberCommunity(
        communities as never,
        members as never,
        'queer-devs',
        'user-1',
      );

      expect(access.community).toBe(ARCHIVED_COMMUNITY);
      expect(access.role).toBe(RosterRole.Member);
      expect(communities.findOne).toHaveBeenCalledWith({
        where: { slug: 'queer-devs' },
      });
    });

    it('refuses a non-member with 403', async () => {
      communities.findOne.mockResolvedValue(LIVE_COMMUNITY);
      members.findOne.mockResolvedValue(null);

      await expect(
        resolveMemberCommunity(
          communities as never,
          members as never,
          'queer-devs',
          'stranger-1',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s an unknown slug', async () => {
      communities.findOne.mockResolvedValue(null);

      await expect(
        resolveMemberCommunity(
          communities as never,
          members as never,
          'unknown-slug',
          'user-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ENG-426 follow-up: `CommunityResourcesService.listBySlug` (the Library
  // shelf) used to serve a plain member of a community a moderator had
  // hidden or removed, even though `getBySlug`, posts, replies and the
  // roster already 404 it. This resolver closes that gap.
  describe('resolveMemberCommunityInterior', () => {
    it('throws NotFoundException for a plain member of a taken-down community', async () => {
      communities.findOne.mockResolvedValue(LIVE_COMMUNITY);
      members.findOne.mockResolvedValue(MEMBERSHIP);
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      await expect(
        resolveMemberCommunityInterior(
          communities as never,
          members as never,
          contentModeration,
          'queer-devs',
          'user-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([RosterRole.Owner, RosterRole.CoOwner, RosterRole.Mod])(
      'still admits a taken-down community for its %s',
      async (role) => {
        communities.findOne.mockResolvedValue(LIVE_COMMUNITY);
        members.findOne.mockResolvedValue({ ...MEMBERSHIP, role });
        contentModeration.stateFor.mockResolvedValue({
          hidden: true,
          removed: false,
        });

        const access = await resolveMemberCommunityInterior(
          communities as never,
          members as never,
          contentModeration,
          'queer-devs',
          'user-1',
        );

        expect(access.role).toBe(role);
      },
    );

    it('still admits a roster member of a merely archived community', async () => {
      communities.findOne.mockResolvedValue(ARCHIVED_COMMUNITY);
      members.findOne.mockResolvedValue(MEMBERSHIP);

      const access = await resolveMemberCommunityInterior(
        communities as never,
        members as never,
        contentModeration,
        'queer-devs',
        'user-1',
      );

      expect(access.community).toBe(ARCHIVED_COMMUNITY);
      expect(access.role).toBe(RosterRole.Member);
    });

    it('still refuses a non-member with 403', async () => {
      communities.findOne.mockResolvedValue(LIVE_COMMUNITY);
      members.findOne.mockResolvedValue(null);

      await expect(
        resolveMemberCommunityInterior(
          communities as never,
          members as never,
          contentModeration,
          'queer-devs',
          'stranger-1',
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('resolveStaffCommunity', () => {
    it('still 404s an archived community', async () => {
      communities.findOne.mockResolvedValue(null);

      await expect(
        resolveStaffCommunity(
          communities as never,
          members as never,
          'queer-devs',
          'user-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(communities.findOne).toHaveBeenCalledWith({
        where: { slug: 'queer-devs', archivedAt: IsNull() },
      });
      expect(members.findOne).not.toHaveBeenCalled();
    });
  });
});
