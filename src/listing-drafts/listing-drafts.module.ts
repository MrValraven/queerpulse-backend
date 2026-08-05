import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailerModule } from '../mailer/mailer.module';
import { ListingDraft } from './entities/listing-draft.entity';
import { ListingDraftsController } from './listing-drafts.controller';
import { ListingDraftsService } from './listing-drafts.service';

@Module({
  imports: [TypeOrmModule.forFeature([ListingDraft]), MailerModule],
  controllers: [ListingDraftsController],
  providers: [ListingDraftsService],
})
export class ListingDraftsModule {}
