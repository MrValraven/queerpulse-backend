import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { HousingViewingsModule } from '../housing-viewings/housing-viewings.module';
import { HousingReview } from './entities/housing-review.entity';
import { HousingReviewsController } from './housing-reviews.controller';
import { HousingReviewsService } from './housing-reviews.service';

/**
 * Two-sided blind housing reviews (P2.4), gated on a completed viewing. Depends
 * on HousingViewingsModule for the completed-viewing gate; a read-only
 * HousingListing repo (forFeature) resolves the public listing display.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([HousingReview, HousingListing]),
    // Profile repo (review author MemberRef hydration).
    UsersModule,
    // The completed-viewing gate + participation checks.
    HousingViewingsModule,
  ],
  controllers: [HousingReviewsController],
  providers: [HousingReviewsService],
})
export class HousingReviewsModule {}
