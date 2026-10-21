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
import { AcceptInviteDetailsDto } from './dto/accept-invite-details.dto';
import {
  EventInvite,
  EventInviteSource,
  EventInviteStatus,
} from './entities/event-invite.entity';
import { RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus } from './entities/event.entity';
import { EventInvitesService } from './event-invites.service';
import { EventsService } from './events.service';
import { EVENT_INVITE_ACCEPTED, EVENT_INVITED } from './event.events';
import { RsvpService } from './rsvp.service';

interface InsertBuilderMock {
  insert: jest.Mock;
  into: jest.Mock;
  values: jest.Mock;
  orIgnore: jest.Mock;
  returning: jest.Mock;
  execute: jest.Mock;
}

interface UpdateBuilderMock {
  update: jest.Mock;
  set: jest.Mock;
  where: jest.Mock;
  returning: jest.Mock;
  execute: jest.Mock;
}

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

const detailsWithVisibility = (
  visibility: AcceptInviteDetailsDto['visibility'],
): AcceptInviteDetailsDto => ({ visibility });

describe('EventInvitesService', () => {
  let service: EventInvitesService;
  let invites: {
    findOne: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let insertBuilder: InsertBuilderMock;
  let updateBuilder: UpdateBuilderMock;
  let events: { findOne: jest.Mock; find: jest.Mock };
  let profiles: { find: jest.Mock };
  let users: { find: jest.Mock };
  let eventsService: { isOrganizer: jest.Mock };
  let emitter: { emit: jest.Mock };
  let rsvpService: { acceptInviteRsvp: jest.Mock };

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

    updateBuilder = {
      update: jest.fn(),
      set: jest.fn(),
      where: jest.fn(),
      returning: jest.fn(),
      execute: jest.fn().mockResolvedValue({ raw: [] }),
    };
    updateBuilder.update.mockReturnValue(updateBuilder);
    updateBuilder.set.mockReturnValue(updateBuilder);
    updateBuilder.where.mockReturnValue(updateBuilder);
    updateBuilder.returning.mockReturnValue(updateBuilder);

    invites = {
      findOne: jest.fn(),
      save: jest.fn((invite: unknown) => invite),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => ({
        insert: insertBuilder.insert,
        update: updateBuilder.update,
      })),
    };
    events = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    users = { find: jest.fn().mockResolvedValue([]) };
    eventsService = { isOrganizer: jest.fn().mockResolvedValue(true) };
    emitter = { emit: jest.fn() };
    rsvpService = { acceptInviteRsvp: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventInvitesService,
        { provide: getRepositoryToken(EventInvite), useValue: invites },
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: EventsService, useValue: eventsService },
        { provide: EventEmitter2, useValue: emitter },
        { provide: RsvpService, useValue: rsvpService },
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
    invites.find.mockResolvedValue([
      { id: 'i0', inviteeId: 'b', status: EventInviteStatus.Pending },
    ]);

    const result = await service.createInvites('x', 'inviter', ['a', 'b']);

    expect(result).toEqual({ created: 1, alreadyInvited: ['b'] });
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

    const firstCallArguments = insertBuilder.values.mock.calls[0] as unknown[];
    const inserted = firstCallArguments[0] as Array<{ inviteeId: string }>;
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.inviteeId).toBe('a');
  });

  it('createInvites short-circuits when no active invitees remain', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      status: EventStatus.Published,
    });
    profiles.find.mockResolvedValue([{ userId: 'b', slug: 'b' }]);
    users.find.mockResolvedValue([]); // none active

    const result = await service.createInvites('x', 'inviter', ['b']);

    expect(result).toEqual({ created: 0, alreadyInvited: [] });
    expect(insertBuilder.execute).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it('createInvites revives declined, withdrawn and host_declined rows as pending host invites and notifies them', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      slug: 'party',
      status: EventStatus.Published,
    });
    profiles.find.mockResolvedValue([
      { userId: 'u-declined', slug: 'dee' },
      { userId: 'u-withdrawn', slug: 'wes' },
      { userId: 'u-host-declined', slug: 'hal' },
    ]);
    users.find.mockResolvedValue([
      { id: 'u-declined' },
      { id: 'u-withdrawn' },
      { id: 'u-host-declined' },
    ]);
    // Every invitee already has a row, so the insert returns nothing.
    insertBuilder.execute.mockResolvedValue({ raw: [] });
    invites.find.mockResolvedValue([
      { id: 'i1', inviteeId: 'u-declined', status: EventInviteStatus.Declined },
      {
        id: 'i2',
        inviteeId: 'u-withdrawn',
        status: EventInviteStatus.Withdrawn,
      },
      {
        id: 'i3',
        inviteeId: 'u-host-declined',
        status: EventInviteStatus.HostDeclined,
      },
    ]);
    updateBuilder.execute.mockResolvedValue({
      raw: [
        { id: 'i1', invitee_id: 'u-declined' },
        { id: 'i2', invitee_id: 'u-withdrawn' },
        { id: 'i3', invitee_id: 'u-host-declined' },
      ],
    });

    const result = await service.createInvites('party', 'host', [
      'dee',
      'wes',
      'hal',
    ]);

    expect(result).toEqual({ created: 3, alreadyInvited: [] });
    // A revived row takes a fresh createdAt, so it sorts as a new invite.
    expect(updateBuilder.set).toHaveBeenCalledWith({
      status: EventInviteStatus.Pending,
      inviterId: 'host',
      source: EventInviteSource.Host,
      createdAt: expect.any(Date) as unknown,
    });
    const whereArguments = updateBuilder.where.mock.calls[0] as unknown[];
    expect(whereArguments[1]).toEqual(
      expect.objectContaining({ revivableIds: ['i1', 'i2', 'i3'] }),
    );
    expect(emitter.emit).toHaveBeenCalledTimes(3);
    for (const [inviteId, inviteeId] of [
      ['i1', 'u-declined'],
      ['i2', 'u-withdrawn'],
      ['i3', 'u-host-declined'],
    ]) {
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_INVITED,
        expect.objectContaining({
          eventId: 'e1',
          eventSlug: 'party',
          inviteId,
          inviterId: 'host',
          inviteeId,
        }),
      );
    }
  });

  it.each([EventInviteStatus.Pending, EventInviteStatus.AwaitingHost])(
    'createInvites reports open rows in alreadyInvited (%s)',
    async (existingStatus) => {
      events.findOne.mockResolvedValue({
        id: 'e1',
        slug: 'party',
        status: EventStatus.Published,
      });
      profiles.find.mockResolvedValue([
        { userId: 'u-new', slug: 'nia' },
        { userId: 'u-ana', slug: 'ana' },
      ]);
      users.find.mockResolvedValue([{ id: 'u-new' }, { id: 'u-ana' }]);
      insertBuilder.execute.mockResolvedValue({
        raw: [{ id: 'i-new', invitee_id: 'u-new' }],
      });
      invites.find.mockResolvedValue([
        { id: 'i-ana', inviteeId: 'u-ana', status: existingStatus },
      ]);

      const result = await service.createInvites('party', 'host', [
        'nia',
        'ana',
      ]);

      expect(result).toEqual({ created: 1, alreadyInvited: ['ana'] });
      expect(updateBuilder.update).not.toHaveBeenCalled();
      expect(emitter.emit).toHaveBeenCalledTimes(1);
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_INVITED,
        expect.objectContaining({ inviteId: 'i-new', inviteeId: 'u-new' }),
      );
    },
  );

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

  describe('createInvites on an accepted invite', () => {
    beforeEach(() => {
      events.findOne.mockResolvedValue({
        id: 'e1',
        slug: 'party',
        status: EventStatus.Published,
      });
      profiles.find.mockResolvedValue([{ userId: 'u-ana', slug: 'ana' }]);
      users.find.mockResolvedValue([{ id: 'u-ana' }]);
      insertBuilder.execute.mockResolvedValue({ raw: [] });
      invites.find.mockResolvedValue([
        { id: 'i-ana', inviteeId: 'u-ana', status: EventInviteStatus.Accepted },
      ]);
    });

    it('createInvites revives an accepted invite whose invitee holds no live RSVP', async () => {
      updateBuilder.execute.mockResolvedValue({
        raw: [{ id: 'i-ana', invitee_id: 'u-ana' }],
      });

      const result = await service.createInvites('party', 'host', ['ana']);

      expect(result).toEqual({ created: 1, alreadyInvited: [] });
      const [condition, parameters] = updateBuilder.where.mock
        .calls[0] as unknown[];
      // The live-RSVP guard runs inside the UPDATE, so an invitee who RSVPs
      // between the read and the write keeps their accepted invite.
      expect(condition).toContain('status = :acceptedStatus AND NOT EXISTS');
      expect(condition).toContain('FROM event_rsvps r');
      expect(condition).toContain('r.status <> :cancelledStatus');
      expect(parameters).toEqual(
        expect.objectContaining({
          revivableIds: ['i-ana'],
          acceptedStatus: EventInviteStatus.Accepted,
          cancelledStatus: RsvpStatus.Cancelled,
        }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        EVENT_INVITED,
        expect.objectContaining({ inviteId: 'i-ana', inviteeId: 'u-ana' }),
      );
    });

    it('createInvites reports an accepted invite with a live RSVP as already invited', async () => {
      // The UPDATE's live-RSVP guard leaves the row alone.
      updateBuilder.execute.mockResolvedValue({ raw: [] });

      const result = await service.createInvites('party', 'host', ['ana']);

      expect(result).toEqual({ created: 0, alreadyInvited: ['ana'] });
      expect(emitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('respondInvite accept', () => {
    const pendingInvite = (
      source: EventInviteSource = EventInviteSource.Host,
    ) => ({
      id: 'i1',
      eventId: 'e1',
      inviterId: 'inviter',
      inviteeId: 'u1',
      status: EventInviteStatus.Pending,
      source,
    });
    const openEvent = () => ({
      id: 'e1',
      slug: 'party',
      title: 'Party',
      status: EventStatus.Published,
      startAt: new Date(Date.now() + 10 * DAY_IN_MILLISECONDS),
      endAt: null,
      rsvpCutoff: null,
    });

    beforeEach(() => {
      events.findOne.mockResolvedValue(openEvent());
      rsvpService.acceptInviteRsvp.mockResolvedValue({
        status: RsvpStatus.Going,
        waitlistPosition: null,
      });
    });

    it('respondInvite accept without details is a 400', async () => {
      invites.findOne.mockResolvedValue(pendingInvite());
      const attempt = service.respondInvite('i1', 'u1', 'accept');
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow('Choose who can see you are going');
      expect(rsvpService.acceptInviteRsvp).not.toHaveBeenCalled();
      expect(invites.save).not.toHaveBeenCalled();
    });

    it('respondInvite accept runs acceptInviteRsvp and returns its RSVP', async () => {
      invites.findOne.mockResolvedValue(pendingInvite());
      rsvpService.acceptInviteRsvp.mockResolvedValue({
        status: RsvpStatus.Waitlisted,
        waitlistPosition: 4,
      });
      const details = detailsWithVisibility('everyone');

      const result = await service.respondInvite('i1', 'u1', 'accept', details);

      expect(result).toEqual({
        id: 'i1',
        status: EventInviteStatus.Accepted,
        rsvp: { status: RsvpStatus.Waitlisted, waitlistPosition: 4 },
      });
      expect(rsvpService.acceptInviteRsvp).toHaveBeenCalledWith(
        'party',
        'u1',
        'i1',
        details,
      );
      expect(invites.save).not.toHaveBeenCalled();
    });

    it('respondInvite accept propagates a refused RSVP and leaves the invite pending', async () => {
      const invite = pendingInvite();
      invites.findOne.mockResolvedValue(invite);
      rsvpService.acceptInviteRsvp.mockRejectedValue(
        new BadRequestException('This event is full'),
      );

      const attempt = service.respondInvite(
        'i1',
        'u1',
        'accept',
        detailsWithVisibility('everyone'),
      );

      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow('This event is full');
      expect(invites.save).not.toHaveBeenCalled();
      expect(invite.status).toBe(EventInviteStatus.Pending);
      expect(emitter.emit).not.toHaveBeenCalled();
    });

    it('respondInvite on a withdrawn invite is a 409', async () => {
      invites.findOne.mockResolvedValue({
        ...pendingInvite(EventInviteSource.Member),
        status: EventInviteStatus.Withdrawn,
      });

      await expect(
        service.respondInvite(
          'i1',
          'u1',
          'accept',
          detailsWithVisibility('everyone'),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(rsvpService.acceptInviteRsvp).not.toHaveBeenCalled();
      expect(invites.save).not.toHaveBeenCalled();
    });

    // The inviter notice (spec decision 7: everyone, connections while still
    // connected, never justMe) is sent by RsvpService after its transaction
    // commits, the same rule a direct RSVP follows. See rsvp.service.spec.
    it.each([
      ['everyone on a member invite', EventInviteSource.Member, 'everyone'],
      [
        'connections on a member invite',
        EventInviteSource.Member,
        'connections',
      ],
      ['justMe on a member invite', EventInviteSource.Member, 'justMe'],
      ['a host invite', EventInviteSource.Host, 'everyone'],
    ] as const)(
      'respondInvite leaves EVENT_INVITE_ACCEPTED to RsvpService for %s',
      async (_label, source, visibility) => {
        invites.findOne.mockResolvedValue(pendingInvite(source));

        await service.respondInvite(
          'i1',
          'u1',
          'accept',
          detailsWithVisibility(visibility),
        );

        expect(emitter.emit).not.toHaveBeenCalledWith(
          EVENT_INVITE_ACCEPTED,
          expect.anything(),
        );
      },
    );
  });

  // The host's RSVP cutoff (create-gathering v2). Accepting is the first half
  // of an RSVP, so past the cutoff it is refused with the same 400 the RSVP
  // itself would give. Declining clears a dead invite and stays allowed.
  describe('RSVP cutoff', () => {
    const HOUR_IN_MILLISECONDS = 60 * 60 * 1000;
    const pendingInvite = () => ({
      id: 'i1',
      eventId: 'e1',
      inviteeId: 'u1',
      status: EventInviteStatus.Pending,
    });
    const eventStartingIn = (milliseconds: number) => ({
      id: 'e1',
      status: EventStatus.Published,
      startAt: new Date(Date.now() + milliseconds),
      endAt: null,
      rsvpCutoff: 'day-before' as const,
    });

    it('refuses to accept once the cutoff has passed', async () => {
      invites.findOne.mockResolvedValue(pendingInvite());
      events.findOne.mockResolvedValue(
        eventStartingIn(2 * HOUR_IN_MILLISECONDS),
      );
      const attempt = service.respondInvite('i1', 'u1', 'accept');
      await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
      await expect(attempt).rejects.toThrow('RSVPs for this event have closed');
      expect(invites.save).not.toHaveBeenCalled();
    });

    it('still lets the invitee decline past the cutoff', async () => {
      invites.findOne.mockResolvedValue(pendingInvite());
      events.findOne.mockResolvedValue(
        eventStartingIn(2 * HOUR_IN_MILLISECONDS),
      );
      const result = await service.respondInvite('i1', 'u1', 'decline');
      expect(result.status).toBe(EventInviteStatus.Declined);
    });

    it('accepts while the cutoff is still ahead', async () => {
      invites.findOne.mockResolvedValue(pendingInvite());
      events.findOne.mockResolvedValue(
        eventStartingIn(72 * HOUR_IN_MILLISECONDS),
      );
      rsvpService.acceptInviteRsvp.mockResolvedValue({
        status: RsvpStatus.Going,
        waitlistPosition: null,
      });
      const result = await service.respondInvite(
        'i1',
        'u1',
        'accept',
        detailsWithVisibility('everyone'),
      );
      expect(result.status).toBe(EventInviteStatus.Accepted);
    });
  });

  it('respondInvite decline returns only { id, status, rsvp: null } without raw entity columns', async () => {
    invites.findOne.mockResolvedValue({
      id: 'i1',
      eventId: 'e1',
      inviterId: 'host',
      inviteeId: 'u1',
      status: EventInviteStatus.Pending,
    });
    const result = await service.respondInvite('i1', 'u1', 'decline');
    expect(result).toEqual({
      id: 'i1',
      status: EventInviteStatus.Declined,
      rsvp: null,
    });
    expect(result).not.toHaveProperty('inviterId');
    expect(result).not.toHaveProperty('inviteeId');
    expect(result).not.toHaveProperty('eventId');
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
    expect(result[0]?.id).toBe('i1');
    expect(result[0]?.event?.slug).toBe('party');
    expect(result[0]?.inviter?.slug).toBe('host-slug');
  });
});
