import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { Community } from '../communities/entities/community.entity';
import { Event } from '../events/entities/event.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { FeedController } from './feed.controller';
import { FeedService } from './feed.service';

/**
 * Read-time feed aggregation (spec §3 Tier 3 "feed"). No entity/migration of
 * its own — it only *reads* the source domains' tables via a redundant
 * `TypeOrmModule.forFeature` registration (the same idiom
 * `CommunitiesModule` uses for `Profile`), so it never needs to import
 * `CommunitiesModule`/`ForumModule`/`EventsModule` themselves (none of them
 * export their entity repositories, only their services).
 *
 * `UsersModule` supplies the `Profile` repository (for `MemberLookup`,
 * resolving authors/hosts to `AuthorSummary`) — see `ForumModule`'s import
 * for the same idiom. `SocialModule` supplies `BlockFilterService` for the
 * cross-cutting block enforcement (spec §2).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CommunityPost, Community, ForumThread, Event]),
    UsersModule,
    SocialModule,
  ],
  controllers: [FeedController],
  providers: [FeedService],
})
export class FeedModule {}
