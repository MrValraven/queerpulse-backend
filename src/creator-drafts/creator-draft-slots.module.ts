import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CreatorDraftSlotsService } from './creator-draft-slots.service';
import { CreatorDraft } from './entities/creator-draft.entity';

/**
 * Repository-only module so the publish paths can discard a slot without
 * importing the heavy creator-drafts module (no cycle).
 */
@Module({
  imports: [TypeOrmModule.forFeature([CreatorDraft])],
  providers: [CreatorDraftSlotsService],
  exports: [CreatorDraftSlotsService],
})
export class CreatorDraftSlotsModule {}
