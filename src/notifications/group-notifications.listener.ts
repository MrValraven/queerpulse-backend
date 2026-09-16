import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  Conversation,
  ConversationKind,
} from '../messaging/entities/conversation.entity';
import {
  GROUP_INVITE_CREATED,
  GROUP_MEMBERS_ADDED,
  GroupInviteCreatedEvent,
  GroupMembersAddedEvent,
} from '../messaging/messaging.events';
import { NotificationType } from './entities/notification.entity';
import { NotificationsService } from './notifications.service';

/**
 * PRD-334. Turns `GROUP_MEMBERS_ADDED` into one `group_added` bell row per added
 * member. The phone push rides on that write: `PushNotificationListener` picks
 * the row up from `NOTIFICATION_BATCH_CREATED`, so there is exactly one place
 * the recipients are filtered.
 *
 * The adder is passed as `createForRecipients`' `actorId`, so a recipient who
 * blocked or muted them gets no row and no push, and the `NewMessages`
 * category gate applies on top. In practice `GroupsService` already refuses to
 * add a member across a block, so the block half is a second lock on the same
 * door; the mute half is the one that bites.
 *
 * Best-effort: the membership has already committed when this runs, so any
 * failure is logged and swallowed rather than surfacing through the emitter.
 */
@Injectable()
export class GroupNotificationsListener {
  private readonly logger = new Logger(GroupNotificationsListener.name);

  constructor(
    private readonly notifications: NotificationsService,
    // Read-only: the group's kind and title for the payload.
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
  ) {}

  @OnEvent(GROUP_MEMBERS_ADDED)
  async onGroupMembersAdded(event: GroupMembersAddedEvent): Promise<void> {
    try {
      // The emit sites already exclude the actor and dedupe, but the listener
      // does not lean on that: nobody is ever told they added themselves.
      const recipientUserIds = [...new Set(event.addedUserIds)].filter(
        (userId) => userId !== event.actorUserId,
      );
      if (recipientUserIds.length === 0) return;
      const conversation = await this.conversations.findOne({
        where: { id: event.conversationId },
      });
      if (!conversation || conversation.kind !== ConversationKind.Group) {
        return;
      }
      const groupTitle = conversation.title?.trim();
      await this.notifications.createForRecipients(
        recipientUserIds,
        NotificationType.GroupAdded,
        {
          // `source: 'message'` + `conversationId` is the deep-link contract
          // both the bell (`sourceHrefFromPayload`) and the push already read.
          source: 'message',
          conversationId: conversation.id,
          ...(groupTitle ? { groupTitle } : {}),
          actorId: event.actorUserId,
        },
        event.actorUserId,
      );
    } catch (error) {
      this.logger.warn(
        `group_added notification failed for conversation ${event.conversationId}: ${String(error)}`,
      );
    }
  }

  /**
   * PRD-353. Turns `GROUP_INVITE_CREATED` into one `group_invite` bell row:
   * same payload shape and same block/mute gate as `onGroupMembersAdded`
   * above (the inviter is `createForRecipients`' `actorId`), mirroring
   * `GroupAdded` exactly so the two share one push handler's copy pattern.
   */
  @OnEvent(GROUP_INVITE_CREATED)
  async onGroupInviteCreated(event: GroupInviteCreatedEvent): Promise<void> {
    try {
      if (event.inviteeUserId === event.inviterUserId) return;
      const conversation = await this.conversations.findOne({
        where: { id: event.conversationId },
      });
      if (!conversation || conversation.kind !== ConversationKind.Group) {
        return;
      }
      const groupTitle = conversation.title?.trim();
      await this.notifications.createForRecipients(
        [event.inviteeUserId],
        NotificationType.GroupInvite,
        {
          // Same deep-link contract as `GroupAdded`: the FE bell row routes
          // a `group_invite` type to the Requests tab instead of the thread
          // itself, since the recipient is not yet a participant.
          source: 'message',
          conversationId: conversation.id,
          ...(groupTitle ? { groupTitle } : {}),
          actorId: event.inviterUserId,
        },
        event.inviterUserId,
      );
    } catch (error) {
      this.logger.warn(
        `group_invite notification failed for conversation ${event.conversationId}: ${String(error)}`,
      );
    }
  }
}
