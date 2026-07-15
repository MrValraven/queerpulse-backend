import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConnectionsModule } from '../connections/connections.module';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import {
  ConversationsController,
  MessageRequestController,
} from './messaging.controller';
import { MessagingService } from './messaging.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, ConversationParticipant, Message]),
    UsersModule,
    ConnectionsModule,
    // Exports `BlockFilterService`, used to reject conversation/message-request
    // creation when either party has blocked the other (spec §2).
    SocialModule,
  ],
  controllers: [ConversationsController, MessageRequestController],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
