import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { UsersService } from '../users/users.service';
import { EventCohostInvitesService } from './event-cohost-invites.service';
import {
  EventCohostInvite,
  EventCohostInviteStatus,
} from './entities/event-cohost-invite.entity';
import { EventRsvp } from './entities/event-rsvp.entity';
import { Event } from './entities/event.entity';
import { EVENT_COHOST_INVITED } from './event.events';
import { EventsService } from './events.service';

interface InsertBuilderMock {
  insert: jest.Mock;
  into: jest.Mock;
  values: jest.Mock;
  orIgnore: jest.Mock;
  returning: jest.Mock;
  execute: jest.Mock;
}

describe('EventCohostInvitesService', () => {
  let service: EventCohostInvitesService;
  let invites: {
    findOne: jest.Mock;
    save: jest.Mock<EventCohostInvite, [EventCohostInvite]>;
    createQueryBuilder: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let insertBuilder: InsertBuilderMock;
  let events: { findOne: jest.Mock; count: jest.Mock };
  let rsvps: { count: jest.Mock };
  let profiles: { findOne: jest.Mock };
  let usersService: { findById: jest.Mock };
  let eventsService: { isOrganizer: jest.Mock; addCohostByUserId: jest.Mock };
  let connectionsService: { mutualCountsByUserIds: jest.Mock };
  let emitter: { emit: jest.Mock };

  beforeEach(async () => {
    insertBuilder = {
      insert: jest.fn(),
      into: jest.fn(),
      values: jest.fn(),
      orIgnore: jest.fn(),
      returning: jest.fn(),
      execute: jest.fn(),
    };
    insertBuilder.insert.mockReturnValue(insertBuilder);
    insertBuilder.into.mockReturnValue(insertBuilder);
    insertBuilder.values.mockReturnValue(insertBuilder);
    insertBuilder.orIgnore.mockReturnValue(insertBuilder);
    insertBuilder.returning.mockReturnValue(insertBuilder);

    invites = {
      findOne: jest.fn(),
      save: jest.fn((invite: EventCohostInvite) => invite),
      createQueryBuilder: jest.fn(() => insertBuilder),
      // `respond` writes the invite status and the cohost roster row in ONE
      // transaction. The stub runs the callback with a manager whose `save`
      // delegates to the same repository mock, so the assertions below are
      // unchanged by the transaction.
      manager: {
        transaction: jest.fn(
          async (runInTransaction: (manager: unknown) => Promise<unknown>) =>
            runInTransaction({
              save: (_entity: unknown, entityLike: EventCohostInvite) =>
                invites.save(entityLike),
            }),
        ),
      },
    };
    events = { findOne: jest.fn(), count: jest.fn().mockResolvedValue(0) };
    rsvps = { count: jest.fn().mockResolvedValue(0) };
    profiles = { findOne: jest.fn() };
    usersService = { findById: jest.fn() };
    eventsService = {
      isOrganizer: jest.fn().mockResolvedValue(true),
      addCohostByUserId: jest.fn().mockResolvedValue(undefined),
    };
    connectionsService = {
      mutualCountsByUserIds: jest.fn().mockResolvedValue(new Map()),
    };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventCohostInvitesService,
        { provide: getRepositoryToken(EventCohostInvite), useValue: invites },
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(EventRsvp), useValue: rsvps },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: UsersService, useValue: usersService },
        { provide: EventsService, useValue: eventsService },
        { provide: ConnectionsService, useValue: connectionsService },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();
    service = module.get(EventCohostInvitesService);
  });

  describe('createInvite', () => {
    it('rejects a non-organizer inviter', async () => {
      events.findOne.mockResolvedValue({ id: 'e1', slug: 'x' });
      eventsService.isOrganizer.mockResolvedValue(false);
      await expect(
        service.createInvite('x', 'not-organizer', {
          inviteeSlug: 'sofia',
          role: 'greeter',
          commitment: 'light',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects inviting yourself', async () => {
      events.findOne.mockResolvedValue({ id: 'e1', slug: 'x' });
      profiles.findOne.mockResolvedValue({ userId: 'host-1', slug: 'sofia' });
      await expect(
        service.createInvite('x', 'host-1', {
          inviteeSlug: 'sofia',
          role: 'greeter',
          commitment: 'light',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an inactive invitee', async () => {
      events.findOne.mockResolvedValue({ id: 'e1', slug: 'x' });
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'sofia' });
      usersService.findById.mockResolvedValue({
        id: 'u2',
        status: UserStatus.Deactivated,
      });
      await expect(
        service.createInvite('x', 'host-1', {
          inviteeSlug: 'sofia',
          role: 'greeter',
          commitment: 'light',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('inserts, emits EVENT_COHOST_INVITED, and returns the pending invite', async () => {
      events.findOne.mockResolvedValue({ id: 'e1', slug: 'pride-picnic' });
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'sofia' });
      usersService.findById.mockResolvedValue({
        id: 'u2',
        status: UserStatus.Active,
      });
      insertBuilder.execute.mockResolvedValue({ raw: [{ id: 'inv-1' }] });

      const result = await service.createInvite('pride-picnic', 'host-1', {
        inviteeSlug: 'sofia',
        role: 'greeter',
        commitment: 'light',
      });

      expect(result).toEqual({
        id: 'inv-1',
        status: EventCohostInviteStatus.Pending,
      });
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_COHOST_INVITED,
        expect.objectContaining({
          eventId: 'e1',
          eventSlug: 'pride-picnic',
          inviteId: 'inv-1',
          inviterId: 'host-1',
          inviteeId: 'u2',
        }),
      );
    });

    it('throws Conflict when the insert is skipped by the unique constraint', async () => {
      events.findOne.mockResolvedValue({ id: 'e1', slug: 'x' });
      profiles.findOne.mockResolvedValue({ userId: 'u2', slug: 'sofia' });
      usersService.findById.mockResolvedValue({
        id: 'u2',
        status: UserStatus.Active,
      });
      insertBuilder.execute.mockResolvedValue({ raw: [] });

      await expect(
        service.createInvite('x', 'host-1', {
          inviteeSlug: 'sofia',
          role: 'greeter',
          commitment: 'light',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('rejects a viewer who is neither inviter nor invitee', async () => {
      invites.findOne.mockResolvedValue({
        id: 'inv-1',
        inviterId: 'host-1',
        inviteeId: 'u2',
      });
      await expect(service.getById('inv-1', 'stranger')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('builds the detail view for the invitee', async () => {
      invites.findOne.mockResolvedValue({
        id: 'inv-1',
        eventId: 'e1',
        inviterId: 'host-1',
        inviteeId: 'u2',
        role: 'greeter',
        commitment: 'light',
        message: null,
        replyByDate: null,
        status: EventCohostInviteStatus.Pending,
        createdAt: new Date('2026-08-01T00:00:00Z'),
      });
      events.findOne.mockResolvedValue({
        id: 'e1',
        slug: 'pride-picnic',
        title: 'Pride Picnic',
        startAt: new Date('2026-09-01T18:00:00Z'),
        endAt: null,
        timezone: 'Europe/Lisbon',
        venue: 'Park',
        isOnline: false,
      });
      profiles.findOne.mockResolvedValue({
        userId: 'host-1',
        slug: 'anika',
        firstName: 'Anika',
        lastName: 'Kovac',
        avatarUrl: null,
      });
      events.count.mockResolvedValue(14);
      rsvps.count.mockResolvedValueOnce(22).mockResolvedValueOnce(4);
      connectionsService.mutualCountsByUserIds.mockResolvedValue(
        new Map([['host-1', 11]]),
      );

      const result = await service.getById('inv-1', 'u2');

      expect(result.inviter.hostedEventsCount).toBe(14);
      expect(result.inviter.mutualConnectionsCount).toBe(11);
      expect(result.event.goingCount).toBe(22);
      expect(result.event.waitlistCount).toBe(4);
      expect(result.status).toBe(EventCohostInviteStatus.Pending);
    });
  });

  describe('respond', () => {
    it('rejects a non-invitee', async () => {
      invites.findOne.mockResolvedValue({
        id: 'inv-1',
        inviteeId: 'u2',
        status: EventCohostInviteStatus.Pending,
      });
      await expect(
        service.respond('inv-1', 'intruder', 'accept'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects a non-pending invite', async () => {
      invites.findOne.mockResolvedValue({
        id: 'inv-1',
        inviteeId: 'u2',
        status: EventCohostInviteStatus.Accepted,
      });
      await expect(
        service.respond('inv-1', 'u2', 'accept'),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('accept adds the cohost via EventsService.addCohostByUserId', async () => {
      invites.findOne.mockResolvedValue({
        id: 'inv-1',
        eventId: 'e1',
        inviteeId: 'u2',
        status: EventCohostInviteStatus.Pending,
      });
      const result = await service.respond('inv-1', 'u2', 'accept');
      expect(result.status).toBe(EventCohostInviteStatus.Accepted);
      expect(eventsService.addCohostByUserId).toHaveBeenCalledWith(
        'e1',
        'u2',
        expect.anything(),
      );
    });

    it('decline does not add a cohost', async () => {
      invites.findOne.mockResolvedValue({
        id: 'inv-1',
        eventId: 'e1',
        inviteeId: 'u2',
        status: EventCohostInviteStatus.Pending,
      });
      const result = await service.respond('inv-1', 'u2', 'decline');
      expect(result.status).toBe(EventCohostInviteStatus.Declined);
      expect(eventsService.addCohostByUserId).not.toHaveBeenCalled();
    });
  });
});
