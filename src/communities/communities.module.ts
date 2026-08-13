import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { MentionsModule } from '../mentions/mentions.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { Report } from '../reports/entities/report.entity';
import { SocialModule } from '../social/social.module';
import { StorageModule } from '../storage/storage.module';
import { Profile } from '../users/entities/profile.entity';
import { UsersModule } from '../users/users.module';
import { VouchModule } from '../vouch/vouch.module';
import { CommunitiesController } from './communities.controller';
import { CommunitiesService } from './communities.service';
import { CommunityAutoFreezeService } from './community-auto-freeze.service';
import { CommunityPostsController } from './community-posts.controller';
import { CommunityPostsService } from './community-posts.service';
import { CommunityJoinRequest } from './entities/community-join-request.entity';
import { CommunityMember } from './entities/community-member.entity';
import { CommunityPostEdit } from './entities/community-post-edit.entity';
import { CommunityPostReaction } from './entities/community-post-reaction.entity';
import { CommunityPostReplyEdit } from './entities/community-post-reply-edit.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { CommunityPost } from './entities/community-post.entity';
import { Community } from './entities/community.entity';
import { MeCommunitiesController } from './me-communities.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Community,
      CommunityMember,
      CommunityPost,
      CommunityPostReaction,
      CommunityPostReply,
      CommunityPostEdit,
      CommunityPostReplyEdit,
      CommunityJoinRequest,
      Profile,
      // Read-only, for the auto-freeze listener's open-report count. Same
      // cross-module `forFeature` reuse `ReportsModule` itself does with
      // `Message`/`HousingListing` — TypeORM allows an entity's repo in more
      // than one module.
      Report,
    ]),
    UsersModule,
    // `VouchService` — second-vouch join gating reads the platform vouch graph
    // to check whether a current member has vouched for an applicant.
    // `VouchModule` imports only `UsersModule`, so there is no cycle.
    VouchModule,
    // `BlockFilterService` — community post feeds and their nested replies
    // exclude blocked/muted authors. Plain import (no `forwardRef`):
    // `SocialModule` pulls in only `UsersModule` + `ReportsModule`.
    SocialModule,
    // `MentionNotificationService` — `@mention`/`c/community` fan-out on
    // post/reply create. Plain import, no `forwardRef`: `MentionsModule`
    // imports only entity repos + `NotificationsModule`, not `CommunitiesModule`.
    MentionsModule,
    // `ContentModerationService` — community post/reply reads honour a
    // moderator `hide_content`/`remove_content` takedown (hidden withheld from
    // members, removed rendered as a tombstone).
    ContentModerationModule,
    // `NotificationsService` — `CommunitiesService` emits join-request
    // received (owner/mods) + decided (applicant). (The community-post-reply
    // notification goes through `MentionNotificationService` above.)
    // `NotificationsModule` imports only `SocialModule`, not `CommunitiesModule`,
    // so there is no cycle.
    NotificationsModule,
    // `StorageService` — delete a post's previous image object when an author
    // replaces or clears it on edit, so the superseded upload stops orphaning.
    StorageModule,
  ],
  controllers: [
    CommunitiesController,
    CommunityPostsController,
    MeCommunitiesController,
  ],
  providers: [
    CommunitiesService,
    CommunityPostsService,
    CommunityAutoFreezeService,
  ],
  exports: [CommunitiesService],
})
export class CommunitiesModule {}
