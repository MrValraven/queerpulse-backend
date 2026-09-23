import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { PAGE_SIZE } from '../common/pagination';
import { UserRole } from '../users/entities/user.entity';
import { Community } from '../communities/entities/community.entity';
import {
  CommunitySpaceRequest,
  CommunitySpaceRequestStatus,
} from '../communities/entities/community-space-request.entity';
import { SPACE_REQUEST_NOT_OPEN_CODE } from '../communities/subcommunity-rules';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { AdminCommunitiesService } from './admin-communities.service';
import { AdminCommunitySpaceRequestsService } from './admin-community-space-requests.service';
import { ListAdminCommunitySpaceRequestsQuery } from './dto/list-admin-community-space-requests.query';

const COMMUNITY = {
  id: 'community-1',
  slug: 'coletivo-gula',
  name: 'Coletivo Gula',
  accessTier: 'request',
  avatarImageUrl: null,
} as unknown as Community;

function makeRequest(
  overrides: Partial<CommunitySpaceRequest> = {},
): CommunitySpaceRequest {
  return {
    id: 'space-request-1',
    communityId: COMMUNITY.id,
    requestedByUserId: 'owner-1',
    note: 'A parents corner',
    status: CommunitySpaceRequestStatus.Open,
    createdAt: new Date('2026-09-23T10:00:00Z'),
    decidedAt: null,
    decidedByUserId: null,
    declineReason: null,
    ...overrides,
  };
}

type SpaceRequestsQueryBuilderStub = {
  orderBy: jest.Mock;
  skip: jest.Mock;
  take: jest.Mock;
  andWhere: jest.Mock;
  getManyAndCount: jest.Mock;
};

/** Stubs the fluent `createQueryBuilder` chain `list()` drives: every chained
 *  method returns the builder itself, and `getManyAndCount` is the one
 *  terminal it calls. */
function makeQueryBuilderStub(
  rows: CommunitySpaceRequest[] = [],
  total: number = rows.length,
): SpaceRequestsQueryBuilderStub {
  const queryBuilder = {} as SpaceRequestsQueryBuilderStub;
  queryBuilder.orderBy = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.skip = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.take = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.andWhere = jest.fn().mockReturnValue(queryBuilder);
  queryBuilder.getManyAndCount = jest.fn().mockResolvedValue([rows, total]);
  return queryBuilder;
}

describe('AdminCommunitySpaceRequestsService', () => {
  let service: AdminCommunitySpaceRequestsService;
  let requests: {
    findOne: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let communities: { findOne: jest.Mock; find: jest.Mock };
  let profiles: { find: jest.Mock };
  let adminCommunities: { updateSettings: jest.Mock };
  let notifications: { create: jest.Mock };

  beforeEach(async () => {
    requests = {
      findOne: jest.fn().mockResolvedValue(makeRequest()),
      save: jest.fn((value: CommunitySpaceRequest) => Promise.resolve(value)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(),
    };
    communities = {
      findOne: jest.fn().mockResolvedValue(COMMUNITY),
      find: jest.fn().mockResolvedValue([COMMUNITY]),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    adminCommunities = { updateSettings: jest.fn().mockResolvedValue({}) };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminCommunitySpaceRequestsService,
        {
          provide: getRepositoryToken(CommunitySpaceRequest),
          useValue: requests,
        },
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: AdminCommunitiesService, useValue: adminCommunities },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(AdminCommunitySpaceRequestsService);
  });

  describe('list', () => {
    it('populates requestedBy for a platform-staff reader', async () => {
      requests.createQueryBuilder.mockReturnValue(
        makeQueryBuilderStub([makeRequest()], 1),
      );
      profiles.find.mockResolvedValue([
        {
          userId: 'owner-1',
          slug: 'owner-slug',
          firstName: 'Ana',
          lastName: 'Silva',
          pronouns: null,
          avatarUrl: 'https://cdn.example.com/owner.jpg',
          photoVisible: true,
        },
      ]);

      const query: ListAdminCommunitySpaceRequestsQuery = {};
      const result = await service.list(query, UserRole.Admin);

      const [firstItem] = result.items;
      expect(firstItem).toBeDefined();
      expect(firstItem?.requestedBy).toEqual({
        slug: 'owner-slug',
        name: 'Ana Silva',
        avatarUrl: 'https://cdn.example.com/owner.jpg',
      });
    });

    it('omits requestedBy entirely for a reader outside the platform staff tier', async () => {
      requests.createQueryBuilder.mockReturnValue(
        makeQueryBuilderStub([makeRequest()], 1),
      );

      const query: ListAdminCommunitySpaceRequestsQuery = {};
      // `UserRole.Member` is the one account tier `isPlatformStaffTier`
      // refuses (only Moderator and Admin pass), so it stands in for any
      // reader outside the platform staff tier, the same narrowing the
      // `communities` staff grant hits.
      const result = await service.list(query, UserRole.Member);

      const [firstItem] = result.items;
      expect(firstItem).toBeDefined();
      expect('requestedBy' in (firstItem ?? {})).toBe(false);
      expect(profiles.find).not.toHaveBeenCalled();
    });

    it('filters by status through andWhere', async () => {
      const queryBuilder = makeQueryBuilderStub([]);
      requests.createQueryBuilder.mockReturnValue(queryBuilder);

      await service.list(
        { status: CommunitySpaceRequestStatus.Declined },
        UserRole.Admin,
      );

      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'request.status = :status',
        { status: CommunitySpaceRequestStatus.Declined },
      );
    });

    it('returns an empty page without touching community or profile lookups', async () => {
      requests.createQueryBuilder.mockReturnValue(makeQueryBuilderStub([], 0));

      const query: ListAdminCommunitySpaceRequestsQuery = {};
      const result = await service.list(query, UserRole.Admin);

      expect(result).toEqual({
        items: [],
        total: 0,
        page: 1,
        pageSize: PAGE_SIZE,
      });
      expect(communities.find).not.toHaveBeenCalled();
      expect(profiles.find).not.toHaveBeenCalled();
    });
  });

  describe('approve', () => {
    it('switches spaces on through updateSettings and returns the re-read request', async () => {
      requests.findOne
        .mockResolvedValueOnce(makeRequest())
        .mockResolvedValueOnce(
          makeRequest({ status: CommunitySpaceRequestStatus.Approved }),
        );
      const result = await service.approve(
        'space-request-1',
        'admin-1',
        UserRole.Admin,
      );
      expect(adminCommunities.updateSettings).toHaveBeenCalledWith(
        COMMUNITY.slug,
        { allowsSubcommunities: true },
        'admin-1',
        true,
      );
      expect(result.status).toBe(CommunitySpaceRequestStatus.Approved);
      // The notification is sent once, by the settings hook, never here.
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('refuses a request that is no longer open', async () => {
      requests.findOne.mockResolvedValue(
        makeRequest({ status: CommunitySpaceRequestStatus.Approved }),
      );
      await expect(
        service.approve('space-request-1', 'admin-1', UserRole.Admin),
      ).rejects.toMatchObject({
        response: { code: SPACE_REQUEST_NOT_OPEN_CODE },
      });
      expect(adminCommunities.updateSettings).not.toHaveBeenCalled();
    });

    it('404s an unknown request', async () => {
      requests.findOne.mockResolvedValue(null);
      await expect(
        service.approve('missing', 'admin-1', UserRole.Admin),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('decline', () => {
    it('stores the trimmed reason and notifies the requester', async () => {
      const result = await service.decline(
        'space-request-1',
        'admin-1',
        '  Too small for now  ',
        UserRole.Admin,
      );
      expect(requests.update).toHaveBeenCalledWith(
        { id: 'space-request-1', status: CommunitySpaceRequestStatus.Open },
        expect.objectContaining({
          status: CommunitySpaceRequestStatus.Declined,
          declineReason: 'Too small for now',
          decidedByUserId: 'admin-1',
        }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        'owner-1',
        NotificationType.CommunitySpaceRequestDeclined,
        {
          source: 'community',
          communitySlug: COMMUNITY.slug,
          communityName: COMMUNITY.name,
        },
      );
      expect(result.status).toBe(CommunitySpaceRequestStatus.Declined);
    });

    it('stores null for a blank reason', async () => {
      await service.decline(
        'space-request-1',
        'admin-1',
        '   ',
        UserRole.Admin,
      );
      expect(requests.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ declineReason: null }),
      );
    });

    it('refuses a request that is no longer open', async () => {
      requests.findOne.mockResolvedValue(
        makeRequest({ status: CommunitySpaceRequestStatus.Withdrawn }),
      );
      await expect(
        service.decline(
          'space-request-1',
          'admin-1',
          undefined,
          UserRole.Admin,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses with SPACE_REQUEST_NOT_OPEN when a concurrent decision wins the write', async () => {
      requests.update.mockResolvedValue({ affected: 0 });
      await expect(
        service.decline(
          'space-request-1',
          'admin-1',
          undefined,
          UserRole.Admin,
        ),
      ).rejects.toMatchObject({
        response: { code: SPACE_REQUEST_NOT_OPEN_CODE },
      });
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });
});
