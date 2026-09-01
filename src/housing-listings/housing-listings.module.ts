import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminQueueNotificationsModule } from '../admin-queue-notifications/admin-queue-notifications.module';
import { ConnectionsModule } from '../connections/connections.module';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { HousingViewingsModule } from '../housing-viewings/housing-viewings.module';
import { MessagingModule } from '../messaging/messaging.module';
import { UsersModule } from '../users/users.module';
import { VerificationModule } from '../verification/verification.module';
import { AffirmingPledgeModule } from '../affirming-pledge/affirming-pledge.module';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { AdminHousingListingsController } from './admin-housing-listings.controller';
import { HousingDirectoryController } from './housing-directory.controller';
import { HousingDirectoryService } from './housing-directory.service';
import { HousingListingsController } from './housing-listings.controller';
import { HousingListingModerationService } from './housing-listing-moderation.service';
import { HousingListingsService } from './housing-listings.service';
import { HousingListingExpirySweeperService } from './housing-listing-expiry-sweeper.service';
import { HousingListing } from './entities/housing-listing.entity';

@Module({
  imports: [
    // UserStaffRole is registered here too — `HousingModerationGuard` (on
    // `AdminHousingListingsController`) needs it to check the additive
    // `housing_moderator` staff role.
    // `ModAuditLog` gets its own registration here (TypeORM permits overlapping
    // ones): `ModerationModule` exports nothing at all, so importing it would
    // not make `Repository<ModAuditLog>` reachable. Same precedent
    // `AdminMembersModule` follows. `HousingListingModerationService` writes one
    // immutable row per decision into the shared moderation trail.
    TypeOrmModule.forFeature([HousingListing, UserStaffRole, ModAuditLog]),
    // UsersModule exports the Profile repository (member-ref hydration).
    UsersModule,
    // MessagingModule exports MessagingService (enquiry delivery).
    MessagingModule,
    // Read-only: public housing browse/detail/search withhold a
    // moderator-taken-down listing (keyed by slug), mirroring the directory.
    ContentModerationModule,
    // Step-up gating (create/enquiry) + honest lister badge hydration.
    VerificationModule,
    // The mandatory LGBTQ+ affirming pledge gate (create/enquiry).
    AffirmingPledgeModule,
    // Exports ConnectionsService — the address-privacy gate on the public detail
    // read discloses the exact point/address only to the owner or a connected
    // member (`areConnected`).
    ConnectionsModule,
    // Exports NotificationsService — every moderation decision tells the lister
    // in-app (and, via `PushNotificationListener`, on their phone). No cycle:
    // `NotificationsModule` imports nothing that reaches back into housing.
    NotificationsModule,
    // Exports HousingViewingsService — the address-privacy gate ALSO unlocks the
    // exact point/address to an enquirer with a lister-accepted viewing.
    HousingViewingsModule,
    // `AdminQueueNotificationsService`: tells the housing-listing queue's
    // reviewers when `create` lands a new listing in review.
    AdminQueueNotificationsModule,
  ],
  controllers: [
    HousingListingsController,
    HousingDirectoryController,
    AdminHousingListingsController,
  ],
  providers: [
    HousingListingsService,
    // The moderator surface (review queue + decisions). Kept apart from
    // `HousingListingsService`, which is owner-scoped by construction.
    HousingListingModerationService,
    HousingDirectoryService,
    // HSG-3 daily expiry sweep (see the service's own doc comment). Registered
    // here, not exported — it's a background job, not a dependency of another
    // module. `ScheduleModule.forRoot()` is already wired app-wide in
    // `app.module.ts`.
    HousingListingExpirySweeperService,
  ],
  // HousingDirectoryService is exported for the cross-entity SearchModule
  // (public LIVE-listing search); the owner-mutation HousingListingsService
  // stays module-private.
  exports: [HousingDirectoryService],
})
export class HousingListingsModule {}
