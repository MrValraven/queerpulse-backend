import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformJoinRequest } from '../membership/entities/join-request.entity';
import { Appeal } from '../moderation/entities/appeal.entity';
import { BanRatification } from '../moderation/entities/ban-ratification.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Report } from '../reports/entities/report.entity';
import { User } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { VerificationRequest } from '../verification/entities/verification-request.entity';
import { AdminModerationHealthController } from './admin-moderation-health.controller';
import { ModerationQueueAlertState } from './entities/moderation-queue-alert-state.entity';
import { ModerationQueueAlertService } from './moderation-queue-alert.service';
import { ModerationQueueHealthService } from './moderation-queue-health.service';

/**
 * Moderator workload and SLA alerting (TS-04): the read route, the queue
 * measurements behind it, and the hourly cron that turns a threshold crossing
 * into an in-app alert.
 *
 * Its own module rather than an addition to `AdminOverviewModule`, for two
 * reasons. The route is open to MODERATORS as well as admins while that one is
 * admin-only, and this module owns a cron, so importing it starts a
 * scheduled job, which is a thing that should be visible in `app.module.ts`
 * rather than smuggled in behind a dashboard.
 *
 * `MetricsService` is injected without an import here: `MetricsModule` is
 * `@Global`, exactly so cross-cutting collectors like this one can reach the
 * registry (the same route `ChatGateway`'s WebSocket gauge takes).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      // The five queues, each registered here directly rather than pulled in
      // through its owning feature module. That is `AdminOverviewModule`'s and
      // `AdminCommunitiesModule`'s precedent (TypeORM permits overlapping
      // registrations), and it matters more here than usual: importing
      // `ReportsModule`, `ModerationModule`, `MembershipModule` and
      // `VerificationModule` to read five COUNT queries would drag four
      // feature surfaces and their dependency graphs into a read-only
      // dashboard, and `ModerationModule` reaches back toward notifications.
      PlatformJoinRequest,
      Report,
      Appeal,
      VerificationRequest,
      BanRatification,
      // The alert dedup state this module owns outright.
      ModerationQueueAlertState,
      // `users`: the active moderator/admin roster, which is both the
      // `activeModeratorCount` denominator and the alert's recipient list.
      User,
      // Read-only, and only for `RolesOrStaffGuard` on the controller: it
      // resolves the caller's additive staff grants when their account tier
      // alone does not satisfy `@Roles(...)`. Same registration precedent as
      // `AdminCommunitiesModule`.
      UserStaffRole,
    ]),
    // `NotificationsService`, the alert fan-out, which that module exports.
    // Plain import: `NotificationsModule` does not reach back to anything here,
    // so there is no cycle to break.
    //
    // `NotificationPushThrottleService` is deliberately NOT used from here,
    // although it is exported alongside. It suppresses recipients, and this
    // module's alerts carry state a suppressed write would lose; see
    // `ModerationQueueAlertService`'s docstring for the failure it caused when
    // it was wired in.
    NotificationsModule,
  ],
  controllers: [AdminModerationHealthController],
  providers: [ModerationQueueHealthService, ModerationQueueAlertService],
  // Exported so a future admin surface can reuse the measurements rather than
  // re-deriving them. The alert service is deliberately NOT exported: it is
  // cron-driven and stateful, and a second caller would confuse the dedup.
  exports: [ModerationQueueHealthService],
})
export class AdminModerationHealthModule {}
