import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { Profile } from '../users/entities/profile.entity';
import { UsersModule } from '../users/users.module';
import { Partner } from './entities/partner.entity';
import {
  AdminPartnersController,
  PartnerApplicationsController,
  PartnersController,
} from './partners.controller';
import { PartnersService } from './partners.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      // Read-only, and only for `RolesOrStaffGuard` on this module's admin
      // controllers: it resolves the caller's additive staff grants when their
      // account tier alone does not satisfy `@Roles(...)`. Same registration
      // precedent as `HousingListingsModule` for `HousingModerationGuard`.
      UserStaffRole,
      Partner,
      Profile,
    ]),
    UsersModule,
  ],
  controllers: [
    PartnersController,
    PartnerApplicationsController,
    AdminPartnersController,
  ],
  providers: [PartnersService],
  // `VolunteeringModule` imports this module to resolve `partnerSlug` ->
  // `partner_id` and `partner_id` -> `{slug,name}` refs (one-way; `Partners`
  // has no dependency back on `Volunteering`, so no `forwardRef()` needed).
  exports: [PartnersService],
})
export class PartnersModule {}
