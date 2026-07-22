import { Module } from '@nestjs/common';
import { HousingModule } from '../housing/housing.module';
import { AdminHousingController } from './admin-housing.controller';

@Module({
  imports: [HousingModule],
  controllers: [AdminHousingController],
})
export class AdminHousingModule {}
