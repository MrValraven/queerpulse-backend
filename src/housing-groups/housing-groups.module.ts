import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AffirmingPledgeModule } from '../affirming-pledge/affirming-pledge.module';
import { Connection } from '../connections/entities/connection.entity';
import { GroupJoinRequest } from './entities/group-join-request.entity';
import { GroupListing } from './entities/group-listing.entity';
import { HousingGroup } from './entities/housing-group.entity';
import { HousingGroupsController } from './housing-groups.controller';
import { HousingGroupsService } from './housing-groups.service';

// `Connection` is registered read-only here (via `forFeature`) so the service
// can derive the mutual-connections trust signal without depending on
// ConnectionsModule's provider surface.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      HousingGroup,
      GroupJoinRequest,
      GroupListing,
      Connection,
    ]),
    // Mandatory LGBTQ+ affirming pledge gate (group-listing create; group join
    // when the applicant is a signed-in member).
    AffirmingPledgeModule,
  ],
  controllers: [HousingGroupsController],
  providers: [HousingGroupsService],
  exports: [HousingGroupsService],
})
export class HousingGroupsModule {}
