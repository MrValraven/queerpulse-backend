import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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
    TypeOrmModule.forFeature([
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
  ],
  providers: [
    ResourcesService,
    ResourceGuideRatingsService,
    AdminResourceGuideRatingsService,
    ResourceListingsService,
    ResourceSuggestionsService,
    AdminResourceListingsService,
    AdminResourceSuggestionsService,
  ],
  // Exported for the cross-entity SearchModule (resource search).
  exports: [ResourcesService],
})
export class ResourcesModule {}
