import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Notification,
  NotificationType,
} from '../notifications/entities/notification.entity';
import { NOTIFICATION_BATCH_CREATED } from '../notifications/notification.events';
import type { NotificationBatchCreatedEvent } from '../notifications/notification.events';
import { actorIdOf } from '../notifications/notification-response';
import { NotificationPreferenceCategory } from '../notifications/notification-preferences';
import { NotificationPreferencesService } from '../notifications/notification-preferences.service';
import { isStorageKey } from '../storage/storage-key';
import { Profile } from '../users/entities/profile.entity';
import { PushService } from './push.service';

/**
 * Turns persisted in-app notifications into phone pushes for a curated WHITELIST
 * of types. `NOTIFICATION_BATCH_CREATED` fires once per WRITE — one recipient
 * (`NotificationsService.create`) or a whole fan-out
 * (`NotificationsService.createForRecipients`) alike — carrying
 * `{ userIds, type, payload, actorId, notification }`, a single representative
 * row plus the full recipient list, so a single listener covers almost every
 * new push type without touching the emitting services AND without re-running
 * the category gate / actor lookup / send once per recipient (that per-row
 * cost is exactly what `NOTIFICATION_CREATED` — a different event, consumed by
 * the chat gateway for the live socket feed — would produce if this listener
 * used it instead; see `notification.events.ts`).
 *
 * The set of pushed types is a whitelist, NEVER a blocklist — everything not
 * named in the switch is silently ignored. Two exclusions are load-bearing:
 * `NewMessage` and `EventReminder` already push from `push.listener.ts` and
 * `event-reminders.service.ts` respectively, so handling them here too would
 * double-send. Being absent from the switch is exactly how they are excluded.
 *
 * The backend stays language-neutral: every push sets an English `title`/`body`
 * fallback AND `l10n.titleKey`/`bodyKey` (+ resolved `params`) so the service
 * worker can localise (queerpulse/src/pushMessages.ts). Display strings (actor
 * name, event title) are resolved best-effort for `params`; the whole handler is
 * wrapped in try/catch so a failed lookup degrades to the English fallback or
 * skips entirely — a push side effect must never throw back into the emitter.
 */
@Injectable()
export class PushNotificationListener {
  private readonly logger = new Logger(PushNotificationListener.name);

  constructor(
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly pushService: PushService,
    private readonly notificationPreferences: NotificationPreferencesService,
  ) {}

  @OnEvent(NOTIFICATION_BATCH_CREATED)
  async handleNotificationBatchCreated(
    event: NotificationBatchCreatedEvent,
  ): Promise<void> {
    try {
      const { userIds, notification } = event;
      switch (notification.type) {
        case NotificationType.ConnectionRequest:
        case NotificationType.ConnectionAccepted:
          await this.pushConnection(userIds, notification);
          return;
        case NotificationType.Mention:
          await this.pushMention(userIds, notification);
          return;
        case NotificationType.ForumReply:
        case NotificationType.ForumThreadReply:
          await this.pushForumReply(userIds, notification);
          return;
        case NotificationType.VouchReceived:
          await this.pushVouch(userIds, notification);
          return;
        case NotificationType.SafeSpaceVouch:
          await this.pushSafeSpaceVouch(userIds, notification);
          return;
        case NotificationType.EventUpdated:
        case NotificationType.EventCancelled:
          await this.pushEvent(userIds, notification);
          return;
        // Whitelist: every other type — CRITICALLY `NewMessage` and
        // `EventReminder`, which already push elsewhere — falls through here and
        // produces no push. Do NOT add them; doing so double-sends.
        default:
          return;
      }
    } catch (error) {
      // Push is best-effort and must never affect notification delivery.
      this.logger.warn(`Push on notification failed: ${String(error)}`);
    }
  }

  // --- Per-type handlers ----------------------------------------------------

  private async pushConnection(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.Connections,
    );
    if (recipientUserIds.length === 0) return;
    const actor = await this.resolveActor(notification);
    const name = this.displayName(actor);
    const isRequest = notification.type === NotificationType.ConnectionRequest;
    // Deep-link to the actor's profile; fall back to the connections list when
    // the actor can no longer be resolved (never a broken/empty link).
    const url = actor ? `/members/${actor.slug}` : '/account/connections';
    await this.pushService.sendToUsers(recipientUserIds, {
      title: isRequest ? 'New connection request' : 'Connection accepted',
      body: isRequest
        ? `${name} wants to connect with you.`
        : `${name} accepted your connection request.`,
      tag: `notification:${notification.id}`,
      data: { url },
      ...this.iconOf(actor),
      l10n: {
        titleKey: isRequest
          ? 'push:connection.request.title'
          : 'push:connection.accepted.title',
        bodyKey: isRequest
          ? 'push:connection.request.body'
          : 'push:connection.accepted.body',
        params: { name },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  private async pushMention(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.Mentions,
    );
    if (recipientUserIds.length === 0) return;
    const actor = await this.resolveActor(notification);
    const name = this.displayName(actor);
    await this.pushService.sendToUsers(recipientUserIds, {
      title: 'You were mentioned',
      body: `${name} mentioned you.`,
      tag: `notification:${notification.id}`,
      data: { url: this.threadUrl(notification) },
      ...this.iconOf(actor),
      l10n: {
        titleKey: 'push:mention.title',
        bodyKey: 'push:mention.body',
        params: { name },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  private async pushForumReply(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.CommunityReplies,
    );
    if (recipientUserIds.length === 0) return;
    const actor = await this.resolveActor(notification);
    const name = this.displayName(actor);
    await this.pushService.sendToUsers(recipientUserIds, {
      title: 'New reply',
      body: `${name} replied to you.`,
      tag: `notification:${notification.id}`,
      data: { url: this.threadUrl(notification) },
      ...this.iconOf(actor),
      l10n: {
        titleKey: 'push:forumReply.title',
        bodyKey: 'push:forumReply.body',
        params: { name },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  private async pushVouch(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.Vouches,
    );
    if (recipientUserIds.length === 0) return;
    const actor = await this.resolveActor(notification);
    const name = this.displayName(actor);
    // Deep-link to the voucher's profile; the notifications centre otherwise.
    const url = actor ? `/members/${actor.slug}` : '/notifications';
    await this.pushService.sendToUsers(recipientUserIds, {
      title: 'You received a vouch',
      body: `${name} vouched for you.`,
      tag: `notification:${notification.id}`,
      data: { url },
      ...this.iconOf(actor),
      l10n: {
        titleKey: 'push:vouch.received.title',
        bodyKey: 'push:vouch.received.body',
        params: { name },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  private async pushSafeSpaceVouch(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.Vouches,
    );
    if (recipientUserIds.length === 0) return;
    // The voucher — `null` (so `name` → "Someone") for an anonymous vouch, whose
    // emit site omits `voucherId` from the payload. The space name/slug are
    // carried on the payload by the emit site (no extra listing lookup here).
    const actor = await this.resolveActor(notification);
    const name = this.displayName(actor);
    const space = this.payloadString(notification, 'spaceName') ?? 'your space';
    const spaceSlug = this.payloadString(notification, 'spaceSlug');
    // Deep-link the owner to their space's detail page; fall back to the Safe
    // Spaces directory when the slug is somehow absent (never a broken link).
    const url = spaceSlug
      ? `/local/directory/${spaceSlug}`
      : '/local/safe-spaces';
    await this.pushService.sendToUsers(recipientUserIds, {
      title: 'New vouch for your safe space',
      body: `${name} vouched for ${space}.`,
      tag: `notification:${notification.id}`,
      data: { url },
      ...this.iconOf(actor),
      l10n: {
        titleKey: 'push:safeSpace.vouch.title',
        bodyKey: 'push:safeSpace.vouch.body',
        params: { name, space },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  private async pushEvent(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    // Event changed/cancelled are always-on (important + infrequent, no toggle),
    // exactly like their in-app rows — no category gate, so every recipient in
    // the batch goes straight to `sendToUsers` with no preference query at all.
    const isCancelled = notification.type === NotificationType.EventCancelled;
    // The emitter already resolved and carried `title` + `eventSlug` in the
    // payload (see events.service.ts), so these are read from there rather than
    // via an extra event lookup. A missing title degrades to a neutral fallback.
    const title = this.payloadString(notification, 'title') ?? 'A gathering';
    const eventSlug = this.payloadString(notification, 'eventSlug');
    const url = eventSlug ? `/events/${eventSlug}` : '/events';
    await this.pushService.sendToUsers(userIds, {
      title: isCancelled ? 'Event cancelled' : 'Event updated',
      body: isCancelled
        ? `${title} has been cancelled.`
        : `${title} has new details — tap to see what changed.`,
      tag: `notification:${notification.id}`,
      data: { url },
      l10n: {
        titleKey: isCancelled
          ? 'push:event.cancelled.title'
          : 'push:event.updated.title',
        bodyKey: isCancelled
          ? 'push:event.cancelled.body'
          : 'push:event.updated.body',
        params: { event: title },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  // --- Shared helpers -------------------------------------------------------

  /**
   * The subset of `userIds` that still want a phone push for `category` — one
   * batched `recipientsPushEnabled` query for the WHOLE notification-type
   * batch, not one call per recipient (the fix for the N+1 this listener used
   * to reintroduce on `NOTIFICATION_CREATED`'s per-recipient fan-out — see
   * `NOTIFICATION_BATCH_CREATED`'s docstring).
   */
  private async pushEnabledRecipients(
    userIds: string[],
    category: NotificationPreferenceCategory,
  ): Promise<string[]> {
    return this.notificationPreferences.recipientsPushEnabled(
      userIds,
      category,
    );
  }

  /**
   * The acting member's profile, or `null` when the type carries no actor or the
   * actor can no longer be resolved. Reuses `actorIdOf` (the same per-type
   * payload-key map the bell uses) so actor resolution stays in one place.
   */
  private async resolveActor(
    notification: Notification,
  ): Promise<Profile | null> {
    const actorId = actorIdOf(notification);
    if (!actorId) return null;
    return (
      (await this.profiles.findOne({ where: { userId: actorId } })) ?? null
    );
  }

  private displayName(profile: Profile | null): string {
    if (!profile) return 'Someone';
    const name = [profile.firstName, profile.lastName]
      .filter((part) => !!part)
      .join(' ')
      .trim();
    return name || 'Someone';
  }

  /**
   * A conditional `{ icon }` spread — the actor's avatar, but ONLY when it is an
   * absolute public https URL a push client can fetch without our session cookie
   * (the same public-https-only rule as `push.listener.ts`). A storage-key
   * avatar resolves to our auth-gated `/files/*` route, so we omit `icon`
   * entirely rather than ship a URL that renders as a broken image.
   */
  private iconOf(
    profile: Profile | null,
  ): { icon: string } | Record<string, never> {
    const raw = profile?.avatarUrl;
    return raw && !isStorageKey(raw) && raw.startsWith('https://')
      ? { icon: raw }
      : {};
  }

  /** `/thread/{slug}` for a forum mention/reply, else the notifications centre. */
  private threadUrl(notification: Notification): string {
    const source = this.payloadString(notification, 'source');
    const threadSlug = this.payloadString(notification, 'threadSlug');
    return source === 'forum' && threadSlug
      ? `/thread/${threadSlug}`
      : '/notifications';
  }

  /** A string field from the notification payload, or `undefined`. */
  private payloadString(
    notification: Notification,
    key: string,
  ): string | undefined {
    const value = notification.payload?.[key];
    return typeof value === 'string' && value ? value : undefined;
  }
}
