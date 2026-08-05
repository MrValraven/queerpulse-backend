import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SavedItem } from '../saved/entities/saved-item.entity';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';
import { CollectionItem } from './entities/collection-item.entity';
import { Collection } from './entities/collection.entity';

@Module({
  // `SavedItem` is registered read-only here so `CollectionsService` can hydrate
  // each filed item back into the owner's saved-snapshot on `GET /:id`.
  imports: [TypeOrmModule.forFeature([Collection, CollectionItem, SavedItem])],
  controllers: [CollectionsController],
  providers: [CollectionsService],
  exports: [CollectionsService],
})
export class CollectionsModule {}
