import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { AdminListingDraftsController } from './admin-listing-drafts.controller';
import { AdminListingDraftsService } from './admin-listing-drafts.service';
import { ListingDraft } from './entities/listing-draft.entity';
import { ListingDraftsController } from './listing-drafts.controller';
import { ListingDraftsService } from './listing-drafts.service';

@Module({
  // `Profile` is read only by `AdminListingDraftsService`, to resolve each
  // draft's owner to a display ref.
  imports: [TypeOrmModule.forFeature([ListingDraft, Profile])],
  controllers: [ListingDraftsController, AdminListingDraftsController],
  providers: [ListingDraftsService, AdminListingDraftsService],
})
export class ListingDraftsModule {}
