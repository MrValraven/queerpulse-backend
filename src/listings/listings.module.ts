import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Event } from '../events/entities/event.entity';
import { UsersModule } from '../users/users.module';
import { DirectoryController } from './directory.controller';
import { DirectoryService } from './directory.service';
import { ListingReview } from './entities/listing-review.entity';
import { Listing } from './entities/listing.entity';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

@Module({
  imports: [
    // `Event` is registered here only to read a listing's upcoming events in
    // `DirectoryService`; the events domain itself lives in `EventsModule`.
    TypeOrmModule.forFeature([Listing, ListingReview, Event]),
    UsersModule,
  ],
  controllers: [ListingsController, DirectoryController],
  providers: [ListingsService, DirectoryService],
})
export class ListingsModule {}
