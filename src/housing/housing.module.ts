import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminQueueNotificationsModule } from '../admin-queue-notifications/admin-queue-notifications.module';
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
    // `AdminQueueNotificationsService`: tells the co-op join-request queue's
    // reviewers when `createJoinRequest` lands a new application.
    AdminQueueNotificationsModule,
  ],
  controllers: [HousingController],
  providers: [HousingService],
  exports: [HousingService],
})
export class HousingModule {}
