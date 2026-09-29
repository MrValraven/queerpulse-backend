import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationDeliveryService } from '../notifications/notification-delivery.service';
import { NotificationPreferenceCategory } from '../notifications/notification-preferences';
import { NotificationPreferencesService } from '../notifications/notification-preferences.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { GENERIC_PUSH_COPY } from '../push/generic-push-copy';
import { PushPreviewPrivacyService } from '../push/push-preview-privacy.service';
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
  // `createForRecipients` echoes its input by default: every attendee gets a
  // row. Tests about the in-app category gate override it.
  let notifications: { createForRecipients: jest.Mock };
  // Quiet hours are applied to the reminder push specifically (this push path
  // bypasses `PushNotificationListener`). Defaults to "nobody has asked for
  // silence", so the payload tests below still see their buzz.
  let notificationDelivery: { recipientsOutsideQuietHours: jest.Mock };
  // The member's PUSH switch for event reminders. Defaults to everyone on.
  let notificationPreferences: { recipientsPushEnabled: jest.Mock };
  // ENG-482: the moderation state of every event the sweep considers. Defaults
  // to an empty map (nothing taken down), so every existing test above still
  // sees its event as reminder-eligible.
  let contentModeration: { statesFor: jest.Mock };
  // The real `PushPreviewPrivacyService` runs, so the lock-screen split is
  // exercised end to end. Its `member_preferences` lookup reads this list:
  // everyone NOT in it has explicitly chosen to show previews.
  let hidingPreviewUserIds: string[];
  let memberPreferences: { find: jest.Mock };
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
    notifications = {
      createForRecipients: jest.fn((userIds: string[]) =>
        Promise.resolve(userIds),
      ),
    };
    notificationDelivery = {
      recipientsOutsideQuietHours: jest.fn((userIds: string[]) =>
        Promise.resolve(userIds),
      ),
    };
    notificationPreferences = {
      recipientsPushEnabled: jest.fn((userIds: string[]) =>
        Promise.resolve(userIds),
      ),
    };
    hidingPreviewUserIds = [];
    memberPreferences = {
      find: jest.fn(({ where }: { where: { userId: unknown } }) => {
        // `where.userId` is TypeORM's `In([...])` operator; its `value` is the
        // requested id list.
        const requestedUserIds = (where.userId as { value: string[] }).value;
        return Promise.resolve(
          requestedUserIds
            .filter((userId) => !hidingPreviewUserIds.includes(userId))
            .map((userId) => ({ userId, hidePushPreviews: false })),
        );
      }),
    };
    push = { sendToUsers: jest.fn().mockResolvedValue(undefined) };
    contentModeration = {
      statesFor: jest.fn().mockResolvedValue(new Map()),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventRemindersService,
        PushPreviewPrivacyService,
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(EventRsvp), useValue: rsvps },
        {
          provide: getRepositoryToken(MemberEventReminderPreferences),
          useValue: preferences,
        },
        {
          provide: getRepositoryToken(MemberPreferences),
          useValue: memberPreferences,
        },
        { provide: NotificationsService, useValue: notifications },
        { provide: PushService, useValue: push },
        {
          provide: NotificationDeliveryService,
          useValue: notificationDelivery,
        },
        {
          provide: NotificationPreferencesService,
          useValue: notificationPreferences,
        },
        { provide: ContentModerationService, useValue: contentModeration },
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
    // The sweep now pulls every candidate RSVP across the whole batch in ONE
    // query and groups them by `eventId` in memory, so each row must carry the
    // event it belongs to.
    rsvps.find.mockResolvedValue([
      { id: 'r1', userId: 'a', eventId: 'e1' },
      { id: 'r2', userId: 'b', eventId: 'e1' },
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
      { id: 'r1', userId: 'a', eventId: 'e1' },
      { id: 'r2', userId: 'b', eventId: 'e1' },
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

  it('skips the fan-out when the claim is lost (RETURNING claims nobody)', async () => {
    events.find.mockResolvedValue([
      { id: 'e1', slug: 'x', startAt: new Date(), reminderSentAt: null },
    ]);
    rsvps.find.mockResolvedValue([{ id: 'r1', userId: 'a', eventId: 'e1' }]);
    // The RSVP was due, but an overlapping tick flipped `reminder_sent_at`
    // first, so the guarded UPDATE claims nothing and RETURNING is empty —
    // nobody to remind.
    claimQueryBuilder.execute.mockResolvedValue({ raw: [] });

    await service.sendDueReminders();

    expect(notifications.createForRecipients).not.toHaveBeenCalled();
    expect(push.sendToUsers).not.toHaveBeenCalled();
  });

  it('does nothing when no events are due', async () => {
    events.find.mockResolvedValue([]);
    await service.sendDueReminders();
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
    expect(events.update).not.toHaveBeenCalled();
  });

  // ENG-482: a moderator takedown must stop this sweep from reminding anyone
  // about the gathering, and must not claim the RSVP either, so a gathering
  // staff later restores still reminds on schedule.
  it('sends no reminder for a hidden event, and claims none of its RSVPs', async () => {
    const hiddenEvent = {
      id: 'e-hidden',
      slug: 'hidden-mixer',
      startAt: new Date(),
      reminderSentAt: null,
    };
    events.find.mockResolvedValue([hiddenEvent]);
    rsvps.find.mockResolvedValue([
      { id: 'r1', userId: 'a', eventId: 'e-hidden' },
    ]);
    contentModeration.statesFor.mockResolvedValue(
      new Map([['e-hidden', { hidden: true, removed: false }]]),
    );

    await service.sendDueReminders();

    expect(contentModeration.statesFor).toHaveBeenCalledWith('event', [
      'e-hidden',
    ]);
    // The event was dropped before the RSVP claim ran at all.
    expect(rsvps.createQueryBuilder).not.toHaveBeenCalled();
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
    expect(push.sendToUsers).not.toHaveBeenCalled();
  });

  it('sends no reminder for a removed event either', async () => {
    events.find.mockResolvedValue([
      { id: 'e-removed', slug: 'removed-mixer', startAt: new Date() },
    ]);
    rsvps.find.mockResolvedValue([
      { id: 'r1', userId: 'a', eventId: 'e-removed' },
    ]);
    contentModeration.statesFor.mockResolvedValue(
      new Map([['e-removed', { hidden: true, removed: true }]]),
    );

    await service.sendDueReminders();

    expect(rsvps.createQueryBuilder).not.toHaveBeenCalled();
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  // Drives one due attendee through the sweep so `pushReminders` runs with a
  // real reminded-user list, then asserts the rich push payload it built.
  function primeOneDueReminder(event: Record<string, unknown>): void {
    events.find.mockResolvedValue([event]);
    // `eventId` must match the primed event so the batched sweep groups this
    // RSVP under it (the fan-out is per-event).
    rsvps.find.mockResolvedValue([
      { id: 'r1', userId: 'u1', eventId: event.id },
    ]);
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
        body: 'Starting soon. Tap to see the details.',
        image: 'https://images.example.com/pride-picnic.jpg',
        actions: [
          {
            action: 'view',
            title: 'Details',
            titleKey: 'push:event.reminder.actionDetails',
          },
        ],
        requireInteraction: true,
        vibrate: [100, 50, 100],
        data: { url: '/gatherings/pride-picnic' },
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
    expect(payload.actions).toEqual([
      {
        action: 'view',
        title: 'Details',
        titleKey: 'push:event.reminder.actionDetails',
      },
    ]);
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

  // PRD-404: the bell row names the gathering and carries the slug it links to.
  it('writes the event slug, title and source onto the bell row payload', async () => {
    const startAt = new Date();
    primeOneDueReminder({
      id: 'e4',
      slug: 'peer-circle',
      title: 'Peer Circle',
      startAt,
      reminderSentAt: null,
      coverImageUrl: null,
    });

    await service.sendDueReminders();

    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['u1'],
      NotificationType.EventReminder,
      {
        eventId: 'e4',
        startAt: startAt.toISOString(),
        source: 'event',
        eventSlug: 'peer-circle',
        eventTitle: 'Peer Circle',
      },
    );
  });

  // Every push the tests below inspect, as `[userIds, payload]` pairs, skipping
  // the empty half of the preview split (the real split always makes both
  // sends, and one side is usually empty).
  function nonEmptyPushSends(): [string[], PushPayload][] {
    return (push.sendToUsers.mock.calls as [string[], PushPayload][]).filter(
      ([userIds]) => userIds.length > 0,
    );
  }

  function primeTwoDueReminders(): void {
    events.find.mockResolvedValue([
      {
        id: 'e5',
        slug: 'pride-picnic',
        title: 'Pride Picnic',
        startAt: new Date(),
        reminderSentAt: null,
        coverImageUrl: 'https://images.example.com/pride-picnic.jpg',
      },
    ]);
    rsvps.find.mockResolvedValue([
      { id: 'r1', userId: 'a', eventId: 'e5' },
      { id: 'r2', userId: 'b', eventId: 'e5' },
    ]);
    claimQueryBuilder.execute.mockResolvedValue({
      raw: [
        { id: 'r1', user_id: 'a' },
        { id: 'r2', user_id: 'b' },
      ],
    });
  }

  // ENG-410: a member who turned event reminders off in-app gets no row from
  // `createForRecipients`, and so no buzz either.
  it('pushes only to the members createForRecipients wrote a row for', async () => {
    primeTwoDueReminders();
    notifications.createForRecipients.mockResolvedValue(['a']);

    await service.sendDueReminders();

    expect(notificationPreferences.recipientsPushEnabled).toHaveBeenCalledWith(
      ['a'],
      NotificationPreferenceCategory.EventReminders,
    );
    const sends = nonEmptyPushSends();
    expect(sends).toHaveLength(1);
    expect(sends[0]![0]).toEqual(['a']);
  });

  it('sends no push when createForRecipients wrote no rows', async () => {
    primeTwoDueReminders();
    notifications.createForRecipients.mockResolvedValue([]);

    await service.sendDueReminders();

    expect(
      notificationPreferences.recipientsPushEnabled,
    ).not.toHaveBeenCalled();
    expect(push.sendToUsers).not.toHaveBeenCalled();
  });

  it("honours the member's push switch for event reminders", async () => {
    primeTwoDueReminders();
    notificationPreferences.recipientsPushEnabled.mockResolvedValue(['b']);

    await service.sendDueReminders();

    // Quiet hours only see the members still wanting a push.
    expect(
      notificationDelivery.recipientsOutsideQuietHours,
    ).toHaveBeenCalledWith(['b']);
    const sends = nonEmptyPushSends();
    expect(sends).toHaveLength(1);
    expect(sends[0]![0]).toEqual(['b']);
  });

  it('withholds the push from members inside quiet hours', async () => {
    primeTwoDueReminders();
    notificationDelivery.recipientsOutsideQuietHours.mockResolvedValue([]);

    await service.sendDueReminders();

    expect(push.sendToUsers).not.toHaveBeenCalled();
  });

  // ENG-410: a gathering's title and cover are exactly what a bystander must
  // not read off the lock screen of a member hiding previews.
  it('sends the generic payload to a member hiding lock-screen previews', async () => {
    primeTwoDueReminders();
    hidingPreviewUserIds = ['b'];

    await service.sendDueReminders();

    const sends = nonEmptyPushSends();
    expect(sends).toHaveLength(2);
    const [richUserIds, richPayload] = sends[0]!;
    const [genericUserIds, genericPayload] = sends[1]!;
    expect(richUserIds).toEqual(['a']);
    expect(richPayload.title).toBe('Pride Picnic');
    expect(genericUserIds).toEqual(['b']);
    expect(genericPayload.title).toBe(GENERIC_PUSH_COPY.notification.title);
    expect(genericPayload.body).toBe(GENERIC_PUSH_COPY.notification.body);
    expect(genericPayload.l10n).toEqual({
      titleKey: GENERIC_PUSH_COPY.notification.titleKey,
      bodyKey: GENERIC_PUSH_COPY.notification.bodyKey,
    });
    // The deep link and tag survive; the cover and the action button do not.
    expect(genericPayload.data).toEqual({ url: '/gatherings/pride-picnic' });
    expect(genericPayload.tag).toBe('event-reminder-e5');
    expect(genericPayload).not.toHaveProperty('image');
    expect(genericPayload).not.toHaveProperty('actions');
    expect(JSON.stringify(genericPayload)).not.toContain('Pride Picnic');
  });

  it('logs a failed push and keeps the claim, since the bell row already landed', async () => {
    primeTwoDueReminders();
    push.sendToUsers.mockRejectedValue(new Error('pool exhausted'));
    const logger = (service as unknown as { logger: Logger }).logger;
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    const logSpy = jest.spyOn(logger, 'log').mockImplementation(() => {});

    await expect(service.sendDueReminders()).resolves.toBeUndefined();

    // The push step logs its own warning and stops there: the per-event
    // "Reminder fan-out failed" error never fires, and the success line still
    // does.
    expect(warnSpy).toHaveBeenCalledWith(
      'Reminder push failed for event pride-picnic: pool exhausted',
    );
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      'Sent 2 reminder(s) for event pride-picnic (2 claimed)',
    );
    // Only the claim UPDATE ran: no release statement followed it.
    expect(rsvps.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(claimQueryBuilder.set).toHaveBeenCalledTimes(1);
    expect(claimQueryBuilder.set).not.toHaveBeenCalledWith({
      reminderSentAt: null,
    });
  });

  it('logs the notified count beside the claimed count', async () => {
    primeTwoDueReminders();
    notifications.createForRecipients.mockResolvedValue(['a']);
    const logger = (service as unknown as { logger: Logger }).logger;
    const logSpy = jest.spyOn(logger, 'log').mockImplementation(() => {});

    await service.sendDueReminders();

    expect(logSpy).toHaveBeenCalledWith(
      'Sent 1 reminder(s) for event pride-picnic (2 claimed)',
    );
  });
});
