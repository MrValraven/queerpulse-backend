import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HandlesModule } from '../handles/handles.module';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { Subprofile } from './entities/subprofile.entity';
import { SubprofileItem } from './entities/subprofile-item.entity';
import {
  ProfileSubprofilesController,
  SubprofilesController,
} from './subprofiles.controller';
import { SubprofilesService } from './subprofiles.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Subprofile, SubprofileItem]),
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
  providers: [SubprofilesService],
})
export class SubprofilesModule {}
