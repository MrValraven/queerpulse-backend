import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SavedItem } from '../saved/entities/saved-item.entity';
import { SavedModule } from '../saved/saved.module';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';
import { CollectionItem } from './entities/collection-item.entity';
import { Collection } from './entities/collection.entity';

@Module({
  // `SavedItem` is registered read-only here so `CollectionsService` can hydrate
  // each filed item back into the owner's saved-snapshot on `GET /:id`.
  //
  // `SavedModule` for `SavedAvailabilityService`: a filed item is the same
  // `saved_item` snapshot the saved module serves, and it has to answer the same
  // question about it (PRD-169): is the subject still there for this viewer, or
  // is this card pointing at a 404. Reusing that resolver keeps one rule per
  // subject kind instead of a second copy that drifts.
  imports: [
    TypeOrmModule.forFeature([Collection, CollectionItem, SavedItem]),
    SavedModule,
  ],
  controllers: [CollectionsController],
  providers: [CollectionsService],
  exports: [CollectionsService],
})
export class CollectionsModule {}
