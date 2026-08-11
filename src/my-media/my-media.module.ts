import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { MediaReferencesModule } from '../media-references/media-references.module';
import { MyMediaController } from './my-media.controller';
import { MyMediaService } from './my-media.service';

@Module({
  imports: [StorageModule, MediaReferencesModule],
  controllers: [MyMediaController],
  providers: [MyMediaService],
})
export class MyMediaModule {}
