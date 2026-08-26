import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Community } from '../communities/entities/community.entity';
import { Event as GatheringEvent } from '../events/entities/event.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
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
import { ProfileLastActive } from './entities/profile-last-active.entity';
import { Shaping } from './entities/shaping.entity';
import { Skill } from './entities/skill.entity';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';
import { ActivityListener } from './activity.listener';
import { ActivityVisibilityService } from './activity-visibility.service';
import { ActivityService } from './activity.service';
import { LastActiveListener } from './last-active.listener';
import { LastActiveService } from './last-active.service';
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
      ProfileLastActive,
      Community,
      CommunityMember,
      // Read-only, for the activity privacy gate: `ActivityVisibilityService`
      // re-checks that an activity row's subject (a gathering, a persona) is
      // still public, and `ActivityListener` reads the community a join event
      // names. Neither ever writes to these tables.
      GatheringEvent,
      Subprofile,
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
    // forum threads, public-community posts and joins, persona publishes).
    // The listener is discovered globally by @nestjs/event-emitter once
    // registered here.
    ActivityService,
    ActivityListener,
    // The read half of that gate: drops (and purges) rows whose subject has
    // stopped being public since the row was written.
    ActivityVisibilityService,
    // The coarse "recently active" signal. The listener is the ONLY writer:
    // it coarsens `auth.session_refreshed` to a month and writes at most once
    // a day per member. See last-active.ts for what the signal may say.
    LastActiveService,
    LastActiveListener,
  ],
  exports: [ProfilesService],
})
export class ProfilesModule {}
