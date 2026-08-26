import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PlatformProbesService } from './platform-probes.service';

/**
 * Exports `PlatformProbesService` so the public status surface
 * (`src/status/status.module.ts`) reads the SAME probe definitions the
 * orchestrator's readiness check does, rather than growing a second, drifting
 * copy of them.
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [PlatformProbesService],
  exports: [PlatformProbesService],
})
export class HealthModule {}
