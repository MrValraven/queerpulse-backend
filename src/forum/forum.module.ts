import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { ForumPostVote } from './entities/forum-post-vote.entity';
import { ForumPost } from './entities/forum-post.entity';
import { ForumThread } from './entities/forum-thread.entity';
import { ForumController } from './forum.controller';
import { ForumPostsService } from './forum-posts.service';
import { ForumThreadsService } from './forum-threads.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([ForumThread, ForumPost, ForumPostVote]),
    // Gives access to `Repository<Profile>` (exported by `UsersModule`) for
    // resolving thread/post authors to `AuthorSummary` — mirrors
    // `EventsModule`'s import, not `CommunitiesModule`'s redundant
    // `TypeOrmModule.forFeature([..., Profile])`.
    UsersModule,
  ],
  controllers: [ForumController],
  providers: [ForumThreadsService, ForumPostsService],
  exports: [ForumThreadsService, ForumPostsService],
})
export class ForumModule {}
