import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminChangemakersController } from './admin-changemakers.controller';
import { ChangemakerNominationsController } from './changemaker-nominations.controller';
import { ChangemakerNominationsService } from './changemaker-nominations.service';
import { ChangemakersController } from './changemakers.controller';
import { ChangemakersService } from './changemakers.service';
import { Changemaker } from './entities/changemaker.entity';
import { ChangemakerDirectorySettings } from './entities/changemaker-directory-settings.entity';
import { ChangemakerNomination } from './entities/changemaker-nomination.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Changemaker,
      ChangemakerDirectorySettings,
      ChangemakerNomination,
    ]),
  ],
  controllers: [
    ChangemakersController,
    AdminChangemakersController,
    ChangemakerNominationsController,
  ],
  providers: [ChangemakersService, ChangemakerNominationsService],
})
export class ChangemakersModule {}
