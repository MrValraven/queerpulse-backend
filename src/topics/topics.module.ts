import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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
 * DISC-3 UPDATE — "topics themselves have no backend table" is now stale for
 * the directory metadata (`content` module's `Topic`/`TopicPost` entities
 * exist for real); it stays true for THIS module, which still owns only the
 * follow join. `TopicFollowNotificationsListener` fans a new topic post out
 * to this table's followers — plain `NotificationsModule` import, no
 * `forwardRef`: `NotificationsModule` imports only `SocialModule`, which does
 * not reach back into `TopicsModule`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([TopicFollow]), NotificationsModule],
  controllers: [TopicFollowsController],
  providers: [TopicFollowsService, TopicFollowNotificationsListener],
  exports: [TopicFollowsService],
})
export class TopicsModule {}
