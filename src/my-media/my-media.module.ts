import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { MyMediaController } from './my-media.controller';
import { MyMediaService } from './my-media.service';
import { MY_MEDIA_USAGE_RESOLVER } from './my-media-usage.resolver';

@Module({
  imports: [StorageModule],
  controllers: [MyMediaController],
  providers: [
    MyMediaService,
    // Placeholder until a later task swaps in the real class-based resolver.
    {
      provide: MY_MEDIA_USAGE_RESOLVER,
      useValue: { resolve: () => Promise.resolve(new Map<string, string>()) },
    },
  ],
})
export class MyMediaModule {}
