import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../../notifications/notifications.module';
import { StorageModule } from '../../storage/storage.module';
import { User } from '../../users/entities/user.entity';
import { SubprofileFeedEntry } from '../entities/subprofile-feed-entry.entity';
import { SubprofileFeed } from '../entities/subprofile-feed.entity';
import { SubprofileItem } from '../entities/subprofile-item.entity';
import { SubprofileMember } from '../entities/subprofile-member.entity';
import { Subprofile } from '../entities/subprofile.entity';
import { SubprofilesModule } from '../subprofiles.module';
import { FeedImportThrottlerGuard } from './feed-import-throttler.guard';
import { SubprofileFeedFetcher } from './subprofile-feed-fetcher';
import { SubprofileFeedSyncService } from './subprofile-feed-sync.service';
import { SubprofileFeedsController } from './subprofile-feeds.controller';
import { SubprofileFeedsService } from './subprofile-feeds.service';

/**
 * Persona podcast-feed import: connect a podcast RSS feed to a persona, sync it
 * on a schedule, and publish its episodes into a section. Registered in
 * `AppModule`.
 *
 * Its own module rather than more providers on `SubprofilesModule`, because
 * it is the only persona surface that makes outbound fetches and writes to
 * object storage. One-way edges only: `SubprofilesModule` (for
 * `SubprofilesService.getOwned` / `insertItemsAtTop`, the persona lock and
 * edit-version bump), `StorageModule` (`putServerObject` for our copy of the
 * art) and `NotificationsModule` (`persona_import_ready`). None of them
 * imports this module back.
 *
 * `User` is read-only: the scheduled sync auto-publishes as a feed's creator
 * only while that account is active and unrestricted. `Subprofile`,
 * `SubprofileMember` and `SubprofileItem` are read-only too (persona name for
 * the bell, the member roster, the room left in a section).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      SubprofileFeed,
      SubprofileFeedEntry,
      SubprofileItem,
      SubprofileMember,
      Subprofile,
      User,
    ]),
    SubprofilesModule,
    StorageModule,
    NotificationsModule,
  ],
  controllers: [SubprofileFeedsController],
  providers: [
    SubprofileFeedsService,
    SubprofileFeedSyncService,
    SubprofileFeedFetcher,
    FeedImportThrottlerGuard,
  ],
})
export class SubprofileFeedsModule {}
