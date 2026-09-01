import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { User } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { AdminQueueNotificationsService } from './admin-queue-notifications.service';

/**
 * Admin queue arrival alerts: one registry, one service, no controller and no
 * cron.
 *
 * Its own module because roughly twenty feature modules import it, and it must
 * therefore import as little as possible. It registers `User` and
 * `UserStaffRole` directly rather than pulling in `UsersModule`, which is the
 * same precedent `AdminModerationHealthModule` and `AdminOverviewModule` set:
 * TypeORM permits overlapping registrations, and dragging a feature surface
 * and its dependency graph into twenty importers to run two role queries is
 * how a cycle gets built.
 *
 * `NotificationsModule` does not reach back to anything here, so there is no
 * cycle to break.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([User, UserStaffRole]),
    NotificationsModule,
  ],
  providers: [AdminQueueNotificationsService],
  exports: [AdminQueueNotificationsService],
})
export class AdminQueueNotificationsModule {}
