import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AffirmingPledgeModule } from '../affirming-pledge/affirming-pledge.module';
import { CoopJoinRequest } from './entities/coop-join-request.entity';
import { HousingCoop } from './entities/housing-coop.entity';
import { HousingController } from './housing.controller';
import { HousingService } from './housing.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([HousingCoop, CoopJoinRequest]),
    // Mandatory LGBTQ+ affirming pledge gate (coop join when
    // the applicant is a signed-in member).
    AffirmingPledgeModule,
  ],
  controllers: [HousingController],
  providers: [HousingService],
  exports: [HousingService],
})
export class HousingModule {}
