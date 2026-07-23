import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SocialModule } from '../social/social.module';
import { Profile } from '../users/entities/profile.entity';
import { UsersModule } from '../users/users.module';
import { CommunitiesController } from './communities.controller';
import { CommunitiesService } from './communities.service';
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
    ]),
    UsersModule,
    // `BlockFilterService` — community post feeds and their nested replies
    // exclude blocked/muted authors. Plain import (no `forwardRef`):
    // `SocialModule` pulls in only `UsersModule` + `ReportsModule`.
    SocialModule,
  ],
  controllers: [
    CommunitiesController,
    CommunityPostsController,
    MeCommunitiesController,
  ],
  providers: [CommunitiesService, CommunityPostsService],
  exports: [CommunitiesService],
})
export class CommunitiesModule {}
