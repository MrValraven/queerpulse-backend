import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConnectionsModule } from '../connections/connections.module';
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
  ],
  controllers: [ConversationsController, MessageRequestController],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
