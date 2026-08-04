import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConnectionsModule } from '../connections/connections.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { ConversationsService } from './conversations.service';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { ConversationPinnedMessage } from './entities/conversation-pinned-message.entity';
import { Conversation } from './entities/conversation.entity';
import { MessageReaction } from './entities/message-reaction.entity';
import { MessageStar } from './entities/message-star.entity';
import { Message } from './entities/message.entity';
import { GroupsService } from './groups.service';
import { MessageAnnotationsService } from './message-annotations.service';
import { MessageRequestsService } from './message-requests.service';
import { MessagesService } from './messages.service';
import {
  ConversationsController,
  MessageRequestController,
} from './messaging.controller';
import { MessagingCoreService } from './messaging-core.service';
import { MessagingService } from './messaging.service';

/**
 * The god `MessagingService` (2,565 lines) has been split into five
 * concern-scoped providers — `ConversationsService`, `MessagesService`,
 * `MessageAnnotationsService`, `GroupsService`, `MessageRequestsService` —
 * plus `MessagingCoreService`, the cross-cutting helper hub all five depend on
 * (singularly holds the `clearedAt`-floor `requireParticipant` and the
 * `toMessageResponses` hydration, so neither can diverge between concerns).
 * `MessagingService` remains registered/exported as a thin backward-compatible
 * facade — see its header comment.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Conversation,
      ConversationParticipant,
      ConversationPinnedMessage,
      Message,
      MessageReaction,
      MessageStar,
    ]),
    UsersModule,
    ConnectionsModule,
    // Exports `BlockFilterService`, used to reject conversation/message-request
    // creation when either party has blocked the other (spec §2).
    SocialModule,
    // Re-exports `TypeOrmModule.forFeature([ContentModeration])`, so
    // `MessagingCoreService` can inject the moderation-state repository to
    // tombstone moderator-taken-down messages in thread reads.
    ContentModerationModule,
  ],
  controllers: [ConversationsController, MessageRequestController],
  providers: [
    MessagingCoreService,
    ConversationsService,
    MessagesService,
    MessageAnnotationsService,
    GroupsService,
    MessageRequestsService,
    MessagingService,
  ],
  exports: [
    MessagingService,
    MessagingCoreService,
    ConversationsService,
    MessagesService,
    MessageAnnotationsService,
    GroupsService,
    MessageRequestsService,
  ],
})
export class MessagingModule {}
