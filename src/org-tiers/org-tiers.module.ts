import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { OrgTier } from './entities/org-tier.entity';
import {
  AdminOrgTiersController,
  OrgTiersController,
} from './org-tiers.controller';
import { OrgTiersService } from './org-tiers.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      // Read-only, and only for `RolesOrStaffGuard` on this module's admin
      // controllers: it resolves the caller's additive staff grants when their
      // account tier alone does not satisfy `@Roles(...)`. Same registration
      // precedent as `HousingListingsModule` for `HousingModerationGuard`.
      UserStaffRole,
      OrgTier,
    ]),
  ],
  controllers: [OrgTiersController, AdminOrgTiersController],
  providers: [OrgTiersService],
})
export class OrgTiersModule {}
