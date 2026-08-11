import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { StorageModule } from '../storage/storage.module';
import { MediaReferencesModule } from '../media-references/media-references.module';
import { AdminMediaController } from './admin-media.controller';
import { AdminMediaService } from './admin-media.service';

@Module({
  // `Profile` for uploader resolution; `StorageModule` exports `StorageService`
  // for the bucket listing / head / presign calls; `MediaReferencesModule`
  // exports `MediaReferenceResolver` for the "where is this used" column.
  imports: [
    TypeOrmModule.forFeature([Profile]),
    StorageModule,
    MediaReferencesModule,
  ],
  controllers: [AdminMediaController],
  providers: [AdminMediaService],
})
export class AdminMediaModule {}
