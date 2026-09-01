import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminQueueNotificationsModule } from '../admin-queue-notifications/admin-queue-notifications.module';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { Listing } from '../listings/entities/listing.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { SafeSpaceVouchesModule } from '../safe-space-vouches/safe-space-vouches.module';
import { User } from '../users/entities/user.entity';
import { SafeSpaceBadgeSuspension } from './entities/safe-space-badge-suspension.entity';
import { SafeSpaceDecisionAudit } from './entities/safe-space-decision-audit.entity';
import { SafeSpaceFlag } from './entities/safe-space-flag.entity';
import { SafeSpaceNomination } from './entities/safe-space-nomination.entity';
import { SafeSpaceAuditService } from './safe-space-audit.service';
import { SafeSpaceBadgeService } from './safe-space-badge.service';
import {
  AdminSafeSpaceBadgesController,
  AdminSafeSpaceFlagsController,
  SafeSpaceFlagsController,
} from './safe-space-flags.controller';
import { SafeSpaceFlagsService } from './safe-space-flags.service';
import {
  AdminSafeSpaceNominationsController,
  SafeSpaceNominationsController,
} from './safe-space-nominations.controller';
import { SafeSpaceNominationsService } from './safe-space-nominations.service';
import { SafeSpaceNotifierService } from './safe-space-notifier.service';
import { SafeSpaceReviewSweeperService } from './safe-space-review-sweeper.service';

/**
 * Safe-space GOVERNANCE: nominations and their review, member flags, temporary
 * badge suspensions, the annual re-review queue, and the audit trail behind all
 * of it. The member-written visit records themselves live next door in
 * `SafeSpaceVouchesModule`, which this imports for `SafeSpaceVisitsService`.
 *
 * `Listing` is registered for its entity only, to resolve a business by ref or
 * slug and to write the badge grant onto it. `ListingsModule` is deliberately
 * NOT imported (it pulls in users, messaging, content moderation, storage,
 * reports and media crops), matching the reason `ListingLookupModule` exists.
 *
 * `User` is registered so the daily sweeper can find the active
 * moderators/admins to tell about an overdue queue. `ScheduleModule` is already
 * global from `AppModule`, so the `@Cron` provider only needs to appear here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      // Read-only, and only for `RolesOrStaffGuard` on this module's admin
      // controllers: it resolves the caller's additive staff grants when their
      // account tier alone does not satisfy `@Roles(...)`. Same registration
      // precedent as `HousingListingsModule` for `HousingModerationGuard`.
      UserStaffRole,

      SafeSpaceNomination,
      SafeSpaceFlag,
      SafeSpaceBadgeSuspension,
      SafeSpaceDecisionAudit,
      Listing,
      User,
    ]),
    NotificationsModule,
    SafeSpaceVouchesModule,
    // Tells whoever works the safe-space nomination and flag queues when a
    // member's own action lands a new row.
    AdminQueueNotificationsModule,
  ],
  controllers: [
    SafeSpaceNominationsController,
    AdminSafeSpaceNominationsController,
    SafeSpaceFlagsController,
    AdminSafeSpaceFlagsController,
    AdminSafeSpaceBadgesController,
  ],
  providers: [
    SafeSpaceNominationsService,
    SafeSpaceFlagsService,
    SafeSpaceBadgeService,
    SafeSpaceAuditService,
    SafeSpaceNotifierService,
    SafeSpaceReviewSweeperService,
  ],
  exports: [SafeSpaceBadgeService],
})
export class SafeSpaceNominationsModule {}
