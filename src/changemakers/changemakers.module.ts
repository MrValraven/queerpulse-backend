import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { Profile } from '../users/entities/profile.entity';
import { AdminChangemakerNominationsController } from './admin-changemaker-nominations.controller';
import { AdminChangemakerNominationsService } from './admin-changemaker-nominations.service';
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
    // `Profile` is registered here (overlapping `forFeature` is permitted) so
    // the nomination admin read model can resolve nominator refs.
    TypeOrmModule.forFeature([
      Changemaker,
      ChangemakerDirectorySettings,
      ChangemakerNomination,
      Profile,
    ]),
    NotificationsModule,
  ],
  controllers: [
    ChangemakersController,
    AdminChangemakersController,
    ChangemakerNominationsController,
    AdminChangemakerNominationsController,
  ],
  providers: [
    ChangemakersService,
    ChangemakerNominationsService,
    AdminChangemakerNominationsService,
  ],
})
export class ChangemakersModule {}
