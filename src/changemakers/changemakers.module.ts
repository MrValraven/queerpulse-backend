import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
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
      // Read-only, and only for `RolesOrStaffGuard` on this module's admin
      // controllers: it resolves the caller's additive staff grants when their
      // account tier alone does not satisfy `@Roles(...)`. Same registration
      // precedent as `HousingListingsModule` for `HousingModerationGuard`.
      UserStaffRole,

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
