import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { AdminQueuesController } from './admin-queues.controller';
import { AdminQueuesService } from './admin-queues.service';

/**
 * The staff triage console's read model (PRD-282). One controller, one service,
 * no cron, no writes.
 *
 * ONLY `UserStaffRole` IS REGISTERED HERE, and that is on purpose. This module
 * reads roughly thirty tables owned by roughly thirty other feature modules;
 * a `forFeature` listing all of them would be thirty constructor parameters and
 * an import graph reaching most of the platform, and importing those modules
 * outright would build cycles. `AdminQueuesService` instead resolves each
 * repository from the shared `DataSource` at query time, the same escape hatch
 * `AdminCommunitiesService`, `MetricsService` and `LandingService` already
 * use, so a new queue costs an entry in `admin-queue-counters.ts` and nothing
 * here.
 *
 * `UserStaffRole` is the one exception, twice over: `AdminQueuesService` reads
 * the caller's grants to filter the body, and `RolesOrStaffGuard` — resolved in
 * THIS module's injector because the controller names it in `@UseGuards` —
 * injects the same repository to run the endpoint's own gate.
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserStaffRole])],
  controllers: [AdminQueuesController],
  providers: [AdminQueuesService],
})
export class AdminQueuesModule {}
