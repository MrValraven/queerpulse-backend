import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { CommunityMembershipService } from '../communities/community-membership.service';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { ConnectionsService } from '../connections/connections.service';
import { Profile } from '../users/entities/profile.entity';
import { EventCohost } from './entities/event-cohost.entity';
import {
  EventCommunity,
  EventCommunityStatus,
} from './entities/event-community.entity';
import { EventRsvp } from './entities/event-rsvp.entity';
import { Event, EventStatus } from './entities/event.entity';
import { EventCommunitiesService } from './event-communities.service';
import {
  EVENT_COMMUNITY_INVITE_RESPONDED,
  EVENT_COMMUNITY_INVITED,
} from './event.events';
import { EventsService } from './events.service';

interface InsertBuilderMock {
  insert: jest.Mock;
  into: jest.Mock;
  values: jest.Mock;
  orIgnore: jest.Mock;
  returning: jest.Mock;
  execute: jest.Mock;
}

const DAY_IN_MILLISECONDS = 86_400_000;
const LEAD_COMMUNITY_ID = 'lead-community';
const GUEST_COMMUNITY_ID = 'guest-community';
const STAFF_ROLES = [RosterRole.Owner, RosterRole.CoOwner, RosterRole.Mod];

const eventRow = (overrides: Partial<Event> = {}): Event =>
  ({
    id: 'event-1',
    slug: 'pride-picnic',
    title: 'Pride Picnic',
    hostId: 'host-1',
    communityId: LEAD_COMMUNITY_ID,
    status: EventStatus.Published,
    startAt: new Date(Date.now() + DAY_IN_MILLISECONDS),
    endAt: null,
    timezone: 'Europe/Lisbon',
    venue: 'Jardim da Estrela',
    isOnline: false,
    showAttendeeCount: true,
    ...overrides,
  }) as unknown as Event;

const guestCommunity = (overrides: Partial<Community> = {}): Community =>
  ({
    id: GUEST_COMMUNITY_ID,
    slug: 'drag-club',
    name: 'Drag Club',
    accessTier: AccessTier.Public,
    parentId: null,
    frozenAt: null,
    archivedAt: null,
    ...overrides,
  }) as unknown as Community;

const inviteRow = (
  overrides: Partial<EventCommunity> = {},
): EventCommunity => ({
  id: 'invite-1',
  eventId: 'event-1',
  communityId: GUEST_COMMUNITY_ID,
  status: EventCommunityStatus.Pending,
  invitedByUserId: 'host-1',
  respondedByUserId: null,
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
  respondedAt: null,
  ...overrides,
});

const PROFILES: Record<string, Partial<Profile>> = {
  'host-1': {
    userId: 'host-1',
    slug: 'anika',
    firstName: 'Anika',
    lastName: 'Kovac',
    avatarUrl: null,
  },
  'mod-1': {
    userId: 'mod-1',
    slug: 'rui',
    firstName: 'Rui',
    lastName: 'Matos',
    avatarUrl: null,
  },
};

describe('EventCommunitiesService', () => {
  let service: EventCommunitiesService;
  let insertBuilder: InsertBuilderMock;
  let eventCommunities: {
    findOne: jest.Mock;
    find: jest.Mock;
    count: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let transactionManager: {
    findOne: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let events: { findOne: jest.Mock; count: jest.Mock };
  let cohosts: { find: jest.Mock };
  let rsvps: { count: jest.Mock };
  let communities: { findOne: jest.Mock; find: jest.Mock };
  let communityMembers: { find: jest.Mock };
  let profiles: { findOne: jest.Mock };
  let eventsService: { isOrganizer: jest.Mock };
  let membership: {
    effectiveRole: jest.Mock;
    isMember: jest.Mock;
    hostingRefById: jest.Mock;
  };
  let connectionsService: { mutualCountsByUserIds: jest.Mock };
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    insertBuilder = {
      insert: jest.fn(),
      into: jest.fn(),
      values: jest.fn(),
      orIgnore: jest.fn(),
      returning: jest.fn(),
      execute: jest.fn().mockResolvedValue({ raw: [{ id: 'invite-1' }] }),
    };
    insertBuilder.insert.mockReturnValue(insertBuilder);
    insertBuilder.into.mockReturnValue(insertBuilder);
    insertBuilder.values.mockReturnValue(insertBuilder);
    insertBuilder.orIgnore.mockReturnValue(insertBuilder);
    insertBuilder.returning.mockReturnValue(insertBuilder);

    eventCommunities = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: jest.fn(() => insertBuilder),
      manager: { transaction: jest.fn() },
    };
    transactionManager = {
      findOne: jest.fn().mockResolvedValue({ id: 'event-1' }),
      count: eventCommunities.count,
      createQueryBuilder: eventCommunities.createQueryBuilder,
    };
    eventCommunities.manager.transaction.mockImplementation(
      (callback: (manager: typeof transactionManager) => unknown) =>
        callback(transactionManager),
    );
    events = {
      findOne: jest.fn().mockResolvedValue(eventRow()),
      count: jest.fn().mockResolvedValue(3),
    };
    cohosts = { find: jest.fn().mockResolvedValue([]) };
    rsvps = { count: jest.fn().mockResolvedValue(0) };
    communities = {
      findOne: jest.fn().mockResolvedValue(guestCommunity()),
      find: jest.fn().mockResolvedValue([]),
    };
    communityMembers = { find: jest.fn().mockResolvedValue([]) };
    profiles = {
      findOne: jest.fn(({ where }: { where: { userId: string } }) =>
        Promise.resolve(PROFILES[where.userId] ?? null),
      ),
    };
    eventsService = { isOrganizer: jest.fn().mockResolvedValue(true) };
    membership = {
      effectiveRole: jest.fn().mockResolvedValue(null),
      isMember: jest.fn().mockResolvedValue(false),
      hostingRefById: jest.fn().mockResolvedValue({
        slug: 'queerpulse-social',
        name: 'QueerPulse Social',
        accessTier: AccessTier.Public,
        avatarImageUrl: null,
      }),
    };
    connectionsService = {
      mutualCountsByUserIds: jest.fn().mockResolvedValue(new Map()),
    };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventCommunitiesService,
        {
          provide: getRepositoryToken(EventCommunity),
          useValue: eventCommunities,
        },
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(EventCohost), useValue: cohosts },
        { provide: getRepositoryToken(EventRsvp), useValue: rsvps },
        { provide: getRepositoryToken(Community), useValue: communities },
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: communityMembers,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: EventsService, useValue: eventsService },
        { provide: CommunityMembershipService, useValue: membership },
        { provide: ConnectionsService, useValue: connectionsService },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();
    service = module.get(EventCommunitiesService);
  });

  describe('invite', () => {
    it('refuses a caller who does not organise the gathering', async () => {
      eventsService.isOrganizer.mockResolvedValue(false);

      await expect(
        service.invite('pride-picnic', 'stranger', 'drag-club'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(insertBuilder.execute).not.toHaveBeenCalled();
    });

    it('answers 400 while the gathering has no lead community', async () => {
      events.findOne.mockResolvedValue(eventRow({ communityId: null }));

      await expect(
        service.invite('pride-picnic', 'host-1', 'drag-club'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('answers 409 on a cancelled gathering before writing anything', async () => {
      events.findOne.mockResolvedValue(
        eventRow({ status: EventStatus.Cancelled }),
      );

      await expect(
        service.invite('pride-picnic', 'host-1', 'drag-club'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(insertBuilder.execute).not.toHaveBeenCalled();
    });

    it('answers 409 once the gathering has happened', async () => {
      events.findOne.mockResolvedValue(
        eventRow({ startAt: new Date(Date.now() - DAY_IN_MILLISECONDS) }),
      );

      await expect(
        service.invite('pride-picnic', 'host-1', 'drag-club'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(insertBuilder.execute).not.toHaveBeenCalled();
    });

    it('locks the event row before counting the guests', async () => {
      await service.invite('pride-picnic', 'host-1', 'drag-club');

      expect(transactionManager.findOne).toHaveBeenCalledWith(Event, {
        where: { id: 'event-1' },
        select: { id: true, communityId: true },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('answers 409 when a lead move made the community the lead while the invite waited on the lock', async () => {
      transactionManager.findOne.mockResolvedValue({
        id: 'event-1',
        communityId: GUEST_COMMUNITY_ID,
      });

      const error = await service
        .invite('pride-picnic', 'host-1', 'drag-club')
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toBe(
        'This community already leads the event',
      );
      expect(eventCommunities.count).not.toHaveBeenCalled();
      expect(insertBuilder.execute).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown or archived community', async () => {
      communities.findOne.mockResolvedValue(null);

      await expect(
        service.invite('pride-picnic', 'host-1', 'nowhere'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers 404 for a private community the inviter is off', async () => {
      communities.findOne.mockResolvedValue(
        guestCommunity({ accessTier: AccessTier.Private }),
      );

      await expect(
        service.invite('pride-picnic', 'host-1', 'drag-club'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(insertBuilder.execute).not.toHaveBeenCalled();
    });

    it('invites a private community the inviter belongs to', async () => {
      communities.findOne.mockResolvedValue(
        guestCommunity({ accessTier: AccessTier.Private }),
      );
      membership.effectiveRole.mockResolvedValue(RosterRole.Member);

      const view = await service.invite('pride-picnic', 'host-1', 'drag-club');

      expect(view.status).toBe(EventCommunityStatus.Pending);
    });

    it('answers 409 when the community already leads the gathering', async () => {
      communities.findOne.mockResolvedValue(
        guestCommunity({ id: LEAD_COMMUNITY_ID }),
      );

      await expect(
        service.invite('pride-picnic', 'host-1', 'queerpulse-social'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('answers 409 when the community declined before, which is final', async () => {
      eventCommunities.findOne.mockResolvedValue(
        inviteRow({ status: EventCommunityStatus.Declined }),
      );

      await expect(
        service.invite('pride-picnic', 'host-1', 'drag-club'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(insertBuilder.execute).not.toHaveBeenCalled();
    });

    it('answers 409 when the community is frozen', async () => {
      communities.findOne.mockResolvedValue(
        guestCommunity({ frozenAt: new Date('2026-10-02T00:00:00.000Z') }),
      );

      await expect(
        service.invite('pride-picnic', 'host-1', 'drag-club'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('answers 400 once five guests are pending or accepted', async () => {
      eventCommunities.count.mockResolvedValue(5);

      await expect(
        service.invite('pride-picnic', 'host-1', 'drag-club'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(eventCommunities.count).toHaveBeenCalledWith(EventCommunity, {
        where: {
          eventId: 'event-1',
          status: In([
            EventCommunityStatus.Pending,
            EventCommunityStatus.Accepted,
          ]),
        },
      });
    });

    it('creates a pending invite and tells the guest staff', async () => {
      communityMembers.find.mockResolvedValue([
        { userId: 'owner-2', role: RosterRole.Owner },
        { userId: 'mod-3', role: RosterRole.Mod },
      ]);

      const view = await service.invite('pride-picnic', 'host-1', 'drag-club');

      expect(view).toEqual({
        id: 'invite-1',
        status: EventCommunityStatus.Pending,
        community: {
          slug: 'drag-club',
          name: 'Drag Club',
          accessTier: AccessTier.Public,
        },
      });
      expect(insertBuilder.values).toHaveBeenCalledWith({
        eventId: 'event-1',
        communityId: GUEST_COMMUNITY_ID,
        status: EventCommunityStatus.Pending,
        invitedByUserId: 'host-1',
        respondedByUserId: null,
        respondedAt: null,
      });
      expect(communityMembers.find).toHaveBeenCalledWith({
        where: { communityId: GUEST_COMMUNITY_ID, role: In(STAFF_ROLES) },
        select: { userId: true, role: true },
      });
      expect(emitter.emit).toHaveBeenCalledWith(EVENT_COMMUNITY_INVITED, {
        inviteId: 'invite-1',
        eventId: 'event-1',
        eventSlug: 'pride-picnic',
        eventTitle: 'Pride Picnic',
        communitySlug: 'drag-club',
        communityName: 'Drag Club',
        leadCommunityName: 'QueerPulse Social',
        inviterId: 'host-1',
        recipientUserIds: ['owner-2', 'mod-3'],
      });
    });

    it('reaches parent staff of a space guest and drops space staff whose parent row is gone', async () => {
      communities.findOne.mockResolvedValue(
        guestCommunity({ parentId: 'parent-1' }),
      );
      communityMembers.find
        .mockResolvedValueOnce([
          { userId: 'space-mod', role: RosterRole.Mod },
          { userId: 'orphaned-mod', role: RosterRole.Mod },
        ])
        .mockResolvedValueOnce([
          { userId: 'parent-owner', role: RosterRole.Owner },
          { userId: 'space-mod', role: RosterRole.Member },
        ]);

      await service.invite('pride-picnic', 'host-1', 'drag-club');

      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_COMMUNITY_INVITED,
        expect.objectContaining({
          recipientUserIds: ['space-mod', 'parent-owner'],
        }),
      );
    });

    it('leaves a private lead name out of the invite notification', async () => {
      membership.hostingRefById.mockResolvedValue({
        slug: 'secret-circle',
        name: 'Secret Circle',
        accessTier: AccessTier.Private,
        avatarImageUrl: null,
      });

      await service.invite('pride-picnic', 'host-1', 'drag-club');

      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_COMMUNITY_INVITED,
        expect.objectContaining({ leadCommunityName: null }),
      );
    });

    it('accepts on the spot when the inviter moderates the guest community, and tells nobody', async () => {
      membership.effectiveRole.mockResolvedValue(RosterRole.Mod);

      const view = await service.invite('pride-picnic', 'host-1', 'drag-club');

      expect(view.status).toBe(EventCommunityStatus.Accepted);
      expect(insertBuilder.values).toHaveBeenCalledWith(
        expect.objectContaining({
          status: EventCommunityStatus.Accepted,
          respondedByUserId: 'host-1',
          respondedAt: expect.any(Date),
        }),
      );
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('answers 409 when a concurrent invite wins the unique pair', async () => {
      insertBuilder.execute.mockResolvedValue({ raw: [] });

      await expect(
        service.invite('pride-picnic', 'host-1', 'drag-club'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('removeByOrganizer', () => {
    it('refuses a caller who does not organise the gathering', async () => {
      eventsService.isOrganizer.mockResolvedValue(false);

      await expect(
        service.removeByOrganizer('pride-picnic', 'stranger', 'drag-club'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(eventCommunities.delete).not.toHaveBeenCalled();
    });

    describe('with a guest row on the gathering', () => {
      beforeEach(() => {
        eventCommunities.find.mockResolvedValue([inviteRow()]);
        communities.find.mockResolvedValue([guestCommunity()]);
      });

      it('deletes a pending guest row, silently', async () => {
        await service.removeByOrganizer('pride-picnic', 'host-1', 'drag-club');

        // Matching on status keeps a decline that lands after the read.
        expect(eventCommunities.delete).toHaveBeenCalledWith({
          id: 'invite-1',
          status: In([
            EventCommunityStatus.Pending,
            EventCommunityStatus.Accepted,
          ]),
        });
        expect(emitter.emit).not.toHaveBeenCalled();
      });

      it('keeps a declined row so the decline stays final', async () => {
        eventCommunities.find.mockResolvedValue([
          inviteRow({ status: EventCommunityStatus.Declined }),
        ]);

        await service.removeByOrganizer('pride-picnic', 'host-1', 'drag-club');
        expect(eventCommunities.delete).not.toHaveBeenCalled();

        eventCommunities.findOne.mockResolvedValue(
          inviteRow({ status: EventCommunityStatus.Declined }),
        );
        await expect(
          service.invite('pride-picnic', 'host-1', 'drag-club'),
        ).rejects.toBeInstanceOf(ConflictException);
      });
    });

    it('answers one identical 404 for an unknown slug and a private non-guest slug', async () => {
      eventCommunities.find.mockResolvedValue([]);
      communities.find.mockResolvedValue([]);

      const unknownError = await service
        .removeByOrganizer('pride-picnic', 'host-1', 'nowhere')
        .catch((error: unknown) => error);
      const privateError = await service
        .removeByOrganizer('pride-picnic', 'host-1', 'secret-circle')
        .catch((error: unknown) => error);

      expect(unknownError).toBeInstanceOf(NotFoundException);
      expect(privateError).toBeInstanceOf(NotFoundException);
      expect((privateError as NotFoundException).message).toBe(
        (unknownError as NotFoundException).message,
      );
      expect(eventCommunities.delete).not.toHaveBeenCalled();
    });
  });

  describe('listForOrganizer', () => {
    it('refuses a caller who does not organise the gathering', async () => {
      eventsService.isOrganizer.mockResolvedValue(false);

      await expect(
        service.listForOrganizer('pride-picnic', 'stranger'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lists every guest in invite order, declined and private included', async () => {
      eventCommunities.find.mockResolvedValue([
        inviteRow({ id: 'row-a', status: EventCommunityStatus.Accepted }),
        inviteRow({
          id: 'row-b',
          communityId: 'book-club-id',
          status: EventCommunityStatus.Declined,
        }),
      ]);
      communities.find.mockResolvedValue([
        guestCommunity(),
        guestCommunity({
          id: 'book-club-id',
          slug: 'book-club',
          name: 'Book Club',
          accessTier: AccessTier.Private,
        }),
      ]);

      const views = await service.listForOrganizer('pride-picnic', 'host-1');

      expect(eventCommunities.find).toHaveBeenCalledWith({
        where: { eventId: 'event-1' },
        order: { createdAt: 'ASC' },
      });
      expect(views).toEqual([
        {
          id: 'row-a',
          status: EventCommunityStatus.Accepted,
          community: {
            slug: 'drag-club',
            name: 'Drag Club',
            accessTier: AccessTier.Public,
          },
        },
        {
          id: 'row-b',
          status: EventCommunityStatus.Declined,
          community: {
            slug: 'book-club',
            name: 'Book Club',
            accessTier: AccessTier.Private,
          },
        },
      ]);
    });
  });

  describe('getInvite', () => {
    beforeEach(() => {
      eventCommunities.findOne.mockResolvedValue(inviteRow());
      eventsService.isOrganizer.mockResolvedValue(false);
      membership.effectiveRole.mockResolvedValue(RosterRole.Mod);
    });

    it('refuses a viewer who neither runs the guest community nor organises', async () => {
      membership.effectiveRole.mockResolvedValue(RosterRole.Member);

      await expect(
        service.getInvite('invite-1', 'member-9'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('builds the open invite for a guest mod', async () => {
      rsvps.count.mockResolvedValueOnce(12).mockResolvedValueOnce(2);

      const detail = await service.getInvite('invite-1', 'mod-1');

      expect(detail).toEqual(
        expect.objectContaining({
          id: 'invite-1',
          status: EventCommunityStatus.Pending,
          respondedAt: null,
          respondedByName: null,
          community: {
            slug: 'drag-club',
            name: 'Drag Club',
            accessTier: AccessTier.Public,
          },
          leadCommunity: {
            slug: 'queerpulse-social',
            name: 'QueerPulse Social',
          },
          canRespond: true,
          canLeave: false,
        }),
      );
      expect(detail.event).toEqual(
        expect.objectContaining({
          slug: 'pride-picnic',
          goingCount: 12,
          waitlistCount: 2,
          isCancelled: false,
          isPast: false,
        }),
      );
      expect(detail.inviter).toEqual(
        expect.objectContaining({ slug: 'anika', hostedEventsCount: 3 }),
      );
    });

    it('closes the answer on a cancelled gathering', async () => {
      events.findOne.mockResolvedValue(
        eventRow({ status: EventStatus.Cancelled }),
      );

      const detail = await service.getInvite('invite-1', 'mod-1');

      expect(detail.event.isCancelled).toBe(true);
      expect(detail.canRespond).toBe(false);
    });

    it('closes the answer once the gathering has happened', async () => {
      events.findOne.mockResolvedValue(
        eventRow({ startAt: new Date(Date.now() - DAY_IN_MILLISECONDS) }),
      );

      const detail = await service.getInvite('invite-1', 'mod-1');

      expect(detail.event.isPast).toBe(true);
      expect(detail.canRespond).toBe(false);
    });

    it('closes the answer while the guest community is frozen', async () => {
      communities.findOne.mockResolvedValue(
        guestCommunity({ frozenAt: new Date('2026-10-02T00:00:00.000Z') }),
      );

      const detail = await service.getInvite('invite-1', 'mod-1');

      expect(detail.canRespond).toBe(false);
    });

    it('withholds a private lead from a guest mod off its roster', async () => {
      membership.hostingRefById.mockResolvedValue({
        slug: 'secret-circle',
        name: 'Secret Circle',
        accessTier: AccessTier.Private,
        avatarImageUrl: null,
      });

      const detail = await service.getInvite('invite-1', 'mod-1');

      expect(detail.leadCommunity).toBeNull();
      expect(membership.isMember).toHaveBeenCalledWith(
        LEAD_COMMUNITY_ID,
        'mod-1',
      );
    });

    it('shows a private lead to a guest mod on its roster', async () => {
      membership.hostingRefById.mockResolvedValue({
        slug: 'secret-circle',
        name: 'Secret Circle',
        accessTier: AccessTier.Private,
        avatarImageUrl: null,
      });
      membership.isMember.mockResolvedValue(true);

      const detail = await service.getInvite('invite-1', 'mod-1');

      expect(detail.leadCommunity).toEqual({
        slug: 'secret-circle',
        name: 'Secret Circle',
      });
    });

    it('shows a private lead to an organiser without a roster read', async () => {
      membership.effectiveRole.mockResolvedValue(null);
      eventsService.isOrganizer.mockResolvedValue(true);
      membership.hostingRefById.mockResolvedValue({
        slug: 'secret-circle',
        name: 'Secret Circle',
        accessTier: AccessTier.Private,
        avatarImageUrl: null,
      });

      const detail = await service.getInvite('invite-1', 'host-1');

      expect(detail.leadCommunity).toEqual({
        slug: 'secret-circle',
        name: 'Secret Circle',
      });
      expect(membership.isMember).not.toHaveBeenCalled();
    });

    it('withholds both tallies when the host hid the count', async () => {
      events.findOne.mockResolvedValue(eventRow({ showAttendeeCount: false }));

      const detail = await service.getInvite('invite-1', 'mod-1');

      expect(detail.event.goingCount).toBeNull();
      expect(detail.event.waitlistCount).toBeNull();
      expect(rsvps.count).not.toHaveBeenCalled();
    });

    it('lets an organiser read the invite without answering it', async () => {
      membership.effectiveRole.mockResolvedValue(null);
      eventsService.isOrganizer.mockResolvedValue(true);

      const detail = await service.getInvite('invite-1', 'host-1');

      expect(detail.canRespond).toBe(false);
      expect(detail.canLeave).toBe(false);
    });

    it('names the mod who answered and offers leaving an accepted collab', async () => {
      eventCommunities.findOne.mockResolvedValue(
        inviteRow({
          status: EventCommunityStatus.Accepted,
          respondedByUserId: 'mod-1',
          respondedAt: new Date('2026-10-03T09:00:00.000Z'),
        }),
      );

      const detail = await service.getInvite('invite-1', 'mod-1');

      expect(detail.respondedByName).toBe('Rui Matos');
      expect(detail.canRespond).toBe(false);
      expect(detail.canLeave).toBe(true);
    });
  });

  describe('respond', () => {
    beforeEach(() => {
      eventCommunities.findOne.mockResolvedValue(inviteRow());
      membership.effectiveRole.mockResolvedValue(RosterRole.Mod);
    });

    it('refuses a plain member of the guest community', async () => {
      membership.effectiveRole.mockResolvedValue(RosterRole.Member);

      await expect(
        service.respond('invite-1', 'member-9', 'accept'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(eventCommunities.update).not.toHaveBeenCalled();
    });

    it('answers 409 once the invite is no longer pending', async () => {
      eventCommunities.findOne.mockResolvedValue(
        inviteRow({ status: EventCommunityStatus.Declined }),
      );

      await expect(
        service.respond('invite-1', 'mod-1', 'accept'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('answers 409 on a cancelled gathering', async () => {
      events.findOne.mockResolvedValue(
        eventRow({ status: EventStatus.Cancelled }),
      );

      await expect(
        service.respond('invite-1', 'mod-1', 'accept'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('answers 409 once the gathering has happened', async () => {
      events.findOne.mockResolvedValue(
        eventRow({ startAt: new Date(Date.now() - DAY_IN_MILLISECONDS) }),
      );

      await expect(
        service.respond('invite-1', 'mod-1', 'accept'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('answers 409 while the guest community is frozen', async () => {
      communities.findOne.mockResolvedValue(
        guestCommunity({ frozenAt: new Date('2026-10-02T00:00:00.000Z') }),
      );

      await expect(
        service.respond('invite-1', 'mod-1', 'accept'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('answers 409 when another mod answered first', async () => {
      eventCommunities.update.mockResolvedValue({ affected: 0 });

      await expect(
        service.respond('invite-1', 'mod-1', 'accept'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('accepts through a pending-only update and tells the organisers', async () => {
      cohosts.find.mockResolvedValue([
        { userId: 'cohost-1' },
        { userId: 'mod-1' },
      ]);

      const detail = await service.respond('invite-1', 'mod-1', 'accept');

      expect(eventCommunities.update).toHaveBeenCalledWith(
        { id: 'invite-1', status: EventCommunityStatus.Pending },
        {
          status: EventCommunityStatus.Accepted,
          respondedByUserId: 'mod-1',
          respondedAt: expect.any(Date),
        },
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_COMMUNITY_INVITE_RESPONDED,
        {
          inviteId: 'invite-1',
          eventId: 'event-1',
          eventSlug: 'pride-picnic',
          eventTitle: 'Pride Picnic',
          communitySlug: 'drag-club',
          communityName: 'Drag Club',
          decision: 'accepted',
          responderId: 'mod-1',
          recipientUserIds: ['host-1', 'cohost-1'],
        },
      );
      expect(detail.status).toBe(EventCommunityStatus.Accepted);
      expect(detail.respondedByName).toBe('Rui Matos');
      expect(detail.canRespond).toBe(false);
      expect(detail.canLeave).toBe(true);
    });

    it('declines and reports the decline', async () => {
      const detail = await service.respond('invite-1', 'mod-1', 'decline');

      expect(eventCommunities.update).toHaveBeenCalledWith(
        { id: 'invite-1', status: EventCommunityStatus.Pending },
        expect.objectContaining({ status: EventCommunityStatus.Declined }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_COMMUNITY_INVITE_RESPONDED,
        expect.objectContaining({ decision: 'declined' }),
      );
      expect(detail.status).toBe(EventCommunityStatus.Declined);
      expect(detail.canLeave).toBe(false);
    });
  });

  describe('leave', () => {
    beforeEach(() => {
      eventCommunities.findOne.mockResolvedValue(
        inviteRow({ status: EventCommunityStatus.Accepted }),
      );
      membership.effectiveRole.mockResolvedValue(RosterRole.Owner);
    });

    it('refuses someone who does not run the guest community', async () => {
      membership.effectiveRole.mockResolvedValue(null);

      await expect(service.leave('invite-1', 'host-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(eventCommunities.update).not.toHaveBeenCalled();
    });

    it('answers 409 on an invite that was never accepted', async () => {
      eventCommunities.findOne.mockResolvedValue(inviteRow());

      await expect(service.leave('invite-1', 'owner-2')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('records a decline on the accepted row, silently', async () => {
      await service.leave('invite-1', 'owner-2');

      expect(eventCommunities.update).toHaveBeenCalledWith(
        { id: 'invite-1', status: EventCommunityStatus.Accepted },
        {
          status: EventCommunityStatus.Declined,
          respondedByUserId: 'owner-2',
          respondedAt: expect.any(Date),
        },
      );
      expect(eventCommunities.delete).not.toHaveBeenCalled();
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('answers 409 when the collab was already left', async () => {
      eventCommunities.update.mockResolvedValue({ affected: 0 });

      await expect(service.leave('invite-1', 'owner-2')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('blocks a re-invite after leaving', async () => {
      await service.leave('invite-1', 'owner-2');
      eventCommunities.findOne.mockResolvedValue(
        inviteRow({ status: EventCommunityStatus.Declined }),
      );
      eventsService.isOrganizer.mockResolvedValue(true);

      await expect(
        service.invite('pride-picnic', 'host-1', 'drag-club'),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
