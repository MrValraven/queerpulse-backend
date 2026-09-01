import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { UsersModule } from '../users/users.module';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { HousingViewingsModule } from '../housing-viewings/housing-viewings.module';
import { SubmissionsModule } from '../submissions/submissions.module';
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
    // Read-only: the public reviews block honours a moderator takedown on the
    // listing (`housing` subject) and on an individual review (`review`
    // subject), matching every other public housing read (BE-HSG-13).
    ContentModerationModule,
    // PRD-47: the shared `ReviewReplied` bell row, so a guest hears that the
    // lister answered them through the same primitive every other vertical's
    // right of reply uses. Plain import, no `forwardRef`: `SubmissionsModule`
    // pulls in `NotificationsModule` only, which never reaches back here.
    SubmissionsModule,
  ],
  controllers: [HousingReviewsController],
  providers: [HousingReviewsService],
})
export class HousingReviewsModule {}
