import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { Connection } from '../connections/entities/connection.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { VerificationLevel } from '../verification/verification-level';
import { VerificationService } from '../verification/verification.service';
import { CreateGroupListingDto } from './dto/create-group-listing.dto';
import { GroupJoinRequest } from './entities/group-join-request.entity';
import {
  GroupListing,
  GroupListingStatus,
} from './entities/group-listing.entity';
import { HousingGroup } from './entities/housing-group.entity';
import { HousingGroupsService } from './housing-groups.service';

/**
 * Covers `createListing` only, the surface this spec was written for
 * (the admin-queue-notifications announce call, ENG queue
 * `housing_group_listings`). The service's roster/join-request/triage
 * surfaces are exercised by `housing-groups-listing-review.service.spec.ts`
 * and its siblings.
 */
describe('HousingGroupsService', () => {
  let service: HousingGroupsService;
  let groups: { findOne: jest.Mock };
  let listings: { create: jest.Mock; save: jest.Mock };
  let joinRequests: { count: jest.Mock };
  let connections: Record<string, jest.Mock>;
  let profiles: Record<string, jest.Mock>;
  let affirmingPledge: { requireAccepted: jest.Mock };
  let verification: { requireLevel: jest.Mock; levelForUser: jest.Mock };
  let notifications: { create: jest.Mock };
  let adminQueueNotifications: { announce: jest.Mock };

  const publishedGroup = {
    id: 'group-1',
    slug: 'sunset-house',
    name: 'Sunset House',
  };

  const CREATE_DTO: CreateGroupListingDto = {
    title: 'Room in a queer household',
    description: 'A bright room in a shared, welcoming home.',
    neighbourhood: 'Arroios',
    priceEuros: 450,
    accessibilityInfo: 'Ground floor, no stairs.',
  };

  beforeEach(async () => {
    groups = { findOne: jest.fn().mockResolvedValue(publishedGroup) };
    listings = {
      create: jest.fn((row: object) => row),
      save: jest.fn((row: unknown) =>
        Promise.resolve({
          id: 'group-listing-1',
          status: GroupListingStatus.Review,
          hidden: false,
          hiddenReason: null,
          decidedAt: null,
          decisionReason: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          ...(row as object),
        }),
      ),
    };
    joinRequests = { count: jest.fn().mockResolvedValue(0) };
    connections = { find: jest.fn().mockResolvedValue([]) };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    affirmingPledge = {
      requireAccepted: jest.fn().mockResolvedValue(undefined),
    };
    verification = {
      requireLevel: jest.fn().mockResolvedValue(undefined),
      levelForUser: jest.fn().mockResolvedValue(VerificationLevel.Phone),
    };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    adminQueueNotifications = {
      announce: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HousingGroupsService,
        { provide: getRepositoryToken(HousingGroup), useValue: groups },
        {
          provide: getRepositoryToken(GroupJoinRequest),
          useValue: joinRequests,
        },
        { provide: getRepositoryToken(GroupListing), useValue: listings },
        { provide: getRepositoryToken(Connection), useValue: connections },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: AffirmingPledgeService, useValue: affirmingPledge },
        { provide: VerificationService, useValue: verification },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: AdminQueueNotificationsService,
          useValue: adminQueueNotifications,
        },
      ],
    }).compile();

    service = module.get(HousingGroupsService);
  });

  describe('createListing', () => {
    it('tells the housing-group-listing queue that a listing landed in review', async () => {
      await service.createListing('sunset-house', CREATE_DTO, 'member-1');

      expect(listings.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: GroupListingStatus.Review }),
      );
      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.HousingGroupListings,
        'group-listing-1',
      );
    });

    it('tells nobody when the group does not exist', async () => {
      groups.findOne.mockResolvedValue(null);

      await expect(
        service.createListing('missing-group', CREATE_DTO, 'member-1'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(listings.save).not.toHaveBeenCalled();
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });

    it('tells nobody when the affirming pledge has not been accepted', async () => {
      affirmingPledge.requireAccepted.mockRejectedValue(
        new ForbiddenException('AFFIRMING_PLEDGE_REQUIRED'),
      );

      await expect(
        service.createListing('sunset-house', CREATE_DTO, 'member-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(listings.save).not.toHaveBeenCalled();
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });
  });
});
