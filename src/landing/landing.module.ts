import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { Changemaker } from '../changemakers/entities/changemaker.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { Profile } from '../users/entities/profile.entity';
import { AdminLandingController } from './admin-landing.controller';
import { LandingFeature } from './entities/landing-feature.entity';
import { LandingController } from './landing.controller';
import { LandingService } from './landing.service';

@Module({
  imports: [
    // Every repository `LandingService` injects: `LandingFeature` (own
    // table), `Profile`/`Community`/`Changemaker` (the three featurable
    // target types), and `CommunityMember` (community member counts on the
    // public payload).
    TypeOrmModule.forFeature([
      // Read-only, and only for `RolesOrStaffGuard` on this module's admin
      // controllers: it resolves the caller's additive staff grants when their
      // account tier alone does not satisfy `@Roles(...)`. Same registration
      // precedent as `HousingListingsModule` for `HousingModerationGuard`.
      UserStaffRole,

      LandingFeature,
      Profile,
      Community,
      Changemaker,
      CommunityMember,
    ]),
  ],
  controllers: [LandingController, AdminLandingController],
  providers: [LandingService],
})
export class LandingModule {}
