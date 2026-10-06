import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import { EventAnnouncement } from './entities/event-announcement.entity';
import { EventCohost } from './entities/event-cohost.entity';
import { EventInvite } from './entities/event-invite.entity';
import { EventRsvp } from './entities/event-rsvp.entity';
import { Event } from './entities/event.entity';
import { EventAnnouncementsService } from './event-announcements.service';

const gathering = {
  id: 'event-1',
  slug: 'queer-book-club',
  title: 'Queer book club',
  hostId: 'host-1',
} as Event;

describe('EventAnnouncementsService', () => {
  let service: EventAnnouncementsService;
  let events: { findOne: jest.Mock };
  let cohosts: { exists: jest.Mock };
  let rsvps: { find: jest.Mock; exists: jest.Mock };
  let invites: { find: jest.Mock; exists: jest.Mock };
  let announcements: { create: jest.Mock; save: jest.Mock; find: jest.Mock };
  let profiles: { findOne: jest.Mock; find: jest.Mock };
  let notifications: { createForRecipients: jest.Mock };

  beforeEach(async () => {
    events = { findOne: jest.fn().mockResolvedValue(gathering) };
    cohosts = { exists: jest.fn().mockResolvedValue(false) };
    rsvps = {
      find: jest.fn().mockResolvedValue([{ userId: 'guest-1' }]),
      exists: jest.fn().mockResolvedValue(false),
    };
    invites = {
      find: jest.fn().mockResolvedValue([{ inviteeId: 'guest-2' }]),
      exists: jest.fn().mockResolvedValue(false),
    };
    announcements = {
      create: jest.fn((row: Partial<EventAnnouncement>) => row),
      save: jest.fn((row: Partial<EventAnnouncement>) =>
        Promise.resolve({
          id: 'announcement-1',
          createdAt: new Date('2026-09-29T12:00:00.000Z'),
          ...row,
        } as EventAnnouncement),
      ),
      find: jest.fn().mockResolvedValue([]),
    };
    profiles = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    };
    notifications = {
      createForRecipients: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventAnnouncementsService,
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(EventCohost), useValue: cohosts },
        { provide: getRepositoryToken(EventRsvp), useValue: rsvps },
        { provide: getRepositoryToken(EventInvite), useValue: invites },
        {
          provide: getRepositoryToken(EventAnnouncement),
          useValue: announcements,
        },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(EventAnnouncementsService);
  });

  describe('create', () => {
    it('writes the event source, slug and gathering title the bell deep-links and names from', async () => {
      await service.create('queer-book-club', 'host-1', 'We moved upstairs.');

      expect(notifications.createForRecipients).toHaveBeenCalledWith(
        ['guest-1', 'guest-2'],
        NotificationType.EventAnnouncement,
        expect.objectContaining({
          source: 'event',
          eventSlug: 'queer-book-club',
          title: 'Queer book club',
          announcementId: 'announcement-1',
          actorId: 'host-1',
        }),
        'host-1',
      );
    });

    it('sends nothing when the host is the only person with a stake', async () => {
      rsvps.find.mockResolvedValue([{ userId: 'host-1' }]);
      invites.find.mockResolvedValue([]);

      await service.create('queer-book-club', 'host-1', 'We moved upstairs.');

      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    });
  });

  // `recipientCount` is the fan-out to every live RSVP, so it follows the
  // host's "Show attendee count" toggle the way the detail's copy does: null
  // for a reader who is not an organiser when the count is hidden. The host
  // and co-hosts keep the figure.
  describe('list honours a hidden attendee count', () => {
    const sentAnnouncement = {
      id: 'announcement-1',
      eventId: 'event-1',
      authorId: 'host-1',
      body: 'We moved upstairs.',
      recipientCount: 12,
      createdAt: new Date('2026-09-29T12:00:00.000Z'),
    } as EventAnnouncement;

    beforeEach(() => {
      events.findOne.mockResolvedValue({
        ...gathering,
        showAttendeeCount: false,
      });
      announcements.find.mockResolvedValue([sentAnnouncement]);
    });

    it('withholds the fan-out size from an attendee who is not an organiser', async () => {
      rsvps.exists.mockResolvedValue(true);

      const rows = await service.list('queer-book-club', 'guest-1');

      expect(rows).toHaveLength(1);
      expect(rows[0]!.recipientCount).toBeNull();
      expect(rows[0]!.body).toBe('We moved upstairs.');
    });

    it('gives the host the fan-out size', async () => {
      const rows = await service.list('queer-book-club', 'host-1');

      expect(rows[0]!.recipientCount).toBe(12);
    });

    it('gives a co-host the fan-out size, settled by one organiser check', async () => {
      cohosts.exists.mockResolvedValue(true);
      announcements.find.mockResolvedValue([
        sentAnnouncement,
        { ...sentAnnouncement, id: 'announcement-2', recipientCount: 9 },
      ]);

      const rows = await service.list('queer-book-club', 'cohost-1');

      expect(rows.map((row) => row.recipientCount)).toEqual([12, 9]);
      expect(cohosts.exists).toHaveBeenCalledTimes(1);
    });

    it('gives an attendee the fan-out size when the count is shown', async () => {
      events.findOne.mockResolvedValue({
        ...gathering,
        showAttendeeCount: true,
      });
      rsvps.exists.mockResolvedValue(true);

      const rows = await service.list('queer-book-club', 'guest-1');

      expect(rows[0]!.recipientCount).toBe(12);
    });
  });
});
