import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GovernanceController } from './governance.controller';
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
  controllers: [GovernanceController],
  providers: [
    GovernanceFinanceService,
    GovernanceOverviewService,
    GovernanceProposalService,
  ],
})
export class GovernanceModule {}
