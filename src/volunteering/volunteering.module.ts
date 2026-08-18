import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityMembershipModule } from '../communities/community-membership.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PartnersModule } from '../partners/partners.module';
import { Profile } from '../users/entities/profile.entity';
import { UsersModule } from '../users/users.module';
import { VolunteerOpportunityTeam } from './entities/volunteer-opportunity-team.entity';
import { VolunteerOpportunity } from './entities/volunteer-opportunity.entity';
import { VolunteerSignup } from './entities/volunteer-signup.entity';
import { VolunteeringController } from './volunteering.controller';
import { VolunteeringService } from './volunteering.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      VolunteerOpportunity,
      VolunteerOpportunityTeam,
      VolunteerSignup,
      Profile,
    ]),
    UsersModule,
    // One-way: `VolunteeringService` injects `PartnersService` to resolve
    // `partnerSlug` <-> `partner_id`. `PartnersModule` has no dependency back
    // on `VolunteeringModule`, so no `forwardRef()` is needed (unlike
    // Companies<->Jobs).
    PartnersModule,
    // `CommunityMembershipService` — resolves `communitySlug` <-> `community_id`
    // for the combined organization link, asserting the poster is on that
    // community's roster (mirrors `EventsModule`'s identical import).
    CommunityMembershipModule,
    // Fires `VolunteerApplicationReceived`/`VolunteerApplicationDecided` on
    // signup/decide — one-way import, `NotificationsModule` has no
    // dependency back on `VolunteeringModule` (mirrors `communities.module.ts`).
    NotificationsModule,
  ],
  controllers: [VolunteeringController],
  providers: [VolunteeringService],
  exports: [VolunteeringService],
})
export class VolunteeringModule {}
