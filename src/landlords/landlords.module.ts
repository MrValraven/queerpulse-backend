import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
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
  ],
  controllers: [LandlordsController, AdminLandlordsController],
  providers: [LandlordsService],
})
export class LandlordsModule {}
