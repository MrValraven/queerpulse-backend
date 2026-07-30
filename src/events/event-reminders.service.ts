import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, IsNull, Repository } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { PushService } from '../push/push.service';
import {
  DEFAULT_REMINDER_LEAD_MINUTES,
  MemberEventReminderPreferences,
} from './entities/member-event-reminder-preferences.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event, EventStatus } from './entities/event.entity';

// The widest lead a member can choose (1 week). Only events starting within
// this horizon can have a reminder due, so the sweep never scans further out.
const MAX_REMINDER_LEAD_MS = 10080 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

@Injectable()
export class EventRemindersService {
  private readonly logger = new Logger(EventRemindersService.name);

  constructor(
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventRsvp) private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(MemberEventReminderPreferences)
    private readonly preferences: Repository<MemberEventReminderPreferences>,
    private readonly notifications: NotificationsService,
    private readonly push: PushService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async sendDueReminders(): Promise<void> {
    // @nestjs/schedule does not wrap handlers, so an escaping rejection becomes
    // an unhandledRejection — which, absent a Sentry listener, takes the process
    // down. A DB blip must not restart the server; the next tick retries.
    try {
      await this.fanOutDueReminders();
    } catch (error) {
      this.logger.error(
        `Event reminder sweep failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }

  private async fanOutDueReminders(): Promise<void> {
    const now = new Date();
    const horizon = new Date(now.getTime() + MAX_REMINDER_LEAD_MS);
    // Any event still ahead of us but within the widest lead may have a
    // reminder due for at least one attendee. Attendee-level timing and the
    // at-most-once claim happen per event below.
    const upcoming = await this.events.find({
      where: {
        status: EventStatus.Published,
        startAt: Between(now, horizon),
      },
    });
    for (const event of upcoming) {
      // Isolate each event: one event's fan-out failing must not strand the
      // rest of the batch.
      try {
        await this.remindForEvent(event, now);
      } catch (error) {
        this.logger.error(
          `Reminder fan-out failed for event ${event.slug}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }
    }
  }

  private async remindForEvent(event: Event, now: Date): Promise<void> {
    // Only attendees who are going/maybe and have not yet been reminded.
    const pendingRsvps = await this.rsvps.find({
      where: {
        eventId: event.id,
        status: In([RsvpStatus.Going, RsvpStatus.Maybe]),
        reminderSentAt: IsNull(),
      },
    });
    if (pendingRsvps.length === 0) {
      return;
    }

    // One query for everyone's lead time; absent rows fall back to the default.
    const attendeeIds = pendingRsvps.map((rsvp) => rsvp.userId);
    const preferenceRows = await this.preferences.find({
      where: { userId: In(attendeeIds) },
    });
    const leadMinutesByUser = new Map(
      preferenceRows.map((row) => [row.userId, row.leadMinutes]),
    );

    const remindedUserIds: string[] = [];
    for (const rsvp of pendingRsvps) {
      const leadMinutes =
        leadMinutesByUser.get(rsvp.userId) ?? DEFAULT_REMINDER_LEAD_MINUTES;
      const fireAt = new Date(
        event.startAt.getTime() - leadMinutes * MINUTE_MS,
      );
      if (now < fireAt) {
        continue; // this attendee's reminder is not due yet
      }
      // Claim this RSVP before delivering (stamp-before-send = at-most-once).
      // The conditional UPDATE only stamps a row still unsent, so an overlapping
      // tick that loses the race sees affected === 0 and skips — never a double
      // send.
      const claim = await this.rsvps.update(
        { id: rsvp.id, reminderSentAt: IsNull() },
        { reminderSentAt: now },
      );
      if (claim.affected === 1) {
        remindedUserIds.push(rsvp.userId);
      }
    }
    if (remindedUserIds.length === 0) {
      return;
    }

    // In-app notification for everyone whose reminder just fired (one batched
    // write), then a best-effort phone push on top.
    await this.notifications.createForRecipients(
      remindedUserIds,
      NotificationType.EventReminder,
      { eventId: event.id, startAt: event.startAt.toISOString() },
    );
    await this.pushReminders(event, remindedUserIds);

    this.logger.log(
      `Sent ${remindedUserIds.length} reminder(s) for event ${event.slug}`,
    );
  }

  // Web push is fire-and-forget and must never fail the sweep: a member with no
  // subscription is simply a no-op inside `sendToUser`, and any send error is
  // swallowed per-recipient so one bad endpoint can't strand the others.
  private async pushReminders(event: Event, userIds: string[]): Promise<void> {
    await Promise.all(
      userIds.map((userId) =>
        this.push
          .sendToUser(userId, {
            title: event.title,
            body: 'Starting soon — tap to see the details.',
            tag: `event-reminder-${event.id}`,
            data: { url: `/events/${event.slug}` },
          })
          .catch((error) =>
            this.logger.warn(
              `Reminder push failed for user ${userId} on event ${event.slug}: ${String(error)}`,
            ),
          ),
      ),
    );
  }
}
