import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformSettingChange } from './entities/platform-setting-change.entity';
import { PlatformSettings } from './entities/platform-settings.entity';
import { PlatformSettingsService } from './platform-settings.service';
import { PlatformSettingsController } from './platform-settings.controller';
import { PlatformStatusController } from './platform-status.controller';

/**
 * Exports `PlatformSettingsService` because the enforcement points live
 * outside this module: the global lockdown guard, `AuthService`,
 * `JoinRequestsService`, and `ChatGateway` all read the flags.
 */
@Module({
  imports: [TypeOrmModule.forFeature([PlatformSettings, PlatformSettingChange])],
  providers: [PlatformSettingsService],
  controllers: [PlatformSettingsController, PlatformStatusController],
  exports: [PlatformSettingsService],
})
export class PlatformSettingsModule {}
