import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { Profile } from '../users/entities/profile.entity';
import { CommunityMembershipService } from './community-membership.service';
import { Community } from './entities/community.entity';
import { RosterRole } from './entities/community-member.entity';
import {
  CommunitySpaceRequest,
  CommunitySpaceRequestStatus,
} from './entities/community-space-request.entity';
import { SpaceRequestsService } from './space-requests.service';
import {
  SPACES_ALREADY_ALLOWED_CODE,
  SPACE_REQUEST_ALREADY_OPEN_CODE,
  SUBCOMMUNITIES_NOT_ALLOWED_CODE,
} from './subcommunity-rules';

const ACTOR_ID = 'actor-1';
const COMMUNITY = {
  id: 'community-1',
  slug: 'coletivo-gula',
  name: 'Coletivo Gula',
  parentId: null,
  allowsSubcommunities: false,
  frozenAt: null,
} as unknown as Community;

function makeRequest(
  overrides: Partial<CommunitySpaceRequest> = {},
): CommunitySpaceRequest {
  return {
    id: 'space-request-1',
    communityId: COMMUNITY.id,
    requestedByUserId: ACTOR_ID,
    note: null,
    status: CommunitySpaceRequestStatus.Open,
    createdAt: new Date('2026-09-23T10:00:00Z'),
    decidedAt: null,
    decidedByUserId: null,
    declineReason: null,
    ...overrides,
  };
}

describe('SpaceRequestsService', () => {
  let service: SpaceRequestsService;
  let communities: { findOne: jest.Mock };
  let requests: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
  let membership: {
    assertOwnerOrModBySlug: jest.Mock;
    effectiveRole: jest.Mock;
  };
  let contentModeration: { stateFor: jest.Mock };
  let adminQueueNotifications: { announce: jest.Mock };

  beforeEach(async () => {
    communities = { findOne: jest.fn().mockResolvedValue({ ...COMMUNITY }) };
    requests = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((value: Partial<CommunitySpaceRequest>) => value),
      save: jest.fn((value: Partial<CommunitySpaceRequest>) =>
        Promise.resolve(makeRequest(value)),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    membership = {
      assertOwnerOrModBySlug: jest.fn().mockResolvedValue(COMMUNITY.id),
      effectiveRole: jest.fn().mockResolvedValue(RosterRole.Owner),
    };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SpaceRequestsService,
        { provide: getRepositoryToken(Community), useValue: communities },
        {
          provide: getRepositoryToken(CommunitySpaceRequest),
          useValue: requests,
        },
        {
          provide: getRepositoryToken(Profile),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: CommunityMembershipService, useValue: membership },
        { provide: ContentModerationService, useValue: contentModeration },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
      ],
    }).compile();
    service = module.get(SpaceRequestsService);
  });

  describe('create', () => {
    it('saves an open request with the trimmed note and announces it to the queue', async () => {
      const result = await service.create(COMMUNITY.slug, ACTOR_ID, {
        note: '  parents corner  ',
      });
      expect(requests.save).toHaveBeenCalledWith(
        expect.objectContaining({
          communityId: COMMUNITY.id,
          requestedByUserId: ACTOR_ID,
          note: 'parents corner',
          status: CommunitySpaceRequestStatus.Open,
        }),
      );
      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.CommunitySpaceRequests,
        'space-request-1',
      );
      expect(result.status).toBe(CommunitySpaceRequestStatus.Open);
    });

    it('lets a co-owner file', async () => {
      membership.effectiveRole.mockResolvedValue(RosterRole.CoOwner);
      await expect(
        service.create(COMMUNITY.slug, ACTOR_ID, {}),
      ).resolves.toBeDefined();
    });

    it('refuses a mod with 403', async () => {
      membership.effectiveRole.mockResolvedValue(RosterRole.Mod);
      await expect(
        service.create(COMMUNITY.slug, ACTOR_ID, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(requests.save).not.toHaveBeenCalled();
    });

    it('refuses a space with SUBCOMMUNITIES_NOT_ALLOWED', async () => {
      communities.findOne.mockResolvedValue({
        ...COMMUNITY,
        parentId: 'parent-1',
      });
      await expect(
        service.create(COMMUNITY.slug, ACTOR_ID, {}),
      ).rejects.toMatchObject({
        response: { code: SUBCOMMUNITIES_NOT_ALLOWED_CODE },
      });
    });

    it('refuses when spaces are already on', async () => {
      communities.findOne.mockResolvedValue({
        ...COMMUNITY,
        allowsSubcommunities: true,
      });
      await expect(
        service.create(COMMUNITY.slug, ACTOR_ID, {}),
      ).rejects.toMatchObject({
        response: { code: SPACES_ALREADY_ALLOWED_CODE },
      });
    });

    it('refuses a second open request', async () => {
      requests.findOne.mockResolvedValue(makeRequest());
      await expect(
        service.create(COMMUNITY.slug, ACTOR_ID, {}),
      ).rejects.toMatchObject({
        response: { code: SPACE_REQUEST_ALREADY_OPEN_CODE },
      });
      expect(requests.save).not.toHaveBeenCalled();
    });

    it('maps a unique-index race to SPACE_REQUEST_ALREADY_OPEN', async () => {
      requests.save.mockRejectedValue(
        Object.assign(new Error('duplicate'), { code: '23505' }),
      );
      await expect(
        service.create(COMMUNITY.slug, ACTOR_ID, {}),
      ).rejects.toMatchObject({
        response: { code: SPACE_REQUEST_ALREADY_OPEN_CODE },
      });
    });

    it('refuses a frozen community with 403', async () => {
      communities.findOne.mockResolvedValue({
        ...COMMUNITY,
        frozenAt: new Date(),
      });
      await expect(
        service.create(COMMUNITY.slug, ACTOR_ID, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a community under takedown with 403', async () => {
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });
      await expect(
        service.create(COMMUNITY.slug, ACTOR_ID, {}),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('withdraw', () => {
    it('marks the open request withdrawn and stamps the actor', async () => {
      requests.findOne.mockResolvedValue(makeRequest());
      const result = await service.withdraw(COMMUNITY.slug, ACTOR_ID);
      expect(requests.update).toHaveBeenCalledWith(
        { id: 'space-request-1', status: CommunitySpaceRequestStatus.Open },
        expect.objectContaining({
          status: CommunitySpaceRequestStatus.Withdrawn,
          decidedByUserId: ACTOR_ID,
          decidedAt: expect.any(Date),
        }),
      );
      expect(result.status).toBe(CommunitySpaceRequestStatus.Withdrawn);
    });

    it('404s when nothing is open', async () => {
      await expect(
        service.withdraw(COMMUNITY.slug, ACTOR_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s when a concurrent decision closes the request first', async () => {
      requests.findOne.mockResolvedValue(makeRequest());
      requests.update.mockResolvedValue({ affected: 0 });
      await expect(
        service.withdraw(COMMUNITY.slug, ACTOR_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses a mod with 403', async () => {
      membership.effectiveRole.mockResolvedValue(RosterRole.Mod);
      requests.findOne.mockResolvedValue(makeRequest());
      await expect(
        service.withdraw(COMMUNITY.slug, ACTOR_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('latest', () => {
    it('returns null when the community never asked', async () => {
      await expect(service.latest(COMMUNITY.slug, ACTOR_ID)).resolves.toEqual({
        request: null,
      });
    });

    it('lets a mod read the latest request', async () => {
      membership.effectiveRole.mockResolvedValue(RosterRole.Mod);
      requests.findOne.mockResolvedValue(
        makeRequest({
          status: CommunitySpaceRequestStatus.Declined,
          declineReason: 'Too small for now',
        }),
      );
      const result = await service.latest(COMMUNITY.slug, ACTOR_ID);
      expect(result.request?.declineReason).toBe('Too small for now');
    });
  });
});
