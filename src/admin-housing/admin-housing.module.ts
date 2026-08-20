import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HousingModule } from '../housing/housing.module';
import { HousingGroupsModule } from '../housing-groups/housing-groups.module';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { AdminHousingController } from './admin-housing.controller';
import { AdminHousingGroupsController } from './admin-housing-groups.controller';

@Module({
  imports: [
    HousingModule,
    HousingGroupsModule,
    // `HousingModerationGuard` (on `AdminHousingGroupsController`) needs
    // this to check the additive `housing_moderator` staff role.
    TypeOrmModule.forFeature([UserStaffRole]),
  ],
  controllers: [AdminHousingController, AdminHousingGroupsController],
})
export class AdminHousingModule {}
