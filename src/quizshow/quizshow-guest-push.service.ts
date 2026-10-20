import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FeatureAccessService } from '../early-access/feature-access.service';
import { NotificationDeliveryService } from '../notifications/notification-delivery.service';
import { NotificationPreferenceCategory } from '../notifications/notification-preferences';
import { NotificationPreferencesService } from '../notifications/notification-preferences.service';
import { PushPreviewPrivacyService } from '../push/push-preview-privacy.service';
import { QUIZSHOW_LIMITS, QUIZSHOW_PUSH_COPY_KEYS } from './quizshow.contract';

export interface QuizshowLobbyOpenedPushInput {
  eventId: string;
  eventTitle: string;
  hostUserId: string | null;
  sessionId: string;
  joinCode: string;
  startedAt: Date;
}

/**
 * Going guests with a code. This service enforces no cooldown itself: the
 * caller (the sessions service) claims the two-hour cooldown through
 * `isCooldownOver` and stamps `guest_push_sent_at` atomically before calling
 * `sendLobbyOpened`. Recipients are the
 * going RSVPs minus the host, co-hosts, barred members and anyone blocked
 * either way with the host. While Pulse Live is in early access only guests
 * holding a grant stay on the list, since the others could not open the
 * game. The member's push switch and quiet hours narrow it further, then the
 * lock-screen privacy split sends it. Nothing here
 * throws: a fault is logged with the session id only.
 */
@Injectable()
export class QuizshowGuestPushService {
  private readonly logger = new Logger(QuizshowGuestPushService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notificationPreferences: NotificationPreferencesService,
    private readonly notificationDelivery: NotificationDeliveryService,
    private readonly previewPrivacy: PushPreviewPrivacyService,
    private readonly featureAccess: FeatureAccessService,
  ) {}

  /** True when no session of the event pushed guests within the cooldown. */
  async isCooldownOver(eventId: string, now: Date): Promise<boolean> {
    const cooldownStart = new Date(
      now.getTime() - QUIZSHOW_LIMITS.guestPushCooldownMs,
    );
    const rows: { has_recent_push: boolean }[] = await this.dataSource.query(
      `SELECT EXISTS (
         SELECT 1 FROM "quizshow_sessions" "session"
         WHERE "session"."event_id" = $1
           AND "session"."guest_push_sent_at" > $2
       ) AS "has_recent_push"`,
      [eventId, cooldownStart],
    );
    return rows[0]?.has_recent_push !== true;
  }

  async sendLobbyOpened(input: QuizshowLobbyOpenedPushInput): Promise<void> {
    try {
      const guestUserIds = await this.guestRecipientUserIds(
        input.eventId,
        input.hostUserId,
      );
      if (guestUserIds.length === 0) return;
      const recipientUserIds = await this.featureAccess.usersWithAccess(
        'quizshow',
        guestUserIds,
      );
      if (recipientUserIds.length === 0) return;
      const pushEnabledUserIds =
        await this.notificationPreferences.recipientsPushEnabled(
          recipientUserIds,
          NotificationPreferenceCategory.Quizshow,
        );
      if (pushEnabledUserIds.length === 0) return;
      const audibleUserIds =
        await this.notificationDelivery.recipientsOutsideQuietHours(
          pushEnabledUserIds,
        );
      if (audibleUserIds.length === 0) return;
      await this.previewPrivacy.sendSplitByPreviewPreference(audibleUserIds, {
        title: 'Pulse Live is starting',
        body: `${input.eventTitle} live game is starting, join with code ${input.joinCode}`,
        tag: `quizshow:${input.sessionId}`,
        data: { url: `/play/${input.joinCode}` },
        timestamp: input.startedAt.getTime(),
        l10n: {
          titleKey: QUIZSHOW_PUSH_COPY_KEYS.startingTitle,
          bodyKey: QUIZSHOW_PUSH_COPY_KEYS.startingBody,
          params: { event: input.eventTitle, code: input.joinCode },
        },
      });
    } catch (error) {
      this.logger.warn(
        `Live game push failed for session ${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async guestRecipientUserIds(
    eventId: string,
    hostUserId: string | null,
  ): Promise<string[]> {
    const rows: { user_id: string }[] = await this.dataSource.query(
      `SELECT "rsvp"."user_id" AS "user_id"
       FROM "event_rsvps" "rsvp"
       WHERE "rsvp"."event_id" = $1
         AND "rsvp"."status" = 'going'
         AND ($2::uuid IS NULL OR "rsvp"."user_id" <> $2::uuid)
         AND NOT EXISTS (
           SELECT 1 FROM "event_cohosts" "cohost"
           WHERE "cohost"."event_id" = $1
             AND "cohost"."user_id" = "rsvp"."user_id")
         AND NOT EXISTS (
           SELECT 1 FROM "event_bans" "ban"
           WHERE "ban"."event_id" = $1
             AND "ban"."user_id" = "rsvp"."user_id")
         AND ($2::uuid IS NULL OR NOT EXISTS (
           SELECT 1 FROM "blocks" "block"
           WHERE ("block"."blocker_id" = $2::uuid
                  AND "block"."blocked_id" = "rsvp"."user_id")
              OR ("block"."blocked_id" = $2::uuid
                  AND "block"."blocker_id" = "rsvp"."user_id")))`,
      [eventId, hostUserId],
    );
    return rows.map((row) => row.user_id);
  }
}
