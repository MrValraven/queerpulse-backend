import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { PresenceService } from '../chat/presence.service';
import { storageKeyFromImageUrl } from '../common/image-url';
import { MemberLookup } from '../common/member-ref';
import { extractMentions } from '../common/mentions';
import { ConnectionsService } from '../connections/connections.service';
import { IdentityAttributionService } from '../identities/identity-attribution.service';
import { IdentitiesService } from '../identities/identities.service';
import {
  loadSenderIdentityContext,
  renderMessageSender,
} from '../messaging/author-summary';
import {
  Conversation,
  ConversationKind,
} from '../messaging/entities/conversation.entity';
import {
  ConversationParticipant,
  isMutedForPlainMessagePush,
} from '../messaging/entities/conversation-participant.entity';
import { MessageKind } from '../messaging/entities/message.entity';
import {
  isEverySeatPersonal,
  loadReachableMailboxSeats,
  partitionMailboxThreadSeats,
} from '../messaging/mailbox-seats';
import {
  MESSAGE_CREATED,
  MessageCreatedEvent,
} from '../messaging/messaging.events';
import {
  requireAuthorSummary,
  type AuthorSummary,
  type MessageView,
} from '../messaging/message-response';
import { NotificationPreferenceCategory } from '../notifications/notification-preferences';
import { NotificationPreferencesService } from '../notifications/notification-preferences.service';
import { NotificationDeliveryService } from '../notifications/notification-delivery.service';
import { BlockFilterService } from '../social/block-filter.service';
import { isStorageKey } from '../storage/storage-key';
import { Profile } from '../users/entities/profile.entity';
import { GENERIC_PUSH_COPY } from './generic-push-copy';
import { PushPreviewPrivacyService } from './push-preview-privacy.service';
import type { PushPayload } from './push.service';

const PREVIEW_MAX = 120;

/**
 * ENG-230 push pacing. A recipient already pushed for this conversation less
 * than this long ago gets no push for the new message at all. Nothing is lost:
 * the message is in the thread, the inbox badge counts it, and the service
 * worker folds a burst into one "N new messages" notification anyway.
 */
export const PUSH_MIN_INTERVAL_MS = 3_000;

/**
 * ENG-230 push pacing. A recipient pushed for this conversation inside this
 * window (but past `PUSH_MIN_INTERVAL_MS`) still gets the push, sent with
 * `renotify: false` and no `vibrate`, so the notification updates in place
 * without buzzing the phone again. Also the age at which a pacing entry is
 * pruned, since past it an entry no longer changes any decision.
 */
export const PUSH_QUIET_REPEAT_WINDOW_MS = 60_000;

const FRESH_PUSH_VIBRATE_PATTERN = [80, 40, 80];

function preview(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > PREVIEW_MAX
    ? `${trimmed.slice(0, PREVIEW_MAX - 1)}…`
    : trimmed;
}

type AttachmentMessageKind =
  | MessageKind.Image
  | MessageKind.Gif
  | MessageKind.Document
  | MessageKind.Sticker;

/**
 * ENG-227 kind-aware copy for an attachment sent without a caption. `word` is
 * the English fallback iOS prints verbatim; the keys point at the service
 * worker's bundled catalog (`queerpulse/src/pushMessages.ts`), which localizes
 * them in the RECIPIENT'S language. The EN fallbacks must stay word-for-word
 * the catalog's EN values.
 */
const ATTACHMENT_PUSH_COPY: Record<
  AttachmentMessageKind,
  { word: string; directBodyKey: string; groupBodyKey: string }
> = {
  [MessageKind.Image]: {
    word: 'Photo',
    directBodyKey: 'push:messages.attachment.photo',
    groupBodyKey: 'push:messages.group.attachment.photo',
  },
  [MessageKind.Gif]: {
    word: 'GIF',
    directBodyKey: 'push:messages.attachment.gif',
    groupBodyKey: 'push:messages.group.attachment.gif',
  },
  [MessageKind.Document]: {
    word: 'Document',
    directBodyKey: 'push:messages.attachment.document',
    groupBodyKey: 'push:messages.group.attachment.document',
  },
  // A sticker carries no caption to preview (its send path carries only a
  // `stickerId`), so this copy is the ONLY body a sticker push ever shows.
  [MessageKind.Sticker]: {
    word: 'Sticker',
    directBodyKey: 'push:messages.attachment.sticker',
    groupBodyKey: 'push:messages.group.attachment.sticker',
  },
};

function isAttachmentMessageKind(
  kind: MessageKind,
): kind is AttachmentMessageKind {
  return (
    kind === MessageKind.Image ||
    kind === MessageKind.Gif ||
    kind === MessageKind.Document ||
    kind === MessageKind.Sticker
  );
}

/**
 * A message's typed caption, or '' when it carries none. `GifAttachment`/
 * `DocumentAttachment` declare `caption` as an optional field; `StickerAttachment`
 * declares no such field at all (a sticker send carries only a `stickerId`).
 * This checks for the key's presence before reading it, safely handling the
 * three-shape union.
 */
function attachmentCaptionText(message: MessageView): string {
  const attachment = message.attachment;
  return attachment && 'caption' in attachment
    ? (attachment.caption?.trim() ?? '')
    : '';
}

/** The content-bearing half of a message push: who/where, and what was said. */
interface MessagePushCopy {
  title: string;
  body: string;
  l10n?: PushPayload['l10n'];
  /** True only for a group with a usable title (PRD-333). */
  isGroup: boolean;
}

/**
 * PRD-333 + ENG-227: the title/body a message push carries for recipients who
 * are allowed to see its content.
 *
 * Group shape: `title` is the group's title and `body` is prefixed with the
 * sender's name, so "Anika: the terrace is booked" says which group it came
 * from. A group whose title is null or blank has nothing to name, so it falls
 * back to the DM shape (sender name as title) and does not claim `isGroup`.
 *
 * Caption rule (ENG-227): an attachment message's stored `body` is ALWAYS the
 * sender's client placeholder ("Foto", "Ficheiro", "GIF") in the sender's
 * language, never text the member typed. A caption the member typed travels
 * separately in `attachment.caption` (sanitized at the write boundary, absent
 * when none was typed). So the rule needs no placeholder matching: an
 * attachment kind with a non-blank `attachment.caption` previews the caption,
 * and an attachment kind without one ignores the body and sends the kind copy.
 */
function buildMessagePushCopy(
  message: MessageView,
  conversation: Conversation,
  senderName: string,
): MessagePushCopy {
  const groupTitle =
    conversation.kind === ConversationKind.Group
      ? (conversation.title?.trim() ?? '')
      : '';
  const isGroup = groupTitle !== '';
  const title = isGroup ? groupTitle : senderName;

  const captionText = attachmentCaptionText(message);
  if (isAttachmentMessageKind(message.kind) && captionText === '') {
    const attachmentCopy = ATTACHMENT_PUSH_COPY[message.kind];
    return isGroup
      ? {
          title,
          body: `${senderName}: ${attachmentCopy.word}`,
          l10n: {
            bodyKey: attachmentCopy.groupBodyKey,
            params: { name: senderName },
          },
          isGroup,
        }
      : {
          title,
          body: attachmentCopy.word,
          l10n: { bodyKey: attachmentCopy.directBodyKey },
          isGroup,
        };
  }

  const previewText = preview(
    isAttachmentMessageKind(message.kind) ? captionText : message.body,
  );
  return {
    title,
    body: isGroup ? `${senderName}: ${previewText}` : previewText,
    isGroup,
  };
}

/** The `groupBodyKey` attachment key, reused for the mention-aware variant.
 *  Carries a `Sticker` entry for completeness even though a sticker send's
 *  `body` is always empty and so can never actually `@`-mention anyone (see
 *  `groupMentionedParticipantUserIds`, which reads `message.body`). */
const ATTACHMENT_GROUP_MENTION_BODY_KEY: Record<AttachmentMessageKind, string> =
  {
    [MessageKind.Image]: 'push:messages.group.mention.photo',
    [MessageKind.Gif]: 'push:messages.group.mention.gif',
    [MessageKind.Document]: 'push:messages.group.mention.document',
    [MessageKind.Sticker]: 'push:messages.group.mention.sticker',
  };

/**
 * PRD-336: the mention-aware variant of `buildMessagePushCopy`'s GROUP body.
 * Callers use this ONLY for a recipient this message actually `@`-mentions,
 * and ONLY instead of (never alongside) the plain group copy for that same
 * recipient. This is the fold that keeps a mention from stacking a second
 * lock-screen row on top of the ordinary "new message" one for the identical
 * message. Same title (the group's own), same tag, same underlying preview
 * text; only the phrasing that says "this one is about you" changes.
 *
 * No DM variant exists: a DM mention is already excluded upstream (PRD-221,
 * see `MessagesService.sendMessage`'s own comment), so this is never called
 * for one.
 */
function buildGroupMentionPushCopy(
  message: MessageView,
  groupTitle: string,
  senderName: string,
): MessagePushCopy {
  const captionText = attachmentCaptionText(message);
  if (isAttachmentMessageKind(message.kind) && captionText === '') {
    const attachmentCopy = ATTACHMENT_PUSH_COPY[message.kind];
    return {
      title: groupTitle,
      body: `${senderName} mentioned you: ${attachmentCopy.word}`,
      l10n: {
        bodyKey: ATTACHMENT_GROUP_MENTION_BODY_KEY[message.kind],
        params: { name: senderName },
      },
      isGroup: true,
    };
  }
  const previewText = preview(
    isAttachmentMessageKind(message.kind) ? captionText : message.body,
  );
  return {
    title: groupTitle,
    body: `${senderName} mentioned you: ${previewText}`,
    l10n: {
      bodyKey: 'push:messages.group.mention.body',
      params: { name: senderName, preview: previewText },
    },
    isGroup: true,
  };
}

/** One paced send: who gets it, and whether it may buzz. */
interface PacedRecipients {
  freshUserIds: string[];
  quietRepeatUserIds: string[];
  /** The epoch-ms written into the pacing map for every selected recipient. */
  reservedAt: number;
}

/**
 * Task 13d: the business mailbox a DIRECT thread belongs to, as the push
 * audience reads it. Present only for a thread `partitionMailboxThreadSeats`
 * partitioned with certainty.
 */
interface MailboxPushThread {
  mailboxIdentityId: string;
  customerUserId: string;
}

/** Task 13d: who a message push goes to, and the mailbox it speaks for. */
interface MessagePushRecipients {
  recipientUserIds: Set<string>;
  /** Set exactly when the thread is a partitioned business mailbox thread. */
  mailbox?: MailboxPushThread;
}

/**
 * Task 13d: the seat-level audience of one thread. `personal` covers groups,
 * official threads and a direct thread whose every seat resolved to a
 * profile identity. `unpartitionable` is a thread with a mailbox (or an
 * unresolved) seat that `partitionMailboxThreadSeats` could not split, which
 * receives no push at all.
 */
type MessagePushThreadAudience =
  | { shape: 'personal' }
  | { shape: 'unpartitionable' }
  | {
      shape: 'mailbox';
      mailbox: MailboxPushThread;
      /** The customer seat plus the staff seats this message may reach. */
      audienceUserIds: ReadonlySet<string>;
    };

@Injectable()
export class PushMessageListener {
  private readonly logger = new Logger(PushMessageListener.name);

  /**
   * ENG-230: `${recipientUserId}:${conversationId}` to the epoch-ms of the last
   * message push this process sent that recipient for that conversation.
   *
   * In-memory and per process, the same single-instance assumption
   * `PresenceService` already makes (and `ChatSingleInstanceGuard` enforces
   * for the socket layer). A restart clears it, so the first message after a
   * restart buzzes: the safe direction to fail in.
   *
   * Every write deletes the key before setting it, so iteration order is send
   * order and `pruneExpiredPushPacing` can stop at the first live entry.
   */
  private readonly lastPushAtByRecipientConversation = new Map<
    string,
    number
  >();

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
    private readonly connections: ConnectionsService,
    // Task 13d: a business mailbox thread's seat identities and the
    // business's own display fields, and whether a reader is owed the staff
    // first name, through the same services the in-app sender uses.
    private readonly identities: IdentitiesService,
    private readonly identityAttribution: IdentityAttributionService,
  ) {}

  @OnEvent(MESSAGE_CREATED)
  async handleMessageCreated(event: MessageCreatedEvent): Promise<void> {
    try {
      const { conversationId, message } = event;
      // System messages ("X created the group", "Cy left") are timeline chrome,
      // not something a member should get a phone notification for — skip them.
      if (message.kind === MessageKind.System) return;
      // ENG-243: a sender erased mid-flight has no one to name or gate on.
      if (message.senderId === null) return;
      // Push covers member-authored DMs AND group messages — never the
      // official/announcement thread. Group members (all non-sender, offline,
      // unmuted participants) are notified the same way a DM counterpart is.
      const conversation = await this.conversations.findOne({
        where: { id: conversationId },
      });
      if (!conversation || conversation.isOfficial) return;
      // A thread mute, a block/person-mute either way, the "New message" push
      // category, and quiet hours now all live in one place,
      // `eligibleMessagePushRecipientUserIds`, since PRD-336 needs the exact
      // same question asked a second time (see that method's own doc).
      const { recipientUserIds: pushable, mailbox } =
        await this.resolveMessagePushRecipients(
          conversationId,
          message.senderId,
          undefined,
          message.senderIdentityId,
        );
      if (pushable.size === 0) return;

      const senderProfile = await this.profiles.findOne({
        where: { userId: message.senderId },
      });
      // Task 13d: a reply the business's staff wrote renders as the business,
      // exactly as the in-app bubble does, so the title and icon never name
      // the human behind it. The customer's own messages keep the profile
      // path below.
      const mailboxSenderAuthors =
        mailbox && message.senderId !== mailbox.customerUserId
          ? await this.renderMailboxSenderAuthors(
              message.senderId,
              senderProfile,
              mailbox,
            )
          : undefined;
      // Task 22: the plain title stays the business name for every
      // recipient, whoever wrote the reply, so a client with no attribution
      // catalog entry still renders today's title. The customer's own
      // payload separately gains a titleKey and params naming the staff
      // member, built further down near `contentPayload`, and only when
      // attribution allows it.
      const senderName = mailboxSenderAuthors
        ? mailboxSenderAuthors.businessAuthor.displayName
        : requireAuthorSummary(senderProfile).displayName;
      const messageCopy = buildMessagePushCopy(
        message,
        conversation,
        senderName,
      );
      const pushableUserIds = Array.from(pushable);
      // PRD-336: fold a `@`-mention of a fellow GROUP participant into THIS
      // push rather than letting `PushNotificationListener.pushMention` fire
      // a second, separately-tagged one for the identical message. Only a
      // titled group's mentions qualify (a DM's are already excluded
      // upstream, PRD-221, see `MessagesService.sendMessage`), and only a
      // mention of someone who is in `pushable` anyway: anyone excluded from
      // it (muted thread, quiet hours, blocked, category off) still gets the
      // ordinary standalone mention push, unchanged.
      const mentionedUserIds = messageCopy.isGroup
        ? await this.groupMentionedParticipantUserIds(conversation, message)
        : new Set<string>();
      const mentionedPushableUserIds = new Set(
        pushableUserIds.filter((userId) => mentionedUserIds.has(userId)),
      );
      const mentionCopy =
        mentionedPushableUserIds.size > 0
          ? buildGroupMentionPushCopy(message, messageCopy.title, senderName)
          : undefined;
      // Every lookup happens BEFORE the pacing reservation below, so the
      // decide-and-record step runs with no await in between and two messages
      // landing together cannot both be treated as the first.
      // Task 13d: on a business mailbox thread the copy follows the business
      // relationship, which is the thread's own open state, the same rule the
      // send gate enforces (`MessagesService.sendMessageWithOutcome`). The
      // title and body read identically whichever staff member sent the
      // reply; Task 22 lets the customer's own payload additionally carry a
      // staff first name through `l10n`, gated by attribution, without
      // changing this title or body. An enquiry arrives into a thread that
      // has not opened, so every enquiry pushes the generic copy to all
      // staff; once the business replies and the thread opens, every push
      // carries full copy.
      const strangerUserIds = mailbox
        ? new Set<string>(conversation.openedAt ? [] : pushableUserIds)
        : await this.recipientsNotConnectedToSender(
            conversation,
            message.senderId,
            pushableUserIds,
          );

      // Sender avatar as the notification icon — but ONLY when it is an absolute
      // public https URL a browser can fetch without our session cookie
      // (Google-OAuth / seeded avatars are stored as such absolute URLs). A
      // storage-key avatar resolves to our auth-gated `GET /files/*` route, which
      // a push client cannot fetch, so we omit `icon` entirely (conditional
      // spread below) rather than send a URL that would render as a broken image.
      // Task 13d: a mailbox sender's avatar is the business's own, already
      // resolved to a URL by `describeIdentities`; collapsing our own
      // `/files/*` URL back to its storage key lets the check below drop it.
      const mailboxAvatarUrl =
        mailboxSenderAuthors?.businessAuthor.avatarUrl ?? null;
      const rawSenderAvatar = mailboxSenderAuthors
        ? mailboxAvatarUrl && storageKeyFromImageUrl(mailboxAvatarUrl)
        : senderProfile?.avatarUrl;
      const senderAvatar =
        rawSenderAvatar &&
        !isStorageKey(rawSenderAvatar) &&
        rawSenderAvatar.startsWith('https://')
          ? rawSenderAvatar
          : undefined;

      const deepLinkUrl = `/messages?c=${conversationId}`;
      // The message's own send time rather than delivery time. Lets the SW
      // show the true moment it was sent even if the push was queued/delayed,
      // and (SP5) sorts correctly if it's later folded into a coalesced
      // "N new messages" notification.
      const timestamp = message.createdAt.getTime();

      // Task 22: the customer's payload names the staff member who wrote a
      // business reply, through a titleKey the frontend renders as
      // "{name} from {business}", only when the mailbox owner's switch and
      // the sender's own preference both allow it. `staffFirstName` already
      // carries that exact answer: `renderMailboxSenderAuthors` built it
      // above through the same `IdentityAttributionService` resolver the
      // in-app sender uses, resolved for the customer
      // (`mailbox.customerUserId`), so this reuses that one lookup, resolved
      // once above. The audience check is defensive: CW-27
      // already narrows a staff-written reply's push audience to the
      // customer alone, but a future change to that audience must never hand
      // the customer's attribution answer to a different reader, so the
      // attributed variant is built only when every pushable recipient IS
      // the customer.
      const staffFirstName =
        mailboxSenderAuthors?.businessAuthor.staffFirstName;
      const businessDisplayName =
        mailboxSenderAuthors?.businessAuthor.displayName;
      const isPushAudienceCustomerOnly =
        mailbox != null &&
        pushableUserIds.every((userId) => userId === mailbox.customerUserId);
      const staffAttributionParams =
        staffFirstName && businessDisplayName && isPushAudienceCustomerOnly
          ? { name: staffFirstName, business: businessDisplayName }
          : undefined;
      const contentL10n = staffAttributionParams
        ? {
            ...messageCopy.l10n,
            titleKey: 'push:messages.staffTitle',
            params: { ...messageCopy.l10n?.params, ...staffAttributionParams },
          }
        : messageCopy.l10n;

      // ID-13: every batch below is split by
      // `member_preferences.hide_push_previews` rather than calling
      // `sendToUsers` directly. This is the payload the split exists for: a
      // DM push puts the SENDER'S NAME in `title` and THE MESSAGE ITSELF in
      // `body`, and iOS renders both straight onto the lock screen without
      // ever running the service worker that used to redact them. Recipients
      // hiding previews get "QueerPulse / You have a new message." with no
      // name, no text and no avatar; everyone else gets this payload
      // unchanged. Still one subscription lookup per batch, not per recipient.
      const contentPayload: PushPayload = {
        title: messageCopy.title,
        body: messageCopy.body,
        tag: conversationId,
        data: {
          conversationId,
          url: deepLinkUrl,
          ...(messageCopy.isGroup ? { isGroup: true } : {}),
        },
        // Omit `icon` (not send `undefined`) when there is no public avatar.
        ...(senderAvatar ? { icon: senderAvatar } : {}),
        actions: [{ action: 'view', title: 'View' }],
        ...(contentL10n ? { l10n: contentL10n } : {}),
        timestamp,
      };
      // ENG-232: a cold DM from someone the recipient is not connected to
      // gets the generic copy whatever the recipient's preview preference,
      // matching the parallel message-request path, which never puts a
      // stranger's name on a lock screen. No icon, no actions, no params.
      const strangerPayload: PushPayload = {
        title: GENERIC_PUSH_COPY.message.title,
        body: GENERIC_PUSH_COPY.message.body,
        tag: conversationId,
        data: { conversationId, url: deepLinkUrl },
        l10n: {
          titleKey: GENERIC_PUSH_COPY.message.titleKey,
          bodyKey: GENERIC_PUSH_COPY.message.bodyKey,
        },
        timestamp,
      };
      // PRD-336: the SAME shape as `contentPayload` (same tag, so it never
      // stacks a second lock-screen row; see `sw.ts`'s tag-coalescing note),
      // with only the mention-aware title/body/l10n swapped in. Built once,
      // reused across the fresh/quiet-repeat split below.
      const mentionContentPayload: PushPayload | undefined = mentionCopy
        ? {
            ...contentPayload,
            title: mentionCopy.title,
            body: mentionCopy.body,
            l10n: mentionCopy.l10n,
          }
        : undefined;

      // ENG-230: pace per recipient and conversation. Synchronous from here
      // to the first send, so the reservation cannot race another message.
      const pacedRecipients = this.reservePushPacing(
        pushableUserIds,
        conversationId,
      );
      const sendBatches: { userIds: string[]; payload: PushPayload }[] = [];
      for (const [userIds, isQuietRepeat] of [
        [pacedRecipients.freshUserIds, false],
        [pacedRecipients.quietRepeatUserIds, true],
      ] as const) {
        const connectedUserIds = userIds.filter(
          (userId) => !strangerUserIds.has(userId),
        );
        const unconnectedUserIds = userIds.filter((userId) =>
          strangerUserIds.has(userId),
        );
        // PRD-336: split the connected (never-a-stranger, since a group is
        // never a "stranger" DM) bucket once more, by whether this exact
        // message `@`-mentions the recipient: mentioned recipients get
        // `mentionContentPayload` instead of the plain one, never both.
        const mentionedInBatch = mentionContentPayload
          ? connectedUserIds.filter((userId) =>
              mentionedPushableUserIds.has(userId),
            )
          : [];
        const plainConnectedUserIds = mentionContentPayload
          ? connectedUserIds.filter(
              (userId) => !mentionedPushableUserIds.has(userId),
            )
          : connectedUserIds;
        if (plainConnectedUserIds.length > 0) {
          sendBatches.push({
            userIds: plainConnectedUserIds,
            payload: withPushPacing(contentPayload, isQuietRepeat),
          });
        }
        if (mentionedInBatch.length > 0 && mentionContentPayload) {
          sendBatches.push({
            userIds: mentionedInBatch,
            payload: withPushPacing(mentionContentPayload, isQuietRepeat),
          });
        }
        if (unconnectedUserIds.length > 0) {
          sendBatches.push({
            userIds: unconnectedUserIds,
            payload: withPushPacing(strangerPayload, isQuietRepeat),
          });
        }
      }

      // One batch after another, never `Promise.all`: `sendToUsers` caps its
      // fan-out PER CALL (see `MAX_CONCURRENT_PUSH_SENDS` and the sequencing
      // comment in `PushPreviewPrivacyService`), so concurrent batches would
      // multiply the real ceiling against the database pool. A failed batch
      // does not stop the others, and it releases its recipients' pacing
      // reservation so their next message buzzes instead of being quieted
      // behind a push that never went out.
      for (const batch of sendBatches) {
        try {
          await this.previewPrivacy.sendSplitByPreviewPreference(
            batch.userIds,
            batch.payload,
            // "A new message" rather than "a new notification": the most the
            // copy can narrow without leaking who or what.
            GENERIC_PUSH_COPY.message,
          );
        } catch (error) {
          this.releasePushPacing(
            batch.userIds,
            conversationId,
            pacedRecipients.reservedAt,
          );
          this.logger.warn(`Push on new message failed: ${String(error)}`);
        }
      }
    } catch (error) {
      // Push is best-effort and must never affect message delivery.
      this.logger.warn(`Push on new message failed: ${String(error)}`);
    }
  }

  /**
   * The participants of `conversationId` who would receive THIS message's
   * plain "new message" push right now: excluding the sender, anyone who
   * left, anyone currently online, anyone who has thread-muted it, and
   * anyone blocked (either direction) or muting the sender; requiring the
   * "New message" push category to be on and the recipient to be outside
   * quiet hours. Everything `handleMessageCreated` used to compute inline
   * for its own `pushable` set, now in one place.
   *
   * `candidateUserIds`, when given, narrows which participants are even
   * loaded (omitted, every participant of the conversation is a candidate).
   *
   * `senderIdentityId`, when given, excludes every seat speaking for that
   * same identity, the literal sender included. This is the push-side twin
   * of the unread rule (`unread-own-identity.spec.ts`): on a shared mailbox
   * thread every staff seat carries the business identity as its
   * `identityId`, so a colleague's reply sent as the business is the
   * business speaking, and it stays out of every OTHER staff seat's push the
   * same way it already stays out of their unread count. The customer's own
   * seat always carries their own personal identity, so this check always
   * leaves the customer in the audience.
   *
   * PRD-349: a `mentionsOnly`-muted participant is excluded from this set the
   * same way a fully (`muted`) one already was, via `isMutedForPlainMessagePush`
   * rather than the narrower `isParticipantMuted`. That is what makes the
   * mentions-only mode compose correctly with the PRD-336 fold just below: a
   * mentions-only participant never lands in `pushable`, so `handleMessageCreated`
   * never sends them the plain OR the merged mention-aware message push, and
   * `PushNotificationListener.pushMention`'s own fold
   * (`dropRecipientsAlreadyCoveredByMessagePush`, which asks THIS method the
   * identical question) then finds they are NOT covered and sends them its own
   * standalone `@`-mention push instead. Net effect: a plain message never
   * reaches a mentions-only member, and a message that mentions them reaches
   * them exactly once, through the mention path rather than this one.
   *
   * PRD-336: exposed beyond this listener's own use so
   * `PushNotificationListener.pushMention` can ask, for a GROUP `@mention` on
   * the identical message, "is this recipient about to get (or did they
   * already get) the merged, mention-aware message push from THIS listener?"
   * This is the fold that keeps a mention from stacking a second lock-screen
   * row on top of the ordinary message push. Recomputed fresh on each call rather
   * than read off any state this listener wrote during its own run, so there
   * is no ordering dependency between the two listeners reacting to the same
   * `sendMessage` call: each asks the same deterministic question of the
   * database and gets the same answer.
   *
   * Task 13d: a business mailbox thread builds its audience from the seats
   * (`resolveMessagePushRecipients`), and a claim narrows only the
   * business's STAFF seats. Recipients are the customer seat plus the
   * claimant when the thread is claimed, or every live staff seat when it is
   * unclaimed, minus the sender, and then the leftAt, online, muted, blocked
   * and quiet-hours filters below, including the per-identity filter that
   * drops every seat sharing the sender's own `identityId` (CW-27, Task 15).
   * A staff member's reply is sent as the one business identity every staff
   * seat shares, so that filter removes the whole staff audience whatever
   * the claim state: the claimant's own reply and a colleague's reply both
   * reach the customer exclusively, excluding every fellow staff seat. The
   * claim narrowing therefore only shapes who the CUSTOMER's own message
   * reaches: the claimant alone when the thread is claimed, every live
   * staff seat when it is unclaimed. An online claimant still gets no push,
   * exactly like an online member on any other thread.
   *
   * A staff member blocked either way with the customer is outside the
   * audience, whoever sent (`loadReachableMailboxSeats`), and a claim that
   * staff member held before the block is ignored for push, so the
   * customer's messages reach the remaining live, unblocked staff. A
   * claimant with no live seat at all keeps Task 12's defensive answer, no
   * staff push: `IdentityMailboxSyncService.unseatUser` releases the claim in
   * the same operation that ends the seat, so the case does not arise in
   * practice, and falling back to the whole roster would recreate the
   * double-reply problem claiming exists to solve.
   */
  async eligibleMessagePushRecipientUserIds(
    conversationId: string,
    senderId: string,
    candidateUserIds?: string[],
    senderIdentityId?: string | null,
  ): Promise<Set<string>> {
    const { recipientUserIds } = await this.resolveMessagePushRecipients(
      conversationId,
      senderId,
      candidateUserIds,
      senderIdentityId,
    );
    return recipientUserIds;
  }

  /**
   * Task 13d: `eligibleMessagePushRecipientUserIds`, together with the
   * mailbox the thread belongs to, which `handleMessageCreated` needs to
   * render the push as the business.
   *
   * On a mailbox thread the person-level block and mute below are read for
   * the business's staff recipients only. The customer receives every reply
   * the business sends, whatever personal block or mute they hold against
   * one employee, since skipping that employee's replies would tell the
   * customer which replies were theirs. A block between the customer and a
   * staff member removes that staff member's own access instead (see the
   * audience above), which is the rule every REST surface already follows.
   */
  private async resolveMessagePushRecipients(
    conversationId: string,
    senderId: string,
    candidateUserIds?: string[],
    senderIdentityId?: string | null,
  ): Promise<MessagePushRecipients> {
    const [participants, conversation] = await Promise.all([
      this.participants.find({
        where: {
          conversationId,
          ...(candidateUserIds ? { userId: In(candidateUserIds) } : {}),
        },
        select: {
          userId: true,
          identityId: true,
          leftAt: true,
          muted: true,
          mutedUntil: true,
          muteMode: true,
        },
      }),
      this.conversations.findOne({
        where: { id: conversationId },
        select: {
          id: true,
          kind: true,
          isOfficial: true,
          claimedByUserId: true,
        },
      }),
    ]);
    if (!conversation) return { recipientUserIds: new Set() };
    const threadAudience = await this.loadMessagePushThreadAudience(
      conversation,
      candidateUserIds ? undefined : participants,
    );
    if (threadAudience.shape === 'unpartitionable') {
      return { recipientUserIds: new Set() };
    }
    const mailboxAudience =
      threadAudience.shape === 'mailbox' ? threadAudience : undefined;
    const mailbox = mailboxAudience?.mailbox;
    const audienceParticipants = mailboxAudience
      ? participants.filter((participant) =>
          mailboxAudience.audienceUserIds.has(participant.userId),
        )
      : participants;
    const now = new Date();
    const targets = audienceParticipants.filter(
      (participant) =>
        participant.userId !== senderId &&
        participant.identityId !== senderIdentityId &&
        participant.leftAt == null &&
        !this.presence.isOnline(participant.userId) &&
        !isMutedForPlainMessagePush(participant, now),
    );
    if (targets.length === 0) return { recipientUserIds: new Set(), mailbox };
    const targetUserIds = targets.map((participant) => participant.userId);
    const personGatedUserIds = mailbox
      ? targetUserIds.filter((userId) => userId !== mailbox.customerUserId)
      : targetUserIds;
    const [blockedUserIds, muterUserIds] = await Promise.all([
      this.blockFilter.blockedUserIds(senderId, personGatedUserIds),
      this.blockFilter.mutersOf(senderId, personGatedUserIds),
    ]);
    const deliverableUserIds = targetUserIds.filter(
      (userId) => !blockedUserIds.has(userId) && !muterUserIds.has(userId),
    );
    if (deliverableUserIds.length === 0) {
      return { recipientUserIds: new Set(), mailbox };
    }
    const [pushEnabledUserIds, audibleUserIds] = await Promise.all([
      this.notificationPreferences.recipientsPushEnabled(
        deliverableUserIds,
        NotificationPreferenceCategory.NewMessages,
      ),
      this.notificationDelivery.recipientsOutsideQuietHours(deliverableUserIds),
    ]);
    const pushEnabled = new Set(pushEnabledUserIds);
    const audible = new Set(audibleUserIds);
    return {
      recipientUserIds: new Set(
        deliverableUserIds.filter(
          (userId) => pushEnabled.has(userId) && audible.has(userId),
        ),
      ),
      mailbox,
    };
  }

  /**
   * Task 13d: whether a thread is personal or a business mailbox, and for a
   * mailbox thread which seats this message may reach. `loadedSeats` is the
   * thread's full seat list when the caller already holds it; a caller that
   * narrowed its own participant query passes `undefined`, and the seats are
   * read here.
   *
   * A thread is personal only once every seat is confirmed a profile
   * identity. A mailbox or unresolved seat with no certain partition reads
   * `unpartitionable`, so nothing that could carry a staff member's identity
   * is pushed from it.
   *
   * The partition drops departed seats (`shouldIncludeDepartedSeats: false`):
   * a push audience is the people who can act now. It is NOT block-aware, so
   * the live staff seats then go through `loadReachableMailboxSeats`, the
   * one home of the rule the REST surfaces and the live socket frames apply,
   * with the blocks between each staff member and the customer read in one
   * batched query.
   */
  private async loadMessagePushThreadAudience(
    conversation: Pick<
      Conversation,
      'id' | 'kind' | 'isOfficial' | 'claimedByUserId'
    >,
    loadedSeats: ConversationParticipant[] | undefined,
  ): Promise<MessagePushThreadAudience> {
    if (
      conversation.kind === ConversationKind.Group ||
      conversation.isOfficial
    ) {
      return { shape: 'personal' };
    }
    const seats =
      loadedSeats ??
      (await this.participants.find({
        where: { conversationId: conversation.id },
        select: { userId: true, identityId: true, leftAt: true },
      }));
    const identities = await this.identities.getByIds(
      seats.map((seat) => seat.identityId),
    );
    const identityKindById = new Map(
      identities.map((identity) => [identity.id, identity.kind]),
    );
    if (isEverySeatPersonal(seats, identityKindById)) {
      return { shape: 'personal' };
    }
    const partition = partitionMailboxThreadSeats(seats, identityKindById, {
      shouldIncludeDepartedSeats: false,
    });
    if (!partition) return { shape: 'unpartitionable' };

    const customerSeat = partition.customerSeat;
    const reachableSeats = await loadReachableMailboxSeats(
      partition,
      identityKindById,
      this.blockFilter,
    );
    // Task 14: the customer blocked the business, so the thread reaches
    // nobody: the customer's own seat and every staff seat are out.
    if (!reachableSeats.customerSeat) {
      return {
        shape: 'mailbox',
        mailbox: {
          mailboxIdentityId: partition.mailboxIdentityId,
          customerUserId: customerSeat.userId,
        },
        audienceUserIds: new Set(),
      };
    }
    const reachableStaffUserIds = new Set(
      reachableSeats.staffSeats.map((seat) => seat.userId),
    );

    const claimedByUserId = conversation.claimedByUserId;
    const hasLiveClaimantSeat = partition.staffSeats.some(
      (seat) => seat.userId === claimedByUserId,
    );
    let staffAudienceUserIds: ReadonlySet<string>;
    if (!claimedByUserId) {
      staffAudienceUserIds = reachableStaffUserIds;
    } else if (reachableStaffUserIds.has(claimedByUserId)) {
      staffAudienceUserIds = new Set([claimedByUserId]);
    } else if (hasLiveClaimantSeat) {
      // The claimant holds a live seat and a block removed it: the claim is
      // ignored for push, and the business keeps hearing its customer.
      staffAudienceUserIds = reachableStaffUserIds;
    } else {
      staffAudienceUserIds = new Set();
    }
    return {
      shape: 'mailbox',
      mailbox: {
        mailboxIdentityId: partition.mailboxIdentityId,
        customerUserId: customerSeat.userId,
      },
      audienceUserIds: new Set([customerSeat.userId, ...staffAudienceUserIds]),
    };
  }

  /**
   * Task 13d: a staff-written mailbox reply's sender, rendered by
   * `renderMessageSender` exactly as the in-app bubble renders it for the
   * customer. The sender is rendered as the mailbox identity their seat
   * speaks for, so a message row carrying no identity still renders the
   * business. Only the business's own display name and avatar are read from
   * it (see the title comment in `handleMessageCreated`).
   */
  private async renderMailboxSenderAuthors(
    senderId: string,
    senderProfile: Profile | null,
    mailbox: MailboxPushThread,
  ): Promise<{ businessAuthor: AuthorSummary }> {
    const senderContext = await loadSenderIdentityContext(
      {
        identities: this.identities,
        identityAttribution: this.identityAttribution,
      },
      [mailbox.mailboxIdentityId],
      mailbox.customerUserId,
    );
    const profileByUser = new Map<string, Profile>(
      senderProfile ? [[senderId, senderProfile]] : [],
    );
    return {
      businessAuthor: renderMessageSender(
        { senderId, senderIdentityId: mailbox.mailboxIdentityId },
        profileByUser,
        senderContext,
      ),
    };
  }

  /**
   * The subset of `conversation`'s CURRENT participants (mirrors
   * `MentionNotificationService.recipientsAllowedForSource`'s own
   * message-source restriction: excludes anyone who left) that `message`'s
   * body `@`-mentions, excluding the sender. Reads `message.body`: for an
   * attachment message that is always the sender's placeholder text, never a
   * typed caption (see `buildMessagePushCopy`'s own doc), so this correctly
   * finds nothing for one today, exactly like `MentionNotificationService`
   * does when it fans the same body out to notification rows.
   */
  private async groupMentionedParticipantUserIds(
    conversation: Conversation,
    message: MessageView,
  ): Promise<Set<string>> {
    const slugs = extractMentions(message.body).members;
    if (slugs.length === 0) return new Set();
    const bySlug = await new MemberLookup(this.profiles).userIdsForSlugs(slugs);
    const candidateUserIds = Array.from(new Set(bySlug.values())).filter(
      (userId) => userId !== message.senderId,
    );
    if (candidateUserIds.length === 0) return new Set();
    const rows = await this.participants.find({
      where: {
        conversationId: conversation.id,
        userId: In(candidateUserIds),
        leftAt: IsNull(),
      },
      select: { userId: true },
    });
    return new Set(rows.map((row) => row.userId));
  }

  /**
   * ENG-232: the recipients of a 1:1 conversation who are NOT accepted
   * connections of the sender. Always empty for a group, whose membership is
   * itself the consent to hear from its members.
   *
   * Fails private: a lookup that throws counts as "not connected", so the
   * recipient still gets a push, with the generic copy.
   */
  private async recipientsNotConnectedToSender(
    conversation: Conversation,
    senderId: string,
    recipientUserIds: string[],
  ): Promise<Set<string>> {
    if (conversation.kind !== ConversationKind.Direct) return new Set();
    const strangerUserIds = new Set<string>();
    // A direct conversation has exactly one recipient, so this is one query.
    for (const recipientUserId of recipientUserIds) {
      let isConnected = false;
      try {
        isConnected = await this.connections.areConnected(
          senderId,
          recipientUserId,
        );
      } catch (error) {
        this.logger.warn(
          `Connection lookup for message push failed: ${String(error)}`,
        );
      }
      if (!isConnected) strangerUserIds.add(recipientUserId);
    }
    return strangerUserIds;
  }

  /**
   * ENG-230: sort recipients into fresh (buzz) and quiet repeat (update in
   * place), drop anyone pushed for this conversation under
   * `PUSH_MIN_INTERVAL_MS` ago, and record `now` for every recipient that
   * will be sent to. Suppressed recipients keep their earlier timestamp, so a
   * steady stream cannot hold them silent forever: the next message past the
   * interval gets through.
   */
  private reservePushPacing(
    userIds: string[],
    conversationId: string,
  ): PacedRecipients {
    const now = Date.now();
    this.pruneExpiredPushPacing(now);
    const freshUserIds: string[] = [];
    const quietRepeatUserIds: string[] = [];
    for (const userId of userIds) {
      const pacingKey = `${userId}:${conversationId}`;
      const lastPushAt = this.lastPushAtByRecipientConversation.get(pacingKey);
      const elapsedMs =
        lastPushAt === undefined ? Number.POSITIVE_INFINITY : now - lastPushAt;
      // A negative elapsed time means the clock moved backwards; treat the
      // entry as unknown and let the push buzz.
      if (elapsedMs >= 0 && elapsedMs < PUSH_MIN_INTERVAL_MS) continue;
      if (elapsedMs >= 0 && elapsedMs < PUSH_QUIET_REPEAT_WINDOW_MS) {
        quietRepeatUserIds.push(userId);
      } else {
        freshUserIds.push(userId);
      }
      // Delete then set, so the key moves to the end and the map stays in
      // send order for the pruning loop.
      this.lastPushAtByRecipientConversation.delete(pacingKey);
      this.lastPushAtByRecipientConversation.set(pacingKey, now);
    }
    return { freshUserIds, quietRepeatUserIds, reservedAt: now };
  }

  /**
   * Undo a reservation for a batch whose send failed. Only an entry still
   * holding this reservation's timestamp is removed (a newer message may have
   * re-reserved it meanwhile). Removing rather than restoring the older value
   * keeps the map in send order, and it errs towards the next push buzzing.
   */
  private releasePushPacing(
    userIds: string[],
    conversationId: string,
    reservedAt: number,
  ): void {
    for (const userId of userIds) {
      const pacingKey = `${userId}:${conversationId}`;
      if (
        this.lastPushAtByRecipientConversation.get(pacingKey) === reservedAt
      ) {
        this.lastPushAtByRecipientConversation.delete(pacingKey);
      }
    }
  }

  /**
   * Bound the pacing map: drop every entry at or past
   * `PUSH_QUIET_REPEAT_WINDOW_MS`, since such an entry no longer changes a
   * decision. The map is in send order, so the loop stops at the first live
   * entry and the cost is proportional to what expired. An entry from the
   * future (clock moved backwards) is dropped too, so a clock step can never
   * wedge the loop at the head and let the map grow.
   */
  private pruneExpiredPushPacing(now: number): void {
    for (const [pacingKey, pushedAt] of this
      .lastPushAtByRecipientConversation) {
      const ageMs = now - pushedAt;
      if (ageMs >= 0 && ageMs < PUSH_QUIET_REPEAT_WINDOW_MS) break;
      this.lastPushAtByRecipientConversation.delete(pacingKey);
    }
  }
}

/**
 * ENG-230: a fresh push re-alerts on tag replace and vibrates; a quiet repeat
 * sets `renotify: false` and carries no `vibrate`, so the notification updates
 * silently.
 */
function withPushPacing(
  payload: PushPayload,
  isQuietRepeat: boolean,
): PushPayload {
  return isQuietRepeat
    ? { ...payload, renotify: false }
    : { ...payload, renotify: true, vibrate: FRESH_PUSH_VIBRATE_PATTERN };
}
