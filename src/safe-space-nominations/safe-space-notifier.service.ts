import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';

/** `payload.source`, which the frontend's deep-link builder reads first. */
export const SAFE_SPACE_NOTIFICATION_SOURCE = 'safe-space';

/**
 * The `payload.action` vocabulary for every safe-space review notification.
 *
 * These ride on `NotificationType.ModerationOutcome`, which is the repo's
 * "the platform is telling you the outcome of a review" type: no actor, no
 * preference toggle, always delivered. That is exactly right here for three
 * reasons. A badge suspension IS a moderation outcome landing on a venue
 * owner. Nobody may mute it. And carrying no actor is what keeps a flagger
 * anonymous: `NotificationsService.create` resolves the bell's "who" from the
 * actor argument, so passing none means no notification in this domain can
 * ever name the member who raised a flag.
 *
 * `ModerationOutcome`'s payload allowlist is `['action', 'note']`, unioned
 * with the common routing keys (`source`, `listingSlug`), so exactly these
 * four fields reach the client and nothing else can leak through the payload.
 */
export const SafeSpaceNotificationAction = {
  NominationAcknowledged: 'safe_space_nomination_acknowledged',
  NominationAwarded: 'safe_space_nomination_awarded',
  NominationDeclined: 'safe_space_nomination_declined',
  BadgeSuspended: 'safe_space_badge_suspended',
  BadgeRestored: 'safe_space_badge_restored',
  FlagReviewOpened: 'safe_space_flag_review_opened',
  FlagResolved: 'safe_space_flag_resolved',
  QueueOverdue: 'safe_space_queue_overdue',
} as const;

export type SafeSpaceNotificationActionCode =
  (typeof SafeSpaceNotificationAction)[keyof typeof SafeSpaceNotificationAction];

/**
 * One place every safe-space review notification goes through, so the anonymity
 * rule and the best-effort rule are stated once instead of at nine call sites.
 *
 * BEST EFFORT, ALWAYS. A notification failure must never fail the decision that
 * produced it: a badge suspension that rolled back because the bell was down
 * would be the worst possible outcome of a safety mechanism. Errors are logged
 * and swallowed, matching `SafeSpaceVouchesService.createVouch`.
 *
 * QueerPulse sends no email. These are in-app rows (which the push listener may
 * turn into a phone push) and nothing else.
 */
@Injectable()
export class SafeSpaceNotifierService {
  private readonly logger = new Logger(SafeSpaceNotifierService.name);

  constructor(private readonly notifications: NotificationsService) {}

  /**
   * Tell `recipientIds` the outcome of a safe-space review step. Never passes
   * an actor, so no block, mute or identity can attach to it.
   */
  async tell(
    recipientIds: (string | null | undefined)[],
    action: SafeSpaceNotificationActionCode,
    note: string,
    listingSlug?: string | null,
  ): Promise<void> {
    const recipients = [
      ...new Set(
        recipientIds.filter((userId): userId is string => Boolean(userId)),
      ),
    ];
    if (!recipients.length) return;
    try {
      await this.notifications.createForRecipients(
        recipients,
        NotificationType.ModerationOutcome,
        {
          source: SAFE_SPACE_NOTIFICATION_SOURCE,
          action,
          note,
          ...(listingSlug ? { listingSlug } : {}),
        },
      );
    } catch (error) {
      this.logger.warn(
        `Safe-space ${action} notification failed for ${recipients.length} recipient(s)`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
