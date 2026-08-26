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
import { NotificationDeliveryService } from '../notifications/notification-delivery.service';
import { isStorageKey } from '../storage/storage-key';
import { Profile } from '../users/entities/profile.entity';
import { GENERIC_PUSH_COPY } from './generic-push-copy';
import { PushPreviewPrivacyService } from './push-preview-privacy.service';
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
 *
 * ---------------------------------------------------------------------------
 * LOCK-SCREEN PRIVACY: send through `previewPrivacy`, never `pushService` (ID-13)
 * ---------------------------------------------------------------------------
 * Every handler below composes the RICH payload (the actor's name in `body`,
 * their name again in `l10n.params`, their avatar in `icon`) and hands it to
 * `PushPreviewPrivacyService.sendSplitByPreviewPreference`, which splits the
 * recipient list by `member_preferences.hide_push_previews` and sends the
 * generic payload to anyone hiding previews.
 *
 * This has to happen HERE rather than in the service worker, because iOS never
 * runs the worker's push handler: it renders the payload's plain `title`/`body`
 * itself. A name that reaches an iPhone in a payload reaches its lock screen.
 * See `push-preview-privacy.service.ts` for the whole argument.
 *
 * So: a new handler calls `sendSplitByPreviewPreference`. Calling
 * `this.pushService.sendToUsers` directly is a privacy bug even when the copy
 * looks harmless today, because the copy is what changes. The ONE exception in
 * this file is `pushSecurityNewSignIn`, which has no rich variant at all,
 * because its only copy is already generic. It says so at its own docstring.
 */
@Injectable()
export class PushNotificationListener {
  private readonly logger = new Logger(PushNotificationListener.name);

  constructor(
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly pushService: PushService,
    private readonly previewPrivacy: PushPreviewPrivacyService,
    private readonly notificationPreferences: NotificationPreferencesService,
    private readonly notificationDelivery: NotificationDeliveryService,
  ) {}

  @OnEvent(NOTIFICATION_BATCH_CREATED)
  async handleNotificationBatchCreated(
    event: NotificationBatchCreatedEvent,
  ): Promise<void> {
    try {
      const { notification } = event;
      // Quiet hours, applied ONCE for the whole batch and before the per-type
      // switch, so every push path below inherits it and none can forget to.
      //
      // This suppresses the PUSH and nothing else. The in-app row was already
      // written by `NotificationsService` before this event fired, so a member
      // inside their window loses no notification: it is waiting in the bell
      // when they wake up. Withholding the buzz is the entire promise the
      // setting makes, and the 3am push that contradicted it is the bug this
      // closes.
      const userIds =
        await this.notificationDelivery.recipientsOutsideQuietHours(
          event.userIds,
        );
      if (userIds.length === 0) return;
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
        case NotificationType.HousingListingMatch:
          await this.pushHousingMatch(userIds, notification);
          return;
        case NotificationType.HousingListingDecision:
          await this.pushHousingDecision(userIds, notification);
          return;
        // A gathering has named this member's venue (LOC-16). Always-on: it is
        // the platform telling a business its name has been attached to
        // somebody else's event, which is a decision about something of
        // theirs rather than social chatter, and the only prompt to confirm
        // or detach.
        case NotificationType.VenueEventAttachment:
          await this.pushVenueEventAttachment(userIds, notification);
          return;
        case NotificationType.TopicNewPost:
          await this.pushTopicNewPost(userIds, notification);
          return;
        // The four approval queues (LOC-19). Each is the platform's answer to
        // a member's own submission, so all four push unconditionally: no
        // category gates them (they map to no `NotificationPreferenceCategory`
        // at all), exactly like `pushEvent`'s always-on types.
        case NotificationType.ReadingGroupProposalDecided:
          await this.pushReadingGroupProposalDecided(userIds, notification);
          return;
        case NotificationType.GroupListingDecided:
          await this.pushGroupListingDecided(userIds, notification);
          return;
        case NotificationType.LandlordSuggestionDecided:
          await this.pushLandlordSuggestionDecided(userIds, notification);
          return;
        case NotificationType.LandlordIntroRequestDecided:
          await this.pushLandlordIntroRequestDecided(userIds, notification);
          return;
        // A sign-in from a device the member has not used before (ID-06).
        // No `NotificationPreferenceCategory` gate, deliberately: the member's
        // own switch (`member_preferences.login_alerts_enabled`) is enforced at
        // the EMIT site in `AuthService.issueTokens`, so this row exists only
        // because they asked to hear about it. Gating it a second time here
        // would mean a content-volume category could silence a security alert.
        case NotificationType.SecurityNewSignIn:
          await this.pushSecurityNewSignIn(userIds, notification);
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
    await this.previewPrivacy.sendSplitByPreviewPreference(recipientUserIds, {
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
    await this.previewPrivacy.sendSplitByPreviewPreference(recipientUserIds, {
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
    await this.previewPrivacy.sendSplitByPreviewPreference(recipientUserIds, {
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
    await this.previewPrivacy.sendSplitByPreviewPreference(recipientUserIds, {
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
    await this.previewPrivacy.sendSplitByPreviewPreference(recipientUserIds, {
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
    await this.previewPrivacy.sendSplitByPreviewPreference(userIds, {
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

  /**
   * The moderator's decision on the member's OWN housing listing (LOC-01).
   *
   * Always-on, no category gate, mirroring `pushHousingMatch` and for a
   * stronger reason: this is the platform answering a submission the member
   * made, and "your home is live" or "we need you to change something" is
   * exactly the message that has to reach a phone rather than wait for the
   * next time they open the app. The moderator's reason is deliberately NOT in
   * the push body: it can be long and it can be sensitive on a lock screen, so
   * the push says what happened and the notification the member taps through to
   * carries the words.
   */
  private async pushHousingDecision(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const title = this.payloadString(notification, 'title') ?? 'Your listing';
    const decision = this.payloadString(notification, 'decision');
    const slug = this.payloadString(notification, 'slug');
    // An approved listing is publicly browsable, so the member can be sent
    // straight to it; anything else lives on their own management view.
    const url =
      decision === 'approve' && slug ? `/housing/${slug}` : '/housing/mine';
    const COPY: Record<string, { title: string; body: string; key: string }> = {
      approve: {
        title: 'Your home is live',
        body: `${title} is now on the housing board.`,
        key: 'approved',
      },
      request_changes: {
        title: 'Your listing needs a change',
        body: `A moderator asked for a change to ${title}. Open it to see what.`,
        key: 'changesRequested',
      },
      reject: {
        title: 'Your listing was not published',
        body: `${title} was not published. Open it to see why.`,
        key: 'rejected',
      },
      take_down: {
        title: 'Your listing was removed',
        body: `${title} was removed from the housing board. Open it to see why.`,
        key: 'takenDown',
      },
    };
    const copy = decision ? COPY[decision] : undefined;
    if (!copy) return;
    await this.previewPrivacy.sendSplitByPreviewPreference(userIds, {
      title: copy.title,
      body: copy.body,
      tag: `notification:${notification.id}`,
      data: { url },
      l10n: {
        titleKey: `push:housing.decision.${copy.key}.title`,
        bodyKey: `push:housing.decision.${copy.key}.body`,
        params: { title },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * A gathering has named this member's listing as its venue (LOC-16).
   *
   * Always-on, straight to `sendToUsers`: the recipient is the venue owner, and
   * this is the one prompt that lets them confirm or detach before the
   * attachment reaches the public page. The deep link goes to the listing
   * rather than the gathering, because confirm and detach live on the owner's
   * side of the listing.
   *
   * No actor is named anywhere here, matching the notification itself: running
   * this through the block filter would let a host the owner has blocked attach
   * a gathering to that owner's page and silently suppress the only warning
   * they would get.
   */
  private async pushVenueEventAttachment(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const listingName =
      this.payloadString(notification, 'listingName') ?? 'Your venue';
    const eventTitle =
      this.payloadString(notification, 'eventTitle') ?? 'a gathering';
    const listingSlug = this.payloadString(notification, 'listingSlug');
    const url = listingSlug
      ? `/local/directory/${listingSlug}`
      : '/local/directory';
    await this.previewPrivacy.sendSplitByPreviewPreference(userIds, {
      title: 'A gathering at your venue',
      body: `${listingName} has been named as the venue for "${eventTitle}".`,
      tag: `notification:${notification.id}`,
      data: { url },
      l10n: {
        titleKey: 'push:venue.attachment.title',
        bodyKey: 'push:venue.attachment.body',
        params: { listingName, eventTitle },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  private async pushHousingMatch(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    // Always-on (no category gate): the member's saved-search `alertsEnabled`
    // flag is the consent that produced this notification at all, so every
    // recipient in the batch goes straight to `sendToUsers` — mirroring how
    // `pushEvent` treats its always-on types.
    const title = this.payloadString(notification, 'title') ?? 'A new home';
    const area = this.payloadString(notification, 'area');
    const slug = this.payloadString(notification, 'slug');
    const url = slug ? `/housing/${slug}` : '/housing';
    await this.previewPrivacy.sendSplitByPreviewPreference(userIds, {
      title: 'A home matches your search',
      body: area
        ? `${title} in ${area} matches a search you saved.`
        : `${title} matches a search you saved.`,
      tag: `notification:${notification.id}`,
      data: { url },
      l10n: {
        titleKey: 'push:housing.match.title',
        bodyKey: area
          ? 'push:housing.match.body'
          : 'push:housing.match.bodyNoArea',
        params: { title, area: area ?? '' },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  private async pushTopicNewPost(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    // Always-on (no category gate), like `pushHousingMatch`: the topic FOLLOW
    // itself is the member's consent — see
    // `TopicFollowNotificationsListener`'s docstring for why no
    // `NotificationPreferenceCategory` gates this type.
    const actor = await this.resolveActor(notification);
    const name = this.displayName(actor);
    const topic = this.payloadString(notification, 'topicLabel') ?? 'a topic';
    await this.previewPrivacy.sendSplitByPreviewPreference(userIds, {
      title: 'New post in a topic you follow',
      body: `${name} posted in #${topic}.`,
      tag: `notification:${notification.id}`,
      data: { url: this.threadUrl(notification) },
      ...this.iconOf(actor),
      l10n: {
        titleKey: 'push:topic.newPost.title',
        bodyKey: 'push:topic.newPost.body',
        params: { name, topic },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * "Your reading group proposal was decided" (LOC-19). An approval deep-links
   * to the community the member now owns; a decline goes to the notifications
   * centre, where the reviewer's reason is readable in full.
   */
  private async pushReadingGroupProposalDecided(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const isApproved =
      this.payloadString(notification, 'decision') === 'approved';
    const book = this.payloadString(notification, 'book') ?? 'your book';
    const communitySlug = this.payloadString(notification, 'communitySlug');
    const url =
      isApproved && communitySlug
        ? `/community/${communitySlug}`
        : '/notifications';
    await this.previewPrivacy.sendSplitByPreviewPreference(userIds, {
      title: isApproved
        ? 'Your reading group is live'
        : 'About your reading group proposal',
      body: isApproved
        ? `${book} has its own space now, and you own it.`
        : `We could not take ${book} forward. Tap to read why.`,
      tag: `notification:${notification.id}`,
      data: { url },
      l10n: {
        titleKey: isApproved
          ? 'push:readingGroupProposal.approved.title'
          : 'push:readingGroupProposal.declined.title',
        bodyKey: isApproved
          ? 'push:readingGroupProposal.approved.body'
          : 'push:readingGroupProposal.declined.body',
        params: { book },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /** "Your group listing was reviewed" (LOC-19). */
  private async pushGroupListingDecided(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const decision = this.payloadString(notification, 'decision');
    const title =
      this.payloadString(notification, 'listingTitle') ?? 'Your listing';
    const groupSlug = this.payloadString(notification, 'groupSlug');
    // A published listing deep-links to the group page it is now on; anything
    // else goes to the notifications centre, where the moderator's words are.
    const url =
      decision === 'live' && groupSlug
        ? `/local/housing/groups/${groupSlug}`
        : '/notifications';
    const isLive = decision === 'live';
    const isQuestion = decision === 'question';
    await this.previewPrivacy.sendSplitByPreviewPreference(userIds, {
      title: isLive
        ? 'Your listing is live'
        : isQuestion
          ? 'A question about your listing'
          : 'About your listing',
      body: isLive
        ? `${title} is now on the group's board.`
        : isQuestion
          ? `Moderators need one thing cleared up about ${title}.`
          : `${title} was not published. Tap to read why.`,
      tag: `notification:${notification.id}`,
      data: { url },
      l10n: {
        titleKey: isLive
          ? 'push:groupListing.live.title'
          : isQuestion
            ? 'push:groupListing.question.title'
            : 'push:groupListing.declined.title',
        bodyKey: isLive
          ? 'push:groupListing.live.body'
          : isQuestion
            ? 'push:groupListing.question.body'
            : 'push:groupListing.declined.body',
        params: { title },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /** "The landlord you suggested was decided on" (LOC-19). */
  private async pushLandlordSuggestionDecided(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const decision = this.payloadString(notification, 'decision');
    const name =
      this.payloadString(notification, 'landlordName') ?? 'the entry';
    const slug = this.payloadString(notification, 'landlordSlug');
    const isLive = decision === 'live';
    const url = isLive && slug ? `/work/landlord/${slug}` : '/notifications';
    await this.previewPrivacy.sendSplitByPreviewPreference(userIds, {
      title: isLive
        ? 'Your landlord suggestion is live'
        : 'About your landlord suggestion',
      body: isLive
        ? `${name} is in the directory now. Thank you.`
        : `${name} did not make it into the directory. Tap to read why.`,
      tag: `notification:${notification.id}`,
      data: { url },
      l10n: {
        titleKey: isLive
          ? 'push:landlordSuggestion.live.title'
          : 'push:landlordSuggestion.notLive.title',
        bodyKey: isLive
          ? 'push:landlordSuggestion.live.body'
          : 'push:landlordSuggestion.notLive.body',
        params: { name },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /** "Your landlord introduction request was answered" (LOC-19). */
  private async pushLandlordIntroRequestDecided(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const isAccepted =
      this.payloadString(notification, 'decision') === 'accepted';
    const name =
      this.payloadString(notification, 'landlordName') ?? 'the landlord';
    const slug = this.payloadString(notification, 'landlordSlug');
    const url = slug ? `/work/landlord/${slug}` : '/notifications';
    await this.previewPrivacy.sendSplitByPreviewPreference(userIds, {
      title: isAccepted
        ? 'Your introduction is being made'
        : 'About your introduction request',
      body: isAccepted
        ? `Someone is putting you in touch with ${name}.`
        : `We could not make the introduction to ${name}. Tap to read why.`,
      tag: `notification:${notification.id}`,
      data: { url },
      l10n: {
        titleKey: isAccepted
          ? 'push:landlordIntro.accepted.title'
          : 'push:landlordIntro.declined.title',
        bodyKey: isAccepted
          ? 'push:landlordIntro.accepted.body'
          : 'push:landlordIntro.declined.body',
        params: { name },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * "A new device signed in to your account" (ID-06).
   *
   * THE ONE SENDER IN THIS FILE THAT DOES NOT SPLIT BY PREVIEW PREFERENCE, and
   * the reason is that there is nothing to split: this copy is already the
   * generic copy. It names no member, carries no actor, no avatar and no
   * image, so hiding previews would replace one non-identifying sentence with a
   * vaguer one and cost the member the single fact that makes the notification
   * worth unlocking for.
   *
   * THE DEVICE LABEL IS DELIBERATELY ABSENT from the body. "Safari on iPhone"
   * is right on the in-app row and on `/account/sessions`, where the member is
   * already looking at their own account. On a lock screen it is a detail a
   * bystander can read, and it changes nothing about what the member does next:
   * they open the app either way. The label is in the notification payload and
   * on the sessions page, one tap away.
   *
   * Deep-links to `/account/sessions`, the one place the member can end the
   * session they do not recognise.
   */
  private async pushSecurityNewSignIn(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    await this.pushService.sendToUsers(userIds, {
      // The same product-name title a hidden-preview push uses, from the same
      // constant, so the two can never drift apart on a lock screen.
      title: GENERIC_PUSH_COPY.notification.title,
      body: 'A new device signed in to your account.',
      tag: `notification:${notification.id}`,
      data: { url: '/account/sessions' },
      l10n: {
        titleKey: GENERIC_PUSH_COPY.notification.titleKey,
        bodyKey: 'notifications:type.security_new_sign_in.push',
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
