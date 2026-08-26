import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ListingCoManager } from '../listings/entities/listing-co-manager.entity';
import { Listing } from '../listings/entities/listing.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { SafeSpaceNomination } from '../safe-space-nominations/entities/safe-space-nomination.entity';
import { SafeSpaceMemberVouch } from './entities/safe-space-vouch.entity';
import { SafeSpaceVisitsService } from './safe-space-visits.service';
import { SafeSpaceVouchesController } from './safe-space-vouches.controller';
import { SafeSpaceVouchesService } from './safe-space-vouches.service';

/**
 * Member-facing safe-space vouch writes, and the visit tally the review panel
 * reads off them.
 *
 * `Listing` is registered here to resolve a space by its slug (and check it is
 * live, shown, and either badged or under review) before inserting a vouch —
 * the listings domain itself lives in `ListingsModule`, which owns the read
 * path that merges these rows into the safe-space detail DTO.
 * `ListingCoManager` and `SafeSpaceNomination` are registered for their
 * entities only: the first to exclude a listing's own co-managers from the
 * "independent visits" count, the second to let a space collect visits while
 * its nomination is under review. Neither module is imported, so the dependency
 * runs one way — `SafeSpaceNominationsModule` imports THIS module for
 * `SafeSpaceVisitsService`, and this module imports no module of theirs.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      SafeSpaceMemberVouch,
      Listing,
      ListingCoManager,
      SafeSpaceNomination,
    ]),
    // Provides `NotificationsService` so `createVouch` can tell the space's
    // owner. `NotificationsModule` imports only `SocialModule` + TypeORM, so it
    // never reaches back here — no cycle, plain import.
    NotificationsModule,
  ],
  controllers: [SafeSpaceVouchesController],
  providers: [SafeSpaceVouchesService, SafeSpaceVisitsService],
  exports: [SafeSpaceVisitsService],
})
export class SafeSpaceVouchesModule {}
