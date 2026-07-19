import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConnectionsModule } from '../connections/connections.module';
import { HandlesModule } from '../handles/handles.module';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { VouchModule } from '../vouch/vouch.module';
import { Activity } from './entities/activity.entity';
import { BoardPost } from './entities/board-post.entity';
import { Group } from './entities/group.entity';
import { GroupMembership } from './entities/group-membership.entity';
import { Shaping } from './entities/shaping.entity';
import { Skill } from './entities/skill.entity';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';
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
  ],
  controllers: [
    ProfilesController,
    MembersController,
    DiscoverableIdentitiesController,
  ],
  providers: [ProfilesService, DiscoverableIdentitiesService],
  exports: [ProfilesService],
})
export class ProfilesModule {}
