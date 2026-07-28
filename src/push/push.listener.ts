import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PresenceService } from '../chat/presence.service';
import { Conversation } from '../messaging/entities/conversation.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import {
  MESSAGE_CREATED,
  MessageCreatedEvent,
} from '../messaging/messaging.events';
import { requireAuthorSummary } from '../messaging/message-response';
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
  ) {}

  @OnEvent(MESSAGE_CREATED)
  async handleMessageCreated(event: MessageCreatedEvent): Promise<void> {
    try {
      const { conversationId, message } = event;
      // Push is scoped to member-to-member DMs only — official/announcement
      // and other multi-participant threads never trigger a push. `isOfficial`
      // is the same discriminator messaging.service.ts uses to label a
      // conversation 'dm' vs 'group' (a DM also carries a non-null `pairKey`).
      const conversation = await this.conversations.findOne({
        where: { id: conversationId },
      });
      if (!conversation || conversation.isOfficial) return;
      // muted:false at the query level drops anyone who muted this thread.
      const participants = await this.participants.find({
        where: { conversationId, muted: false },
      });
      const targets = participants.filter(
        (participant) =>
          participant.userId !== message.senderId &&
          !this.presence.isOnline(participant.userId),
      );
      if (targets.length === 0) return;

      const senderProfile = await this.profiles.findOne({
        where: { userId: message.senderId },
      });
      const senderName = requireAuthorSummary(senderProfile).displayName;
      const body = preview(message.body);

      await Promise.all(
        targets.map((participant) =>
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
