import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { Profile } from '../users/entities/profile.entity';
import { AdminCommissionInterestsController } from './admin-commission-interests.controller';
import { AdminCommissionInterestsService } from './admin-commission-interests.service';
import { CommissionInterestsController } from './commission-interests.controller';
import { CommissionInterestsService } from './commission-interests.service';
import { CommissionInterest } from './entities/commission-interest.entity';

@Module({
  // Registers its own `forFeature` copy of `Profile` (TypeORM permits
  // overlapping registrations) purely so the admin read model can resolve
  // submitter refs — same self-contained pattern as `AdminInvitesModule`.
  imports: [
    TypeOrmModule.forFeature([
      // Read-only, and only for `RolesOrStaffGuard` on this module's admin
      // controllers: it resolves the caller's additive staff grants when their
      // account tier alone does not satisfy `@Roles(...)`. Same registration
      // precedent as `HousingListingsModule` for `HousingModerationGuard`.
      UserStaffRole,
      CommissionInterest,
      Profile,
    ]),
  ],
  controllers: [
    CommissionInterestsController,
    AdminCommissionInterestsController,
  ],
  providers: [CommissionInterestsService, AdminCommissionInterestsService],
})
export class CultureModule {}
