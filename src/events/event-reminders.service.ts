import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, IsNull, Repository } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { gatheringPath } from './event-paths';
import { NotificationDeliveryService } from '../notifications/notification-delivery.service';
import { NotificationPreferenceCategory } from '../notifications/notification-preferences';
import { NotificationPreferencesService } from '../notifications/notification-preferences.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PushPreviewPrivacyService } from '../push/push-preview-privacy.service';
import type { PushPayload } from '../push/push.service';
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

// The taxonomy code a moderator takedown is recorded under for a gathering,
// the same value `EventsService.SUBJECT_TYPE` uses for the public
// browse/search/detail gate. Kept as its own constant here because that one
// is private to `EventsService`.
const EVENT_MODERATION_SUBJECT_TYPE = 'event';

// Raw row shape from the batched claim UPDATE's RETURNING clause. Column
// names are the actual (snake_case) DB columns; the entity's camelCase names
// do not apply to raw rows.
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
    // Every reminder push goes through the lock-screen privacy split (ENG-410),
    // the same gate `PushNotificationListener` uses for its pushes.
    private readonly previewPrivacy: PushPreviewPrivacyService,
    private readonly notificationDelivery: NotificationDeliveryService,
    private readonly notificationPreferences: NotificationPreferencesService,
    // ENG-482: a moderator takedown must stop this sweep from reminding
    // anyone about the gathering. `EventsModule` already imports
    // `ContentModerationModule`.
    private readonly contentModeration: ContentModerationService,
  ) {}

  // Every 5 minutes, not every 30. The sweep fires a reminder once `now` has
  // passed the attendee's `fireAt`, so the tick interval is pure LATENESS: on a
  // 30 minute cadence the shortest selectable lead (60 minutes) could arrive
  // barely half an hour before the doors, which is too late to be worth
  // sending for an in-person gathering. The query is bounded to a one week
  // horizon and claims in one batched UPDATE, so running it six times as often
  // costs a cheap indexed scan that usually claims nothing.
  @Cron(CronExpression.EVERY_5_MINUTES)
  async sendDueReminders(): Promise<void> {
    // @nestjs/schedule does not wrap handlers, so an escaping rejection becomes
    // an unhandledRejection, which, absent a Sentry listener, takes the process
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
    const upcomingCandidates = await this.events.find({
      where: {
        status: EventStatus.Published,
        startAt: Between(now, horizon),
      },
    });
    if (upcomingCandidates.length === 0) {
      return;
    }

    // ENG-482: a hidden or removed gathering must stop sending reminders. This
    // reads the moderation state for the whole batch in one query and drops
    // matches BEFORE the RSVP claim below runs, so a taken-down event's
    // `reminder_sent_at` is never claimed for it. If it did get claimed here,
    // a gathering staff later restores would stay silently un-reminded, since
    // the claim guard never fires twice for the same RSVP.
    const moderationStates = await this.contentModeration.statesFor(
      EVENT_MODERATION_SUBJECT_TYPE,
      upcomingCandidates.map((event) => event.id),
    );
    const upcoming = upcomingCandidates.filter((event) => {
      const moderation = moderationStates.get(event.id);
      return !moderation?.hidden && !moderation?.removed;
    });
    if (upcoming.length === 0) {
      return;
    }

    // Pull every candidate RSVP across the whole batch in ONE query, which
    // retired the former N+1 of one `rsvps.find(...)` per event. Only attendees
    // who are going/maybe and have not yet been reminded (the same predicate
    // the per-event fetch used), then group by event in memory so each event
    // still sees exactly its own pending RSVPs below.
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

    // Figure out, in memory, which attendees are due. This part runs zero
    // queries per attendee: a per-lead-time comparison against `now` is enough.
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

    // Claim every due RSVP in ONE round trip. This used to be one
    // `this.rsvps.update(...)` per attendee inside the loop above: N
    // sequential writes for an event with N due attendees. The
    // `reminder_sent_at IS NULL` guard preserves the exact at-most-once
    // semantics: RETURNING only reports the rows THIS statement actually
    // flipped, so a row an overlapping tick already claimed is naturally
    // excluded and never counted twice.
    const claimResult = await this.rsvps
      .createQueryBuilder()
      .update(EventRsvp)
      .set({ reminderSentAt: now })
      .where('id IN (:...dueRsvpIds)', { dueRsvpIds })
      .andWhere('reminder_sent_at IS NULL')
      .returning('*')
      .execute();
    const claimedRows = claimResult.raw as ClaimedReminderRow[];
    const remindedUserIds = claimedRows.map((row) => row.user_id);
    if (remindedUserIds.length === 0) {
      return;
    }

    // In-app notification for everyone whose reminder just fired (one batched
    // write), then a best-effort phone push on top.
    //
    // At-most-once is enforced by claiming BEFORE sending, but that only
    // holds up if the claim is RELEASED when the send never happens. Without
    // this rollback a DB blip inside `createForRecipients` left every attendee
    // in the batch permanently stamped as reminded and silently un-notified:
    // the outer `try/catch` in `fanOutDueReminders` only logs, and
    // `reminder_sent_at` is never reset anywhere else. Releasing the claim
    // hands the batch back to the next tick, restoring the retry half of the
    // at-most-once contract without ever risking a duplicate (a row is only
    // released if nothing was delivered for it).
    //
    // `createForRecipients` returns the members a row was actually written
    // for, after its block/mute filter and the member's own in-app category
    // switch for event reminders (ENG-410). Only those members get the push:
    // someone who turned reminders off gets no row, and so no buzz either.
    //
    // The payload names the gathering (PRD-404) so the bell row can say which
    // one is coming up and link straight to it. `source: 'event'` tells the
    // client which kind of subject the slug and title belong to.
    let notifiedUserIds: string[];
    try {
      notifiedUserIds = await this.notifications.createForRecipients(
        remindedUserIds,
        NotificationType.EventReminder,
        {
          eventId: event.id,
          startAt: event.startAt.toISOString(),
          source: 'event',
          eventSlug: event.slug,
          eventTitle: event.title,
        },
      );
    } catch (error) {
      await this.releaseReminderClaims(claimedRows.map((row) => row.id));
      throw error;
    }
    // Push is deliberately OUTSIDE the rollback: it is best-effort by design
    // (`pushReminders` logs and swallows its own failures), and the in-app
    // notification the member actually relies on has already landed. Undoing
    // the claim here would re-deliver that notification on the next tick.
    await this.pushReminders(event, notifiedUserIds);

    // Two counts: the in-app gate can write fewer rows than were claimed, and
    // a claimed attendee with reminders switched off gets no row at all.
    this.logger.log(
      `Sent ${notifiedUserIds.length} reminder(s) for event ${event.slug} (${remindedUserIds.length} claimed)`,
    );
  }

  /**
   * Undo a reminder claim so the next tick can retry it. Best-effort itself: if
   * the release ALSO fails (the same DB trouble that broke the send), the
   * original error still propagates to the caller's logger. Swallowing it here
   * would hide the real failure behind a secondary one.
   */
  private async releaseReminderClaims(rsvpIds: string[]): Promise<void> {
    if (!rsvpIds.length) {
      return;
    }
    try {
      await this.rsvps
        .createQueryBuilder()
        .update(EventRsvp)
        .set({ reminderSentAt: null })
        .where('id IN (:...rsvpIds)', { rsvpIds })
        .execute();
    } catch (error) {
      this.logger.error(
        `Failed to release ${rsvpIds.length} reminder claim(s); they will not retry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Web push is fire-and-forget and must never fail the sweep: a member with no
  // subscription is simply a no-op inside `sendToUsers`, any send error is
  // swallowed per-recipient so one bad endpoint can't strand the others, and a
  // fault in the lookups below is logged here and goes no further.
  //
  // `userIds` are the members `createForRecipients` actually wrote a row for,
  // so the in-app category switch has already been applied. Three more gates
  // narrow the buzz, in this order:
  //   1. the member's PUSH switch for event reminders, the same batched
  //      `recipientsPushEnabled` check `PushNotificationListener` runs for
  //      every toggleable category;
  //   2. quiet hours;
  //   3. the lock-screen privacy split, inside
  //      `PushPreviewPrivacyService.sendSplitByPreviewPreference`.
  private async pushReminders(event: Event, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    try {
      const pushEnabledUserIds =
        await this.notificationPreferences.recipientsPushEnabled(
          userIds,
          NotificationPreferenceCategory.EventReminders,
        );
      if (pushEnabledUserIds.length === 0) return;
      // Honour the member's quiet hours here too. This push path does not
      // travel through `PushNotificationListener`, so without this filter a
      // reminder could still buzz at 3am for someone who had explicitly asked
      // for silence. The in-app notification row is written by the caller
      // regardless: quiet hours withhold the buzz and keep the record.
      const audibleUserIds =
        await this.notificationDelivery.recipientsOutsideQuietHours(
          pushEnabledUserIds,
        );
      if (audibleUserIds.length === 0) return;
      // The rich payload names the gathering and shows its cover. A member
      // hiding lock-screen previews receives the generic "You have a new
      // notification." copy in its place: a gathering's title (a peer-support
      // group, say) is exactly what a bystander must not read off the lock
      // screen. The generic payload keeps only the tag, the deep link and the
      // timestamp, so the image and the action button stay off it too.
      await this.previewPrivacy.sendSplitByPreviewPreference(
        audibleUserIds,
        this.reminderPushPayload(event),
      );
    } catch (error) {
      this.logger.warn(
        `Reminder push failed for event ${event.slug}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The full reminder push, as a member showing previews receives it. */
  private reminderPushPayload(event: Event): PushPayload {
    // Event cover as the notification's large image, but ONLY when it is an
    // absolute public https URL a browser can fetch unauthenticated. A
    // storage-key cover resolves to our auth-gated `GET /files/*` route, which a
    // push client cannot fetch, so `image` is left off entirely (conditional
    // spread below), since that URL would render as a broken image.
    const rawCover = event.coverImageUrl;
    const cover =
      rawCover && !isStorageKey(rawCover) && rawCover.startsWith('https://')
        ? rawCover
        : undefined;
    return {
      title: event.title,
      body: 'Starting soon. Tap to see the details.',
      tag: `event-reminder-${event.id}`,
      // The SPA routes the detail page at `/gatherings/<slug>`; `/events` is
      // the board and has no `:slug` child (PRD-180).
      data: { url: gatheringPath(event.slug) },
      // English fallback stays above; the SW localizes the body via this key
      // (push:event.reminder.body in queerpulse/src/pushMessages.ts) when it
      // knows the recipient's language. The title is always the event's own
      // title, which is never localized.
      l10n: { bodyKey: 'push:event.reminder.body' },
      // A missing cover leaves the `image` key out altogether.
      ...(cover ? { image: cover } : {}),
      // `title` is the English fallback; the SW localizes the button label from
      // `titleKey` when it knows the recipient's language (ENG-414).
      actions: [
        {
          action: 'view',
          title: 'Details',
          titleKey: 'push:event.reminder.actionDetails',
        },
      ],
      requireInteraction: true,
      vibrate: [100, 50, 100],
      // The event's own start time. "Starting soon" reads correctly against
      // when the gathering actually begins, whenever the push is delivered.
      timestamp: event.startAt.getTime(),
    };
  }
}
