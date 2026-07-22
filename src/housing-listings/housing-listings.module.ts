import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessagingModule } from '../messaging/messaging.module';
import { UsersModule } from '../users/users.module';
import { AdminHousingListingsController } from './admin-housing-listings.controller';
import { HousingDirectoryController } from './housing-directory.controller';
import { HousingDirectoryService } from './housing-directory.service';
import { HousingListingsController } from './housing-listings.controller';
import { HousingListingsService } from './housing-listings.service';
import { HousingListing } from './entities/housing-listing.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([HousingListing]),
    // UsersModule exports the Profile repository (member-ref hydration).
    UsersModule,
    // MessagingModule exports MessagingService (enquiry delivery).
    MessagingModule,
  ],
  controllers: [
    HousingListingsController,
    HousingDirectoryController,
    AdminHousingListingsController,
  ],
  providers: [HousingListingsService, HousingDirectoryService],
})
export class HousingListingsModule {}
