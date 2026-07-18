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
    // @nestjs/schedule does not wrap handlers, so an escaping rejection becomes
    // an unhandledRejection — which, absent a Sentry listener, takes the process
    // down. A DB blip must not restart the server; the next tick retries.
    try {
      await this.fanOutDueReminders();
    } catch (err) {
      this.logger.error(
        `Event reminder sweep failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
    }
  }

  private async fanOutDueReminders(): Promise<void> {
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
      // Claim the event *before* fanning out (stamp-before-send = at-most-once).
      // The conditional UPDATE only stamps a row whose reminder is still unsent,
      // so a concurrent run (or an overlapping tick) that loses the race sees
      // affected === 0 and skips — never a double send.
      const claim = await this.events.update(
        { id: event.id, reminderSentAt: IsNull() },
        { reminderSentAt: now },
      );
      if (claim.affected !== 1) {
        continue;
      }
      // Isolate each event: one event's fan-out failing must not strand the rest
      // of the batch. The claim above is already stamped, so this event's
      // reminder is forfeited rather than retried (at-most-once, by design).
      try {
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
        this.logger.log(
          `Sent ${attendees.length} reminder(s) for event ${event.slug}`,
        );
      } catch (err) {
        this.logger.error(
          `Reminder fan-out failed for event ${event.slug}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
      }
    }
  }
}
