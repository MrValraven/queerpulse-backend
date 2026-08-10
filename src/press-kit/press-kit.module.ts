import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Community } from '../communities/entities/community.entity';
import { Event } from '../events/entities/event.entity';
import { MagazineIssue } from '../magazine/entities/magazine-issue.entity';
import { SafeSpaceNomination } from '../safe-space-nominations/entities/safe-space-nomination.entity';
import { UsersModule } from '../users/users.module';
import { AdminPressKitController } from './admin-press-kit.controller';
import { PressContact } from './entities/press-contact.entity';
import { PressCoverage } from './entities/press-coverage.entity';
import { PressKitController } from './press-kit.controller';
import { PressKitService } from './press-kit.service';

@Module({
  imports: [
    // The two own tables plus the read-model entities `PressKitService` counts
    // for its derived facts: `Event` (gatherings), `SafeSpaceNomination`
    // (approved safe spaces), `MagazineIssue` (published issues), and
    // `Community` (public communities). Active-member counts go through
    // `UsersService`, so `UsersModule` (which exports it) is imported rather
    // than the `User` repo re-registered here.
    TypeOrmModule.forFeature([
      PressCoverage,
      PressContact,
      Event,
      SafeSpaceNomination,
      MagazineIssue,
      Community,
    ]),
    UsersModule,
  ],
  controllers: [PressKitController, AdminPressKitController],
  providers: [PressKitService],
})
export class PressKitModule {}
