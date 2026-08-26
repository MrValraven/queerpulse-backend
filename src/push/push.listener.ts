import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PresenceService } from '../chat/presence.service';
import { Conversation } from '../messaging/entities/conversation.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { MessageKind } from '../messaging/entities/message.entity';
import {
  MESSAGE_CREATED,
  MessageCreatedEvent,
} from '../messaging/messaging.events';
import { requireAuthorSummary } from '../messaging/message-response';
import { NotificationPreferenceCategory } from '../notifications/notification-preferences';
import { NotificationPreferencesService } from '../notifications/notification-preferences.service';
import { NotificationDeliveryService } from '../notifications/notification-delivery.service';
import { BlockFilterService } from '../social/block-filter.service';
import { isStorageKey } from '../storage/storage-key';
import { Profile } from '../users/entities/profile.entity';
import { GENERIC_PUSH_COPY } from './generic-push-copy';
import { PushPreviewPrivacyService } from './push-preview-privacy.service';

const PREVIEW_MAX = 120;

function preview(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > PREVIEW_MAX
    ? `${trimmed.slice(0, PREVIEW_MAX - 1)}…`
    : trimmed;
}

@Injectable()
export class PushMessageListener {
  private readonly logger = new Logger(PushMessageListener.name);

  constructor(
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(ConversationParticipant)
    private readonly participants: Repository<ConversationParticipant>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly presence: PresenceService,
    private readonly previewPrivacy: PushPreviewPrivacyService,
    private readonly blockFilter: BlockFilterService,
    private readonly notificationPreferences: NotificationPreferencesService,
    private readonly notificationDelivery: NotificationDeliveryService,
  ) {}

  @OnEvent(MESSAGE_CREATED)
  async handleMessageCreated(event: MessageCreatedEvent): Promise<void> {
    try {
      const { conversationId, message } = event;
      // System messages ("X created the group", "Cy left") are timeline chrome,
      // not something a member should get a phone notification for — skip them.
      if (message.kind === MessageKind.System) return;
      // Push covers member-authored DMs AND group messages — never the
      // official/announcement thread. Group members (all non-sender, offline,
      // unmuted participants) are notified the same way a DM counterpart is.
      const conversation = await this.conversations.findOne({
        where: { id: conversationId },
      });
      if (!conversation || conversation.isOfficial) return;
      // muted:false at the query level drops anyone who muted this thread.
      // A member who LEFT a group keeps their row (for history) but must not be
      // pushed — filter them out alongside the sender + online members.
      const participants = await this.participants.find({
        where: { conversationId, muted: false },
      });
      const targets = participants.filter(
        (participant) =>
          participant.userId !== message.senderId &&
          participant.leftAt == null &&
          !this.presence.isOnline(participant.userId),
      );
      if (targets.length === 0) return;

      // P0/P1-3 hardening: a block either way — OR a person-level mute of the
      // sender — must stop a push from ever reaching that recipient's phone.
      // `sendMessage` already refuses to CREATE a direct message between blocked
      // members, but a group has no single "other" party to gate the send on, so
      // blocked/muting group members are filtered out here instead (belt-and-
      // braces for the direct case too). Two directional lookups: `blockedUserIds`
      // (block either way between sender and recipient) and `mutersOf` (recipients
      // who muted the SENDER at the person level — NOT `mutedUserIds`, which would
      // be whom the sender muted, the wrong direction). The person-level mute is
      // distinct from the thread-level `muted: false` already applied by the query
      // above, which only silences a conversation, not a person.
      const recipientUserIds = targets.map((participant) => participant.userId);
      const [blockedUserIds, muterUserIds] = await Promise.all([
        this.blockFilter.blockedUserIds(message.senderId, recipientUserIds),
        this.blockFilter.mutersOf(message.senderId, recipientUserIds),
      ]);
      const deliverable = targets.filter(
        (participant) =>
          !blockedUserIds.has(participant.userId) &&
          !muterUserIds.has(participant.userId),
      );
      if (deliverable.length === 0) return;

      // Member preference gate (after the block/mute safety filter): drop anyone
      // who turned the "New message" push category off. Batched — one query for
      // all deliverable recipients. This is the push twin of the in-app category
      // gate in `NotificationsService`; the two channels share one switch.
      const pushEnabledUserIds = new Set(
        await this.notificationPreferences.recipientsPushEnabled(
          deliverable.map((participant) => participant.userId),
          NotificationPreferenceCategory.NewMessages,
        ),
      );
      // Quiet hours, on top of the category switch above. A DM landing at 3am
      // is the case the setting exists for, so the buzz is withheld here too.
      // Nothing is lost: the message is already in the conversation and the
      // Messages inbox badge still counts it, exactly as it does for a
      // recipient who simply has push turned off.
      const audibleUserIds = new Set(
        await this.notificationDelivery.recipientsOutsideQuietHours(
          deliverable.map((participant) => participant.userId),
        ),
      );
      const pushable = deliverable.filter(
        (participant) =>
          pushEnabledUserIds.has(participant.userId) &&
          audibleUserIds.has(participant.userId),
      );
      if (pushable.length === 0) return;

      const senderProfile = await this.profiles.findOne({
        where: { userId: message.senderId },
      });
      const senderName = requireAuthorSummary(senderProfile).displayName;
      const body = preview(message.body);

      // Sender avatar as the notification icon — but ONLY when it is an absolute
      // public https URL a browser can fetch without our session cookie
      // (Google-OAuth / seeded avatars are stored as such absolute URLs). A
      // storage-key avatar resolves to our auth-gated `GET /files/*` route, which
      // a push client cannot fetch, so we omit `icon` entirely (conditional
      // spread below) rather than send a URL that would render as a broken image.
      const rawSenderAvatar = senderProfile?.avatarUrl;
      const senderAvatar =
        rawSenderAvatar &&
        !isStorageKey(rawSenderAvatar) &&
        rawSenderAvatar.startsWith('https://')
          ? rawSenderAvatar
          : undefined;

      // ID-13: split by `member_preferences.hide_push_previews` rather than
      // calling `sendToUsers` directly. This is the payload the split exists
      // for: a DM push puts the SENDER'S NAME in `title` and THE MESSAGE
      // ITSELF in `body`, and iOS renders both straight onto the lock screen
      // without ever running the service worker that used to redact them.
      // Recipients hiding previews get "QueerPulse / You have a new message."
      // with no name, no text and no avatar; everyone else gets this payload
      // unchanged. Still one subscription lookup per group, not per recipient.
      await this.previewPrivacy.sendSplitByPreviewPreference(
        pushable.map((participant) => participant.userId),
        {
          title: senderName,
          body,
          tag: conversationId,
          data: { conversationId, url: `/messages?c=${conversationId}` },
          // Omit `icon` (not send `undefined`) when there is no public avatar.
          ...(senderAvatar ? { icon: senderAvatar } : {}),
          actions: [{ action: 'view', title: 'View' }],
          renotify: true,
          vibrate: [80, 40, 80],
          // The message's own send time, not delivery time — lets the SW show
          // the true moment it was sent even if the push was queued/delayed,
          // and (SP5) sorts correctly if it's later folded into a coalesced
          // "N new messages" notification.
          timestamp: message.createdAt.getTime(),
        },
        // "A new message" rather than "a new notification": the most the copy
        // can narrow without leaking who or what.
        GENERIC_PUSH_COPY.message,
      );
    } catch (error) {
      // Push is best-effort and must never affect message delivery.
      this.logger.warn(`Push on new message failed: ${String(error)}`);
    }
  }
}
