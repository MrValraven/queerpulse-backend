import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { MentionsModule } from '../mentions/mentions.module';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { ForumPostEdit } from './entities/forum-post-edit.entity';
import { ForumPostVote } from './entities/forum-post-vote.entity';
import { ForumPost } from './entities/forum-post.entity';
import { ForumThread } from './entities/forum-thread.entity';
import { ForumController } from './forum.controller';
import { ForumPostsService } from './forum-posts.service';
import { ForumThreadsService } from './forum-threads.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ForumThread,
      ForumPost,
      ForumPostVote,
      ForumPostEdit,
    ]),
    // Gives access to `Repository<Profile>` (exported by `UsersModule`) for
    // resolving thread/post authors to `AuthorSummary` — mirrors
    // `EventsModule`'s import, not `CommunitiesModule`'s redundant
    // `TypeOrmModule.forFeature([..., Profile])`.
    UsersModule,
    // `BlockFilterService` — thread/post lists exclude blocked-either-way and
    // muted authors. Plain import, no `forwardRef`: `SocialModule` imports only
    // `UsersModule` + `ReportsModule`, neither of which reaches `ForumModule`.
    SocialModule,
    // `MentionNotificationService` — multi-kind `@mention` fan-out on
    // reply-create. Plain import, no `forwardRef`: `MentionsModule` does not
    // import `ForumModule`.
    MentionsModule,
    // `ContentModerationService` — post/reply reads respect a moderator
    // `hide_content`/`remove_content` takedown: hidden posts are withheld from
    // members (shown to moderators, flagged), removed posts render as a
    // tombstone reusing the existing `deleted` rendering.
    ContentModerationModule,
  ],
  controllers: [ForumController],
  providers: [ForumThreadsService, ForumPostsService],
  exports: [ForumThreadsService, ForumPostsService],
})
export class ForumModule {}
