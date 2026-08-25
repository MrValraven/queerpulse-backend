import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SavedItem } from './entities/saved-item.entity';
import { SavedListEntry } from './entities/saved-list-entry.entity';
import { SavedList } from './entities/saved-list.entity';
import { SavedController } from './saved.controller';
import { SavedListsController } from './saved-lists.controller';
import { SavedListsService } from './saved-lists.service';
import { SavedService } from './saved.service';
import { SharedSavedListController } from './shared-saved-list.controller';

@Module({
  imports: [TypeOrmModule.forFeature([SavedItem, SavedList, SavedListEntry])],
  // `SavedListsController` is registered BEFORE `SavedController` so the
  // literal `me/saved/lists` segment is matched ahead of that controller's
  // `me/saved/:id` composite-ref param. No current route pair actually
  // collides, and the order is what keeps it that way.
  controllers: [
    SavedListsController,
    SavedController,
    SharedSavedListController,
  ],
  providers: [SavedService, SavedListsService],
  exports: [SavedService, SavedListsService],
})
export class SavedModule {}
