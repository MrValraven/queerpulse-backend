import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { HousingSavedSearch } from './entities/housing-saved-search.entity';
import { HousingSavedSearchAlertsListener } from './housing-saved-search-alerts.listener';
import { HousingSavedSearchesController } from './housing-saved-searches.controller';
import { HousingSavedSearchesService } from './housing-saved-searches.service';

/**
 * Member saved housing searches + the go-live alert fan-out (Wave B3 P2.5).
 * Depends on NotificationsModule (which exports NotificationsService) to deliver
 * alerts through the existing bell/socket/push system. It listens for
 * `HOUSING_LISTING_WENT_LIVE` (emitted by housing-listings via the global event
 * bus), so there is no import of / cycle with HousingListingsModule.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([HousingSavedSearch]),
    NotificationsModule,
  ],
  controllers: [HousingSavedSearchesController],
  providers: [HousingSavedSearchesService, HousingSavedSearchAlertsListener],
})
export class HousingSavedSearchesModule {}
