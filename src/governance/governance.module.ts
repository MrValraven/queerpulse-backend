import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GovernanceController } from './governance.controller';
import { GovernanceFinanceService } from './governance-finance.service';
import { GovernanceOverviewService } from './governance-overview.service';
import { GovernanceFinanceChange } from './entities/governance-finance-change.entity';
import { GovernanceFinanceReport } from './entities/governance-finance-report.entity';
import { GovernanceOverview } from './entities/governance-overview.entity';
import { GovernanceOverviewChange } from './entities/governance-overview-change.entity';
import { Profile } from '../users/entities/profile.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      GovernanceFinanceReport,
      GovernanceFinanceChange,
      GovernanceOverview,
      GovernanceOverviewChange,
      Profile,
    ]),
  ],
  controllers: [GovernanceController],
  providers: [GovernanceFinanceService, GovernanceOverviewService],
})
export class GovernanceModule {}
