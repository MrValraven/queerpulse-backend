import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { AdminTitlesController } from './admin-titles.controller';
import { CinemaReconciliationService } from './cinema-reconciliation.service';
import { CinemaService } from './cinema.service';
import { CinemaTitle } from './entities/cinema-title.entity';
import { WatchProgress } from './entities/watch-progress.entity';
import { MuxService } from './mux.service';
import { TitlesController } from './titles.controller';
import { CinemaWebhooksController } from './webhooks.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      // Read-only, and only for `RolesOrStaffGuard` on this module's admin
      // controllers: it resolves the caller's additive staff grants when their
      // account tier alone does not satisfy `@Roles(...)`. Same registration
      // precedent as `HousingListingsModule` for `HousingModerationGuard`.
      UserStaffRole,
      CinemaTitle,
      WatchProgress,
    ]),
  ],
  controllers: [
    TitlesController,
    AdminTitlesController,
    CinemaWebhooksController,
  ],
  providers: [CinemaService, MuxService, CinemaReconciliationService],
})
export class CinemaModule {}
