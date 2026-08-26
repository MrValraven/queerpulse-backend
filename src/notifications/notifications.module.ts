import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityMembershipModule } from '../communities/community-membership.module';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { Report } from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { Mute } from '../social/entities/mute.entity';
import { SocialModule } from '../social/social.module';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { Notification } from './entities/notification.entity';
import { NotificationPreference } from './entities/notification-preference.entity';
import { NotificationDeliveryPreference } from './entities/notification-delivery-preference.entity';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationRetentionService } from './notification-retention.service';
import { NotificationPushThrottleService } from './notification-push-throttle.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';
import { ReportNotificationsListener } from './report-notifications.listener';

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
    // `Report`, `User`, `Community`, `CommunityMember` — read-only, so
    // `ReportNotificationsListener` can resolve a new report's row, the
    // platform's `Moderator`/`Admin` accounts, and the owning community's
    // staff roster. Registered here directly for the same reason
    // `SubprofileMember` is: importing the owning feature modules would be a
    // cycle (`CommunitiesModule` and `ReportsModule`'s dependents both reach
    // back to notifications), and TypeORM permits one entity's repository in
    // more than one module.
    TypeOrmModule.forFeature([
      Notification,
      NotificationPreference,
      NotificationDeliveryPreference,
      Profile,
      Mute,
      SubprofileMember,
      Report,
      User,
      Community,
      CommunityMember,
    ]),
    // `BlockFilterService` — a notification triggered by a member the
    // recipient blocked/muted is never written (and so never pushed). Plain
    // import: `SocialModule` imports `UsersModule` + `ReportsModule`, neither
    // of which imports `NotificationsModule`, so there is no cycle to break
    // with `forwardRef`.
    SocialModule,
    // `CommunityMembershipService` — the post/reply to owning-community
    // resolution `ReportNotificationsListener` needs. This is the deliberately
    // dependency-light module (a `forFeature` registration and nothing else,
    // see its docstring), so importing it pulls in no communities feature
    // surface and creates no cycle.
    CommunityMembershipModule,
  ],
  controllers: [NotificationsController, NotificationPreferencesController],
  providers: [
    NotificationsService,
    NotificationPreferencesService,
    // Quiet hours. Lives beside the category preferences rather than inside
    // them because it gates a CHANNEL (push) at send time, not a category at
    // write time.
    NotificationDeliveryService,
    NotificationsListener,
    // Second listener on `REPORT_CREATED` (alongside the community
    // auto-freeze): tells platform staff and the owning community's staff that
    // a report has landed.
    ReportNotificationsListener,
    // Push-channel rate limiter, shared with `PushNotificationListener`.
    NotificationPushThrottleService,
    // Cron-only; registering it starts the daily read-notification purge.
    NotificationRetentionService,
  ],
  // `NotificationPreferencesService` is exported so the push listener can honour
  // the same per-category switch on the push channel.
  // `NotificationPushThrottleService` is exported for the same reason
  // `NotificationPreferencesService` is: the push listener lives in
  // `PushModule` (which already imports this module) and is where a pile-on's
  // repeat pushes have to be suppressed.
  exports: [
    NotificationsService,
    NotificationPreferencesService,
    // Exported for the same reason as the line above: both push listeners live
    // in `PushModule` (which already imports this module) and are where the
    // member's quiet-hours window has to be honoured.
    NotificationDeliveryService,
    NotificationPushThrottleService,
  ],
})
export class NotificationsModule {}
