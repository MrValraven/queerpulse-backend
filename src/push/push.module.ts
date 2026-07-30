import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatModule } from '../chat/chat.module';
import { Conversation } from '../messaging/entities/conversation.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { PushController } from './push.controller';
import { PushMessageListener } from './push.listener';
import { PushService } from './push.service';
import { PushSubscriptionRetentionService } from './push-subscription-retention.service';
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
    SocialModule, // provides BlockFilterService (P0: block check before push)
  ],
  controllers: [PushController],
  providers: [
    PushService,
    PushMessageListener,
    // Cron-only; registering it starts the daily stale-subscription purge.
    PushSubscriptionRetentionService,
  ],
  // Exported so other domains can deliver a push (e.g. `EventRemindersService`).
  exports: [PushService],
})
export class PushModule {}
