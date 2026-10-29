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
import { bundleKeyFor } from '../notifications/notification-bundling';
import { actorIdOf } from '../notifications/notification-response';
import { NotificationPreferenceCategory } from '../notifications/notification-preferences';
import { NotificationPreferencesService } from '../notifications/notification-preferences.service';
import { NotificationDeliveryService } from '../notifications/notification-delivery.service';
import { Conversation } from '../messaging/entities/conversation.entity';
import {
  displayNameFor,
  memberNameOptionsFor,
} from '../messaging/message-response';
import { GATHERINGS_BOARD_PATH, gatheringPath } from '../events/event-paths';
import { HOST_SWITCHED_OFF_REASON } from '../go-together/go-together-notice-reasons';
import { isStorageKey } from '../storage/storage-key';
import { Profile } from '../users/entities/profile.entity';
import { GENERIC_PUSH_COPY } from './generic-push-copy';
import { PushMessageListener } from './push.listener';
import { PushPreviewPrivacyService } from './push-preview-privacy.service';

/** The Go together meet-again page for one group. Mirrors
 *  `routes.goTogetherFeedback` in the frontend's `routeMap.ts`, the same
 *  link the bell row opens (`notifications.adapters.ts`). */
const GO_TOGETHER_FEEDBACK_PATH = '/go-together/feedback';

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
 * Every push sets an English `title`/`body` fallback AND
 * `l10n.titleKey`/`bodyKey` (+ resolved `params`) so the service worker can
 * localise (queerpulse/src/pushMessages.ts). `PushPreviewPrivacyService`
 * renders the same keys in Portuguese for a `pt` member (PRD-325), so a new key
 * also needs its PT value in `rich-push-copy.ts`. Display strings (actor
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
 * because its only copy is already generic. It sends through
 * `previewPrivacy.sendGenericByLanguage`, which picks the member's language
 * and skips the preview split. It says so at its own docstring.
 */
@Injectable()
export class PushNotificationListener {
  private readonly logger = new Logger(PushNotificationListener.name);

  constructor(
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly previewPrivacy: PushPreviewPrivacyService,
    private readonly notificationPreferences: NotificationPreferencesService,
    private readonly notificationDelivery: NotificationDeliveryService,
    // PRD-336: lets `pushMention` ask, for a message-source mention, which
    // recipients `PushMessageListener` is already covering with a merged
    // push for the identical message (see `pushMention`'s own doc).
    private readonly pushMessageListener: PushMessageListener,
    // PRD-423: tells `pushMention` whether a message mention comes from a
    // matched Go together chat, where members see first names only.
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    // Studio new-release push: the once-per-artist-per-UTC-day claim stamps
    // `pushed_at` on the recipient's row.
    @InjectRepository(Notification)
    private readonly notificationRows: Repository<Notification>,
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
        // A persona this member follows published new work (PRD-208). Gated by
        // the member's own `PersonaFollows` category, so the push and the bell
        // answer to one switch.
        case NotificationType.PersonaUpdate:
          await this.pushPersonaUpdate(userIds, notification);
          return;
        // Studio v2: a persona this member follows put out a release. Same
        // `PersonaFollows` switch as the update above.
        case NotificationType.StudioReleasePublished:
          await this.pushStudioReleasePublished(userIds, notification);
          return;
        // Studio v3: a persona this member follows posted an update. Same
        // `PersonaFollows` switch as the two above.
        case NotificationType.PersonaPost:
          await this.pushPersonaPost(userIds, notification);
          return;
        // Studio artist kinds: a new episode of a show this member follows.
        // Same `PersonaFollows` switch as the release alert.
        case NotificationType.StudioEpisodePublished:
          await this.pushStudioEpisodePublished(userIds, notification);
          return;
        // Studio discovery: credit requests and acceptances, behind the
        // `Personas` switch the persona invites use.
        case NotificationType.StudioCreditRequested:
          await this.pushStudioCreditRequested(userIds, notification);
          return;
        case NotificationType.StudioCreditAccepted:
          await this.pushStudioCreditAccepted(userIds, notification);
          return;
        // Studio landing page: the access grant answers a request, so it
        // pushes unconditionally like the approval queues. The preview
        // notices answer to the `Personas` switch like the credit ones.
        case NotificationType.StudioAccessGranted:
          await this.pushStudioAccessGranted(userIds, notification);
          return;
        case NotificationType.StudioLandingPreviewRequested:
          await this.pushStudioLandingPreviewRequested(userIds, notification);
          return;
        case NotificationType.StudioLandingPreviewLive:
          await this.pushStudioLandingPreviewLive(userIds, notification);
          return;
        // Studio purchases: a claim answers to the `Personas` switch, the
        // buyer's confirmation and decline always arrive. An expired claim
        // stays in the bell.
        case NotificationType.StudioPurchaseClaimed:
          await this.pushStudioPurchaseClaimed(userIds, notification);
          return;
        case NotificationType.StudioPurchaseConfirmed:
          await this.pushStudioPurchaseConfirmed(userIds, notification);
          return;
        case NotificationType.StudioPurchaseDeclined:
          await this.pushStudioPurchaseDeclined(userIds, notification);
          return;
        // Collaborative playlists: an invitation to edit a member's
        // playlist answers to Invitations, a pick as editor of a persona's
        // playlist to Personas. The answers to an invitation stay in the
        // bell.
        case NotificationType.StudioPlaylistEditorInvite:
          await this.pushStudioPlaylistEditorInvite(userIds, notification);
          return;
        case NotificationType.StudioPlaylistEditorAdded:
          await this.pushStudioPlaylistEditorAdded(userIds, notification);
          return;
        // Meet the team: an invite to a persona answers to Personas, a
        // request and a confirmation to Listings.
        case NotificationType.ListingTeamInvite:
          await this.pushListingTeamInvite(userIds, notification);
          return;
        case NotificationType.ListingTeamRequest:
          await this.pushListingTeamRequest(userIds, notification);
          return;
        case NotificationType.ListingTeamAccepted:
          await this.pushListingTeamAccepted(userIds, notification);
          return;
        // Platform staff offering a struggling community help (OPS-05).
        // Always-on, no category gate, for the same reason as the types
        // above: it is the platform reaching the people running a room that
        // is having a hard time, it arrives at most once until they answer
        // it, and the in-app bell is the only other place it lands.
        case NotificationType.CommunitySupportOffered:
          await this.pushCommunitySupportOffered(userIds, notification);
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
        // The verdict on a forum thread its author held back for review. Same
        // always-on reading as the four queues above: it is the platform's
        // answer to something the member themself submitted, and it maps to no
        // `NotificationPreferenceCategory` at all.
        //
        // It pushes where the report types deliberately do not. Those stay off
        // this whitelist because the member is holding the phone that just
        // filed the report; this one lands whenever a moderator reaches the
        // queue, which can be days later and is never a moment the author is
        // watching for. Until it arrives their thread is simply dark.
        case NotificationType.ForumThreadReviewed:
          await this.pushForumThreadReviewed(userIds, notification);
          return;
        // PRD-334. Somebody added this member to a group. Gated by the
        // member's own `NewMessages` category, so the push and the bell answer
        // to one switch.
        case NotificationType.GroupAdded:
          await this.pushGroupAdded(userIds, notification);
          return;
        // PRD-353. An add could not seat this member directly and became an
        // invite instead. Same `NewMessages` gate as `GroupAdded`; the invite
        // itself still appears on `GET /group-invites` regardless of push/bell
        // preferences.
        case NotificationType.GroupInvite:
          await this.pushGroupInvite(userIds, notification);
          return;
        // An admin has offered this member ownership of a listing that has
        // none. Gated by the member's own `Listings` category, so the push
        // and the bell answer to one switch.
        case NotificationType.ListingOwnerOffer:
          await this.pushListingOwnerOffer(userIds, notification);
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
        // Go together: a member invites a friend to go to a gathering with
        // them as a pair (Task 3). Gated by `EventInvites`, the same category
        // an event RSVP invite answers to.
        case NotificationType.GoTogetherPairInvite:
          await this.pushGoTogetherPairInvite(userIds, notification);
          return;
        // Go together: an opt-in window closed and this member's group is
        // ready. Gated by `EventReminders`, the same category the gathering
        // itself uses.
        case NotificationType.GoTogetherGroupReady:
          await this.pushGoTogetherGroupReady(userIds, notification);
          return;
        // Go together: both members of a pair said they want to meet again.
        // Gated by `Connections`, the same category a mutual connection
        // request answers to.
        case NotificationType.GoTogetherMutual:
          await this.pushGoTogetherMutual(userIds, notification);
          return;
        // Go together (PRD-420): someone left this member's group, which may
        // carry a merge offer that expires; the run could not place them; or
        // the gathering is over and the meet-again questions are open. All
        // three are gated by `EventReminders`, the category
        // `notification-preferences.ts` already gives them in the bell.
        case NotificationType.GoTogetherMemberLeft:
          await this.pushGoTogetherMemberLeft(userIds, notification);
          return;
        case NotificationType.GoTogetherUnmatched:
          await this.pushGoTogetherUnmatched(userIds, notification);
          return;
        case NotificationType.GoTogetherMeetAgain:
          await this.pushGoTogetherMeetAgain(userIds, notification);
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
    // PRD-336: a GROUP mention (`source: 'message'`) that ALSO qualifies for
    // this exact message's plain "new message" push must not stack a second
    // lock-screen row. `PushMessageListener.handleMessageCreated` already
    // sends that recipient one merged, mention-aware push, same tag, richer
    // body. `eligibleMessagePushRecipientUserIds` is recomputed fresh here
    // (not read off any state that listener wrote), so there's no ordering
    // dependency between the two listeners reacting to the same send; see
    // its own doc. A recipient who ISN'T in that set for any reason (a thread
    // mute, quiet hours withholding the New Messages category but not
    // Mentions, blocked, anything at all) still gets THIS push unchanged,
    // exactly as before this fold existed. A DM mention never reaches
    // `pushMention` at all (excluded upstream, PRD-221), so this branch only
    // ever narrows a group's recipients.
    const recipientUserIdsAfterMessagePushFold =
      this.payloadString(notification, 'source') === 'message'
        ? await this.dropRecipientsAlreadyCoveredByMessagePush(
            notification,
            recipientUserIds,
          )
        : recipientUserIds;
    if (recipientUserIdsAfterMessagePushFold.length === 0) return;
    const actor = await this.resolveActor(notification);
    const name = await this.mentionActorName(notification, actor);
    await this.previewPrivacy.sendSplitByPreviewPreference(
      recipientUserIdsAfterMessagePushFold,
      {
        title: 'You were mentioned',
        body: `${name} mentioned you.`,
        tag: `notification:${notification.id}`,
        data: { url: this.threadUrl(notification) },
        // PRD-423: a Go together chat mention carries no icon, since the
        // stored avatar URL names the member's account.
        ...(notification.payload?.isGoTogetherChat === true
          ? {}
          : this.iconOf(actor)),
        l10n: {
          titleKey: 'push:mention.title',
          bodyKey: 'push:mention.body',
          params: { name },
        },
        timestamp: notification.createdAt.getTime(),
      },
    );
  }

  /**
   * PRD-423: the mentioning member's name as the chat itself spells it. A
   * mention inside a matched Go together group chat (the conversation has
   * `isGoTogetherChat`) names the member by first name only, the way the
   * chat introduces strangers; every other mention uses the full name. A
   * conversation that cannot be read falls back to the full name, as before.
   */
  private async mentionActorName(
    notification: Notification,
    actor: Profile | null,
  ): Promise<string> {
    const conversationId = this.payloadString(notification, 'conversationId');
    if (
      !actor ||
      this.payloadString(notification, 'source') !== 'message' ||
      !conversationId
    ) {
      return this.displayName(actor);
    }
    const conversation = await this.conversations.findOne({
      where: { id: conversationId },
      select: { id: true, isGoTogetherChat: true, eventMatchGroupId: true },
    });
    const nameOptions = memberNameOptionsFor(conversation);
    if (!nameOptions.isMatchedGroup) return this.displayName(actor);
    return displayNameFor(actor, nameOptions) || 'Someone';
  }

  /**
   * PRD-336: the subset of `recipientUserIds` who are NOT among the exact
   * recipients `PushMessageListener` is (or will be) sending its own merged,
   * mention-aware message push to for `notification`'s underlying message.
   * Only called for a `source: 'message'` mention.
   *
   * Reads `conversationId` + `actorId` straight off the notification's own
   * payload (both already written by `MentionNotificationService.notify` for
   * every `message`-source mention) rather than looking the message back up,
   * and fails open on a missing/malformed payload field: an unresolvable
   * conversation or actor means "cannot fold", so nothing is dropped and this
   * push still reaches everyone it always did.
   */
  private async dropRecipientsAlreadyCoveredByMessagePush(
    notification: Notification,
    recipientUserIds: string[],
  ): Promise<string[]> {
    const conversationId = this.payloadString(notification, 'conversationId');
    const actorId = actorIdOf(notification);
    if (!conversationId || !actorId) return recipientUserIds;
    const coveredUserIds =
      await this.pushMessageListener.eligibleMessagePushRecipientUserIds(
        conversationId,
        actorId,
        recipientUserIds,
      );
    if (coveredUserIds.size === 0) return recipientUserIds;
    return recipientUserIds.filter((userId) => !coveredUserIds.has(userId));
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
    const title = this.payloadString(notification, 'title') ?? 'An event';
    const eventSlug = this.payloadString(notification, 'eventSlug');
    // `/gatherings/<slug>` — the SPA's own detail route. This used to say
    // `/events/<slug>`, which the frontend router has no match for, so every
    // reminder and cancellation push landed the member on 404 (PRD-180).
    const url = eventSlug ? gatheringPath(eventSlug) : GATHERINGS_BOARD_PATH;
    // How many dates a cancellation took off the calendar (ENG-141). One
    // message now covers a whole series, so the copy has to say so: naming a
    // single Tuesday when thirty of them are gone leaves the other twenty-nine
    // unexplained. Absent or 1 keeps the original single-gathering sentence,
    // which is what every cancellation before series support said.
    const occurrenceCount =
      this.payloadNumber(notification, 'occurrenceCount') ?? 1;
    const isSeries = isCancelled && occurrenceCount > 1;
    // How many dates BESIDES the one named in the body.
    const laterCount = occurrenceCount - 1;
    // The service worker's catalog has no CLDR plurals — it interpolates
    // `{token}` and nothing else — so the singular and plural are two separate
    // keys and the SENDER picks, because the sender is the side that knows the
    // count. A single "{count} later dates" string would render "1 later
    // dates" for a two-date series. The English strings below are the plain
    // fallback iOS renders directly, so they have to agree word for word with
    // the keys they name.
    const cancelledBody = !isSeries
      ? `${title} has been cancelled.`
      : laterCount === 1
        ? `${title} has been cancelled, and so has the next date.`
        : `${title} has been cancelled, and so have the next ${laterCount} dates.`;
    const cancelledBodyKey = !isSeries
      ? 'push:event.cancelled.body'
      : laterCount === 1
        ? 'push:event.cancelled.seriesBodyOne'
        : 'push:event.cancelled.seriesBody';
    await this.previewPrivacy.sendSplitByPreviewPreference(userIds, {
      title: isCancelled ? 'Event cancelled' : 'Event updated',
      body: isCancelled
        ? cancelledBody
        : `${title} has new details. Tap to see what changed.`,
      tag: `notification:${notification.id}`,
      data: { url },
      l10n: {
        titleKey: isCancelled
          ? 'push:event.cancelled.title'
          : 'push:event.updated.title',
        bodyKey: isCancelled ? cancelledBodyKey : 'push:event.updated.body',
        // `count` rides along only for the plural series body, the one string
        // that interpolates it. A plain cancellation carries no `{count}`
        // token, so sending `count: '0'` would put a number on the wire that
        // no copy can render and that means nothing if it ever were rendered.
        params: {
          event: title,
          ...(isSeries && laterCount > 1 ? { count: String(laterCount) } : {}),
        },
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
      this.payloadString(notification, 'eventTitle') ?? 'an event';
    const listingSlug = this.payloadString(notification, 'listingSlug');
    const url = listingSlug
      ? `/local/directory/${listingSlug}`
      : '/local/directory';
    await this.previewPrivacy.sendSplitByPreviewPreference(userIds, {
      title: 'An event at your venue',
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

  /**
   * "Someone from QueerPulse has offered your community support."
   *
   * Deep-links straight to the support pane of that community's mod tools,
   * which is where the offer is read in full and answered — the same
   * `?tab=modtools&mod=…` destination `community_report_filed` uses. The
   * staff member's note never rides on the push: it is not in the payload
   * allowlist at all, and it belongs behind the moderator's own
   * authentication.
   */
  private async pushCommunitySupportOffered(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const communityName =
      this.payloadString(notification, 'communityName') ?? 'Your community';
    const communitySlug = this.payloadString(notification, 'communitySlug');
    const url = communitySlug
      ? `/community/${communitySlug}?tab=modtools&mod=support`
      : '/communities';
    await this.previewPrivacy.sendSplitByPreviewPreference(userIds, {
      title: 'An offer of support',
      body: `Someone from QueerPulse has offered ${communityName} a hand. Tap to read it.`,
      tag: `notification:${notification.id}`,
      data: { url },
      l10n: {
        titleKey: 'push:community.supportOffered.title',
        bodyKey: 'push:community.supportOffered.body',
        params: { communityName },
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
   * "A persona you follow published something new" (PRD-208).
   *
   * NAMES THE PERSONA, NEVER ITS OWNER. `resolveActor` is not called and no
   * avatar rides along: `PersonaUpdate` carries no actor key, and a lock
   * screen reading a pseudonymous persona's owner's name would undo the whole
   * point of an unlinked persona. The copy is the persona's own public display
   * name and the title of the newest item, both already readable by anyone who
   * opens the link.
   *
   * Deep-links to the persona's own page through the `deepLink` the fan-out
   * resolved, falling back to the persona directory rather than shipping an
   * empty destination.
   */
  private async pushPersonaUpdate(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.PersonaFollows,
    );
    if (recipientUserIds.length === 0) return;
    const persona =
      this.payloadString(notification, 'subprofileName') ?? 'A persona';
    const itemTitle = this.payloadString(notification, 'itemTitle');
    const url = this.payloadString(notification, 'deepLink') ?? '/subprofiles';
    await this.previewPrivacy.sendSplitByPreviewPreference(recipientUserIds, {
      title: 'New work from a persona you follow',
      body: itemTitle
        ? `${persona} published ${itemTitle}.`
        : `${persona} published something new.`,
      tag: `notification:${notification.id}`,
      data: { url },
      l10n: {
        titleKey: 'push:personaUpdate.title',
        bodyKey: itemTitle
          ? 'push:personaUpdate.bodyWithTitle'
          : 'push:personaUpdate.body',
        params: { persona, itemTitle: itemTitle ?? '' },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * At most one new-release push per recipient per artist per UTC day. In one
   * statement, stamps `pushed_at` on each recipient's persona-bundle row and
   * returns the recipients that had no stamp from today yet; the rest already
   * heard from this artist today and get the in-app row only. Bundle
   * absorption leaves `pushed_at` alone, so the stamp outlives a later release
   * folding into the row. A payload with no persona id has no bundle to
   * limit, so every recipient passes.
   */
  private async claimTodaysReleasePush(
    userIds: string[],
    notification: Notification,
  ): Promise<string[]> {
    const bundleKey = bundleKeyFor(notification.type, notification.payload);
    if (!bundleKey) return userIds;
    const now = new Date();
    const startOfUtcDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const claimed: { user_id: string }[] = await this.notificationRows.query(
      `UPDATE "notifications" AS "row"
          SET "pushed_at" = now()
        WHERE "row"."user_id" = ANY($1::uuid[])
          AND "row"."type" = $2::notifications_type_enum
          AND "row"."bundle_key" = $3
          AND "row"."created_at" >= $4
          AND ("row"."pushed_at" IS NULL OR "row"."pushed_at" < $4)
          AND NOT EXISTS (
            SELECT 1 FROM "notifications" "earlier"
             WHERE "earlier"."user_id" = "row"."user_id"
               AND "earlier"."type" = "row"."type"
               AND "earlier"."bundle_key" = "row"."bundle_key"
               AND "earlier"."pushed_at" >= $4
          )
       RETURNING "row"."user_id"::text AS "user_id"`,
      [userIds, notification.type, bundleKey, startOfUtcDay],
    );
    const claimedUserIds = new Set(claimed.map((row) => row.user_id));
    return userIds.filter((userId) => claimedUserIds.has(userId));
  }

  /**
   * "A persona you follow put out a release" (Studio v2).
   *
   * NAMES THE PERSONA AND THE RELEASE AND LEAVES THE OWNER OUT: `resolveActor`
   * is not called and no avatar rides along, for the reason
   * `pushPersonaUpdate` gives. Opens the release page; a recipient whose grant
   * has gone lands on the Studio teaser there.
   *
   * Persona name and release title are both required to publish, so a
   * notification missing either is malformed and sends no push. The bell row
   * is unaffected. No English fallback text feeds the localized params.
   */
  private async pushStudioReleasePublished(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const persona = this.payloadString(notification, 'subprofileName');
    const title = this.payloadString(notification, 'releaseTitle');
    if (!persona || !title) return;
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.PersonaFollows,
    );
    if (recipientUserIds.length === 0) return;
    const pushableUserIds = await this.claimTodaysReleasePush(
      recipientUserIds,
      notification,
    );
    if (pushableUserIds.length === 0) return;
    const releaseId = this.payloadString(notification, 'releaseId');
    const url = releaseId
      ? `/studio/album?id=${encodeURIComponent(releaseId)}`
      : '/studio';
    await this.previewPrivacy.sendSplitByPreviewPreference(pushableUserIds, {
      title: 'New from an artist you follow',
      body: `${persona} released ${title}`,
      tag: `notification:${notification.id}`,
      data: { url },
      l10n: {
        titleKey: 'push:studioReleasePublished.title',
        bodyKey: 'push:studioReleasePublished.body',
        params: { persona, title },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * "A persona you follow posted an update" (Studio v3).
   *
   * Titled with the persona's own name, the body is the post's first words,
   * and it opens the persona page's Updates block. `resolveActor` is not
   * called and no avatar rides along, for the reason `pushPersonaUpdate`
   * gives. A payload missing the name, the excerpt or the address is
   * malformed and sends no push; the bell row is unaffected. The body is
   * member-written text, so it goes through the preview split like every
   * other message-like push.
   */
  private async pushPersonaPost(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const persona = this.payloadString(notification, 'subprofileName');
    const excerpt = this.payloadString(notification, 'excerpt');
    const personaAddress = this.payloadString(
      notification,
      'subprofileSlugOrHandle',
    );
    if (!persona || !excerpt || !personaAddress) return;
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.PersonaFollows,
    );
    if (recipientUserIds.length === 0) return;
    await this.previewPrivacy.sendSplitByPreviewPreference(recipientUserIds, {
      title: persona,
      body: excerpt,
      tag: `notification:${notification.id}`,
      data: { url: `/p/${encodeURIComponent(personaAddress)}#updates` },
      l10n: {
        titleKey: 'push:personaPost.title',
        bodyKey: 'push:personaPost.body',
        params: { persona, excerpt },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * "A show you follow published an episode" (Studio artist kinds).
   *
   * NAMES THE PERSONA, THE SHOW AND THE EPISODE AND LEAVES THE OWNER OUT:
   * `resolveActor` is not called and no avatar rides along, for the reason
   * `pushPersonaUpdate` gives. Opens the episode page. The persona name, the
   * show and episode titles, the persona address and the episode id are all
   * required: a payload missing one is malformed and sends no push, and the
   * bell row is unaffected. Titles are member-written, so it goes through
   * the preview split like every other message-like push.
   */
  private async pushStudioEpisodePublished(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const persona = this.payloadString(notification, 'subprofileName');
    const show = this.payloadString(notification, 'releaseTitle');
    const episode = this.payloadString(notification, 'trackTitle');
    const personaAddress = this.payloadString(
      notification,
      'subprofileSlugOrHandle',
    );
    const trackId = this.payloadString(notification, 'trackId');
    if (!persona || !show || !episode || !personaAddress || !trackId) return;
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.PersonaFollows,
    );
    if (recipientUserIds.length === 0) return;
    await this.previewPrivacy.sendSplitByPreviewPreference(recipientUserIds, {
      title: `New episode of ${show}`,
      body: `${persona}: ${episode}`,
      tag: `notification:${notification.id}`,
      data: { url: `/studio/track?id=${encodeURIComponent(trackId)}` },
      l10n: {
        titleKey: 'push:studioEpisodePublished.title',
        bodyKey: 'push:studioEpisodePublished.body',
        params: { persona, show, episode },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * "A release credited a persona you run" (Studio discovery). Names both
   * personas and the track; `resolveActor` is never called, so no member's
   * face or name rides along. Opens the credits inbox. A notification
   * missing any of the three params is malformed and sends no push; the
   * bell row is unaffected. The role stays in the bell copy only, since the
   * push params carry no translated label.
   */
  private async pushStudioCreditRequested(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const requester = this.payloadString(notification, 'requestingPersonaName');
    const persona = this.payloadString(notification, 'creditedPersonaName');
    const track = this.payloadString(notification, 'trackTitle');
    if (!requester || !persona || !track) return;
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.Personas,
    );
    if (recipientUserIds.length === 0) return;
    await this.previewPrivacy.sendSplitByPreviewPreference(recipientUserIds, {
      title: 'New credit request',
      body: `${requester} credited ${persona} on ${track}`,
      tag: `notification:${notification.id}`,
      data: { url: '/studio/credits' },
      l10n: {
        titleKey: 'push:studioCreditRequested.title',
        bodyKey: 'push:studioCreditRequested.body',
        params: { requester, persona, track },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * "A persona accepted your credit" (Studio discovery). Opens the track
   * page, or the credits inbox when the payload carries no track id. Persona
   * name and track title are required; the accepting member is never
   * resolved.
   */
  private async pushStudioCreditAccepted(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const persona = this.payloadString(notification, 'creditedPersonaName');
    const track = this.payloadString(notification, 'trackTitle');
    if (!persona || !track) return;
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.Personas,
    );
    if (recipientUserIds.length === 0) return;
    const trackId = this.payloadString(notification, 'trackId');
    const url = trackId
      ? `/studio/track?id=${encodeURIComponent(trackId)}`
      : '/studio/credits';
    await this.previewPrivacy.sendSplitByPreviewPreference(recipientUserIds, {
      title: 'Credit accepted',
      body: `${persona} accepted your credit on ${track}`,
      tag: `notification:${notification.id}`,
      data: { url },
      l10n: {
        titleKey: 'push:studioCreditAccepted.title',
        bodyKey: 'push:studioCreditAccepted.body',
        params: { persona, track },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * "You have Studio access" (Studio landing page). Goes to the member
   * granted access, from Waiting for Studio or the member drawer, with no
   * category gate, since the grant is about their own account; quiet hours
   * already ran for the batch. The payload is empty and no
   * member is resolved. Opens Studio.
   */
  private async pushStudioAccessGranted(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    await this.previewPrivacy.sendSplitByPreviewPreference(userIds, {
      title: 'You have Studio access',
      body: 'Studio is open for you. Tap to start listening.',
      tag: `notification:${notification.id}`,
      data: { url: '/studio' },
      l10n: {
        titleKey: 'push:studioAccessGranted.title',
        bodyKey: 'push:studioAccessGranted.body',
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * "Our team would like to play a track on the Studio page" (Studio
   * landing page). Goes to the members of the release persona that hold a
   * Studio grant, behind the `Personas` switch, and opens the dashboard
   * previews. A payload missing the persona name or the track title is
   * malformed and sends no push; the bell row is unaffected. No member is
   * resolved.
   */
  private async pushStudioLandingPreviewRequested(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const persona = this.payloadString(notification, 'personaName');
    const track = this.payloadString(notification, 'trackTitle');
    if (!persona || !track) return;
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.Personas,
    );
    if (recipientUserIds.length === 0) return;
    await this.previewPrivacy.sendSplitByPreviewPreference(recipientUserIds, {
      title: 'A Studio page preview request',
      body: `${persona}: our team would like to play ${track} on the Studio page`,
      tag: `notification:${notification.id}`,
      data: { url: this.studioLandingPreviewsUrl(notification) },
      l10n: {
        titleKey: 'push:studioLandingPreviewRequested.title',
        bodyKey: 'push:studioLandingPreviewRequested.body',
        params: { persona, track },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * "Approved for the Studio page" (Studio landing page). Goes to the
   * members of the release persona and of each credited persona that hold a
   * Studio grant, behind the `Personas` switch, and opens the dashboard
   * previews. The payload carries the main persona name; a payload missing
   * it or the track title sends no push. No member is resolved.
   */
  private async pushStudioLandingPreviewLive(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const persona = this.payloadString(notification, 'mainPersonaName');
    const track = this.payloadString(notification, 'trackTitle');
    if (!persona || !track) return;
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.Personas,
    );
    if (recipientUserIds.length === 0) return;
    await this.previewPrivacy.sendSplitByPreviewPreference(recipientUserIds, {
      title: 'Approved for the Studio page',
      body: `${track} by ${persona} is approved for the Studio page`,
      tag: `notification:${notification.id}`,
      data: { url: this.studioLandingPreviewsUrl(notification) },
      l10n: {
        titleKey: 'push:studioLandingPreviewLive.title',
        bodyKey: 'push:studioLandingPreviewLive.body',
        params: { persona, track },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * The dashboard previews section of the persona the notice names, or of
   * the dashboard itself when the payload carries no persona id.
   */
  private studioLandingPreviewsUrl(notification: Notification): string {
    const subprofileId = this.payloadString(notification, 'subprofileId');
    return subprofileId
      ? `/studio/dashboard?persona=${encodeURIComponent(subprofileId)}#landing-previews`
      : '/studio/dashboard#landing-previews';
  }

  /**
   * "Someone says they paid Night Shift for Lisbon at four" (Studio
   * purchases). Goes to the members of the persona that hold a Studio grant,
   * behind the `Personas` switch, and opens the payments page on that
   * persona. No member is resolved, so no face or name rides along; the
   * amount stays in the app. A payload missing the persona id, the artist
   * name or the item title is malformed and sends no push; the bell row is
   * unaffected.
   */
  private async pushStudioPurchaseClaimed(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const subprofileId = this.payloadString(notification, 'subprofileId');
    const artist = this.payloadString(notification, 'artistName');
    const item = this.payloadString(notification, 'itemTitle');
    if (!subprofileId || !artist || !item) return;
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.Personas,
    );
    if (recipientUserIds.length === 0) return;
    await this.previewPrivacy.sendSplitByPreviewPreference(recipientUserIds, {
      title: 'Payment to confirm',
      body: `Someone says they paid ${artist} for ${item}`,
      tag: `notification:${notification.id}`,
      data: {
        url: `/studio/payments?persona=${encodeURIComponent(subprofileId)}`,
      },
      l10n: {
        titleKey: 'push:studioPurchaseClaimed.title',
        bodyKey: 'push:studioPurchaseClaimed.body',
        params: { artist, item },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * "Night Shift confirmed your payment for Lisbon at four" (Studio
   * purchases). Goes to the buyer with no category gate, since the buyer
   * asked for the purchase; quiet hours already ran for the batch. No member
   * is resolved and the amount stays in the app. Opens the purchases page.
   */
  private async pushStudioPurchaseConfirmed(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const artist = this.payloadString(notification, 'artistName');
    const item = this.payloadString(notification, 'itemTitle');
    if (!artist || !item) return;
    await this.previewPrivacy.sendSplitByPreviewPreference(userIds, {
      title: 'Purchase confirmed',
      body: `${artist} confirmed your payment for ${item}`,
      tag: `notification:${notification.id}`,
      data: { url: '/account/music-purchases' },
      l10n: {
        titleKey: 'push:studioPurchaseConfirmed.title',
        bodyKey: 'push:studioPurchaseConfirmed.body',
        params: { artist, item },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * "Night Shift could not match your payment for Lisbon at four" (Studio
   * purchases). Goes to the buyer with no category gate; quiet hours already
   * ran for the batch. The decline reason and the amount stay in the app, and
   * no member is resolved. Opens the purchases page.
   */
  private async pushStudioPurchaseDeclined(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const artist = this.payloadString(notification, 'artistName');
    const item = this.payloadString(notification, 'itemTitle');
    if (!artist || !item) return;
    await this.previewPrivacy.sendSplitByPreviewPreference(userIds, {
      title: 'Payment not confirmed',
      body: `${artist} could not match your payment for ${item}`,
      tag: `notification:${notification.id}`,
      data: { url: '/account/music-purchases' },
      l10n: {
        titleKey: 'push:studioPurchaseDeclined.title',
        bodyKey: 'push:studioPurchaseDeclined.body',
        params: { artist, item },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * "Ana Silva invited you to edit Night bus" (collaborative playlists).
   * Names the inviting owner, carries their face when it is public, and
   * opens the playlist, where the invite banner waits. A payload missing the
   * playlist id or name sends no push; the bell row is unaffected.
   */
  private async pushStudioPlaylistEditorInvite(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const playlistId = this.payloadString(notification, 'playlistId');
    const playlist = this.payloadString(notification, 'playlistName');
    if (!playlistId || !playlist) return;
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.Invitations,
    );
    if (recipientUserIds.length === 0) return;
    const actor = await this.resolveActor(notification);
    const name = this.displayName(actor);
    await this.previewPrivacy.sendSplitByPreviewPreference(
      recipientUserIds,
      {
        title: 'Playlist invite',
        body: `${name} invited you to edit ${playlist}`,
        tag: `notification:${notification.id}`,
        data: {
          url: `/studio/collection?id=${encodeURIComponent(playlistId)}`,
        },
        ...this.iconOf(actor),
        l10n: {
          titleKey: 'push:studioPlaylistEditorInvite.title',
          bodyKey: 'push:studioPlaylistEditorInvite.body',
          params: { name, playlist },
        },
        timestamp: notification.createdAt.getTime(),
      },
      GENERIC_PUSH_COPY.notification,
    );
  }

  /**
   * "Ana Silva added you as an editor of Night bus (Night Shift)"
   * (collaborative playlists). The recipient co-owns the persona, so the
   * owner's name and the persona name are both theirs to read. Playlist id,
   * playlist name and persona name are required.
   */
  private async pushStudioPlaylistEditorAdded(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const playlistId = this.payloadString(notification, 'playlistId');
    const playlist = this.payloadString(notification, 'playlistName');
    const persona = this.payloadString(notification, 'personaName');
    if (!playlistId || !playlist || !persona) return;
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.Personas,
    );
    if (recipientUserIds.length === 0) return;
    const actor = await this.resolveActor(notification);
    const name = this.displayName(actor);
    await this.previewPrivacy.sendSplitByPreviewPreference(
      recipientUserIds,
      {
        title: 'You can edit a playlist',
        body: `${name} added you as an editor of ${playlist} (${persona})`,
        tag: `notification:${notification.id}`,
        data: {
          url: `/studio/collection?id=${encodeURIComponent(playlistId)}`,
        },
        ...this.iconOf(actor),
        l10n: {
          titleKey: 'push:studioPlaylistEditorAdded.title',
          bodyKey: 'push:studioPlaylistEditorAdded.body',
          params: { name, playlist, persona },
        },
        timestamp: notification.createdAt.getTime(),
      },
      GENERIC_PUSH_COPY.notification,
    );
  }

  /**
   * "Ink House invited River Ink to join the team" (Meet the team). Opens
   * the persona's Works at pane. Persona id, persona name and listing name
   * are required; no member is looked up.
   */
  private async pushListingTeamInvite(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const subprofileId = this.payloadString(notification, 'subprofileId');
    const persona = this.payloadString(notification, 'personaName');
    const listing = this.payloadString(notification, 'listingName');
    if (!subprofileId || !persona || !listing) return;
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.Personas,
    );
    if (recipientUserIds.length === 0) return;
    await this.previewPrivacy.sendSplitByPreviewPreference(recipientUserIds, {
      title: 'Team invite',
      body: `${listing} invited ${persona} to join the team`,
      tag: `notification:${notification.id}`,
      data: { url: this.listingTeamInviteUrl(subprofileId) },
      l10n: {
        titleKey: 'push:listingTeamInvite.title',
        bodyKey: 'push:listingTeamInvite.body',
        params: { persona, listing },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * "River Ink asked to join the team at Ink House" (Meet the team). Opens
   * the listing editor's Team section. Listing ref, persona name and
   * listing name are required.
   */
  private async pushListingTeamRequest(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const listingRef = this.payloadString(notification, 'listingRef');
    const persona = this.payloadString(notification, 'personaName');
    const listing = this.payloadString(notification, 'listingName');
    if (!listingRef || !persona || !listing) return;
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.Listings,
    );
    if (recipientUserIds.length === 0) return;
    await this.previewPrivacy.sendSplitByPreviewPreference(recipientUserIds, {
      title: 'Team request',
      body: `${persona} asked to join the team at ${listing}`,
      tag: `notification:${notification.id}`,
      data: { url: this.listingTeamRequestUrl(listingRef) },
      l10n: {
        titleKey: 'push:listingTeamRequest.title',
        bodyKey: 'push:listingTeamRequest.body',
        params: { persona, listing },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * "River Ink is now on the team at Ink House" (Meet the team). Opens the
   * starting side's own surface: the listing editor's Team section when the
   * listing started the link, the persona's Works at pane when the persona
   * did. The id that surface needs is required alongside both names.
   */
  private async pushListingTeamAccepted(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const persona = this.payloadString(notification, 'personaName');
    const listing = this.payloadString(notification, 'listingName');
    const isListingStarted =
      this.payloadString(notification, 'initiatedBy') === 'listing';
    const surfaceId = this.payloadString(
      notification,
      isListingStarted ? 'listingRef' : 'subprofileId',
    );
    if (!persona || !listing || !surfaceId) return;
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.Listings,
    );
    if (recipientUserIds.length === 0) return;
    await this.previewPrivacy.sendSplitByPreviewPreference(recipientUserIds, {
      title: 'Team link confirmed',
      body: `${persona} is now on the team at ${listing}`,
      tag: `notification:${notification.id}`,
      data: {
        url: isListingStarted
          ? this.listingTeamRequestUrl(surfaceId)
          : this.listingTeamInviteUrl(surfaceId),
      },
      l10n: {
        titleKey: 'push:listingTeamAccepted.title',
        bodyKey: 'push:listingTeamAccepted.body',
        params: { persona, listing },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  private listingTeamInviteUrl(subprofileId: string): string {
    return `/account/subprofiles/${encodeURIComponent(subprofileId)}/edit?pane=works-at`;
  }

  private listingTeamRequestUrl(listingRef: string): string {
    return `/local/directory/list/${encodeURIComponent(listingRef)}/edit#lb-editor-team`;
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
    // PRD-463: a moderator took an already-published listing down. "Was not
    // published" would misdescribe it, so it gets its own sentence.
    const isHidden = decision === 'hidden';
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
          : isHidden
            ? `${title} was taken off the group's board. Tap to read why.`
            : `${title} was not published. Tap to read why.`,
      tag: `notification:${notification.id}`,
      data: { url },
      l10n: {
        titleKey: isLive
          ? 'push:groupListing.live.title'
          : isQuestion
            ? 'push:groupListing.question.title'
            : isHidden
              ? 'push:groupListing.hidden.title'
              : 'push:groupListing.declined.title',
        bodyKey: isLive
          ? 'push:groupListing.live.body'
          : isQuestion
            ? 'push:groupListing.question.body'
            : isHidden
              ? 'push:groupListing.hidden.body'
              : 'push:groupListing.declined.body',
        params: { title },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * "Your thread was reviewed" — the verdict on a thread its author held back
   * for the editors or the council.
   *
   * An APPROVED thread deep-links to the thread itself, which is live from the
   * moment the verdict was written (or from its scheduled instant, if the
   * author also scheduled it). A rejected one goes to the notifications centre,
   * where the moderator's note is: the thread stays invisible to everyone but
   * its author and staff, so sending them to a page only they can open would
   * read as though something had gone wrong.
   *
   * Nothing of the thread's BODY is in the copy — only the title the author
   * wrote themself, which is what makes the row worth opening when several
   * threads are in the queue.
   */
  private async pushForumThreadReviewed(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const isApproved =
      this.payloadString(notification, 'decision') === 'approved';
    const title = this.payloadString(notification, 'title') ?? 'Your thread';
    // `threadUrl` builds the same `/thread/:slug` deep link every other forum
    // push uses, off the `source: 'forum'` + `threadSlug` pair in the payload.
    const url = isApproved ? this.threadUrl(notification) : '/notifications';
    await this.previewPrivacy.sendSplitByPreviewPreference(userIds, {
      title: isApproved ? 'Your thread is live' : 'About your thread',
      body: isApproved
        ? `${title} is on the forum now.`
        : `${title} was not published. Tap to read why.`,
      tag: `notification:${notification.id}`,
      data: { url },
      l10n: {
        titleKey: isApproved
          ? 'push:forumThreadReviewed.approved.title'
          : 'push:forumThreadReviewed.rejected.title',
        bodyKey: isApproved
          ? 'push:forumThreadReviewed.approved.body'
          : 'push:forumThreadReviewed.rejected.body',
        params: { title },
      },
      timestamp: notification.createdAt.getTime(),
    });
  }

  /**
   * "Added to a group" (PRD-334): an owner or admin put this member into a
   * group conversation, at creation or through "Add members".
   *
   * Gated by `NewMessages`, the same category the bell row sits behind, and
   * sent through the preview split with the generic NOTIFICATION copy: the
   * adder's name and the group's title are exactly what a lock screen must not
   * show to somebody hiding previews.
   *
   * Opens the conversation itself (`/messages?c=<conversationId>`). A group
   * title is required at creation and on rename, so the untitled branch is
   * defensive only; it drops `{group}` rather than inventing a name.
   */
  private async pushGroupAdded(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.NewMessages,
    );
    if (recipientUserIds.length === 0) return;
    const actor = await this.resolveActor(notification);
    const name = this.displayName(actor);
    const groupTitle = this.payloadString(notification, 'groupTitle')?.trim();
    const conversationId = this.payloadString(notification, 'conversationId');
    const url = conversationId
      ? `/messages?c=${encodeURIComponent(conversationId)}`
      : '/messages';
    await this.previewPrivacy.sendSplitByPreviewPreference(
      recipientUserIds,
      {
        title: 'Added to a group',
        body: groupTitle
          ? `${name} added you to ${groupTitle}.`
          : `${name} added you to a group.`,
        tag: `notification:${notification.id}`,
        data: { url },
        ...this.iconOf(actor),
        l10n: {
          titleKey: 'push:groupAdded.title',
          bodyKey: groupTitle
            ? 'push:groupAdded.body'
            : 'push:groupAdded.bodyUntitled',
          params: groupTitle ? { name, group: groupTitle } : { name },
        },
        timestamp: notification.createdAt.getTime(),
      },
      GENERIC_PUSH_COPY.notification,
    );
  }

  /**
   * "Invited to a group" (PRD-353): an add could not seat this member
   * directly (their own `group_add_policy` is `invite_only`, or they have a
   * prior left/removed row in this exact group) and became an invite
   * instead.
   *
   * Gated by `NewMessages`, same as `pushGroupAdded`, and sent through the
   * same preview split with the generic NOTIFICATION copy: the inviter's
   * name and the group's title are exactly what a lock screen must not show
   * to somebody hiding previews.
   *
   * Opens `/messages?tab=requests`, NOT the conversation itself: unlike
   * `pushGroupAdded`'s recipient, this member is not yet a participant, so
   * `GET :id/messages` would 403 them. The Requests tab is where
   * `GET /group-invites` renders the accept/decline actions.
   */
  private async pushGroupInvite(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.NewMessages,
    );
    if (recipientUserIds.length === 0) return;
    const actor = await this.resolveActor(notification);
    const name = this.displayName(actor);
    const groupTitle = this.payloadString(notification, 'groupTitle')?.trim();
    await this.previewPrivacy.sendSplitByPreviewPreference(
      recipientUserIds,
      {
        title: 'New group invite',
        body: groupTitle
          ? `${name} invited you to ${groupTitle}.`
          : `${name} invited you to a group.`,
        tag: `notification:${notification.id}`,
        data: { url: '/messages?tab=requests' },
        ...this.iconOf(actor),
        l10n: {
          titleKey: 'push:groupInvite.title',
          bodyKey: groupTitle
            ? 'push:groupInvite.body'
            : 'push:groupInvite.bodyUntitled',
          params: groupTitle ? { name, group: groupTitle } : { name },
        },
        timestamp: notification.createdAt.getTime(),
      },
      GENERIC_PUSH_COPY.notification,
    );
  }

  /**
   * "An admin has offered you ownership of Lux Cafe" (admin-authored
   * listing ownership offers).
   *
   * Gated by `Listings`, the same category the bell row sits behind, and
   * sent through the preview split with the generic NOTIFICATION copy: the
   * offering admin's name and the listing's own public name are exactly what
   * a lock screen must not show to somebody hiding previews.
   *
   * Opens the account profile's Places section (`/account/profile#places`),
   * where the accept/decline controls actually live. The listing's own
   * public page (`/local/directory/<listingSlug>`) has no accept button on
   * it at all, which is exactly the mistake this route used to make: the
   * in-app bell notification for this same event was already corrected to
   * the Places section (`notifications.adapters.ts`'s `listing_owner_offer`
   * branch), and this push route was the one place left disagreeing with it.
   */
  private async pushListingOwnerOffer(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.Listings,
    );
    if (recipientUserIds.length === 0) return;
    const actor = await this.resolveActor(notification);
    const name = this.displayName(actor);
    const listingName =
      this.payloadString(notification, 'listingName') ?? 'a listing';
    const url = '/account/profile#places';
    await this.previewPrivacy.sendSplitByPreviewPreference(
      recipientUserIds,
      {
        title: 'Ownership offer',
        body: `${name} has offered you ownership of ${listingName}.`,
        tag: `notification:${notification.id}`,
        data: { url },
        ...this.iconOf(actor),
        l10n: {
          titleKey: 'push:listingOwnerOffer.title',
          bodyKey: 'push:listingOwnerOffer.body',
          params: { name, listingName },
        },
        timestamp: notification.createdAt.getTime(),
      },
      GENERIC_PUSH_COPY.notification,
    );
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
   * "Ana wants to go to a gathering together" (Go together, Task 3): a
   * friend who opted in to a gathering invited this member to join them as
   * a pair, so the two are matched into a group together.
   *
   * Gated by `EventInvites`, the same category an event RSVP invite answers
   * to, and sent through the preview split with the generic NOTIFICATION
   * copy: the inviting member's name is exactly what a lock screen must not
   * show to somebody hiding previews. The copy never names the gathering
   * itself (spec 7), so even the rich variant says only that an invite
   * exists.
   *
   * Opens the gathering's own page via `gatheringPath`, the shared route
   * contract with the frontend (`event-paths.ts`), falling back to the
   * gatherings board when the payload carries no slug.
   */
  private async pushGoTogetherPairInvite(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.EventInvites,
    );
    if (recipientUserIds.length === 0) return;
    const actor = await this.resolveActor(notification);
    const name = this.displayName(actor);
    const eventSlug = this.payloadString(notification, 'eventSlug');
    const url = eventSlug ? gatheringPath(eventSlug) : GATHERINGS_BOARD_PATH;
    await this.previewPrivacy.sendSplitByPreviewPreference(
      recipientUserIds,
      {
        title: 'Go together',
        body: `${name} wants to go to an event together`,
        tag: `notification:${notification.id}`,
        data: { url },
        ...this.iconOf(actor),
        l10n: {
          titleKey: 'push:goTogether.pairInvite.title',
          bodyKey: 'push:goTogether.pairInvite.body',
          params: { name },
        },
        timestamp: notification.createdAt.getTime(),
      },
      GENERIC_PUSH_COPY.notification,
    );
  }

  /**
   * "Your group for a gathering is ready" (Go together, Task 3): the opt-in
   * window closed and this member's group was seated.
   *
   * Gated by `EventReminders`, the same category the gathering itself uses,
   * and sent through the preview split with the generic NOTIFICATION copy.
   * There is no actor: the matching pass itself forms a group, so the copy
   * carries no name and takes no `l10n.params`. The copy never names the
   * gathering itself (spec 7).
   *
   * Opens the gathering's own page via `gatheringPath`, falling back to
   * `/notifications` when the payload carries no slug: unlike
   * `pushGoTogetherPairInvite`, this member is already grouped, so the
   * gatherings board is a worse fallback than the notifications centre.
   */
  private async pushGoTogetherGroupReady(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.EventReminders,
    );
    if (recipientUserIds.length === 0) return;
    const eventSlug = this.payloadString(notification, 'eventSlug');
    const url = eventSlug ? gatheringPath(eventSlug) : '/notifications';
    await this.previewPrivacy.sendSplitByPreviewPreference(
      recipientUserIds,
      {
        title: 'Go together',
        body: 'Your group for an event is ready',
        tag: `notification:${notification.id}`,
        data: { url },
        l10n: {
          titleKey: 'push:goTogether.groupReady.title',
          bodyKey: 'push:goTogether.groupReady.body',
          params: {},
        },
        timestamp: notification.createdAt.getTime(),
      },
      GENERIC_PUSH_COPY.notification,
    );
  }

  /**
   * "You and Ana both want to meet again" (Go together, Task 3): both
   * members of a past pair said, independently, that they want to meet
   * again.
   *
   * Gated by `Connections`, the same category a mutual connection request
   * answers to, and sent through the preview split with the generic
   * NOTIFICATION copy: the other member's name is exactly what a lock
   * screen must not show to somebody hiding previews.
   *
   * Opens `/notifications`: this event carries no gathering slug of its
   * own, only the past pairing, so the notifications centre is the one
   * destination that always reads.
   */
  private async pushGoTogetherMutual(
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
    await this.previewPrivacy.sendSplitByPreviewPreference(
      recipientUserIds,
      {
        title: 'Go together',
        body: `You and ${name} both want to meet again`,
        tag: `notification:${notification.id}`,
        data: { url: '/notifications' },
        ...this.iconOf(actor),
        l10n: {
          titleKey: 'push:goTogether.mutual.title',
          bodyKey: 'push:goTogether.mutual.body',
          params: { name },
        },
        timestamp: notification.createdAt.getTime(),
      },
      GENERIC_PUSH_COPY.notification,
    );
  }

  /**
   * "Someone left your group" (Go together, PRD-420). When the group got
   * small before the gathering, the row carries `mergeOfferGroupId`, an offer
   * to move into another group that stops being open as soon as that group
   * fills, so it is worth a buzz; the body then says there is a group with
   * room.
   *
   * Gated by `EventReminders` and sent through the preview split with the
   * generic NOTIFICATION copy, like `pushGoTogetherGroupReady`. There is no
   * actor: the copy never says who left, and never names the gathering
   * (spec 7). Opens the gathering's own page, where the group card shows the
   * offer, the same link the bell row opens; falls back to `/notifications`.
   */
  private async pushGoTogetherMemberLeft(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.EventReminders,
    );
    if (recipientUserIds.length === 0) return;
    const eventSlug = this.payloadString(notification, 'eventSlug');
    const hasMergeOffer =
      this.payloadString(notification, 'mergeOfferGroupId') !== undefined;
    await this.previewPrivacy.sendSplitByPreviewPreference(
      recipientUserIds,
      {
        title: 'Go together',
        body: hasMergeOffer
          ? 'Someone left your group. Another group has room for you'
          : 'Someone left your group for an event',
        tag: `notification:${notification.id}`,
        data: { url: eventSlug ? gatheringPath(eventSlug) : '/notifications' },
        l10n: {
          titleKey: 'push:goTogether.memberLeft.title',
          bodyKey: hasMergeOffer
            ? 'push:goTogether.memberLeft.bodyMergeOffer'
            : 'push:goTogether.memberLeft.body',
          params: {},
        },
        timestamp: notification.createdAt.getTime(),
      },
      GENERIC_PUSH_COPY.notification,
    );
  }

  /**
   * "We couldn't find a group for you yet" (Go together, PRD-420). A run
   * could not place this member. `isFinal: true` is the last pass before the
   * gathering, and its body says so; otherwise a later pass may still seat
   * them. `reason: HOST_SWITCHED_OFF_REASON` (sent with `isFinal: true`) means the
   * host switched Go together off for the gathering, and gets a body of its
   * own.
   *
   * Gated by `EventReminders` and sent through the preview split with the
   * generic NOTIFICATION copy. No actor and no gathering name (spec 7).
   * Opens the gathering's own page, the same link the bell row opens; falls
   * back to `/notifications`.
   */
  private async pushGoTogetherUnmatched(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.EventReminders,
    );
    if (recipientUserIds.length === 0) return;
    const eventSlug = this.payloadString(notification, 'eventSlug');
    const copy = this.goTogetherUnmatchedCopy(notification);
    await this.previewPrivacy.sendSplitByPreviewPreference(
      recipientUserIds,
      {
        title: 'Go together',
        body: copy.body,
        tag: `notification:${notification.id}`,
        data: { url: eventSlug ? gatheringPath(eventSlug) : '/notifications' },
        l10n: {
          titleKey: 'push:goTogether.unmatched.title',
          bodyKey: copy.bodyKey,
          params: {},
        },
        timestamp: notification.createdAt.getTime(),
      },
      GENERIC_PUSH_COPY.notification,
    );
  }

  /** The English body and its catalog key for one unmatched notice: the
   *  host switched Go together off, the final pass, or a pass that may still
   *  be followed by another. */
  private goTogetherUnmatchedCopy(notification: Notification): {
    body: string;
    bodyKey: string;
  } {
    if (
      this.payloadString(notification, 'reason') === HOST_SWITCHED_OFF_REASON
    ) {
      return {
        body: 'The host switched Go together off for this event',
        bodyKey: 'push:goTogether.unmatched.bodyHostSwitchedOff',
      };
    }
    if (notification.payload?.isFinal === true) {
      return {
        body: "We weren't able to place you in a group this time",
        bodyKey: 'push:goTogether.unmatched.bodyFinal',
      };
    }
    return {
      body: "We couldn't find a group for you yet. We'll keep looking",
      bodyKey: 'push:goTogether.unmatched.body',
    };
  }

  /**
   * "Want to meet your group again?" (Go together, PRD-420): the gathering
   * is over and the meet-again questions are open for a week.
   *
   * Gated by `EventReminders` and sent through the preview split with the
   * generic NOTIFICATION copy. No actor and no gathering name (spec 7).
   * Opens the feedback page for that one group, the same link the bell row
   * opens; falls back to `/notifications` when the payload has no group.
   */
  private async pushGoTogetherMeetAgain(
    userIds: string[],
    notification: Notification,
  ): Promise<void> {
    const recipientUserIds = await this.pushEnabledRecipients(
      userIds,
      NotificationPreferenceCategory.EventReminders,
    );
    if (recipientUserIds.length === 0) return;
    const groupId = this.payloadString(notification, 'groupId');
    await this.previewPrivacy.sendSplitByPreviewPreference(
      recipientUserIds,
      {
        title: 'Go together',
        body: 'Want to meet your group again?',
        tag: `notification:${notification.id}`,
        data: {
          url: groupId
            ? `${GO_TOGETHER_FEEDBACK_PATH}/${encodeURIComponent(groupId)}`
            : '/notifications',
        },
        l10n: {
          titleKey: 'push:goTogether.meetAgain.title',
          bodyKey: 'push:goTogether.meetAgain.body',
          params: {},
        },
        timestamp: notification.createdAt.getTime(),
      },
      GENERIC_PUSH_COPY.notification,
    );
  }

  /**
   * "A new device signed in to your account" (ID-06).
   *
   * THE ONE SENDER IN THIS FILE THAT DOES NOT SPLIT BY PREVIEW PREFERENCE, and
   * the reason is that there is nothing to split: this copy is already the
   * generic copy (`GENERIC_PUSH_COPY.newSignIn`). It goes through
   * `sendGenericByLanguage` so the plain fields iOS prints are in the
   * member's stored language (PRD-325). It names no member, carries no
   * actor, no avatar and no image, so hiding previews would replace one
   * non-identifying sentence with a vaguer one and cost the member the single
   * fact that makes the notification worth unlocking for.
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
    const copy = GENERIC_PUSH_COPY.newSignIn;
    await this.previewPrivacy.sendGenericByLanguage(
      userIds,
      {
        title: copy.title,
        body: copy.body,
        tag: `notification:${notification.id}`,
        data: { url: '/account/sessions' },
        l10n: {
          titleKey: copy.titleKey,
          // ENG-228. A key the service-worker catalog (`pushMessages.ts`)
          // actually holds; the old `notifications:` key lived only in the app
          // catalogs, so the worker could never localise this body.
          bodyKey: copy.bodyKey,
        },
        timestamp: notification.createdAt.getTime(),
      },
      copy,
    );
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
   * A conditional `{ icon }` spread: the actor's avatar, but ONLY when it is an
   * absolute public https URL a push client can fetch without our session cookie
   * (the same public-https-only rule as `push.listener.ts`). A storage-key
   * avatar resolves to our auth-gated `/files/*` route, which would render as a
   * broken image, so such an avatar leaves `icon` off entirely.
   *
   * ENG-412: an actor who hid their photo (`photoVisible` false) sends no icon
   * at all, the same switch feed, messaging and listings honour. A face on a
   * recipient's lock screen is the most visible place that photo could leak.
   * `resolveActor` loads the whole profile row, so the flag is always present.
   */
  private iconOf(
    profile: Profile | null,
  ): { icon: string } | Record<string, never> {
    if (!profile?.photoVisible) return {};
    const raw = profile.avatarUrl;
    return raw && !isStorageKey(raw) && raw.startsWith('https://')
      ? { icon: raw }
      : {};
  }

  /**
   * Where a mention / reply / topic push opens: the SAME destination the bell
   * row builds for that payload (`sourceHrefFromPayload` on the client), for
   * every source a mention can be written from.
   *
   * PRD-222. This used to resolve `forum` and nothing else, so "Ana mentioned
   * you" on a community post or in a DM landed on the notifications list, one
   * tap short of the thing the member was told about, while the bell row for
   * the identical payload opened the post permalink. The three sources
   * `MentionNotificationService` is ever called with are `forum`
   * (`ForumPostsService`/`ForumThreadsService`), `community`
   * (`CommunityPostsService`, both the nested and the flat write paths) and
   * `message` (`MessagesService.sendMessage`), and each is resolved here.
   *
   * `/notifications` stays the last resort rather than the default: a payload
   * whose slug or id is missing has no page to open, and the notifications
   * centre is the one destination that always reads.
   */
  private threadUrl(notification: Notification): string {
    const source = this.payloadString(notification, 'source');
    if (source === 'forum') {
      const threadSlug = this.payloadString(notification, 'threadSlug');
      if (threadSlug) return `/thread/${threadSlug}`;
    }
    if (source === 'community') {
      // The POST's own permalink, mirroring SOC-02 on the bell row: a
      // community with no `postId` (a notification about the community itself)
      // falls back to the community page rather than to the list.
      const communitySlug = this.payloadString(notification, 'communitySlug');
      if (communitySlug) {
        const postId = this.payloadString(notification, 'postId');
        return postId
          ? `/community/${communitySlug}/post/${postId}`
          : `/community/${communitySlug}`;
      }
    }
    if (source === 'message') {
      // `/messages?c=<conversationId>&m=<messageId>` is the deep-link contract
      // `useMessageDeepLinks` already honours (open that thread, then scroll to
      // and highlight that message). Same shape `push.listener.ts` uses for a
      // plain new-message push, plus the message id a mention can name.
      const conversationId = this.payloadString(notification, 'conversationId');
      if (conversationId) {
        const messageId = this.payloadString(notification, 'messageId');
        const conversationParam = encodeURIComponent(conversationId);
        return messageId
          ? `/messages?c=${conversationParam}&m=${encodeURIComponent(messageId)}`
          : `/messages?c=${conversationParam}`;
      }
    }
    if (source === 'event') {
      // A mention written in a gathering's description opens that gathering.
      const eventSlug = this.payloadString(notification, 'eventSlug');
      if (eventSlug) return gatheringPath(eventSlug);
    }
    return '/notifications';
  }

  /** A string field from the notification payload, or `undefined`. */
  private payloadString(
    notification: Notification,
    key: string,
  ): string | undefined {
    const value = notification.payload?.[key];
    return typeof value === 'string' && value ? value : undefined;
  }

  /** A finite number from the payload, or `undefined`. Same shape as
   *  `payloadString`: a missing or malformed field degrades to the caller's
   *  own fallback rather than reaching the copy as `NaN`. */
  private payloadNumber(
    notification: Notification,
    key: string,
  ): number | undefined {
    const value = notification.payload?.[key];
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
  }
}
