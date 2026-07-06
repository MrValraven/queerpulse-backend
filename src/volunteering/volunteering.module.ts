import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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
  ],
  controllers: [VolunteeringController],
  providers: [VolunteeringService],
  exports: [VolunteeringService],
})
export class VolunteeringModule {}
