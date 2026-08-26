import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Topic } from '../content/entities/topic.entity';
import { TopicFollow } from '../topics/entities/topic-follow.entity';
import { AdminTopicsController } from './admin-topics.controller';
import { AdminTopicsService } from './admin-topics.service';

/**
 * The staff authoring surface for the topic directory (SOC-01).
 *
 * A separate module rather than another controller inside `content`, matching
 * `admin-forum` / `admin-communities`: the read side stays a member-facing
 * feature module and the guarded write side lives on its own.
 *
 * Registers the two entities it writes directly (`Topic`, owned read-side by
 * `ContentModule`, and `TopicFollow`, owned by `TopicsModule`) rather than
 * importing those modules, since neither exports a repository and the only
 * shared thing needed here is the table.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Topic, TopicFollow])],
  controllers: [AdminTopicsController],
  providers: [AdminTopicsService],
})
export class AdminTopicsModule {}
