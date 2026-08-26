import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { VerificationModule } from '../verification/verification.module';
import { AffirmingPledgeModule } from '../affirming-pledge/affirming-pledge.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminLandlordsController } from './admin-landlords.controller';
import { LandlordIntroRequest } from './entities/landlord-intro-request.entity';
import { LandlordRecommendation } from './entities/landlord-recommendation.entity';
import { Landlord } from './entities/landlord.entity';
import { LandlordsController } from './landlords.controller';
import { LandlordsService } from './landlords.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Landlord,
      LandlordRecommendation,
      LandlordIntroRequest,
    ]),
    UsersModule, // exports the Profile repository (member-ref hydration)
    VerificationModule, // step-up gating (intro request) + honest badge hydration
    AffirmingPledgeModule, // mandatory LGBTQ+ affirming pledge gate (suggest/intro)
    // LOC-19: a member who suggested an entry, or asked for an introduction,
    // is told what staff decided. No cycle — NotificationsModule does not
    // import this one.
    NotificationsModule,
  ],
  controllers: [LandlordsController, AdminLandlordsController],
  providers: [LandlordsService],
})
export class LandlordsModule {}
