import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SubmissionsModule } from '../submissions/submissions.module';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { Profile } from '../users/entities/profile.entity';
import { GlossaryTerm } from './entities/glossary-term.entity';
import { Resource } from './entities/resource.entity';
import { ResourceGuideRating } from './entities/resource-guide-rating.entity';
import { ResourceListing } from './entities/resource-listing.entity';
import { ResourceSuggestion } from './entities/resource-suggestion.entity';
import {
  GlossaryController,
  ResourcesController,
} from './resources.controller';
import { ResourceGuideRatingsController } from './resource-guide-ratings.controller';
import { AdminResourceGuideRatingsController } from './admin-resource-guide-ratings.controller';
import { AdminGlossaryController } from './admin-glossary.controller';
import { AdminGlossaryService } from './admin-glossary.service';
import { AdminResourcesController } from './admin-resources.controller';
import { AdminResourcesService } from './admin-resources.service';
import { AdminResourceListingsController } from './admin-resource-listings.controller';
import { AdminResourceListingsService } from './admin-resource-listings.service';
import { AdminResourceSuggestionsController } from './admin-resource-suggestions.controller';
import { AdminResourceSuggestionsService } from './admin-resource-suggestions.service';
import { ResourceListingsService } from './resource-listings.service';
import { ResourceSuggestionsService } from './resource-suggestions.service';
import { ResourcesService } from './resources.service';
import { ResourceGuideRatingsService } from './resource-guide-ratings.service';
import { AdminResourceGuideRatingsService } from './admin-resource-guide-ratings.service';

@Module({
  // `Profile` is registered here (overlapping `forFeature` is permitted) so
  // `AdminResourceSuggestionsService` can resolve suggester refs — same
  // pattern as `ReadingGroupProposalsModule`.
  imports: [
    // The shared intake primitive (PRD-48), so a member who suggests a
    // resource is told what was decided. Plain import, no `forwardRef`: it
    // pulls in `NotificationsModule` only, and nothing there reaches back
    // here.
    SubmissionsModule,

    TypeOrmModule.forFeature([
      // Read-only, and only for `RolesOrStaffGuard` on this module's admin
      // controllers: it resolves the caller's additive staff grants when their
      // account tier alone does not satisfy `@Roles(...)`. Same registration
      // precedent as `HousingListingsModule` for `HousingModerationGuard`.
      UserStaffRole,

      Resource,
      GlossaryTerm,
      ResourceGuideRating,
      ResourceListing,
      ResourceSuggestion,
      Profile,
    ]),
  ],
  controllers: [
    ResourcesController,
    GlossaryController,
    ResourceGuideRatingsController,
    AdminResourceGuideRatingsController,
    AdminResourceListingsController,
    AdminResourceSuggestionsController,
    AdminResourcesController,
    AdminGlossaryController,
  ],
  providers: [
    ResourcesService,
    ResourceGuideRatingsService,
    AdminResourceGuideRatingsService,
    ResourceListingsService,
    ResourceSuggestionsService,
    AdminResourceListingsService,
    AdminResourceSuggestionsService,
    AdminResourcesService,
    AdminGlossaryService,
  ],
  // Exported for the cross-entity SearchModule (resource search).
  exports: [ResourcesService],
})
export class ResourcesModule {}
