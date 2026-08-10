import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, IsNull, Repository } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { PushService } from '../push/push.service';
import { isStorageKey } from '../storage/storage-key';
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

// Raw row shape from the batched claim UPDATE's RETURNING clause — column
// names are the actual (snake_case) DB columns, not the entity's camelCase.
interface ClaimedReminderRow {
  id: string;
  user_id: string;
}

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
    if (upcoming.length === 0) {
      return;
    }

    // Pull every candidate RSVP across the whole batch in ONE query instead of
    // one `rsvps.find(...)` per event (the former N+1). Only attendees who are
    // going/maybe and have not yet been reminded — the same predicate the
    // per-event fetch used — then group by event in memory so each event still
    // sees exactly its own pending RSVPs below.
    const pendingRsvps = await this.rsvps.find({
      where: {
        eventId: In(upcoming.map((event) => event.id)),
        status: In([RsvpStatus.Going, RsvpStatus.Maybe]),
        reminderSentAt: IsNull(),
      },
    });
    const pendingRsvpsByEventId = new Map<string, EventRsvp[]>();
    for (const rsvp of pendingRsvps) {
      const bucket = pendingRsvpsByEventId.get(rsvp.eventId);
      if (bucket) {
        bucket.push(rsvp);
      } else {
        pendingRsvpsByEventId.set(rsvp.eventId, [rsvp]);
      }
    }

    for (const event of upcoming) {
      // Isolate each event: one event's fan-out failing must not strand the
      // rest of the batch.
      try {
        await this.remindForEvent(
          event,
          pendingRsvpsByEventId.get(event.id) ?? [],
          now,
        );
      } catch (error) {
        this.logger.error(
          `Reminder fan-out failed for event ${event.slug}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }
    }
  }

  private async remindForEvent(
    event: Event,
    pendingRsvps: EventRsvp[],
    now: Date,
  ): Promise<void> {
    // `pendingRsvps` are this event's going/maybe, not-yet-reminded attendees,
    // pre-fetched and grouped by the batched query in `fanOutDueReminders`.
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

    // Figure out, in memory, which attendees are due — no query per attendee
    // for this part, just a per-lead-time comparison against `now`.
    const dueRsvpIds = pendingRsvps
      .filter((rsvp) => {
        const leadMinutes =
          leadMinutesByUser.get(rsvp.userId) ?? DEFAULT_REMINDER_LEAD_MINUTES;
        const fireAt = new Date(
          event.startAt.getTime() - leadMinutes * MINUTE_MS,
        );
        return now >= fireAt;
      })
      .map((rsvp) => rsvp.id);
    if (dueRsvpIds.length === 0) {
      return;
    }

    // Claim every due RSVP in ONE round trip instead of one UPDATE per
    // attendee (was: `this.rsvps.update(...)` inside the loop above — N
    // sequential writes for an event with N due attendees). The
    // `reminder_sent_at IS NULL` guard preserves the exact at-most-once
    // semantics: RETURNING only reports the rows THIS statement actually
    // flipped, so a row an overlapping tick already claimed is naturally
    // excluded rather than double-counted.
    const claimResult = await this.rsvps
      .createQueryBuilder()
      .update(EventRsvp)
      .set({ reminderSentAt: now })
      .where('id IN (:...dueRsvpIds)', { dueRsvpIds })
      .andWhere('reminder_sent_at IS NULL')
      .returning('*')
      .execute();
    const remindedUserIds = (claimResult.raw as ClaimedReminderRow[]).map(
      (row) => row.user_id,
    );
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
  // subscription is simply a no-op inside `sendToUsers`, and any send error is
  // swallowed per-recipient so one bad endpoint can't strand the others.
  //
  // `sendToUsers` batches the subscription lookup with one `IN (...)` query
  // for every reminded attendee, instead of the one-`find`-per-user cost of
  // calling `sendToUser` inside a `userIds.map(...)` loop.
  private async pushReminders(event: Event, userIds: string[]): Promise<void> {
    // Event cover as the notification's large image — but ONLY when it is an
    // absolute public https URL a browser can fetch unauthenticated. A
    // storage-key cover resolves to our auth-gated `GET /files/*` route, which a
    // push client cannot fetch, so we omit `image` entirely (conditional spread
    // below) rather than send a URL that would render as a broken image.
    const rawCover = event.coverImageUrl;
    const cover =
      rawCover && !isStorageKey(rawCover) && rawCover.startsWith('https://')
        ? rawCover
        : undefined;
    await this.push.sendToUsers(userIds, {
      title: event.title,
      body: 'Starting soon — tap to see the details.',
      tag: `event-reminder-${event.id}`,
      data: { url: `/events/${event.slug}` },
      // English fallback stays above; the SW localizes the body via this key
      // (push:event.reminder.body in queerpulse/src/pushMessages.ts) when it
      // knows the recipient's language. The title is always the event's own
      // title, which is never localized.
      l10n: { bodyKey: 'push:event.reminder.body' },
      // Omit `image` (not send `undefined`) when there is no public cover.
      ...(cover ? { image: cover } : {}),
      actions: [{ action: 'view', title: 'Details' }],
      requireInteraction: true,
      vibrate: [100, 50, 100],
      // The event's own start time, not delivery time — "starting soon" reads
      // correctly against when the gathering actually begins.
      timestamp: event.startAt.getTime(),
    });
  }
}
