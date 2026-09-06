import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SocialModule } from '../social/social.module';
import { SavedItem } from './entities/saved-item.entity';
import { SavedListEntry } from './entities/saved-list-entry.entity';
import { SavedList } from './entities/saved-list.entity';
import { SavedAvailabilityService } from './saved-availability.service';
import { SavedController } from './saved.controller';
import { SavedListsController } from './saved-lists.controller';
import { SavedListsService } from './saved-lists.service';
import { SavedService } from './saved.service';
import { SharedSavedListController } from './shared-saved-list.controller';

@Module({
  // `SocialModule` for `BlockFilterService`, which `SavedAvailabilityService`
  // needs to apply the same block severance a forum thread's and a flatmate
  // profile's own read paths apply.
  //
  // The other ten subject tables are read through the saved repository's shared
  // entity manager rather than registered here (see
  // `SavedAvailabilityService.queryBuilderFor`), so this module takes no
  // dependency on ten feature modules to answer a question about ten rows.
  imports: [
    TypeOrmModule.forFeature([SavedItem, SavedList, SavedListEntry]),
    SocialModule,
  ],
  // `SavedListsController` is registered BEFORE `SavedController` so the
  // literal `me/saved/lists` segment is matched ahead of that controller's
  // `me/saved/:id` composite-ref param. No current route pair actually
  // collides, and the order is what keeps it that way.
  controllers: [
    SavedListsController,
    SavedController,
    SharedSavedListController,
  ],
  providers: [SavedService, SavedListsService, SavedAvailabilityService],
  // `SavedAvailabilityService` is exported for `CollectionsModule`: a collection
  // hydrates the same `saved_item` rows, so it needs the same subject-resolution
  // pass or it keeps rendering dead links the saved surface no longer shows.
  exports: [SavedService, SavedListsService, SavedAvailabilityService],
})
export class SavedModule {}
