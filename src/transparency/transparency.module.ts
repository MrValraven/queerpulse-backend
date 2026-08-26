import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityGovernanceLog } from '../communities/entities/community-governance-log.entity';
import { Appeal } from '../moderation/entities/appeal.entity';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { Report } from '../reports/entities/report.entity';
import { TransparencyController } from './transparency.controller';
import { TransparencyService } from './transparency.service';

/**
 * The public Transparency Report.
 *
 * Registers the four entities it counts directly in its own `forFeature`
 * rather than importing `ReportsModule` / `ModerationModule` / `CommunitiesModule`
 * (the `RoadmapModule` precedent). It needs read repositories and nothing else:
 * pulling in those modules would drag their services, their event listeners and
 * their guards behind a public endpoint that must stay a set of aggregate
 * queries.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Report,
      ModAuditLog,
      Appeal,
      CommunityGovernanceLog,
    ]),
  ],
  controllers: [TransparencyController],
  providers: [TransparencyService],
})
export class TransparencyModule {}
