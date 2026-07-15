import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentController, TopicsController } from './content.controller';
import { ContentPagesService } from './content-pages.service';
import { ContentPage } from './entities/content-page.entity';
import { Topic } from './entities/topic.entity';
import { TopicsService } from './topics.service';

@Module({
  imports: [TypeOrmModule.forFeature([ContentPage, Topic])],
  controllers: [ContentController, TopicsController],
  providers: [ContentPagesService, TopicsService],
})
export class ContentModule {}
