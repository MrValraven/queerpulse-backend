import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminQueueNotificationsModule } from '../admin-queue-notifications/admin-queue-notifications.module';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { Profile } from '../users/entities/profile.entity';
import { SubmissionsModule } from '../submissions/submissions.module';
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
    // PRD-37. The shared intake primitive, so approving or rejecting a partner
    // application tells the organisation that applied. A plain import: it pulls
    // in `NotificationsModule` only, nothing there reaches back here, so no
    // `forwardRef()`.
    SubmissionsModule,
    // Tells whoever works the partner-application queue when a member's own
    // application lands.
    AdminQueueNotificationsModule,
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
