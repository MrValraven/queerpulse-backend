import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HealthModule } from '../health/health.module';
import { StatusIncident } from './entities/status-incident.entity';
import { StatusController } from './status.controller';
import { StatusService } from './status.service';

/**
 * The public status surface. Imports `HealthModule` for
 * `PlatformProbesService`, so the page reports the same probes the
 * orchestrator's readiness check runs rather than a second copy of them.
 *
 * Owns the `StatusIncident` entity; `AdminStatusModule` registers its own
 * overlapping `forFeature` copy for the authoring side (TypeORM permits that,
 * same pattern as `AdminInvitesModule`).
 */
@Module({
  imports: [HealthModule, TypeOrmModule.forFeature([StatusIncident])],
  controllers: [StatusController],
  providers: [StatusService],
})
export class StatusModule {}
