import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Notification,
  NotificationType,
} from '../notifications/entities/notification.entity';
import { NOTIFICATION_CREATED } from '../notifications/notification.events';
import type { NotificationCreatedEvent } from '../notifications/notification.events';
import { actorIdOf } from '../notifications/notification-response';
import { NotificationPreferenceCategory } from '../notifications/notification-preferences';
import { NotificationPreferencesService } from '../notifications/notification-preferences.service';
import { isStorageKey } from '../storage/storage-key';
import { Profile } from '../users/entities/profile.entity';
import { PushService } from './push.service';

/**
 * Turns persisted in-app notifications into phone pushes for a curated WHITELIST
 * of types. `NOTIFICATION_CREATED` fires once per recipient per persisted row
 * (`NotificationsService.create`/`createForRecipients`), carrying
 * `{ userId, notification }`, so a single listener covers almost every new push
 * type without touching the emitting services.
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

  @OnEvent(NOTIFICATION_CREATED)
  async handleNotificationCreated(
    event: NotificationCreatedEvent,
  ): Promise<void> {
    try {
      const { userId, notification } = event;
      switch (notification.type) {
        case NotificationType.ConnectionRequest:
        case NotificationType.ConnectionAccepted:
          await this.pushConnection(userId, notification);
          return;
        case NotificationType.Mention:
          await this.pushMention(userId, notification);
          return;
        case NotificationType.ForumReply:
        case NotificationType.ForumThreadReply:
          await this.pushForumReply(userId, notification);
          return;
        case NotificationType.VouchReceived:
          await this.pushVouch(userId, notification);
          return;
        case NotificationType.SafeSpaceVouch:
          await this.pushSafeSpaceVouch(userId, notification);
          return;
        case NotificationType.EventUpdated:
        case NotificationType.EventCancelled:
          await this.pushEvent(userId, notification);
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
    userId: string,
    notification: Notification,
  ): Promise<void> {
    if (
      !(await this.categoryEnabled(
        userId,
        NotificationPreferenceCategory.Connections,
      ))
    ) {
      return;
    }
    const actor = await this.resolveActor(notification);
    const name = this.displayName(actor);
    const isRequest = notification.type === NotificationType.ConnectionRequest;
    // Deep-link to the actor's profile; fall back to the connections list when
    // the actor can no longer be resolved (never a broken/empty link).
    const url = actor ? `/members/${actor.slug}` : '/account/connections';
    await this.pushService.sendToUsers([userId], {
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
    userId: string,
    notification: Notification,
  ): Promise<void> {
    if (
      !(await this.categoryEnabled(
        userId,
        NotificationPreferenceCategory.Mentions,
      ))
    ) {
      return;
    }
    const actor = await this.resolveActor(notification);
    const name = this.displayName(actor);
    await this.pushService.sendToUsers([userId], {
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
    userId: string,
    notification: Notification,
  ): Promise<void> {
    if (
      !(await this.categoryEnabled(
        userId,
        NotificationPreferenceCategory.CommunityReplies,
      ))
    ) {
      return;
    }
    const actor = await this.resolveActor(notification);
    const name = this.displayName(actor);
    await this.pushService.sendToUsers([userId], {
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
    userId: string,
    notification: Notification,
  ): Promise<void> {
    if (
      !(await this.categoryEnabled(
        userId,
        NotificationPreferenceCategory.Vouches,
      ))
    ) {
      return;
    }
    const actor = await this.resolveActor(notification);
    const name = this.displayName(actor);
    // Deep-link to the voucher's profile; the notifications centre otherwise.
    const url = actor ? `/members/${actor.slug}` : '/notifications';
    await this.pushService.sendToUsers([userId], {
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
    userId: string,
    notification: Notification,
  ): Promise<void> {
    if (
      !(await this.categoryEnabled(
        userId,
        NotificationPreferenceCategory.Vouches,
      ))
    ) {
      return;
    }
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
    await this.pushService.sendToUsers([userId], {
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
    userId: string,
    notification: Notification,
  ): Promise<void> {
    // Event changed/cancelled are always-on (important + infrequent, no toggle),
    // exactly like their in-app rows — no category gate.
    const isCancelled = notification.type === NotificationType.EventCancelled;
    // The emitter already resolved and carried `title` + `eventSlug` in the
    // payload (see events.service.ts), so these are read from there rather than
    // via an extra event lookup. A missing title degrades to a neutral fallback.
    const title = this.payloadString(notification, 'title') ?? 'A gathering';
    const eventSlug = this.payloadString(notification, 'eventSlug');
    const url = eventSlug ? `/events/${eventSlug}` : '/events';
    await this.pushService.sendToUsers([userId], {
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

  /** Whether the recipient still wants a phone push for `category`. */
  private async categoryEnabled(
    userId: string,
    category: NotificationPreferenceCategory,
  ): Promise<boolean> {
    const enabled = await this.notificationPreferences.recipientsPushEnabled(
      [userId],
      category,
    );
    return enabled.length > 0;
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
