import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { EventInvite, EventInviteStatus } from './entities/event-invite.entity';
import { Event, EventStatus } from './entities/event.entity';
import { EventInvitesService } from './event-invites.service';
import { EventsService } from './events.service';
import { EVENT_INVITED } from './event.events';

interface InsertBuilderMock {
  insert: jest.Mock;
  into: jest.Mock;
  values: jest.Mock;
  orIgnore: jest.Mock;
  returning: jest.Mock;
  execute: jest.Mock;
}

describe('EventInvitesService', () => {
  let service: EventInvitesService;
  let invites: {
    findOne: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let insertBuilder: InsertBuilderMock;
  let events: { findOne: jest.Mock; find: jest.Mock };
  let profiles: { find: jest.Mock };
  let users: { find: jest.Mock };
  let eventsService: { isOrganizer: jest.Mock };
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
      save: jest.fn(async (i) => i),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => insertBuilder),
    };
    events = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    users = { find: jest.fn().mockResolvedValue([]) };
    eventsService = { isOrganizer: jest.fn().mockResolvedValue(true) };
    emitter = { emit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventInvitesService,
        { provide: getRepositoryToken(EventInvite), useValue: invites },
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: EventsService, useValue: eventsService },
        { provide: EventEmitter2, useValue: emitter },
      ],
    }).compile();
    service = module.get(EventInvitesService);
  });

  it('createInvites rejects a non-published event', async () => {
    events.findOne.mockResolvedValue({ id: 'e1', status: EventStatus.Draft });
    await expect(
      service.createInvites('x', 'inviter', ['a']),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('createInvites only inserts (and notifies) actually-new rows', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
    });
    profiles.find.mockResolvedValue([
      { userId: 'a', slug: 'a' },
      { userId: 'b', slug: 'b' },
    ]);
    users.find.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    // Only 'a' was actually inserted; 'b' hit the unique constraint and was
    // skipped by ON CONFLICT DO NOTHING, so RETURNING omits it.
    insertBuilder.execute.mockResolvedValue({
      raw: [{ id: 'i1', invitee_id: 'a' }],
    });

    const result = await service.createInvites('x', 'inviter', ['a', 'b']);

    expect(result).toEqual({ created: 1 });
    expect(emitter.emit).toHaveBeenCalledTimes(1);
    expect(emitter.emit).toHaveBeenCalledWith(
      EVENT_INVITED,
      expect.objectContaining({
        eventId: 'e1',
        inviteId: 'i1',
        inviteeId: 'a',
        inviterId: 'inviter',
      }),
    );
  });

  it('createInvites filters out non-active invitees before inserting', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
    });
    profiles.find.mockResolvedValue([
      { userId: 'a', slug: 'a' },
      { userId: 'b', slug: 'b' },
    ]);
    users.find.mockResolvedValue([{ id: 'a' }]); // 'b' is not active
    insertBuilder.execute.mockResolvedValue({
      raw: [{ id: 'i1', invitee_id: 'a' }],
    });

    await service.createInvites('x', 'inviter', ['a', 'b']);

    const inserted = insertBuilder.values.mock.calls[0][0] as Array<{
      inviteeId: string;
    }>;
    expect(inserted).toHaveLength(1);
    expect(inserted[0].inviteeId).toBe('a');
  });

  it('createInvites short-circuits when no active invitees remain', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
    });
    profiles.find.mockResolvedValue([{ userId: 'b', slug: 'b' }]);
    users.find.mockResolvedValue([]); // none active

    const result = await service.createInvites('x', 'inviter', ['b']);

    expect(result).toEqual({ created: 0 });
    expect(insertBuilder.execute).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('respondInvite rejects a non-invitee', async () => {
    invites.findOne.mockResolvedValue({
      id: 'i1',
      inviteeId: 'someone',
      status: EventInviteStatus.Pending,
    });
    await expect(
      service.respondInvite('i1', 'intruder', 'accept'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('respondInvite rejects a non-pending invite', async () => {
    invites.findOne.mockResolvedValue({
      id: 'i1',
      inviteeId: 'u1',
      status: EventInviteStatus.Accepted,
    });
    await expect(
      service.respondInvite('i1', 'u1', 'accept'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('respondInvite accepts a pending invite for its invitee', async () => {
    invites.findOne.mockResolvedValue({
      id: 'i1',
      inviteeId: 'u1',
      status: EventInviteStatus.Pending,
    });
    const result = await service.respondInvite('i1', 'u1', 'accept');
    expect(result.status).toBe(EventInviteStatus.Accepted);
  });

  it('listMyPendingInvites maps invite id, event and inviter', async () => {
    invites.find.mockResolvedValue([
      {
        id: 'i1',
        eventId: 'e1',
        inviterId: 'host',
        status: EventInviteStatus.Pending,
        createdAt: new Date('2026-07-01T00:00:00Z'),
      },
    ]);
    events.find.mockResolvedValue([
      { id: 'e1', slug: 'party', title: 'Party' },
    ]);
    profiles.find.mockResolvedValue([
      { userId: 'host', slug: 'host-slug', firstName: 'H', lastName: 'Ost' },
    ]);

    const result = await service.listMyPendingInvites('u1');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('i1');
    expect(result[0].event?.slug).toBe('party');
    expect(result[0].inviter?.slug).toBe('host-slug');
  });
});
