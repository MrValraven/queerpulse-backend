import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Community } from '../communities/entities/community.entity';
import { Event } from '../events/entities/event.entity';
import { Handle } from '../handles/entities/handle.entity';
import { HandlesModule } from '../handles/handles.module';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { Subprofile } from './entities/subprofile.entity';
import { SubprofileAffiliation } from './entities/subprofile-affiliation.entity';
import { SubprofileEndorsement } from './entities/subprofile-endorsement.entity';
import { SubprofileFollower } from './entities/subprofile-follower.entity';
import { SubprofileItem } from './entities/subprofile-item.entity';
import { SubprofileSocialLink } from './entities/subprofile-social-link.entity';
import {
  ProfileSubprofilesController,
  SubprofilesController,
} from './subprofiles.controller';
import { SubprofileEndorsementsService } from './subprofile-endorsements.service';
import { SubprofileFollowersService } from './subprofile-followers.service';
import { SubprofilesService } from './subprofiles.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Subprofile,
      SubprofileAffiliation,
      SubprofileEndorsement,
      SubprofileFollower,
      SubprofileItem,
      SubprofileSocialLink,
      Event,
      Community,
      Handle,
    ]),
    // Exports the `Profile` repository (used to resolve an owner slug → user).
    UsersModule,
    // Exports `BlockFilterService`, used to hide blocked-either-way members
    // from the directory and by-handle lookups (design spec §4).
    SocialModule,
    // Exports `HandlesService` — publish/unpublish/link-switch/handle-change now
    // claim/release the persona's name in the ONE global namespace (Task C2).
    HandlesModule,
  ],
  controllers: [SubprofilesController, ProfileSubprofilesController],
  providers: [
    SubprofilesService,
    SubprofileEndorsementsService,
    SubprofileFollowersService,
  ],
})
export class SubprofilesModule {}
