import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Event } from '../events/entities/event.entity';
import { MessagingModule } from '../messaging/messaging.module';
import { SavedItem } from '../saved/entities/saved-item.entity';
import { UsersModule } from '../users/users.module';
import { DirectoryController } from './directory.controller';
import { DirectoryService } from './directory.service';
import { ListingEditSuggestion } from './entities/listing-edit-suggestion.entity';
import { ListingReview } from './entities/listing-review.entity';
import { Listing } from './entities/listing.entity';
import { ListingEditSuggestionsService } from './listing-edit-suggestions.service';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

@Module({
  imports: [
    // `Event` is registered here only to read a listing's upcoming events in
    // `DirectoryService`; the events domain itself lives in `EventsModule`.
    // `SavedItem` is registered here only for the read-only `savedCount`
    // aggregate on the directory detail DTO — the saved-items domain itself
    // lives in `SavedModule`.
    TypeOrmModule.forFeature([
      Listing,
      ListingReview,
      ListingEditSuggestion,
      Event,
      SavedItem,
    ]),
    UsersModule,
    // MessagingModule exports MessagingService — delivers a moderator's
    // question to the submitter as a DM (mirrors HousingListingsModule).
    MessagingModule,
  ],
  controllers: [ListingsController, DirectoryController],
  providers: [ListingsService, ListingEditSuggestionsService, DirectoryService],
  exports: [DirectoryService],
})
export class ListingsModule {}
