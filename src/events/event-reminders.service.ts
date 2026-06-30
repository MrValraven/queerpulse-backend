import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, IsNull, Repository } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus } from './entities/event.entity';

const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000; // events starting within 24h

@Injectable()
export class EventRemindersService {
  private readonly logger = new Logger(EventRemindersService.name);

  constructor(
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventRsvp) private readonly rsvps: Repository<EventRsvp>,
    private readonly notifications: NotificationsService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async sendDueReminders(): Promise<void> {
    const now = new Date();
    const horizon = new Date(now.getTime() + REMINDER_WINDOW_MS);
    const due = await this.events.find({
      where: {
        status: EventStatus.Published,
        reminderSentAt: IsNull(),
        startAt: Between(now, horizon),
      },
    });
    for (const event of due) {
      const attendees = await this.rsvps.find({
        where: {
          eventId: event.id,
          status: In([RsvpStatus.Going, RsvpStatus.Maybe]),
        },
      });
      await this.notifications.createForRecipients(
        attendees.map((a) => a.userId),
        NotificationType.EventReminder,
        { eventId: event.id, startAt: event.startAt.toISOString() },
      );
      event.reminderSentAt = now;
      await this.events.save(event);
      this.logger.log(
        `Sent ${attendees.length} reminder(s) for event ${event.slug}`,
      );
    }
  }
}
