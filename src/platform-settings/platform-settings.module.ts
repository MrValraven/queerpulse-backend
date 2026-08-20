import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnnouncementDismissal } from './entities/announcement-dismissal.entity';
import { PlatformSettingChange } from './entities/platform-setting-change.entity';
import { PlatformSettings } from './entities/platform-settings.entity';
import { AnnouncementController } from './announcement.controller';
import { AnnouncementDismissalService } from './announcement-dismissal.service';
import { PlatformSettingsService } from './platform-settings.service';
import { PlatformSettingsController } from './platform-settings.controller';
import { PlatformStatusController } from './platform-status.controller';

/**
 * Exports `PlatformSettingsService` because the enforcement points live
 * outside this module: the global lockdown guard, `AuthService`,
 * `JoinRequestsService`, and `ChatGateway` all read the flags.
 *
 * `AnnouncementDismissal` (ADM-25's per-member "seen this banner" state)
 * lives here rather than its own module — it only exists to back the
 * announcement fields on `PlatformSettings`, so it has no reason to live
 * anywhere else.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PlatformSettings,
      PlatformSettingChange,
      AnnouncementDismissal,
    ]),
  ],
  providers: [PlatformSettingsService, AnnouncementDismissalService],
  controllers: [
    PlatformSettingsController,
    PlatformStatusController,
    AnnouncementController,
  ],
  exports: [PlatformSettingsService],
})
export class PlatformSettingsModule {}
