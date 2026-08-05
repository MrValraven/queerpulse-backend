import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TopicFollow } from './entities/topic-follow.entity';
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
 */
@Module({
  imports: [TypeOrmModule.forFeature([TopicFollow])],
  controllers: [TopicFollowsController],
  providers: [TopicFollowsService],
  exports: [TopicFollowsService],
})
export class TopicsModule {}
