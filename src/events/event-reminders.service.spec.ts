import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { EventRsvp } from './entities/event-rsvp.entity';
import { Event } from './entities/event.entity';
import { EventRemindersService } from './event-reminders.service';

describe('EventRemindersService', () => {
  let service: EventRemindersService;
  let events: { find: jest.Mock; update: jest.Mock };
  let rsvps: { find: jest.Mock };
  let notifications: { createForRecipients: jest.Mock };

  beforeEach(async () => {
    events = {
      find: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    rsvps = { find: jest.fn().mockResolvedValue([]) };
    notifications = { createForRecipients: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventRemindersService,
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(EventRsvp), useValue: rsvps },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = module.get(EventRemindersService);
  });

  it('claims each due event before notifying (stamp-before-send)', async () => {
    const event = {
      id: 'e1',
      slug: 'x',
      startAt: new Date(),
      reminderSentAt: null,
    };
    events.find.mockResolvedValue([event]);
    rsvps.find.mockResolvedValue([{ userId: 'a' }, { userId: 'b' }]);

    await service.sendDueReminders();

    // The conditional claim stamps reminderSentAt on a still-unsent row...
    expect(events.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1' }),
      expect.objectContaining({ reminderSentAt: expect.any(Date) }),
    );
    // ...and only then does the fan-out happen (at-most-once ordering).
    expect(events.update.mock.invocationCallOrder[0]).toBeLessThan(
      notifications.createForRecipients.mock.invocationCallOrder[0],
    );
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['a', 'b'],
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
