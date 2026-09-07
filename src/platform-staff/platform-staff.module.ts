import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { UsersModule } from '../users/users.module';
import { PlatformStaffController } from './platform-staff.controller';
import { PlatformStaffService } from './platform-staff.service';

@Module({
  // `UsersModule` exports the User/Profile repositories; the additive staff
  // grants live in their own table and are registered here rather than widened
  // into `UsersModule`, so the roster owns the only reason this module reads
  // them.
  imports: [UsersModule, TypeOrmModule.forFeature([UserStaffRole])],
  controllers: [PlatformStaffController],
  providers: [PlatformStaffService],
  // Exported for `GovernanceModule`: an advisory-council seat may only be held
  // by someone on this roster, and the write path asks this service rather than
  // restating the rule.
  exports: [PlatformStaffService],
})
export class PlatformStaffModule {}
