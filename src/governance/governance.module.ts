import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GovernanceController } from './governance.controller';
import { AdminGovernanceController } from './admin-governance.controller';
import { GovernanceFinanceService } from './governance-finance.service';
import { GovernanceOverviewService } from './governance-overview.service';
import { GovernanceProposalService } from './governance-proposal.service';
import { GovernanceFinanceChange } from './entities/governance-finance-change.entity';
import { GovernanceFinanceReport } from './entities/governance-finance-report.entity';
import { GovernanceOverview } from './entities/governance-overview.entity';
import { GovernanceOverviewChange } from './entities/governance-overview-change.entity';
import { GovernanceProposal } from './entities/governance-proposal.entity';
import { GovernanceVote } from './entities/governance-vote.entity';
import { Profile } from '../users/entities/profile.entity';
// `UsersModule` exports `UsersService`, whose `countActiveMembers()` backs
// the live "active members" health stat (COM-4) — same injected-service
// pattern `AdminOverviewModule` uses, rather than this module re-registering
// `User` via its own `TypeOrmModule.forFeature` and duplicating the query.
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      GovernanceFinanceReport,
      GovernanceFinanceChange,
      GovernanceOverview,
      GovernanceOverviewChange,
      GovernanceProposal,
      GovernanceVote,
      Profile,
    ]),
    UsersModule,
  ],
  // `AdminGovernanceController` (`/admin/governance/*`) carries the staff
  // routes that used to live on `GovernanceController` under an `admin/*`
  // path prefix — see BE-COM-14. It reuses this module's services, so it is
  // registered here rather than in a separate top-level module.
  controllers: [GovernanceController, AdminGovernanceController],
  providers: [
    GovernanceFinanceService,
    GovernanceOverviewService,
    GovernanceProposalService,
  ],
  // `GovernanceFinanceService` is reused directly by `AdminReportsModule`
  // (the consolidated `/admin/reports` page's finance section) so that page
  // can never drift from the governance Finances tab's own figures.
  exports: [GovernanceFinanceService],
})
export class GovernanceModule {}
