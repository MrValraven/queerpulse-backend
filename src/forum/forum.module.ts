import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityMembershipModule } from '../communities/community-membership.module';
import { ContentModule } from '../content/content.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { MentionsModule } from '../mentions/mentions.module';
import { ModerationModule } from '../moderation/moderation.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { ForumPollOption } from './entities/forum-poll-option.entity';
import { ForumPollVote } from './entities/forum-poll-vote.entity';
import { ForumPoll } from './entities/forum-poll.entity';
import { ForumPostEdit } from './entities/forum-post-edit.entity';
import { ForumPostPhoto } from './entities/forum-post-photo.entity';
import { ForumPostVote } from './entities/forum-post-vote.entity';
import { ForumPost } from './entities/forum-post.entity';
import { ForumThread } from './entities/forum-thread.entity';
import { ForumThreadSubscription } from './entities/forum-thread-subscription.entity';
import { ForumController } from './forum.controller';
import { ForumPollsService } from './forum-polls.service';
import { ForumPostsService } from './forum-posts.service';
import { ForumSubscriptionsService } from './forum-subscriptions.service';
import { ForumThreadsService } from './forum-threads.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ForumThread,
      ForumPost,
      ForumPostVote,
      ForumPostEdit,
      ForumThreadSubscription,
      // The richer composer's own tables
      // (`AddForumRichComposer1817300000000`): one poll per thread with its
      // options and ballots, and the multi-photo child of `forum_post`.
      // Registered here rather than in a module of their own — they have no
      // life outside a thread, and every FK between them cascades from one.
      ForumPoll,
      ForumPollOption,
      ForumPollVote,
      ForumPostPhoto,
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
    // `CommunityMembershipService` — an optional `communitySlug` on create
    // resolves + roster-checks a community for the thread to attach to.
    // Mirrors `EventsModule`'s import.
    CommunityMembershipModule,
    // `TopicPostLinkService` (DISC-5) — a newly created thread's tags are
    // reconciled against the topics directory on create. Plain import, no
    // `forwardRef`: `ContentModule` imports `SocialModule` + `UsersModule`,
    // neither of which reaches back into `ForumModule`.
    ContentModule,
    // `ModAuditService` — staff thread actions (lock/unlock, pin/unpin, the
    // "QueerPulse Official" byline toggle) append a `mod_audit_logs` row so
    // they show up in `GET /mod/audit` and its CSV export alongside every
    // other moderator action (BE-COM-19). Plain import, no `forwardRef`:
    // `ModerationModule`'s own import graph (auth, users, reports,
    // content-moderation, notifications, community-membership) never reaches
    // back into `ForumModule`.
    ModerationModule,
    // `NotificationsService` — the author's own word on a moderator's review
    // verdict (`ForumThreadsService.reviewThread`). Plain import, no
    // `forwardRef`: `NotificationsModule` imports users, social, reports and
    // community membership, none of which reaches back into `ForumModule`.
    NotificationsModule,
  ],
  controllers: [ForumController],
  providers: [
    ForumThreadsService,
    ForumPostsService,
    // Polls. Depends on `ForumThreadsService` for the thread visibility gate
    // and on nothing else in this module; `ForumThreadsService` writes polls
    // through the plain helpers in `forum-poll.ts` rather than injecting this,
    // which is what keeps the arrow one-way and the module free of a
    // `forwardRef`.
    ForumPollsService,
    ForumSubscriptionsService,
  ],
  exports: [
    ForumThreadsService,
    ForumPostsService,
    ForumPollsService,
    ForumSubscriptionsService,
  ],
})
export class ForumModule {}
