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
  let rsvps: { find: jest.Mock };
  let invites: { find: jest.Mock };
  let announcements: { create: jest.Mock; save: jest.Mock };
  let profiles: { findOne: jest.Mock };
  let notifications: { createForRecipients: jest.Mock };

  beforeEach(async () => {
    events = { findOne: jest.fn().mockResolvedValue(gathering) };
    cohosts = { exists: jest.fn().mockResolvedValue(false) };
    rsvps = {
      find: jest.fn().mockResolvedValue([{ userId: 'guest-1' }]),
    };
    invites = {
      find: jest.fn().mockResolvedValue([{ inviteeId: 'guest-2' }]),
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
    };
    profiles = { findOne: jest.fn().mockResolvedValue(null) };
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
});
