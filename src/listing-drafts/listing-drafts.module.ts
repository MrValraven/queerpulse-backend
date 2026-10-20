import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ModerationModule } from '../moderation/moderation.module';
import { Profile } from '../users/entities/profile.entity';
import { AdminListingDraftsController } from './admin-listing-drafts.controller';
import { AdminListingDraftsService } from './admin-listing-drafts.service';
import { ListingDraft } from './entities/listing-draft.entity';
import { ListingDraftsController } from './listing-drafts.controller';
import { ListingDraftsService } from './listing-drafts.service';

@Module({
  // `Profile` is read only by `AdminListingDraftsService`, to resolve each
  // draft's owner to a display ref. `ModerationModule` exports
  // `ModAuditService`, which the Admin detail uses to write its
  // `creator_draft_viewed` row. Only `AppModule` imports this module, so the
  // import closes no cycle.
  imports: [
    TypeOrmModule.forFeature([ListingDraft, Profile]),
    ModerationModule,
  ],
  controllers: [ListingDraftsController, AdminListingDraftsController],
  providers: [ListingDraftsService, AdminListingDraftsService],
})
export class ListingDraftsModule {}
