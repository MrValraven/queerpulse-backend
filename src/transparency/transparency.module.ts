import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityGovernanceLog } from '../communities/entities/community-governance-log.entity';
import { LegalRequest } from '../legal-requests/entities/legal-request.entity';
import { Appeal } from '../moderation/entities/appeal.entity';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { Report } from '../reports/entities/report.entity';
import { TransparencyController } from './transparency.controller';
import { TransparencyService } from './transparency.service';

/**
 * The public Transparency Report.
 *
 * Registers the five entities it counts directly in its own `forFeature`
 * rather than importing `ReportsModule` / `ModerationModule` / `CommunitiesModule`
 * / `LegalRequestsModule` (the `RoadmapModule` precedent). It needs read
 * repositories and nothing else: pulling in those modules would drag their
 * services, their event listeners and their guards behind a public endpoint that
 * must stay a set of aggregate queries. `LegalRequest` is the sharpest case of
 * that rule. Its module owns a write side no public endpoint should be able to
 * reach, so the report takes a read repository over the table and never the
 * service that fills it.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Report,
      ModAuditLog,
      Appeal,
      CommunityGovernanceLog,
      LegalRequest,
    ]),
  ],
  controllers: [TransparencyController],
  providers: [TransparencyService],
})
export class TransparencyModule {}
