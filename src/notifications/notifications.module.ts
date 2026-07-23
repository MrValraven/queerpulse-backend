import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { SocialModule } from '../social/social.module';
import { Notification } from './entities/notification.entity';
import { NotificationsController } from './notifications.controller';
import { NotificationsListener } from './notifications.listener';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [
    // `Profile` — read-only, to resolve each notification's acting member
    // (name/slug/avatar) at serve time so the bell can name and link to them.
    TypeOrmModule.forFeature([Notification, Profile]),
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
