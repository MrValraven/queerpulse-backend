import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatModule } from '../chat/chat.module';
import { Conversation } from '../messaging/entities/conversation.entity';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { PushController } from './push.controller';
import { PushMessageListener } from './push.listener';
import { PushNotificationListener } from './push-notification.listener';
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
    // provides NotificationPreferencesService — the new-message push honours the
    // member's "New message" category switch. One-way edge: NotificationsModule
    // imports only SocialModule + TypeOrm, so it never reaches back to PushModule.
    NotificationsModule,
  ],
  controllers: [PushController],
  providers: [
    PushService,
    PushMessageListener,
    // Fans persisted in-app notifications (NOTIFICATION_CREATED) out to phone
    // push for a whitelist of types. Resolvers it needs are already on hand:
    // Profile repo (actor name/avatar) via UsersModule's re-exported TypeORM,
    // NotificationPreferencesService (per-category push gate) via
    // NotificationsModule — both already imported above.
    PushNotificationListener,
    // Cron-only; registering it starts the daily stale-subscription purge.
    PushSubscriptionRetentionService,
  ],
  // Exported so other domains can deliver a push (e.g. `EventRemindersService`).
  exports: [PushService],
})
export class PushModule {}
