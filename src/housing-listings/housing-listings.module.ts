import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConnectionsModule } from '../connections/connections.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { HousingViewingsModule } from '../housing-viewings/housing-viewings.module';
import { MessagingModule } from '../messaging/messaging.module';
import { UsersModule } from '../users/users.module';
import { VerificationModule } from '../verification/verification.module';
import { AffirmingPledgeModule } from '../affirming-pledge/affirming-pledge.module';
import { AdminHousingListingsController } from './admin-housing-listings.controller';
import { HousingDirectoryController } from './housing-directory.controller';
import { HousingDirectoryService } from './housing-directory.service';
import { HousingListingsController } from './housing-listings.controller';
import { HousingListingsService } from './housing-listings.service';
import { HousingListingExpirySweeperService } from './housing-listing-expiry-sweeper.service';
import { HousingListing } from './entities/housing-listing.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([HousingListing]),
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
    // Exports HousingViewingsService — the address-privacy gate ALSO unlocks the
    // exact point/address to an enquirer with a lister-accepted viewing.
    HousingViewingsModule,
  ],
  controllers: [
    HousingListingsController,
    HousingDirectoryController,
    AdminHousingListingsController,
  ],
  providers: [
    HousingListingsService,
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
