import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { PushService } from '../push/push.service';
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
});
