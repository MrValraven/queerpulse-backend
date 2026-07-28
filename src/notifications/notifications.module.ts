import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { Mute } from '../social/entities/mute.entity';
import { SocialModule } from '../social/social.module';
import { Notification } from './entities/notification.entity';
import { NotificationsController } from './notifications.controller';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [
    // `Profile` — read-only, to resolve each notification's acting member
    // (name/slug/avatar) at serve time so the bell can name and link to them.
    // `Mute` — read-only, for the fan-out `visibleRecipients` batched
    // directional mute lookup (recipients who muted the actor); the mirror
    // direction `BlockFilterService` exposes, so it is queried locally.
    TypeOrmModule.forFeature([Notification, Profile, Mute]),
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
