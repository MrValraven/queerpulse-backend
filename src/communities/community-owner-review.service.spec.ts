import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CommunityOwnerReviewService } from './community-owner-review.service';
import {
  CommunityMember,
  CommunityNotificationLevel,
  RosterRole,
} from './entities/community-member.entity';
import {
  CommunityOwnerReviewRequest,
  CommunityOwnerReviewRequestStatus,
} from './entities/community-owner-review-request.entity';
import {
  AccessTier,
  Community,
  CommunityType,
} from './entities/community.entity';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';

describe('CommunityOwnerReviewService', () => {
  let service: CommunityOwnerReviewService;
  let communities: { findOne: jest.Mock };
  let members: { findOne: jest.Mock; find: jest.Mock };
  let reviewRequests: { findOne: jest.Mock };
  let profiles: { find: jest.Mock };
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
    archivedAt: new Date('2026-03-01T00:00:00.000Z'),
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

  // The row `MemberLookup.byUserIds` reads to render the requester's
  // `MemberRef` on `CommunityOwnerReviewStateDTO.request.requestedBy`.
  const REQUESTER_PROFILE_ROW = {
    userId: 'user-1',
    slug: 'reyes-r',
    firstName: 'Reyes',
    lastName: 'Rivera',
    pronouns: null,
    avatarUrl: null,
    photoVisible: false,
  };

  beforeEach(async () => {
    communities = { findOne: jest.fn() };
    members = { findOne: jest.fn(), find: jest.fn() };
    reviewRequests = { findOne: jest.fn() };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CommunityOwnerReviewService,
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(CommunityMember), useValue: members },
        {
          provide: getRepositoryToken(CommunityOwnerReviewRequest),
          useValue: reviewRequests,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(User), useValue: {} },
        {
          provide: NotificationsService,
          useValue: { createForRecipients: jest.fn() },
        },
        { provide: ContentModerationService, useValue: contentModeration },
      ],
    }).compile();

    service = module.get(CommunityOwnerReviewService);
  });

  describe('getState', () => {
    it('reports canOpen and canWithdraw both false for a member of an archived community', async () => {
      communities.findOne.mockResolvedValue(ARCHIVED_COMMUNITY);
      members.findOne.mockResolvedValue(MEMBERSHIP);
      reviewRequests.findOne.mockResolvedValue(null);

      const state = await service.getState('queer-devs', 'user-1');

      expect(state.canOpen).toBe(false);
      expect(state.canWithdraw).toBe(false);
    });

    it('still reports canOpen true for a plain member of a live community with no open request', async () => {
      communities.findOne.mockResolvedValue(LIVE_COMMUNITY);
      members.findOne.mockResolvedValue(MEMBERSHIP);
      reviewRequests.findOne.mockResolvedValue(null);

      const state = await service.getState('queer-devs', 'user-1');

      expect(state.canOpen).toBe(true);
      expect(state.canWithdraw).toBe(false);
    });

    it('reports canWithdraw false for the requester of an archived community even with an open request', async () => {
      communities.findOne.mockResolvedValue(ARCHIVED_COMMUNITY);
      members.findOne.mockResolvedValue(MEMBERSHIP);
      const openRequest: CommunityOwnerReviewRequest = {
        id: 'request-1',
        communityId: 'community-1',
        requestedByUserId: 'user-1',
        reason: null,
        status: CommunityOwnerReviewRequestStatus.Open,
        createdAt: new Date('2026-02-15T00:00:00.000Z'),
        resolvedAt: null,
      };
      reviewRequests.findOne.mockResolvedValue(openRequest);
      profiles.find.mockResolvedValue([REQUESTER_PROFILE_ROW]);

      const state = await service.getState('queer-devs', 'user-1');

      expect(state.canOpen).toBe(false);
      expect(state.canWithdraw).toBe(false);
      // Proves the `MemberLookup(this.profiles).byUserIds` path this test
      // exercises (a request with a `requestedByUserId`) actually resolved:
      // the archived gate alone should not be doing all the work of making
      // `canWithdraw` false here.
      expect(state.request?.requestedBy?.slug).toBe('reyes-r');
    });

    // ENG-426 follow-up: `getState` used to serve a plain member of a
    // community a moderator had hidden or removed, even though `getBySlug`,
    // posts, replies and the roster already 404 it. This pins the same
    // closure here.
    it('throws NotFoundException for a plain member of a taken-down community', async () => {
      communities.findOne.mockResolvedValue(LIVE_COMMUNITY);
      members.findOne.mockResolvedValue(MEMBERSHIP);
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      await expect(
        service.getState('queer-devs', 'user-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([RosterRole.Owner, RosterRole.CoOwner, RosterRole.Mod])(
      'still reads a taken-down community for its %s',
      async (role) => {
        communities.findOne.mockResolvedValue(LIVE_COMMUNITY);
        members.findOne.mockResolvedValue({ ...MEMBERSHIP, role });
        reviewRequests.findOne.mockResolvedValue(null);
        contentModeration.stateFor.mockResolvedValue({
          hidden: true,
          removed: false,
        });

        const state = await service.getState('queer-devs', 'user-1');

        expect(state).toBeDefined();
      },
    );
  });
});
