import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatModule } from '../chat/chat.module';
import { Conversation } from '../messaging/entities/conversation.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { UsersModule } from '../users/users.module';
import { PushController } from './push.controller';
import { PushMessageListener } from './push.listener';
import { PushService } from './push.service';
import { PushSubscription } from './entities/push-subscription.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PushSubscription,
      ConversationParticipant,
      Conversation,
    ]),
    UsersModule, // provides UsersService + Profile repo (re-exported TypeOrmModule)
    ChatModule, // provides PresenceService
  ],
  controllers: [PushController],
  providers: [PushService, PushMessageListener],
})
export class PushModule {}
