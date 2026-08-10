import { Notification, NotificationType } from './entities/notification.entity';

/**
 * Internal `@nestjs/event-emitter` topic fired once per persisted notification
 * row (see {@link NotificationsService.create} / `createForRecipients`).
 *
 * NOTE — this is the **event-emitter topic name**, not a socket event name.
 * The chat gateway consumes this and re-emits it to the recipient's
 * `user:${userId}` room as the socket event `notification:new`. The two
 * namespaces are separate on purpose; do not "align" them (same trap as
 * `MESSAGE_CREATED` → `message:new`).
 *
 * This stays one emission per row (not batched) because the gateway's handler
 * does no DB query — it only re-emits the row it was handed to that
 * recipient's socket room, so N emissions cost nothing beyond N cheap
 * in-memory `emit` calls. See `NOTIFICATION_BATCH_CREATED` below for the event
 * that exists specifically to avoid the O(N) *query* fan-out this one would
 * otherwise cause in listeners that DO hit the database per event.
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

/**
 * Fired exactly ONCE per `create()`/`createForRecipients()` call — a single
 * recipient yields a one-element `userIds`, a fan-out yields every recipient a
 * row was actually saved for (post block/mute + preference filtering).
 *
 * Every row in one write shares the same `type`/`payload`/acting member (a
 * block/mute or preference gate can only ever *drop* a recipient from the
 * batch, never change what the notification says), so a listener that needs
 * that shared context — display copy, the acting member's profile — reads it
 * once from `notification` (any one representative row) instead of resolving
 * it per recipient. Consumers that instead need this shape per-row (the chat
 * gateway, which pushes each recipient their OWN row for their live socket
 * feed) should keep using `NOTIFICATION_CREATED` — this event exists so a
 * listener whose handler hits the database (`PushNotificationListener`'s
 * category gate + actor lookup + push dispatch) does it once per WRITE, not
 * once per RECIPIENT.
 */
export const NOTIFICATION_BATCH_CREATED = 'notification.batch_created';

export interface NotificationBatchCreatedEvent {
  /** Every recipient a row was persisted for in this write, in save order. */
  userIds: string[];
  /** Shared across every row in the batch. */
  type: NotificationType;
  /** Shared across every row in the batch (same object reference). */
  payload: Record<string, unknown>;
  /** The acting member shared by every row in the batch, or `null`. */
  actorId: string | null;
  /**
   * One representative persisted row — used for its `id` (push dedup tag)
   * and `createdAt` (push timestamp). Never read its `userId`; use `userIds`
   * above for the recipient list.
   */
  notification: Notification;
}
