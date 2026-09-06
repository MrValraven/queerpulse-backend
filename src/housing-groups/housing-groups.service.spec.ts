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
import {
  GroupJoinRequest,
  GroupJoinRequestStatus,
} from './entities/group-join-request.entity';
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
  let joinRequests: { count: jest.Mock; find: jest.Mock };
  let connections: Record<string, jest.Mock>;
  let profiles: Record<string, jest.Mock>;
  let affirmingPledge: { requireAccepted: jest.Mock };
  let verification: { requireLevel: jest.Mock; levelForUser: jest.Mock };
  let notifications: { create: jest.Mock };
  let adminQueueNotifications: { announce: jest.Mock };

  // An OPEN group: `isAccessGated` false means "an open reading room", so every
  // active member may share a room in it and gate 0 stands down (ENG-171).
  const publishedGroup = {
    id: 'group-1',
    slug: 'sunset-house',
    name: 'Sunset House',
    isAccessGated: false,
  };

  const gatedGroup = { ...publishedGroup, isAccessGated: true };

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
    joinRequests = {
      count: jest.fn().mockResolvedValue(0),
      // The caller's own join requests for this group (ENG-171). Empty is the
      // honest default; the access-gated cases below set it per test.
      find: jest.fn().mockResolvedValue([]),
    };
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

    it('refuses a non-member on an access-gated group, before any other gate', async () => {
      groups.findOne.mockResolvedValue(gatedGroup);

      await expect(
        service.createListing('sunset-house', CREATE_DTO, 'stranger-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Gate 0 runs first, so a stranger is never sent through a pledge or a
      // phone verification only to be refused afterwards.
      expect(affirmingPledge.requireAccepted).not.toHaveBeenCalled();
      expect(verification.requireLevel).not.toHaveBeenCalled();
      expect(listings.save).not.toHaveBeenCalled();
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });

    it('tells a member with a request still in triage that it is pending', async () => {
      groups.findOne.mockResolvedValue(gatedGroup);
      joinRequests.find.mockResolvedValue([
        { id: 'request-1', status: GroupJoinRequestStatus.Pending },
      ]);

      await expect(
        service.createListing('sunset-house', CREATE_DTO, 'applicant-1'),
      ).rejects.toMatchObject({
        response: {
          code: 'GROUP_MEMBERSHIP_REQUIRED',
          membershipStanding: 'pending',
        },
      });
    });

    it('lets an approved member share a room in an access-gated group', async () => {
      groups.findOne.mockResolvedValue(gatedGroup);
      joinRequests.find.mockResolvedValue([
        { id: 'request-1', status: GroupJoinRequestStatus.Approved },
      ]);

      await service.createListing('sunset-house', CREATE_DTO, 'member-1');

      expect(listings.save).toHaveBeenCalled();
      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.HousingGroupListings,
        'group-listing-1',
      );
    });

    it('leaves an open group open to every active member', async () => {
      joinRequests.find.mockResolvedValue([]);

      await service.createListing('sunset-house', CREATE_DTO, 'member-1');

      // No roster read at all: the flag is false, so the gate never runs.
      expect(joinRequests.find).not.toHaveBeenCalled();
      expect(listings.save).toHaveBeenCalled();
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
