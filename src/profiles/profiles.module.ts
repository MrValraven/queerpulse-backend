import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Community } from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { ConnectionsModule } from '../connections/connections.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { HandlesModule } from '../handles/handles.module';
import { MediaCropsModule } from '../media-crops/media-crops.module';
import { SocialModule } from '../social/social.module';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { VouchModule } from '../vouch/vouch.module';
import { Activity } from './entities/activity.entity';
import { BoardPost } from './entities/board-post.entity';
import { Group } from './entities/group.entity';
import { GroupMembership } from './entities/group-membership.entity';
import { ProfileFeaturedCommunity } from './entities/profile-featured-community.entity';
import { Shaping } from './entities/shaping.entity';
import { Skill } from './entities/skill.entity';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';
import { ActivityListener } from './activity.listener';
import { ActivityService } from './activity.service';
import { DiscoverableIdentitiesController } from './discoverable-identities.controller';
import { DiscoverableIdentitiesService } from './discoverable-identities.service';
import { MembersController, ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SocialLink,
      WorkItem,
      Skill,
      BoardPost,
      Shaping,
      Activity,
      Group,
      GroupMembership,
      ProfileFeaturedCommunity,
      Community,
      CommunityMember,
    ]),
    UsersModule,
    VouchModule,
    ConnectionsModule,
    // Exports `BlockFilterService`, used to hide blocked-either-way members
    // from the members directory search (spec §2).
    SocialModule,
    // Exports `HandlesService` for the shared global username namespace — the
    // `PATCH me/username` rename transacts against it (design plan PART C / UC4).
    HandlesModule,
    // `StorageService` — delete the previous avatar object when `updateMe`
    // replaces or clears `avatarUrl`, so a superseded upload stops orphaning.
    StorageModule,
    // `ContentModerationService` — the member read path honours a moderator
    // `hide_content`/`remove_content` takedown on a `member` subject.
    ContentModerationModule,
    // Batched crop lookup (`MediaCropService.getMany`) for a work item's
    // `imageUrl` sibling `crop`.
    MediaCropsModule,
  ],
  controllers: [
    ProfilesController,
    MembersController,
    DiscoverableIdentitiesController,
  ],
  providers: [
    ProfilesService,
    DiscoverableIdentitiesService,
    // Writes profile "Recent activity" rows off domain events (event RSVPs,
    // forum threads, public-community posts). The listener is discovered
    // globally by @nestjs/event-emitter once registered here.
    ActivityService,
    ActivityListener,
  ],
  exports: [ProfilesService],
})
export class ProfilesModule {}
