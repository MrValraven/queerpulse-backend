import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ListingDraft } from './entities/listing-draft.entity';
import { ListingDraftsController } from './listing-drafts.controller';
import { ListingDraftsService } from './listing-drafts.service';

@Module({
  imports: [TypeOrmModule.forFeature([ListingDraft])],
  controllers: [ListingDraftsController],
  providers: [ListingDraftsService],
})
export class ListingDraftsModule {}
