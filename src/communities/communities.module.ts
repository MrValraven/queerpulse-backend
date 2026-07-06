import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { UsersModule } from '../users/users.module';
import { CommunitiesController } from './communities.controller';
import { CommunitiesService } from './communities.service';
import { CommunityPostsService } from './community-posts.service';
import { CommunityJoinRequest } from './entities/community-join-request.entity';
import { CommunityMember } from './entities/community-member.entity';
import { CommunityPostReaction } from './entities/community-post-reaction.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { CommunityPost } from './entities/community-post.entity';
import { Community } from './entities/community.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Community,
      CommunityMember,
      CommunityPost,
      CommunityPostReaction,
      CommunityPostReply,
      CommunityJoinRequest,
      Profile,
    ]),
    UsersModule,
  ],
  controllers: [CommunitiesController],
  providers: [CommunitiesService, CommunityPostsService],
  exports: [CommunitiesService],
})
export class CommunitiesModule {}
