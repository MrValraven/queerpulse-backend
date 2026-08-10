import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { WorkItem } from '../profiles/entities/work-item.entity';
import { MagazineIssue } from '../magazine/entities/magazine-issue.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { Listing } from '../listings/entities/listing.entity';
import { StorageModule } from '../storage/storage.module';
import { MyMediaController } from './my-media.controller';
import { MyMediaService } from './my-media.service';
import {
  MY_MEDIA_USAGE_RESOLVER,
  MyMediaUsageResolverImpl,
} from './my-media-usage.resolver';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Profile,
      WorkItem,
      MagazineIssue,
      EventPhoto,
      Conversation,
      Listing,
    ]),
    StorageModule,
  ],
  controllers: [MyMediaController],
  providers: [
    MyMediaService,
    { provide: MY_MEDIA_USAGE_RESOLVER, useClass: MyMediaUsageResolverImpl },
  ],
})
export class MyMediaModule {}
