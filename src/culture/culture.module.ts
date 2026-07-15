import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommissionInterestsController } from './commission-interests.controller';
import { CommissionInterestsService } from './commission-interests.service';
import { CommissionInterest } from './entities/commission-interest.entity';

@Module({
  imports: [TypeOrmModule.forFeature([CommissionInterest])],
  controllers: [CommissionInterestsController],
  providers: [CommissionInterestsService],
})
export class CultureModule {}
