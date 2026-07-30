import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentModerationService } from './content-moderation.service';
import { ContentModeration } from './entities/content-moderation.entity';

/**
 * The shared content-moderation state, consumed both ways: the moderation
 * module writes takedowns through {@link ContentModerationService}, and content
 * modules (forum, communities, events, listings, …) read it to filter their
 * public/member read paths. Exports the service + the `TypeOrmModule` so
 * importers get the repository too, mirroring `ReportsModule`/`UsersModule`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ContentModeration])],
  providers: [ContentModerationService],
  exports: [ContentModerationService, TypeOrmModule],
})
export class ContentModerationModule {}
