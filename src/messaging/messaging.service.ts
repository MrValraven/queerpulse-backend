import { Injectable } from '@nestjs/common';
import { DeleteMessageDto } from './dto/delete-message.dto';
import {
  ConversationMuteMode,
  ConversationRole,
} from './entities/conversation-participant.entity';
import { AttachmentInput } from './entities/message.entity';
import { MessageReactionKey } from './entities/message-reaction.entity';
import {
  ConversationResponse,
  MessageHistoryPage,
  MessageReactorsResponse,
  MessageResponse,
  MessageSearchResponse,
  MessageView,
  StarredMessagesResponse,
} from './message-response';
import { ConversationsService } from './conversations.service';
import { GroupsService } from './groups.service';
import { GroupInvitesService } from './group-invites.service';
import { MessageAnnotationsService } from './message-annotations.service';
import {
  EnquiryContactability,
  IdentityEnquiryContactability,
  MessageRequestsService,
} from './message-requests.service';
import { GetMessagesOptions, MessagesService } from './messages.service';
import { GroupInviteSummary, GroupJoinPreview } from './message-response';

/**
 * Thin backward-compatible facade over the split messaging providers
 * (`ConversationsService`, `MessagesService`, `MessageAnnotationsService`,
 * `GroupsService`, `MessageRequestsService`). The original 2,565-line god
 * service has been decomposed into those five focused providers (see each
 * file's header comment for its concern boundary and `MessagingCoreService`
 * for the cross-cutting helpers — notably the single `clearedAt`-floor
 * `requireParticipant` and `toMessageResponses` — they all share).
 *
 * This facade exists so `ChatGateway`, `HousingListingsService`,
 * `FlatmateProfilesService`, `ListingsService`, and
 * `ConversationsController`/`MessageRequestController` (every existing
 * `MessagingService` consumer) keep working unchanged — no behavior change,
 * pure delegation.
 */
@Injectable()
export class MessagingService {
  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly messagesService: MessagesService,
    private readonly messageAnnotationsService: MessageAnnotationsService,
    private readonly groupsService: GroupsService,
    private readonly groupInvitesService: GroupInvitesService,
    private readonly messageRequestsService: MessageRequestsService,
  ) {}

  // ── Conversations ──────────────────────────────────────────────────────────

  listConversations(userId: string): Promise<ConversationResponse[]> {
    return this.conversationsService.listConversations(userId);
  }

  unreadConversationCount(userId: string): Promise<number> {
    return this.conversationsService.unreadConversationCount(userId);
  }

  createConversation(
    userId: string,
    recipientHandle: string,
  ): Promise<ConversationResponse> {
    return this.conversationsService.createConversation(
      userId,
      recipientHandle,
    );
  }

  markRead(
    conversationId: string,
    userId: string,
    options?: { upToMessageId?: string; lastReadAt?: string },
  ): Promise<{ ok: true }> {
    return this.conversationsService.markRead(conversationId, userId, options);
  }

  markDelivered(conversationId: string, userId: string): Promise<{ ok: true }> {
    return this.conversationsService.markDelivered(conversationId, userId);
  }

  clearConversation(
    conversationId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    return this.conversationsService.clearConversation(conversationId, userId);
  }

  setMuted(
    conversationId: string,
    userId: string,
    muted: boolean,
    mutedUntil?: string | null,
  ): Promise<{ ok: true }> {
    return this.conversationsService.setMuted(
      conversationId,
      userId,
      muted,
      mutedUntil,
    );
  }

  setPinned(
    conversationId: string,
    userId: string,
    pinned: boolean,
  ): Promise<{ ok: true }> {
    return this.conversationsService.setPinned(conversationId, userId, pinned);
  }

  /** PRD-349: facade pass-through for the mute MODE axis, independent of
   *  `setMuted`/`mutedUntil` above (see `ConversationsService.setMuteMode`'s
   *  own doc). */
  setMuteMode(
    conversationId: string,
    userId: string,
    muteMode: ConversationMuteMode,
  ): Promise<{ ok: true }> {
    return this.conversationsService.setMuteMode(
      conversationId,
      userId,
      muteMode,
    );
  }

  setFavorite(
    conversationId: string,
    userId: string,
    favorite: boolean,
  ): Promise<{ ok: true }> {
    return this.conversationsService.setFavorite(
      conversationId,
      userId,
      favorite,
    );
  }

  setArchived(
    conversationId: string,
    userId: string,
    archived: boolean,
  ): Promise<{ ok: true }> {
    return this.conversationsService.setArchived(
      conversationId,
      userId,
      archived,
    );
  }

  setDraft(
    conversationId: string,
    userId: string,
    draft: string,
  ): Promise<{ ok: true }> {
    return this.conversationsService.setDraft(conversationId, userId, draft);
  }

  setMarkedUnread(
    conversationId: string,
    userId: string,
    markedUnread: boolean,
  ): Promise<{ ok: true }> {
    return this.conversationsService.setMarkedUnread(
      conversationId,
      userId,
      markedUnread,
    );
  }

  hideMessageForMe(
    conversationId: string,
    messageId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    return this.messageAnnotationsService.hideMessageForMe(
      conversationId,
      messageId,
      userId,
    );
  }

  canJoinConversationLive(
    conversationId: string,
    userId: string,
  ): Promise<boolean> {
    return this.conversationsService.canJoinConversationLive(
      conversationId,
      userId,
    );
  }

  /** DM rooms a block must evict both members from — see
   *  `ConversationsService.directConversationIdsBetween`. */
  directConversationIdsBetween(
    userId: string,
    otherUserId: string,
  ): Promise<string[]> {
    return this.conversationsService.directConversationIdsBetween(
      userId,
      otherUserId,
    );
  }

  // ── Messages ────────────────────────────────────────────────────────────────

  /** Forward reconcile (`after` set): a bare, oldest-first array. */
  getMessages(
    conversationId: string,
    userId: string,
    opts: GetMessagesOptions & { after: string },
  ): Promise<MessageResponse[]>;
  /** Backward "load older" (no `after`): a newest-first page envelope. */
  getMessages(
    conversationId: string,
    userId: string,
    opts: GetMessagesOptions & { after?: undefined },
  ): Promise<MessageHistoryPage>;
  /** Either path, decided at runtime (the controller's raw query). */
  getMessages(
    conversationId: string,
    userId: string,
    opts: GetMessagesOptions,
  ): Promise<MessageHistoryPage | MessageResponse[]>;
  getMessages(
    conversationId: string,
    userId: string,
    opts: GetMessagesOptions,
  ): Promise<MessageHistoryPage | MessageResponse[]> {
    return this.messagesService.getMessages(conversationId, userId, opts);
  }

  /**
   * Task 24: `mailboxIdentityId` (the route's `?as=`) is authorized here,
   * once and before any query, through
   * `ConversationsService.assertMayReadMailbox`.
   */
  async searchMessages(
    userId: string,
    rawQuery: string,
    limit?: number,
    conversationId?: string,
    mailboxIdentityId?: string,
  ): Promise<MessageSearchResponse> {
    if (mailboxIdentityId !== undefined) {
      await this.conversationsService.assertMayReadMailbox(
        userId,
        mailboxIdentityId,
      );
    }
    return this.messagesService.searchMessages(
      userId,
      rawQuery,
      limit,
      conversationId,
      mailboxIdentityId,
    );
  }

  sendMessage(
    conversationId: string,
    userId: string,
    body: string,
    replyToId?: string,
    clientMessageId?: string,
    forwarded?: boolean,
    kind?: 'user' | 'gif' | 'image' | 'document' | 'sticker',
    attachment?: AttachmentInput,
    stickerId?: string,
    asIdentityId?: string,
  ): Promise<MessageResponse> {
    return this.messagesService.sendMessage(
      conversationId,
      userId,
      body,
      replyToId,
      clientMessageId,
      forwarded,
      kind,
      attachment,
      stickerId,
      asIdentityId,
    );
  }

  /**
   * ENG-222: facade for `MessagesService.sendMessageWithOutcome`, used by the
   * HTTP `POST :id/messages` controller so it can tell a fresh create apart
   * from an idempotent `clientMessageId` replay and answer `201`/`200`
   * accordingly, without a second send implementation.
   */
  sendMessageWithOutcome(
    conversationId: string,
    userId: string,
    body: string,
    replyToId?: string,
    clientMessageId?: string,
    forwarded?: boolean,
    kind?: 'user' | 'gif' | 'image' | 'document' | 'sticker',
    attachment?: AttachmentInput,
    stickerId?: string,
    asIdentityId?: string,
  ): Promise<{ response: MessageResponse; isNew: boolean }> {
    return this.messagesService.sendMessageWithOutcome(
      conversationId,
      userId,
      body,
      replyToId,
      clientMessageId,
      forwarded,
      kind,
      attachment,
      stickerId,
      asIdentityId,
    );
  }

  deleteMessage(
    conversationId: string,
    messageId: string,
    userId: string,
    staffContext: DeleteMessageDto = {},
  ): Promise<{ ok: true }> {
    return this.messagesService.deleteMessage(
      conversationId,
      messageId,
      userId,
      staffContext,
    );
  }

  editMessage(
    conversationId: string,
    messageId: string,
    userId: string,
    body: string,
  ): Promise<MessageResponse> {
    return this.messagesService.editMessage(
      conversationId,
      messageId,
      userId,
      body,
    );
  }

  // ── Annotations (reactions / pins / stars) ──────────────────────────────────

  addMessageReaction(
    conversationId: string,
    messageId: string,
    userId: string,
    key: MessageReactionKey,
  ): Promise<{ ok: true }> {
    return this.messageAnnotationsService.addMessageReaction(
      conversationId,
      messageId,
      userId,
      key,
    );
  }

  removeMessageReaction(
    conversationId: string,
    messageId: string,
    userId: string,
    key: MessageReactionKey,
  ): Promise<{ ok: true }> {
    return this.messageAnnotationsService.removeMessageReaction(
      conversationId,
      messageId,
      userId,
      key,
    );
  }

  listMessageReactors(
    conversationId: string,
    messageId: string,
    userId: string,
  ): Promise<MessageReactorsResponse> {
    return this.messageAnnotationsService.listMessageReactors(
      conversationId,
      messageId,
      userId,
    );
  }

  pinMessage(
    conversationId: string,
    messageId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    return this.messageAnnotationsService.pinMessage(
      conversationId,
      messageId,
      userId,
    );
  }

  unpinMessage(
    conversationId: string,
    messageId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    return this.messageAnnotationsService.unpinMessage(
      conversationId,
      messageId,
      userId,
    );
  }

  listPinnedMessages(
    conversationId: string,
    userId: string,
  ): Promise<MessageResponse[]> {
    return this.messageAnnotationsService.listPinnedMessages(
      conversationId,
      userId,
    );
  }

  starMessage(
    conversationId: string,
    messageId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    return this.messageAnnotationsService.starMessage(
      conversationId,
      messageId,
      userId,
    );
  }

  unstarMessage(
    conversationId: string,
    messageId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    return this.messageAnnotationsService.unstarMessage(
      conversationId,
      messageId,
      userId,
    );
  }

  /**
   * Task 24: `options.mailboxIdentityId` (the route's `?as=`) is authorized
   * here, once and before any query, through
   * `ConversationsService.assertMayReadMailbox`.
   */
  async listStarredMessages(
    userId: string,
    options?: Parameters<MessageAnnotationsService['listStarredMessages']>[1],
  ): Promise<StarredMessagesResponse> {
    if (options?.mailboxIdentityId !== undefined) {
      await this.conversationsService.assertMayReadMailbox(
        userId,
        options.mailboxIdentityId,
      );
    }
    return this.messageAnnotationsService.listStarredMessages(userId, options);
  }

  // ── Groups ──────────────────────────────────────────────────────────────────

  createGroup(
    userId: string,
    title: string,
    memberHandles: string[],
    avatarUrl?: string,
  ): Promise<ConversationResponse> {
    return this.groupsService.createGroup(
      userId,
      title,
      memberHandles,
      avatarUrl,
    );
  }

  leaveGroup(conversationId: string, userId: string): Promise<{ ok: true }> {
    return this.groupsService.leaveGroup(conversationId, userId);
  }

  addMembers(
    conversationId: string,
    actorUserId: string,
    memberHandles: string[],
  ): Promise<ConversationResponse> {
    return this.groupsService.addMembers(
      conversationId,
      actorUserId,
      memberHandles,
    );
  }

  removeMember(
    conversationId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<ConversationResponse> {
    return this.groupsService.removeMember(
      conversationId,
      actorUserId,
      targetUserId,
    );
  }

  changeMemberRole(
    conversationId: string,
    actorUserId: string,
    targetUserId: string,
    role: ConversationRole,
  ): Promise<ConversationResponse> {
    return this.groupsService.changeMemberRole(
      conversationId,
      actorUserId,
      targetUserId,
      role,
    );
  }

  updateGroup(
    conversationId: string,
    actorUserId: string,
    changes: {
      title?: string;
      avatarUrl?: string | null;
      description?: string;
    },
  ): Promise<ConversationResponse> {
    return this.groupsService.updateGroup(conversationId, actorUserId, changes);
  }

  /** DES-228: `POST :id/owner` facade pass-through. */
  transferOwnership(
    conversationId: string,
    actorUserId: string,
    targetUserId: string,
  ): Promise<ConversationResponse> {
    return this.groupsService.transferOwnership(
      conversationId,
      actorUserId,
      targetUserId,
    );
  }

  /** PRD-357: `POST :id/dissolve` facade pass-through. */
  dissolveGroup(
    conversationId: string,
    actorUserId: string,
  ): Promise<ConversationResponse> {
    return this.groupsService.dissolveGroup(conversationId, actorUserId);
  }

  /** PRD-358: `POST :id/invite-link` facade pass-through. */
  createOrRotateInviteLink(
    conversationId: string,
    actorUserId: string,
  ): Promise<{ inviteToken: string }> {
    return this.groupsService.createOrRotateInviteLink(
      conversationId,
      actorUserId,
    );
  }

  /** PRD-358: `DELETE :id/invite-link` facade pass-through. */
  disableInviteLink(
    conversationId: string,
    actorUserId: string,
  ): Promise<void> {
    return this.groupsService.disableInviteLink(conversationId, actorUserId);
  }

  // ── Group invites (PRD-353) / join-by-link (PRD-358) ────────────────────────

  /** `GET /group-invites` facade pass-through. */
  listGroupInvites(userId: string): Promise<GroupInviteSummary[]> {
    return this.groupInvitesService.listMyInvites(userId);
  }

  /** `POST group-invites/:inviteId/accept` facade pass-through. */
  acceptGroupInvite(
    inviteId: string,
    userId: string,
  ): Promise<ConversationResponse> {
    return this.groupInvitesService.accept(inviteId, userId);
  }

  /** `POST group-invites/:inviteId/decline` facade pass-through. */
  declineGroupInvite(inviteId: string, userId: string): Promise<void> {
    return this.groupInvitesService.decline(inviteId, userId);
  }

  /** `DELETE :id/invites/:inviteId` facade pass-through. */
  revokeGroupInvite(
    conversationId: string,
    inviteId: string,
    actorUserId: string,
  ): Promise<void> {
    return this.groupInvitesService.revoke(
      conversationId,
      inviteId,
      actorUserId,
    );
  }

  /** `GET join/:token` facade pass-through. */
  previewGroupJoin(token: string, userId: string): Promise<GroupJoinPreview> {
    return this.groupInvitesService.previewByToken(token, userId);
  }

  /** `POST join/:token` facade pass-through. */
  joinGroupByToken(
    token: string,
    userId: string,
  ): Promise<ConversationResponse> {
    return this.groupInvitesService.joinByToken(token, userId);
  }

  // ── Message requests / cross-domain enquiries ───────────────────────────────

  messageRequest(
    userId: string,
    toSlug: string,
    body: string,
  ): Promise<{
    conversationId: string | null;
    message: MessageView | null;
    connectionRequestId: string | null;
  }> {
    return this.messageRequestsService.messageRequest(userId, toSlug, body);
  }

  deliverEnquiry(
    fromUserId: string,
    toUserId: string,
    body: string,
  ): Promise<{ conversationId: string }> {
    return this.messageRequestsService.deliverEnquiry(
      fromUserId,
      toUserId,
      body,
    );
  }

  /** Read-only "may this enquiry be sent, and can the thread be replied to?" —
   *  see `MessageRequestsService.enquiryContactability`. Lets a domain decide
   *  whether to offer a contact affordance without duplicating messaging's
   *  block and connection rules. */
  enquiryContactability(
    fromUserId: string,
    toUserId: string,
  ): Promise<EnquiryContactability> {
    return this.messageRequestsService.enquiryContactability(
      fromUserId,
      toUserId,
    );
  }

  /** Task 18: `deliverEnquiry` for a listing, persona or company mailbox,
   *  see `MessageRequestsService.deliverEnquiryToIdentity`. */
  deliverEnquiryToIdentity(
    fromUserId: string,
    toIdentityId: string,
    body: string,
    asIdentityId?: string,
  ): Promise<{ conversationId: string }> {
    return this.messageRequestsService.deliverEnquiryToIdentity(
      fromUserId,
      toIdentityId,
      body,
      asIdentityId,
    );
  }

  /** Task 18: the read-only twin of `deliverEnquiryToIdentity`, see
   *  `MessageRequestsService.identityEnquiryContactability`. */
  identityEnquiryContactability(
    fromUserId: string,
    toIdentityId: string,
  ): Promise<IdentityEnquiryContactability> {
    return this.messageRequestsService.identityEnquiryContactability(
      fromUserId,
      toIdentityId,
    );
  }
}
