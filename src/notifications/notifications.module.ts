import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConversationParticipant } from '../messaging/entities/conversation-participant.entity';
import { SocialModule } from '../social/social.module';
import { Notification } from './entities/notification.entity';
import { NotificationsController } from './notifications.controller';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Notification, ConversationParticipant]),
    // `BlockFilterService` — a notification triggered by a member the
    // recipient blocked/muted is never written (and so never pushed). Plain
    // import: `SocialModule` imports `UsersModule` + `ReportsModule`, neither
    // of which imports `NotificationsModule`, so there is no cycle to break
    // with `forwardRef`.
    SocialModule,
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService, NotificationsListener],
  exports: [NotificationsService],
})
export class NotificationsModule {}
