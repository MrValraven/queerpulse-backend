import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { AffirmingPledgeService } from '../affirming-pledge/affirming-pledge.service';
import { Connection } from '../connections/entities/connection.entity';
import { MessagingService } from '../messaging/messaging.service';
import { ModAuditService } from '../moderation/mod-audit.service';
import { BlockFilterService } from '../social/block-filter.service';
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
import {
  GROUP_LISTING_REPORT_TAKEDOWN_CODE,
  HousingGroupsService,
} from './housing-groups.service';

/**
 * Covers `createListing` (the admin-queue-notifications announce call, ENG
 * queue `housing_group_listings`), plus the PRD-462 announce on
 * `createJoinRequest`, its ENG-472 duplicate refusal, the ENG-490 audit rows
 * on `deleteGroup` and `triageJoinRequest`, the distinct member recount, and
 * the PRD-443 poster on the group read and the room enquiry. The
 * listing-review surfaces, including the hide toggle, are exercised by
 * `housing-groups-listing-review.service.spec.ts`.
 */

/** A chainable stand-in for a TypeORM `SelectQueryBuilder`: every builder
 * call returns the same object, and the terminal reads are plain mocks. */
interface QueryBuilderMock {
  select: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  limit: jest.Mock;
  getMany: jest.Mock;
  getOne: jest.Mock;
  getRawOne: jest.Mock;
}

function makeQueryBuilder(terminals: {
  getMany?: unknown;
  getOne?: unknown;
  getRawOne?: unknown;
}): QueryBuilderMock {
  const builder: QueryBuilderMock = {
    select: jest.fn(() => builder),
    where: jest.fn(() => builder),
    andWhere: jest.fn(() => builder),
    orderBy: jest.fn(() => builder),
    addOrderBy: jest.fn(() => builder),
    limit: jest.fn(() => builder),
    getMany: jest.fn().mockResolvedValue(terminals.getMany ?? []),
    getOne: jest.fn().mockResolvedValue(terminals.getOne ?? null),
    getRawOne: jest.fn().mockResolvedValue(terminals.getRawOne),
  };
  return builder;
}

describe('HousingGroupsService', () => {
  let service: HousingGroupsService;
  let groups: { findOne: jest.Mock; delete: jest.Mock; update: jest.Mock };
  let listings: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
    // `listMyListings` reads report takedowns off `content_moderation`
    // through the repository's own manager.
    manager: { find: jest.Mock };
  };
  let listingQuery: ReturnType<typeof makeQueryBuilder>;
  let joinRequests: {
    count: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let memberCountQuery: ReturnType<typeof makeQueryBuilder>;
  let connections: Record<string, jest.Mock>;
  let profiles: { find: jest.Mock };
  let affirmingPledge: { requireAccepted: jest.Mock };
  let verification: { requireLevel: jest.Mock; levelForUser: jest.Mock };
  let notifications: { create: jest.Mock };
  let adminQueueNotifications: { announce: jest.Mock };
  let modAudit: { writeAuditLog: jest.Mock };
  let messaging: { deliverEnquiry: jest.Mock };
  let blockFilter: { excludeHidden: jest.Mock };

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
    listingQuery = makeQueryBuilder({});
    memberCountQuery = makeQueryBuilder({ getRawOne: { memberCount: '0' } });
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
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => listingQuery),
      manager: { find: jest.fn().mockResolvedValue([]) },
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
      // `refreshMemberCount` counts DISTINCT approved members (ENG-472).
      createQueryBuilder: jest.fn(() => memberCountQuery),
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
    messaging = {
      deliverEnquiry: jest
        .fn()
        .mockResolvedValue({ conversationId: 'conversation-1' }),
    };
    blockFilter = {
      excludeHidden: jest.fn((queryBuilder: unknown) => queryBuilder),
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
        { provide: ModAuditService, useValue: modAudit },
        { provide: MessagingService, useValue: messaging },
        { provide: BlockFilterService, useValue: blockFilter },
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

    it('marks a new room as naming its poster (LOC-F2)', async () => {
      await service.createListing('sunset-house', CREATE_DTO, 'member-1');

      expect(listings.create).toHaveBeenCalledWith(
        expect.objectContaining({
          postedByUserId: 'member-1',
          isPosterNamed: true,
        }),
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

    it('asks every applicant for the affirming pledge', async () => {
      await service.createJoinRequest(
        'sunset-house',
        { name: 'Sam', relationship: 'Neighbour', answers: [] },
        'member-2',
      );

      expect(affirmingPledge.requireAccepted).toHaveBeenCalledWith('member-2');
      expect(joinRequests.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'member-2' }),
      );
    });

    it('answers a second request still in triage with a typed 409', async () => {
      joinRequests.find.mockResolvedValue([
        { id: 'request-1', status: GroupJoinRequestStatus.Pending },
      ]);

      const attempt = service.createJoinRequest(
        'sunset-house',
        { name: 'Alex', relationship: 'Friend', answers: [] },
        'member-1',
      );

      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toMatchObject({
        response: {
          statusCode: 409,
          code: 'GROUP_JOIN_ALREADY_REQUESTED',
          membershipStanding: 'pending',
        },
      });
      expect(joinRequests.save).not.toHaveBeenCalled();
      expect(adminQueueNotifications.announce).not.toHaveBeenCalled();
    });

    it('tells an approved member they are already in', async () => {
      joinRequests.find.mockResolvedValue([
        { id: 'request-1', status: GroupJoinRequestStatus.Pending },
        { id: 'request-2', status: GroupJoinRequestStatus.Approved },
      ]);

      await expect(
        service.createJoinRequest(
          'sunset-house',
          { name: 'Alex', relationship: 'Friend', answers: [] },
          'member-1',
        ),
      ).rejects.toMatchObject({
        response: {
          code: 'GROUP_JOIN_ALREADY_REQUESTED',
          membershipStanding: 'member',
        },
      });
      expect(joinRequests.save).not.toHaveBeenCalled();
    });

    it('lets a declined member ask again', async () => {
      // The duplicate check reads only pending and approved rows, so an old
      // decline never reaches it.
      joinRequests.find.mockResolvedValue([]);

      await service.createJoinRequest(
        'sunset-house',
        { name: 'Alex', relationship: 'Friend', answers: [] },
        'member-1',
      );

      const [findOptions] = joinRequests.find.mock.calls[0] as [
        { where: { groupId: string; userId: string } },
      ];
      expect(findOptions.where).toMatchObject({
        groupId: 'group-1',
        userId: 'member-1',
      });
      expect(joinRequests.save).toHaveBeenCalled();
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

  describe('listVisibleListings (PRD-443)', () => {
    const liveRoom = {
      id: 'group-listing-1',
      title: 'Room in a queer household',
      description: 'A bright room.',
      neighbourhood: 'Arroios',
      priceEuros: 450,
      accessibilityInfo: 'Ground floor, no stairs.',
      postedByUserId: 'poster-1',
      isPosterNamed: true,
    };
    // LOC-F2: posted through the old anonymous form.
    const olderRoom = {
      ...liveRoom,
      id: 'group-listing-0',
      isPosterNamed: false,
    };
    const posterProfile = {
      userId: 'poster-1',
      slug: 'rui',
      firstName: 'Rui',
      lastName: 'Sousa',
      pronouns: null,
      avatarUrl: null,
      photoVisible: true,
    };

    it('names nobody to an anonymous reader, so the open answer stays cacheable', async () => {
      listingQuery.getMany.mockResolvedValue([liveRoom]);

      const read = await service.listVisibleListings('sunset-house', null);

      expect(read.isCallerAgnostic).toBe(true);
      expect(read.listings[0]).toMatchObject({
        id: 'group-listing-1',
        poster: null,
        isOwnListing: false,
      });
      expect(profiles.find).not.toHaveBeenCalled();
    });

    it('names the poster to a signed-in reader and keeps that answer private', async () => {
      listingQuery.getMany.mockResolvedValue([liveRoom]);
      profiles.find.mockResolvedValue([posterProfile]);

      const read = await service.listVisibleListings(
        'sunset-house',
        'reader-1',
      );

      expect(read.isCallerAgnostic).toBe(false);
      expect(read.listings[0]).toMatchObject({
        poster: { slug: 'rui', firstName: 'Rui' },
        isOwnListing: false,
      });
    });

    it('names nobody on a room posted through the old anonymous form', async () => {
      listingQuery.getMany.mockResolvedValue([olderRoom]);

      const read = await service.listVisibleListings(
        'sunset-house',
        'reader-1',
      );

      expect(read.listings[0]).toMatchObject({
        id: 'group-listing-0',
        poster: null,
        isOwnListing: false,
      });
      expect(profiles.find).not.toHaveBeenCalled();
    });

    it('names the poster of a new room beside an older room that stays unnamed', async () => {
      listingQuery.getMany.mockResolvedValue([liveRoom, olderRoom]);
      profiles.find.mockResolvedValue([posterProfile]);

      const read = await service.listVisibleListings(
        'sunset-house',
        'reader-1',
      );

      expect(read.listings[0]).toMatchObject({
        id: 'group-listing-1',
        poster: { slug: 'rui' },
      });
      expect(read.listings[1]).toMatchObject({
        id: 'group-listing-0',
        poster: null,
      });
    });

    it('still marks the poster their own older room', async () => {
      listingQuery.getMany.mockResolvedValue([olderRoom]);

      const read = await service.listVisibleListings(
        'sunset-house',
        'poster-1',
      );

      expect(read.listings[0]?.isOwnListing).toBe(true);
    });

    it('marks the reader their own room', async () => {
      listingQuery.getMany.mockResolvedValue([liveRoom]);
      profiles.find.mockResolvedValue([posterProfile]);

      const read = await service.listVisibleListings(
        'sunset-house',
        'poster-1',
      );

      expect(read.listings[0]?.isOwnListing).toBe(true);
    });

    it('skips a room taken down from a report', async () => {
      await service.listVisibleListings('sunset-house', null);

      expect(listingQuery.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('content_moderation'),
        { groupListingSubjectType: 'group_listing' },
      );
    });

    it('hides rooms from members the signed-in reader blocked, was blocked by, or muted', async () => {
      await service.listVisibleListings('sunset-house', 'reader-1');

      expect(blockFilter.excludeHidden).toHaveBeenCalledWith(
        listingQuery,
        'reader-1',
        '"listing"."posted_by_user_id"',
      );
    });

    it('applies no block filter to an anonymous reader', async () => {
      await service.listVisibleListings('sunset-house', null);

      expect(blockFilter.excludeHidden).not.toHaveBeenCalled();
    });
  });

  describe('createListingEnquiry (PRD-443)', () => {
    const ENQUIRY = { body: 'Hello, is the room still free from March?' };
    const liveRoom = {
      id: 'group-listing-1',
      postedByUserId: 'poster-1',
      isPosterNamed: true,
    };

    it('delivers the message to the poster as an enquiry', async () => {
      listingQuery.getOne.mockResolvedValue(liveRoom);

      const result = await service.createListingEnquiry(
        'sunset-house',
        'group-listing-1',
        'reader-1',
        ENQUIRY,
      );

      expect(result).toEqual({ conversationId: 'conversation-1' });
      expect(affirmingPledge.requireAccepted).toHaveBeenCalledWith('reader-1');
      expect(verification.requireLevel).toHaveBeenCalledWith(
        'reader-1',
        VerificationLevel.Phone,
      );
      expect(messaging.deliverEnquiry).toHaveBeenCalledWith(
        'reader-1',
        'poster-1',
        ENQUIRY.body,
      );
    });

    it('404s a room the group page does not show', async () => {
      listingQuery.getOne.mockResolvedValue(null);

      await expect(
        service.createListingEnquiry(
          'sunset-house',
          'group-listing-1',
          'reader-1',
          ENQUIRY,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('reads the room through the block and mute filter for the sender', async () => {
      listingQuery.getOne.mockResolvedValue(liveRoom);

      await service.createListingEnquiry(
        'sunset-house',
        'group-listing-1',
        'reader-1',
        ENQUIRY,
      );

      expect(blockFilter.excludeHidden).toHaveBeenCalledWith(
        listingQuery,
        'reader-1',
        '"listing"."posted_by_user_id"',
      );
    });

    it('refuses a message about your own room', async () => {
      listingQuery.getOne.mockResolvedValue(liveRoom);

      await expect(
        service.createListingEnquiry(
          'sunset-house',
          'group-listing-1',
          'poster-1',
          ENQUIRY,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('refuses a room posted through the old anonymous form, before any gate', async () => {
      listingQuery.getOne.mockResolvedValue({
        ...liveRoom,
        isPosterNamed: false,
      });

      await expect(
        service.createListingEnquiry(
          'sunset-house',
          'group-listing-1',
          'reader-1',
          ENQUIRY,
        ),
      ).rejects.toThrow(
        new BadRequestException('This room does not take messages'),
      );
      expect(affirmingPledge.requireAccepted).not.toHaveBeenCalled();
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });

    it('refuses a room with no poster left to contact', async () => {
      listingQuery.getOne.mockResolvedValue({
        ...liveRoom,
        postedByUserId: null,
      });

      await expect(
        service.createListingEnquiry(
          'sunset-house',
          'group-listing-1',
          'reader-1',
          ENQUIRY,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a non-member of an access-gated group before reading the room', async () => {
      groups.findOne.mockResolvedValue(gatedGroup);

      await expect(
        service.createListingEnquiry(
          'sunset-house',
          'group-listing-1',
          'stranger-1',
          ENQUIRY,
        ),
      ).rejects.toMatchObject({
        response: { code: 'GROUP_MEMBERSHIP_REQUIRED' },
      });
      expect(listingQuery.getOne).not.toHaveBeenCalled();
      expect(messaging.deliverEnquiry).not.toHaveBeenCalled();
    });
  });

  // A report takedown writes `content_moderation`, which the group page
  // honours. The poster's own list has to say so too, or a room nobody can see
  // reads as live to the one person who posted it.
  describe('listMyListings report takedowns (PRD-443)', () => {
    const ownRoom = (id: string) => ({
      id,
      groupId: 'group-1',
      title: 'Room in a queer household',
      description: 'A bright room.',
      neighbourhood: 'Arroios',
      priceEuros: 450,
      accessibilityInfo: 'Ground floor.',
      status: GroupListingStatus.Live,
      hidden: false,
      hiddenReason: null,
      postedByUserId: 'member-1',
      decidedAt: null,
      decisionReason: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    it('marks a hidden room, a removed room, and leaves an untouched one null', async () => {
      listings.find.mockResolvedValue([
        ownRoom('room-hidden'),
        ownRoom('room-removed'),
        ownRoom('room-clear'),
      ]);
      listings.manager.find.mockResolvedValue([
        {
          subjectId: 'room-hidden',
          hiddenAt: new Date('2026-02-01T00:00:00.000Z'),
          removedAt: null,
        },
        {
          subjectId: 'room-removed',
          hiddenAt: new Date('2026-02-01T00:00:00.000Z'),
          removedAt: new Date('2026-02-02T00:00:00.000Z'),
        },
      ]);

      const rows = await service.listMyListings('sunset-house', 'member-1');

      expect(rows.map((row) => [row.id, row.moderationState] as const)).toEqual(
        [
          ['room-hidden', 'hidden'],
          ['room-removed', 'removed'],
          ['room-clear', null],
        ],
      );
    });

    it('skips the takedown lookup when the poster has no rooms', async () => {
      listings.find.mockResolvedValue([]);

      const rows = await service.listMyListings('sunset-house', 'member-1');

      expect(rows).toEqual([]);
      expect(listings.manager.find).not.toHaveBeenCalled();
    });
  });

  // LOC-F13: the poster's card hides Edit on a room taken down after a report,
  // and the server refuses the same edit, since it would lift nothing.
  describe('updateListing report takedowns (LOC-F13)', () => {
    const postedRoom = {
      id: 'group-listing-1',
      groupId: 'group-1',
      title: 'Room in a queer household',
      description: 'A bright room.',
      neighbourhood: 'Arroios',
      priceEuros: 450,
      accessibilityInfo: 'Ground floor.',
      status: GroupListingStatus.Live,
      hidden: false,
      hiddenReason: null,
      postedByUserId: 'member-1',
      isPosterNamed: true,
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    it('refuses an edit to a room taken down after a report with a coded 409', async () => {
      listings.findOne.mockResolvedValue({ ...postedRoom });
      listings.manager.find.mockResolvedValue([
        {
          subjectId: 'group-listing-1',
          hiddenAt: new Date('2026-02-01T00:00:00.000Z'),
          removedAt: null,
        },
      ]);

      const attempt = service.updateListing(
        'sunset-house',
        'group-listing-1',
        { title: 'A new title' },
        'member-1',
      );

      await expect(attempt).rejects.toBeInstanceOf(ConflictException);
      await expect(attempt).rejects.toMatchObject({
        response: { code: GROUP_LISTING_REPORT_TAKEDOWN_CODE },
      });
      expect(listings.save).not.toHaveBeenCalled();
    });

    it('saves an edit to a room with no report takedown', async () => {
      listings.findOne.mockResolvedValue({ ...postedRoom });

      const row = await service.updateListing(
        'sunset-house',
        'group-listing-1',
        { title: 'A new title' },
        'member-1',
      );

      expect(listings.save).toHaveBeenCalled();
      expect(row.title).toBe('A new title');
      expect(row.moderationState).toBeNull();
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

    it('recounts the group as distinct approved members', async () => {
      memberCountQuery.getRawOne.mockResolvedValue({ memberCount: '3' });
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

      expect(memberCountQuery.select).toHaveBeenCalledWith(
        expect.stringContaining('COUNT(DISTINCT'),
        'memberCount',
      );
      expect(groups.update).toHaveBeenCalledWith(
        { id: 'group-1' },
        { memberCount: 3 },
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
