import { Injectable } from '@nestjs/common';
import { ConversationRole } from './entities/conversation-participant.entity';
import { GifAttachment } from './entities/message.entity';
import { MessageReactionKey } from './entities/message-reaction.entity';
import {
  ConversationResponse,
  MessageResponse,
  MessageSearchResponse,
  MessageView,
  StarredMessagesResponse,
} from './message-response';
import { ConversationsService } from './conversations.service';
import { GroupsService } from './groups.service';
import { MessageAnnotationsService } from './message-annotations.service';
import { MessageRequestsService } from './message-requests.service';
import { MessagesService } from './messages.service';

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

  markRead(conversationId: string, userId: string): Promise<{ ok: true }> {
    return this.conversationsService.markRead(conversationId, userId);
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
  ): Promise<{ ok: true }> {
    return this.conversationsService.setMuted(conversationId, userId, muted);
  }

  isParticipant(conversationId: string, userId: string): Promise<boolean> {
    return this.conversationsService.isParticipant(conversationId, userId);
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

  // ── Messages ────────────────────────────────────────────────────────────────

  getMessages(
    conversationId: string,
    userId: string,
    opts: {
      before?: string;
      beforeId?: string;
      after?: string;
      afterId?: string;
      limit?: number;
      cursor?: string;
    },
  ): Promise<MessageResponse[]> {
    return this.messagesService.getMessages(conversationId, userId, opts);
  }

  searchMessages(
    userId: string,
    rawQuery: string,
    limit?: number,
  ): Promise<MessageSearchResponse> {
    return this.messagesService.searchMessages(userId, rawQuery, limit);
  }

  sendMessage(
    conversationId: string,
    userId: string,
    body: string,
    replyToId?: string,
    clientMessageId?: string,
    forwarded?: boolean,
    kind?: 'user' | 'gif',
    attachment?: GifAttachment,
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
    );
  }

  deleteMessage(
    conversationId: string,
    messageId: string,
    userId: string,
  ): Promise<{ ok: true }> {
    return this.messagesService.deleteMessage(
      conversationId,
      messageId,
      userId,
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

  listStarredMessages(
    userId: string,
    limit?: number,
  ): Promise<StarredMessagesResponse> {
    return this.messageAnnotationsService.listStarredMessages(userId, limit);
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
    changes: { title?: string; avatarUrl?: string | null },
  ): Promise<ConversationResponse> {
    return this.groupsService.updateGroup(conversationId, actorUserId, changes);
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
}
