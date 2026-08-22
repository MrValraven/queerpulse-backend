import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { VerificationModule } from '../verification/verification.module';
import { AffirmingPledgeModule } from '../affirming-pledge/affirming-pledge.module';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { HousingViewing } from './entities/housing-viewing.entity';
import { HousingViewingsController } from './housing-viewings.controller';
import { HousingViewingsService } from './housing-viewings.service';

/**
 * Viewing scheduling for member housing listings (P2.3). Registers a read-only
 * HousingListing repo via forFeature so it never depends on
 * HousingListingsModule (which instead depends on THIS module for the
 * accepted-viewing → precise-address gate).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([HousingViewing, HousingListing]),
    // Profile repo (counterparty MemberRef hydration).
    UsersModule,
    // Step-up gate: requesting a viewing needs a phone-verified account.
    VerificationModule,
    // Baseline gate: requesting a viewing is a contact action, so it needs the
    // mandatory LGBTQ+ affirming pledge on record (BE-HSG-06). Imports only
    // `UsersModule`, so no cycle with this module.
    AffirmingPledgeModule,
  ],
  controllers: [HousingViewingsController],
  providers: [HousingViewingsService],
  // Exported for the housing-listings address gate and the housing-reviews
  // completed-viewing gate.
  exports: [HousingViewingsService],
})
export class HousingViewingsModule {}
