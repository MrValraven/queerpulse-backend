import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { EventRsvp } from './entities/event-rsvp.entity';
import { Event } from './entities/event.entity';
import { EventRemindersService } from './event-reminders.service';

describe('EventRemindersService', () => {
  let service: EventRemindersService;
  let events: { find: jest.Mock; save: jest.Mock };
  let rsvps: { find: jest.Mock };
  let notifications: { createForRecipients: jest.Mock };

  beforeEach(async () => {
    events = { find: jest.fn(), save: jest.fn(async (e) => e) };
    rsvps = { find: jest.fn() };
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

  it('notifies attendees and stamps reminderSentAt once per due event', async () => {
    const event = {
      id: 'e1',
      slug: 'x',
      startAt: new Date(),
      reminderSentAt: null,
    };
    events.find.mockResolvedValue([event]);
    rsvps.find.mockResolvedValue([{ userId: 'a' }, { userId: 'b' }]);

    await service.sendDueReminders();

    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      ['a', 'b'],
      NotificationType.EventReminder,
      expect.objectContaining({ eventId: 'e1' }),
    );
    expect(events.save).toHaveBeenCalledWith(
      expect.objectContaining({ reminderSentAt: expect.any(Date) }),
    );
  });

  it('does nothing when no events are due', async () => {
    events.find.mockResolvedValue([]);
    await service.sendDueReminders();
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });
});
