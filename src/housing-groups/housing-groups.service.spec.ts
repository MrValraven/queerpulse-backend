import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { Connection } from '../connections/entities/connection.entity';
import { ModAuditService } from '../moderation/mod-audit.service';
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
 * Covers `createListing` (the admin-queue-notifications announce call, ENG
 * queue `housing_group_listings`), plus the PRD-462 announce on
 * `createJoinRequest` and the ENG-490 audit rows on `deleteGroup` and
 * `triageJoinRequest`. The listing-review surfaces, including the hide
 * toggle, are exercised by `housing-groups-listing-review.service.spec.ts`.
 */
describe('HousingGroupsService', () => {
  let service: HousingGroupsService;
  let groups: { findOne: jest.Mock; delete: jest.Mock; update: jest.Mock };
  let listings: { create: jest.Mock; save: jest.Mock };
  let joinRequests: {
    count: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let connections: Record<string, jest.Mock>;
  let profiles: Record<string, jest.Mock>;
  let affirmingPledge: { requireAccepted: jest.Mock };
  let verification: { requireLevel: jest.Mock; levelForUser: jest.Mock };
  let notifications: { create: jest.Mock };
  let adminQueueNotifications: { announce: jest.Mock };
  let modAudit: { writeAuditLog: jest.Mock };

  // An OPEN group: `isAccessGated` false means "an open reading room", so every
  // active member may share a room in it and gate 0 stands down (ENG-171).
  const publishedGroup = {
    id: 'group-1',
    slug: 'sunset-house',
    name: 'Sunset House',
    isAccessGated: false,
    screeningQuestions: [],
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
    groups = {
      findOne: jest.fn().mockResolvedValue(publishedGroup),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockResolvedValue(undefined),
    };
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
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row: object) => row),
      save: jest.fn((row: object) =>
        Promise.resolve({ id: 'join-request-1', ...row }),
      ),
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
    modAudit = { writeAuditLog: jest.fn().mockResolvedValue(undefined) };

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
        { provide: ModAuditService, useValue: modAudit },
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

  describe('createJoinRequest', () => {
    it('tells the group join-request queue that an application landed', async () => {
      const result = await service.createJoinRequest(
        'sunset-house',
        { name: 'Alex', relationship: 'Friend of a member', answers: [] },
        'member-1',
      );

      expect(result).toEqual({ id: 'join-request-1' });
      expect(joinRequests.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: GroupJoinRequestStatus.Pending }),
      );
      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.HousingGroupJoinRequests,
        'join-request-1',
      );
    });

    it('announces an anonymous application too', async () => {
      await service.createJoinRequest(
        'sunset-house',
        { name: 'Sam', relationship: 'Neighbour', answers: [] },
        null,
      );

      expect(affirmingPledge.requireAccepted).not.toHaveBeenCalled();
      expect(adminQueueNotifications.announce).toHaveBeenCalledWith(
        AdminQueueKey.HousingGroupJoinRequests,
        'join-request-1',
      );
    });

    it('tells nobody when the group does not exist', async () => {
      groups.findOne.mockResolvedValue(null);

      await expect(
        service.createJoinRequest(
          'missing-group',
          { name: 'Alex', relationship: 'Friend', answers: [] },
          'member-1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(joinRequests.save).not.toHaveBeenCalled();
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });
  });

  describe('deleteGroup', () => {
    it('records the acting staff member in the audit trail', async () => {
      await service.deleteGroup('group-1', 'moderator-1');

      expect(groups.delete).toHaveBeenCalledWith({ id: 'group-1' });
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        'moderator-1',
        'housing_group_delete',
        undefined,
        expect.stringContaining('group-1'),
      );
    });

    it('writes no audit row for a group that does not exist', async () => {
      groups.findOne.mockResolvedValue(null);

      await expect(
        service.deleteGroup('missing', 'moderator-1'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(groups.delete).not.toHaveBeenCalled();
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
    });

    it('still answers when the audit write fails, because the delete committed', async () => {
      modAudit.writeAuditLog.mockRejectedValue(new Error('db down'));

      await expect(
        service.deleteGroup('group-1', 'moderator-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('triageJoinRequest', () => {
    const pendingRequest = {
      id: 'join-request-7',
      groupId: 'group-1',
      userId: null,
      name: 'Sam',
      relationship: 'Neighbour',
      answers: [],
      note: null,
      status: GroupJoinRequestStatus.Pending,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    it('records the acting staff member and the decision', async () => {
      joinRequests.findOne
        .mockResolvedValueOnce({ ...pendingRequest })
        .mockResolvedValueOnce({
          ...pendingRequest,
          status: GroupJoinRequestStatus.Approved,
          group: publishedGroup,
        });

      await service.triageJoinRequest(
        'join-request-7',
        'approved',
        'moderator-1',
      );

      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        'moderator-1',
        'housing_group_join_request_triage',
        undefined,
        expect.stringMatching(/join-request-7.*approved/),
      );
    });

    it('writes no audit row for a request that does not exist', async () => {
      joinRequests.findOne.mockResolvedValue(null);

      await expect(
        service.triageJoinRequest('missing', 'declined', 'moderator-1'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
    });
  });
});
