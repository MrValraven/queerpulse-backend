import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { StorageModule } from '../storage/storage.module';
import { MediaReferencesModule } from '../media-references/media-references.module';
import { ModerationModule } from '../moderation/moderation.module';
import { AdminMediaController } from './admin-media.controller';
import { AdminMediaService } from './admin-media.service';

@Module({
  // `Profile` for uploader resolution; `StorageModule` exports `StorageService`
  // for the bucket listing / head / presign calls; `MediaReferencesModule`
  // exports `MediaReferenceResolver` for the "where is this used" column;
  // `ModerationModule` exports `ModAuditService`, which records every forced
  // delete with the acting admin. Plain import: nothing in `ModerationModule`'s
  // import graph reaches back into this module.
  imports: [
    TypeOrmModule.forFeature([Profile]),
    StorageModule,
    MediaReferencesModule,
    ModerationModule,
  ],
  controllers: [AdminMediaController],
  providers: [AdminMediaService],
})
export class AdminMediaModule {}
