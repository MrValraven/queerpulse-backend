import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CONNECTION_ACCEPTED,
  ConnectionAcceptedEvent,
} from '../connections/connection.events';
import { ConnectionsService } from '../connections/connections.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { MessageView } from './message-response';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Message-requests concern of the split `MessagingService`: cold-contact flows
 * that seed or bypass a 1:1 conversation without the caller already being a
 * participant — the "message a stranger" connection-request flow
 * (`messageRequest`), cross-domain enquiry delivery (`deliverEnquiry`, used by
 * housing/listings), and materializing the DM once a connection request is
 * accepted. Everyday thread reads/sends live in `MessagesService`/
 * `ConversationsService`.
 */
@Injectable()
export class MessageRequestsService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly core: MessagingCoreService,
    private readonly connectionsService: ConnectionsService,
    private readonly blockFilter: BlockFilterService,
  ) {}

  async messageRequest(
    userId: string,
    toSlug: string,
    body: string,
  ): Promise<{
    conversationId: string | null;
    message: MessageView | null;
    connectionRequestId: string | null;
  }> {
    const recipient = await this.profiles.findOne({ where: { slug: toSlug } });
    if (!recipient) {
      throw new NotFoundException('Member not found');
    }
    if (recipient.userId === userId) {
      throw new BadRequestException('You cannot message yourself');
    }
    if (await this.blockFilter.isBlockedEitherWay(userId, recipient.userId)) {
      throw new ForbiddenException('You cannot message this member');
    }

    if (await this.connectionsService.areConnected(userId, recipient.userId)) {
      const { conversation } = await this.core.getOrCreateConversation(
        userId,
        recipient.userId,
      );
      const { view } = await this.core.postMessage(
        conversation.id,
        userId,
        body,
      );
      return {
        conversationId: conversation.id,
        message: view,
        connectionRequestId: null,
      };
    }

    // Not connected: the message becomes the seed of a connection request (§7).
    const conn = await this.connectionsService.requestConnection(
      userId,
      toSlug,
      body,
    );
    return {
      conversationId: null,
      message: null,
      connectionRequestId: conn.id,
    };
  }

  /**
   * Delivers a one-off message from `fromUserId` to `toUserId`, addressed by
   * userId (not slug), creating the 1:1 conversation if needed. Unlike
   * `sendMessage`/`messageRequest`, this intentionally does NOT require the two
   * to be accepted connections — it backs cold cross-domain contact such as a
   * housing enquiry, where a pre-existing friendship must not be a precondition.
   * A block either way is still a hard stop.
   */
  async deliverEnquiry(
    fromUserId: string,
    toUserId: string,
    body: string,
  ): Promise<{ conversationId: string }> {
    if (fromUserId === toUserId) {
      throw new BadRequestException('You cannot send an enquiry to yourself');
    }
    if (await this.blockFilter.isBlockedEitherWay(fromUserId, toUserId)) {
      throw new ForbiddenException('You cannot contact this member');
    }
    const { conversation } = await this.core.getOrCreateConversation(
      fromUserId,
      toUserId,
    );
    await this.core.postMessage(conversation.id, fromUserId, body);
    return { conversationId: conversation.id };
  }

  @OnEvent(CONNECTION_ACCEPTED)
  async handleConnectionAccepted(
    payload: ConnectionAcceptedEvent,
  ): Promise<void> {
    const { conversation, created } = await this.core.getOrCreateConversation(
      payload.requesterId,
      payload.addresseeId,
    );
    // Seed the request message only on first materialization (idempotent if the
    // event ever re-fires).
    if (created && payload.requestMessage) {
      await this.core.postMessage(
        conversation.id,
        payload.requesterId,
        payload.requestMessage,
      );
    }
  }
}
