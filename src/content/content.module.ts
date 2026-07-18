import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SocialModule } from '../social/social.module';
import { ContentController, TopicsController } from './content.controller';
import { ContentPagesService } from './content-pages.service';
import { ContentPage } from './entities/content-page.entity';
import { TopicPost } from './entities/topic-post.entity';
import { Topic } from './entities/topic.entity';
import { TopicsService } from './topics.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ContentPage, Topic, TopicPost]),
    // For `BlockFilterService`, so `GET /topics/:slug/posts` hides blocked and
    // muted authors. Plain import, no `forwardRef`: `SocialModule` imports only
    // `UsersModule` + `ReportsModule`, neither of which reaches back into
    // `content`.
    SocialModule,
  ],
  controllers: [ContentController, TopicsController],
  providers: [ContentPagesService, TopicsService],
})
export class ContentModule {}
