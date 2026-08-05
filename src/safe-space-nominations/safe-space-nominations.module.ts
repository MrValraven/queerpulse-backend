import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SafeSpaceNomination } from './entities/safe-space-nomination.entity';
import {
  AdminSafeSpaceNominationsController,
  SafeSpaceNominationsController,
} from './safe-space-nominations.controller';
import { SafeSpaceNominationsService } from './safe-space-nominations.service';

@Module({
  imports: [TypeOrmModule.forFeature([SafeSpaceNomination])],
  controllers: [
    SafeSpaceNominationsController,
    AdminSafeSpaceNominationsController,
  ],
  providers: [SafeSpaceNominationsService],
})
export class SafeSpaceNominationsModule {}
