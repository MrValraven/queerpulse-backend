import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminTitlesController } from './admin-titles.controller';
import { CinemaReconciliationService } from './cinema-reconciliation.service';
import { CinemaService } from './cinema.service';
import { CinemaTitle } from './entities/cinema-title.entity';
import { WatchProgress } from './entities/watch-progress.entity';
import { MuxService } from './mux.service';
import { TitlesController } from './titles.controller';
import { CinemaWebhooksController } from './webhooks.controller';

@Module({
  imports: [TypeOrmModule.forFeature([CinemaTitle, WatchProgress])],
  controllers: [
    TitlesController,
    AdminTitlesController,
    CinemaWebhooksController,
  ],
  providers: [CinemaService, MuxService, CinemaReconciliationService],
})
export class CinemaModule {}
