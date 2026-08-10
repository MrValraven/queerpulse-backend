import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { PushPayload, PushService } from '../push/push.service';
import { EventRsvp } from './entities/event-rsvp.entity';
import { MemberEventReminderPreferences } from './entities/member-event-reminder-preferences.entity';
import { Event } from './entities/event.entity';
import { EventRemindersService } from './event-reminders.service';

describe('EventRemindersService', () => {
  let service: EventRemindersService;
  let events: { find: jest.Mock; update: jest.Mock };
  let rsvps: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let claimQueryBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    returning: jest.Mock;
    execute: jest.Mock;
  };
  let preferences: { find: jest.Mock };
  let notifications: { createForRecipients: jest.Mock };
  let push: { sendToUsers: jest.Mock };

  beforeEach(async () => {
    events = {
      find: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    // The claim is now ONE batched `createQueryBuilder().update(...)` instead
    // of one repository-level `.update()` per RSVP — see
    // `EventRemindersService.remindForEvent`. `execute` defaults to claiming
    // nobody; individual tests override its resolved value with the rows
    // RETURNING would hand back.
    claimQueryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      returning: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ raw: [] }),
    };
    rsvps = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn().mockReturnValue(claimQueryBuilder),
    };
    preferences = { find: jest.fn().mockResolvedValue([]) };
    notifications = { createForRecipients: jest.fn() };
    push = { sendToUsers: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventRemindersService,
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(EventRsvp), useValue: rsvps },
        {
          provide: getRepositoryToken(MemberEventReminderPreferences),
          useValue: preferences,
        },
        { provide: NotificationsService, useValue: notifications },
        { provide: PushService, useValue: push },
      ],
    }).compile();
    service = module.get(EventRemindersService);
  });

  it('claims every due RSVP in one batched UPDATE before notifying (stamp-before-send)', async () => {
    const event = {
      id: 'e1',
      slug: 'x',
      startAt: new Date(),
      reminderSentAt: null,
    };
    events.find.mockResolvedValue([event]);
    rsvps.find.mockResolvedValue([
      { id: 'r1', userId: 'a' },
      { id: 'r2', userId: 'b' },
    ]);
    // RETURNING hands back exactly the rows this statement claimed.
    claimQueryBuilder.execute.mockResolvedValue({
      raw: [
        { id: 'r1', user_id: 'a' },
        { id: 'r2', user_id: 'b' },
      ],
    });

    await service.sendDueReminders();

    // ONE claim UPDATE for both due attendees, not one per attendee.
    expect(rsvps.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(claimQueryBuilder.set).toHaveBeenCalledWith(
      expect.objectContaining({ reminderSentAt: expect.any(Date) as unknown }),
    );
    expect(claimQueryBuilder.where).toHaveBeenCalledWith(
      'id IN (:...dueRsvpIds)',
      { dueRsvpIds: ['r1', 'r2'] },
    );
    expect(claimQueryBuilder.andWhere).toHaveBeenCalledWith(
      'reminder_sent_at IS NULL',
    );
    // ...and only then does the fan-out happen (at-most-once ordering).
    expect(claimQueryBuilder.execute.mock.invocationCallOrder[0]).toBeLessThan(
      notifications.createForRecipients.mock.invocationCallOrder[0]!,
    );
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['a', 'b'],
      NotificationType.EventReminder,
      expect.objectContaining({ eventId: 'e1' }),
    );
  });

  it('excludes a due RSVP that RETURNING reports as already claimed by another tick', async () => {
    const event = {
      id: 'e1',
      slug: 'x',
      startAt: new Date(),
      reminderSentAt: null,
    };
    events.find.mockResolvedValue([event]);
    rsvps.find.mockResolvedValue([
      { id: 'r1', userId: 'a' },
      { id: 'r2', userId: 'b' },
    ]);
    // Both were due, but an overlapping tick already claimed 'r2' — RETURNING
    // only reports the row THIS statement actually flipped.
    claimQueryBuilder.execute.mockResolvedValue({
      raw: [{ id: 'r1', user_id: 'a' }],
    });

    await service.sendDueReminders();

    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['a'],
      NotificationType.EventReminder,
      expect.objectContaining({ eventId: 'e1' }),
    );
  });

  it('skips the fan-out when the claim is lost (affected 0)', async () => {
    events.find.mockResolvedValue([
      { id: 'e1', slug: 'x', startAt: new Date(), reminderSentAt: null },
    ]);
    events.update.mockResolvedValue({ affected: 0 }); // another worker won

    await service.sendDueReminders();

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('does nothing when no events are due', async () => {
    events.find.mockResolvedValue([]);
    await service.sendDueReminders();
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
    expect(events.update).not.toHaveBeenCalled();
  });

  // Drives one due attendee through the sweep so `pushReminders` runs with a
  // real reminded-user list, then asserts the rich push payload it built.
  function primeOneDueReminder(event: Record<string, unknown>): void {
    events.find.mockResolvedValue([event]);
    rsvps.find.mockResolvedValue([{ id: 'r1', userId: 'u1' }]);
    claimQueryBuilder.execute.mockResolvedValue({
      raw: [{ id: 'r1', user_id: 'u1' }],
    });
  }

  it('sends a rich reminder push: cover image, details action, requireInteraction, vibrate', async () => {
    const startAt = new Date();
    primeOneDueReminder({
      id: 'e1',
      slug: 'pride-picnic',
      title: 'Pride Picnic',
      startAt,
      reminderSentAt: null,
      // An absolute public https cover — fetchable by a push client, so it
      // becomes the notification image.
      coverImageUrl: 'https://images.example.com/pride-picnic.jpg',
    });

    await service.sendDueReminders();

    expect(push.sendToUsers).toHaveBeenCalledWith(
      ['u1'],
      expect.objectContaining({
        title: 'Pride Picnic',
        image: 'https://images.example.com/pride-picnic.jpg',
        actions: [{ action: 'view', title: 'Details' }],
        requireInteraction: true,
        vibrate: [100, 50, 100],
        data: { url: '/events/pride-picnic' },
        l10n: { bodyKey: 'push:event.reminder.body' },
        // The event's own start time, not delivery time.
        timestamp: startAt.getTime(),
      }),
    );
  });

  it('omits image when the event has no cover', async () => {
    primeOneDueReminder({
      id: 'e2',
      slug: 'book-club',
      title: 'Book Club',
      startAt: new Date(),
      reminderSentAt: null,
      coverImageUrl: null,
    });

    await service.sendDueReminders();

    const [, payload] = push.sendToUsers.mock.calls[0] as [
      string[],
      PushPayload,
    ];
    expect(payload).not.toHaveProperty('image');
    // The non-image rich fields still ship.
    expect(payload.actions).toEqual([{ action: 'view', title: 'Details' }]);
    expect(payload.requireInteraction).toBe(true);
  });

  it('omits image for a storage-key cover (our /files/* route, not a direct public URL)', async () => {
    primeOneDueReminder({
      id: 'e3',
      slug: 'mixer',
      title: 'Mixer',
      startAt: new Date(),
      reminderSentAt: null,
      // A storage key resolves through `toImageUrl` to our own `GET /files/*`
      // redirect route, not a direct absolute-https asset — never the image.
      coverImageUrl:
        'listing-photos/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222.jpg',
    });

    await service.sendDueReminders();

    const [, payload] = push.sendToUsers.mock.calls[0] as [
      string[],
      PushPayload,
    ];
    expect(payload).not.toHaveProperty('image');
  });
});
