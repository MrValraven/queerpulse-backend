import { Injectable, Logger } from '@nestjs/common';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';

/** `payload.source`, which the frontend's deep-link builder reads first. */
export const SAFE_SPACE_NOTIFICATION_SOURCE = 'safe-space';

/**
 * The `payload.action` vocabulary for every safe-space review notification.
 *
 * These ride on `NotificationType.SafeSpaceReview` (DES-417), which carries
 * no actor, sits outside every preference toggle and is always delivered.
 * Carrying no actor is what keeps a flagger anonymous:
 * `NotificationsService.create` resolves the bell's "who" from the actor
 * argument, so passing none means no notification in this domain can ever
 * name the member who raised a flag.
 *
 * The payload is codes and names only. `SafeSpaceReview`'s allowlist is
 * `['action', 'audience', 'placeName', 'reason']`, unioned with the common
 * routing keys (`source`, `listingSlug`), and the frontend writes the sentence
 * in the member's own language from `action` and `audience`.
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

/** Which side of a safe-space review the recipients of one bell are on. */
export type SafeSpaceNotificationAudience =
  'nominator' | 'owner' | 'flagger' | 'staff';

/** The structured facts one safe-space review bell carries. */
export interface SafeSpaceNotificationDetails {
  audience: SafeSpaceNotificationAudience;
  placeName?: string | null;
  reason?: string | null;
  listingSlug?: string | null;
}

/**
 * One place every safe-space review notification goes through, so the anonymity
 * rule and the best-effort rule are stated once here and the eleven call sites
 * share them.
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
   *
   * `details.audience` says which side of the review the recipients are on,
   * so one action code can read differently to a nominator and to the owner.
   * `placeName` is the venue's public name, `reason` the moderator's word to
   * a nominator on a decline, and `listingSlug` the deep link to the venue.
   */
  async tell(
    recipientIds: (string | null | undefined)[],
    action: SafeSpaceNotificationActionCode,
    details: SafeSpaceNotificationDetails,
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
        NotificationType.SafeSpaceReview,
        {
          source: SAFE_SPACE_NOTIFICATION_SOURCE,
          action,
          audience: details.audience,
          ...(details.placeName ? { placeName: details.placeName } : {}),
          ...(details.reason ? { reason: details.reason } : {}),
          ...(details.listingSlug ? { listingSlug: details.listingSlug } : {}),
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
