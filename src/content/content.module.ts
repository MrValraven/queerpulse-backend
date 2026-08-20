import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { ContentController, TopicsController } from './content.controller';
import { ContentPagesService } from './content-pages.service';
import { ContentPage } from './entities/content-page.entity';
import { TopicPost } from './entities/topic-post.entity';
import { Topic } from './entities/topic.entity';
import { TopicPostLinkService } from './topic-post-link.service';
import { TopicsService } from './topics.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ContentPage, Topic, TopicPost]),
    // For `BlockFilterService`, so `GET /topics/:slug/posts` hides blocked and
    // muted authors. Plain import, no `forwardRef`: `SocialModule` imports only
    // `UsersModule` + `ReportsModule`, neither of which reaches back into
    // `content`.
    SocialModule,
    // Gives `TopicPostLinkService` access to `Repository<Profile>` to resolve
    // a thread author's display name/initials for a linked `topic_post` row.
    // Plain import, no `forwardRef`: `UsersModule` imports nothing that
    // reaches back into `content`.
    UsersModule,
  ],
  controllers: [ContentController, TopicsController],
  providers: [ContentPagesService, TopicsService, TopicPostLinkService],
  // `TopicsService` is also consumed by `SearchModule` (global search's
  // `topic` result type). `TopicPostLinkService` is consumed by `ForumModule`
  // (DISC-5 — `ForumThreadsService.create` links a newly created thread's
  // tags into any matching topic).
  exports: [TopicsService, TopicPostLinkService],
})
export class ContentModule {}
