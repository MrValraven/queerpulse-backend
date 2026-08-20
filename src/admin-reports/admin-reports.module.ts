import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminCommunitiesModule } from '../admin-communities/admin-communities.module';
import { GovernanceModule } from '../governance/governance.module';
import { Report } from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { AdminReportsController } from './admin-reports.controller';
import { AdminReportsService } from './admin-reports.service';

@Module({
  imports: [
    // Own `forFeature` for every entity `AdminReportsService` reads
    // directly — mirrors `AdminOverviewModule`'s precedent of registering
    // its own copies rather than depending on other modules' re-exports.
    TypeOrmModule.forFeature([Profile, Report]),
    // Exports `AdminCommunitiesService`, reused directly for the
    // community-health snapshot (same pattern as `AdminOverviewModule`).
    AdminCommunitiesModule,
    // Exports `GovernanceFinanceService`, reused directly for the finance
    // history section.
    GovernanceModule,
  ],
  controllers: [AdminReportsController],
  providers: [AdminReportsService],
})
export class AdminReportsModule {}
