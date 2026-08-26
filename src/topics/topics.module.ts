import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Topic } from '../content/entities/topic.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { TopicFollow } from './entities/topic-follow.entity';
import { TopicFollowNotificationsListener } from './topic-follow-notifications.listener';
import { TopicFollowsController } from './topic-follows.controller';
import { TopicFollowsService } from './topic-follows.service';

/**
 * Topic follows (P2-15). A new, standalone module — topics themselves have no
 * backend table (the `content` module serves the read-side `/topics` directory
 * from frontend-derived data), so this owns only the `topic_follows` join and
 * its follow/unfollow/list endpoints.
 *
 * Must be imported BEFORE `ContentModule` in `app.module.ts` so its
 * `@Get('follows')` route registers ahead of `content`'s `@Get('topics/:slug')`
 * (both share the `/topics` prefix; Express is first-match-wins).
 *
 * DISC-3 UPDATE: "topics themselves have no backend table" is stale for the
 * directory metadata (`content` module's `Topic`/`TopicPost` entities exist
 * for real). This module still owns only the follow join, and since SOC-01 it
 * also writes one column of `topics`, the denormalized `follower_count`.
 *
 * `TopicFollowNotificationsListener` fans a new topic post out to this
 * table's followers. Plain `NotificationsModule` import, no
 * `forwardRef`: `NotificationsModule` imports only `SocialModule`, which does
 * not reach back into `TopicsModule`.
 */
@Module({
  imports: [
    // `Topic` is registered for its write side only: following a topic moves
    // `topics.follower_count` (SOC-01). The read side of that table stays
    // `ContentModule`'s.
    TypeOrmModule.forFeature([TopicFollow, Topic]),
    NotificationsModule,
  ],
  controllers: [TopicFollowsController],
  providers: [TopicFollowsService, TopicFollowNotificationsListener],
  exports: [TopicFollowsService],
})
export class TopicsModule {}
