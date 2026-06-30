import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import {
  CONNECTION_ACCEPTED,
  CONNECTION_REQUESTED,
  ConnectionAcceptedEvent,
  ConnectionRequestedEvent,
} from '../connections/connection.events';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import {
  MESSAGE_CREATED,
  MessageCreatedEvent,
} from '../messaging/messaging.events';
import {
  EVENT_INVITED,
  EVENT_WAITLIST_PROMOTED,
  EventInvitedEvent,
  EventWaitlistPromotedEvent,
} from '../events/event.events';
import { USER_PROMOTED, UserPromotedEvent } from '../users/user.events';
import { VOUCH_CREATED, VouchCreatedEvent } from '../vouch/vouch.events';
import { NotificationType } from './entities/notification.entity';
import { NotificationsService } from './notifications.service';

@Injectable()
export class NotificationsListener {
  constructor(
    private readonly notifications: NotificationsService,
    @InjectRepository(ConversationParticipant)
    private readonly participants: Repository<ConversationParticipant>,
  ) {}

  @OnEvent(CONNECTION_REQUESTED)
  async onConnectionRequested(e: ConnectionRequestedEvent): Promise<void> {
    await this.notifications.create(
      e.addresseeId,
      NotificationType.ConnectionRequest,
      { connectionId: e.connectionId, fromUserId: e.requesterId },
    );
  }

  @OnEvent(CONNECTION_ACCEPTED)
  async onConnectionAccepted(e: ConnectionAcceptedEvent): Promise<void> {
    await this.notifications.create(
      e.requesterId,
      NotificationType.ConnectionAccepted,
      { connectionId: e.connectionId, byUserId: e.addresseeId },
    );
  }

  @OnEvent(VOUCH_CREATED)
  async onVouchCreated(e: VouchCreatedEvent): Promise<void> {
    await this.notifications.create(
      e.voucheeId,
      NotificationType.VouchReceived,
      { voucherId: e.voucherId },
    );
  }

  @OnEvent(USER_PROMOTED)
  async onUserPromoted(e: UserPromotedEvent): Promise<void> {
    await this.notifications.create(
      e.userId,
      NotificationType.PromotedToMember,
      {},
    );
  }

  @OnEvent(MESSAGE_CREATED)
  async onMessageCreated(e: MessageCreatedEvent): Promise<void> {
    const others = await this.participants.find({
      where: {
        conversationId: e.conversationId,
        userId: Not(e.message.senderId),
      },
    });
    const recipientIds = others
      .filter((p) => !p.muted)
      .map((p) => p.userId);
    await this.notifications.createForRecipients(
      recipientIds,
      NotificationType.NewMessage,
      {
        conversationId: e.conversationId,
        messageId: e.message.id,
        senderId: e.message.senderId,
      },
    );
  }

  @OnEvent(EVENT_INVITED)
  async onEventInvited(e: EventInvitedEvent): Promise<void> {
    await this.notifications.create(
      e.inviteeId,
      NotificationType.EventInvite,
      { eventId: e.eventId, inviterId: e.inviterId },
    );
  }

  @OnEvent(EVENT_WAITLIST_PROMOTED)
  async onWaitlistPromoted(e: EventWaitlistPromotedEvent): Promise<void> {
    await this.notifications.create(
      e.userId,
      NotificationType.WaitlistPromoted,
      { eventId: e.eventId },
    );
  }
}
