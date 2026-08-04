import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { Mute } from '../social/entities/mute.entity';
import { SocialModule } from '../social/social.module';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { Notification } from './entities/notification.entity';
import { NotificationPreference } from './entities/notification-preference.entity';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationRetentionService } from './notification-retention.service';
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
    // `SubprofileMember` — read-only, so `NotificationsListener` can resolve a
    // persona's current co-owner roster on `subprofile.invite.accepted`
    // without importing `SubprofilesModule` (avoids a module cycle).
    TypeOrmModule.forFeature([
      Notification,
      NotificationPreference,
      Profile,
      Mute,
      SubprofileMember,
    ]),
    // `BlockFilterService` — a notification triggered by a member the
    // recipient blocked/muted is never written (and so never pushed). Plain
    // import: `SocialModule` imports `UsersModule` + `ReportsModule`, neither
    // of which imports `NotificationsModule`, so there is no cycle to break
    // with `forwardRef`.
    SocialModule,
  ],
  controllers: [NotificationsController, NotificationPreferencesController],
  providers: [
    NotificationsService,
    NotificationPreferencesService,
    NotificationsListener,
    // Cron-only; registering it starts the daily read-notification purge.
    NotificationRetentionService,
  ],
  // `NotificationPreferencesService` is exported so the push listener can honour
  // the same per-category switch on the push channel.
  exports: [NotificationsService, NotificationPreferencesService],
})
export class NotificationsModule {}
