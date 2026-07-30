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
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { PushService } from './push.service';

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
    private readonly pushService: PushService,
    private readonly blockFilter: BlockFilterService,
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

      // P0 hardening: a block either way must stop a push from ever reaching
      // the blocked party's phone. `sendMessage` already refuses to CREATE a
      // direct message between blocked members, but a group has no single
      // "other" party to gate the send on, so a blocked group member is
      // filtered out here instead — belt-and-braces for the direct case too.
      const blockedUserIds = await this.blockFilter.blockedUserIds(
        message.senderId,
        targets.map((participant) => participant.userId),
      );
      const deliverable = targets.filter(
        (participant) => !blockedUserIds.has(participant.userId),
      );
      if (deliverable.length === 0) return;

      const senderProfile = await this.profiles.findOne({
        where: { userId: message.senderId },
      });
      const senderName = requireAuthorSummary(senderProfile).displayName;
      const body = preview(message.body);

      await Promise.all(
        deliverable.map((participant) =>
          this.pushService.sendToUser(participant.userId, {
            title: senderName,
            body,
            tag: conversationId,
            data: { conversationId, url: `/messages?c=${conversationId}` },
          }),
        ),
      );
    } catch (error) {
      // Push is best-effort and must never affect message delivery.
      this.logger.warn(`Push on new message failed: ${String(error)}`);
    }
  }
}
