import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StatusIncident } from '../status/entities/status-incident.entity';
import { Profile } from '../users/entities/profile.entity';
import { AdminStatusIncidentsController } from './admin-status-incidents.controller';
import { AdminStatusIncidentsService } from './admin-status.service';

/**
 * Registers its own overlapping `forFeature` copies of `StatusIncident` (owned
 * by `StatusModule`) and `Profile` (owned by `ProfilesModule`) rather than
 * importing either — the same self-contained pattern `AdminInvitesModule` uses,
 * and the reason the public status read cannot be dragged into this module's
 * lifecycle. `Profile` backs the author-label snapshot only, and is read-only
 * here.
 */
@Module({
  imports: [TypeOrmModule.forFeature([StatusIncident, Profile])],
  controllers: [AdminStatusIncidentsController],
  providers: [AdminStatusIncidentsService],
})
export class AdminStatusModule {}
