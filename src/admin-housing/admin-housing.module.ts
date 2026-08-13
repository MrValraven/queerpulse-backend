import { Module } from '@nestjs/common';
import { HousingModule } from '../housing/housing.module';
import { HousingGroupsModule } from '../housing-groups/housing-groups.module';
import { AdminHousingController } from './admin-housing.controller';
import { AdminHousingGroupsController } from './admin-housing-groups.controller';

@Module({
  imports: [HousingModule, HousingGroupsModule],
  controllers: [AdminHousingController, AdminHousingGroupsController],
})
export class AdminHousingModule {}
