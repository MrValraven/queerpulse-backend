import { Notification } from './entities/notification.entity';

/**
 * Internal `@nestjs/event-emitter` topic fired once per persisted notification
 * row (see {@link NotificationsService.create} / `createForRecipients`).
 *
 * NOTE — this is the **event-emitter topic name**, not a socket event name.
 * The chat gateway consumes this and re-emits it to the recipient's
 * `user:${userId}` room as the socket event `notification:new`. The two
 * namespaces are separate on purpose; do not "align" them (same trap as
 * `MESSAGE_CREATED` → `message:new`).
 */
export const NOTIFICATION_CREATED = 'notification.created';

export interface NotificationCreatedEvent {
  /** Recipient — the gateway fans out to this member's user room. */
  userId: string;
  /**
   * The persisted row, in the same shape `GET /notifications` serves, so a
   * pushed notification and a fetched one are interchangeable to the client.
   */
  notification: Notification;
}
