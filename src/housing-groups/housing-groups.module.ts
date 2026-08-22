import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AffirmingPledgeModule } from '../affirming-pledge/affirming-pledge.module';
import { Connection } from '../connections/entities/connection.entity';
import { VerificationModule } from '../verification/verification.module';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { GroupJoinRequest } from './entities/group-join-request.entity';
import { GroupListing } from './entities/group-listing.entity';
import { HousingGroup } from './entities/housing-group.entity';
import { AdminHousingGroupListingsController } from './admin-housing-group-listings.controller';
import { HousingGroupsController } from './housing-groups.controller';
import { HousingGroupsService } from './housing-groups.service';

// `Connection` is registered read-only here (via `forFeature`) so the service
// can derive the mutual-connections trust signal without depending on
// ConnectionsModule's provider surface. `UserStaffRole` is registered for the
// same reason: `HousingModerationGuard` (on
// `AdminHousingGroupListingsController`) needs it to check the additive
// `housing_moderator` staff role, mirroring `HousingListingsModule`.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      HousingGroup,
      GroupJoinRequest,
      GroupListing,
      Connection,
      UserStaffRole,
    ]),
    // Mandatory LGBTQ+ affirming pledge gate (group-listing create; group join
    // when the applicant is a signed-in member).
    AffirmingPledgeModule,
    // Step-up gate + lister assurance signal for the group-listing create path
    // (BE-HSG-01), matching the sibling member-listing surface.
    VerificationModule,
  ],
  controllers: [HousingGroupsController, AdminHousingGroupListingsController],
  providers: [HousingGroupsService],
  exports: [HousingGroupsService],
})
export class HousingGroupsModule {}
