import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import { EventCohost } from './entities/event-cohost.entity';
import { EventInvite } from './entities/event-invite.entity';
import { EventRsvp } from './entities/event-rsvp.entity';
import {
  Event,
  EventStatus,
  EventVisibility,
} from './entities/event.entity';
import { EventsService } from './events.service';
import { RsvpService } from './rsvp.service';

describe('EventsService', () => {
  let service: EventsService;
  let events: { findOne: jest.Mock; save: jest.Mock; exists: jest.Mock };
  let cohosts: { exists: jest.Mock; find: jest.Mock };
  let rsvps: {
    count: jest.Mock;
    findOne: jest.Mock;
    exists: jest.Mock;
    find: jest.Mock;
  };
  let invites: { exists: jest.Mock };
  let rsvpService: { reconcileWaitlist: jest.Mock };
  let notifications: { createForRecipients: jest.Mock };

  beforeEach(async () => {
    events = {
      findOne: jest.fn(),
      save: jest.fn(async (e) => e),
      exists: jest.fn().mockResolvedValue(false),
    };
    cohosts = {
      exists: jest.fn().mockResolvedValue(false),
      find: jest.fn().mockResolvedValue([]),
    };
    rsvps = {
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
      exists: jest.fn().mockResolvedValue(false),
      find: jest.fn().mockResolvedValue([]),
    };
    invites = { exists: jest.fn().mockResolvedValue(false) };
    rsvpService = { reconcileWaitlist: jest.fn().mockResolvedValue(undefined) };
    notifications = {
      createForRecipients: jest.fn().mockResolvedValue(undefined),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(EventCohost), useValue: cohosts },
        { provide: getRepositoryToken(EventRsvp), useValue: rsvps },
        { provide: getRepositoryToken(EventInvite), useValue: invites },
        {
          provide: getRepositoryToken(Profile),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: UsersService, useValue: { findById: jest.fn() } },
        { provide: RsvpService, useValue: rsvpService },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(EventsService);
  });

  it('isOrganizer is true for the host', async () => {
    events.findOne.mockResolvedValue({ id: 'e1', hostId: 'u1' });
    await expect(service.isOrganizer('e1', 'u1')).resolves.toBe(true);
  });

  it('isOrganizer falls back to the co-host check', async () => {
    events.findOne.mockResolvedValue({ id: 'e1', hostId: 'host' });
    cohosts.exists.mockResolvedValue(true);
    await expect(service.isOrganizer('e1', 'u2')).resolves.toBe(true);
  });

  it('update rejects a non-organizer', async () => {
    events.findOne.mockResolvedValue({ id: 'e1', slug: 'x', hostId: 'host' });
    cohosts.exists.mockResolvedValue(false);
    await expect(
      service.update('x', 'intruder', { title: 'new' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('getBySlug 404s an unknown slug', async () => {
    events.findOne.mockResolvedValue(null);
    await expect(service.getBySlug('nope', 'u1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('getBySlug hides a draft from non-organizers (404)', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      slug: 'd',
      hostId: 'host',
      status: EventStatus.Draft,
      visibility: EventVisibility.Public,
    });
    cohosts.exists.mockResolvedValue(false);
    await expect(service.getBySlug('d', 'viewer')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('getBySlug shows a draft to its organizer', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      slug: 'd',
      hostId: 'host',
      status: EventStatus.Draft,
      visibility: EventVisibility.Public,
    });
    const detail = await service.getBySlug('d', 'host');
    expect(detail.isOrganizer).toBe(true);
  });

  it('getBySlug hides an invite_only event from a stranger (404)', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      slug: 'io',
      hostId: 'host',
      status: EventStatus.Published,
      visibility: EventVisibility.InviteOnly,
    });
    cohosts.exists.mockResolvedValue(false);
    invites.exists.mockResolvedValue(false);
    rsvps.exists.mockResolvedValue(false);
    await expect(service.getBySlug('io', 'stranger')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('getBySlug shows an invite_only event to an invitee', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      slug: 'io',
      hostId: 'host',
      status: EventStatus.Published,
      visibility: EventVisibility.InviteOnly,
    });
    cohosts.exists.mockResolvedValue(false);
    invites.exists.mockResolvedValue(true);
    const detail = await service.getBySlug('io', 'invited-user');
    expect(detail.slug).toBe('io');
  });

  it('update rejects reopening a cancelled event (409)', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      slug: 'x',
      hostId: 'u1',
      status: EventStatus.Cancelled,
      startAt: new Date(Date.now() + 3_600_000),
      endAt: null,
      capacity: null,
    });
    await expect(
      service.update('x', 'u1', { status: EventStatus.Published }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('update reconciles the waitlist when capacity grows', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      slug: 'x',
      hostId: 'u1',
      status: EventStatus.Published,
      visibility: EventVisibility.Public,
      startAt: new Date(Date.now() + 3_600_000),
      endAt: null,
      capacity: 2,
    });
    await service.update('x', 'u1', { capacity: 5 });
    expect(rsvpService.reconcileWaitlist).toHaveBeenCalledWith('x');
  });

  it('update does not reconcile when capacity shrinks', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      slug: 'x',
      hostId: 'u1',
      status: EventStatus.Published,
      visibility: EventVisibility.Public,
      startAt: new Date(Date.now() + 3_600_000),
      endAt: null,
      capacity: 5,
    });
    await service.update('x', 'u1', { capacity: 2 });
    expect(rsvpService.reconcileWaitlist).not.toHaveBeenCalled();
  });

  it('cancel notifies going/maybe/waitlisted RSVPs, excluding the organizer', async () => {
    events.findOne.mockResolvedValue({
      id: 'e1',
      slug: 'party',
      hostId: 'host',
      status: EventStatus.Published,
      startAt: new Date('2030-01-01T00:00:00.000Z'),
      title: 'Party',
    });
    rsvps.find.mockResolvedValue([
      { userId: 'a' },
      { userId: 'b' },
      { userId: 'host' }, // organizer's own RSVP — must be excluded
    ]);
    await service.cancel('party', 'host');
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['a', 'b'],
      NotificationType.EventCancelled,
      expect.objectContaining({ eventId: 'e1' }),
    );
  });
});
