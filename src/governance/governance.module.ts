import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GovernanceController } from './governance.controller';
import { GovernanceFinanceService } from './governance-finance.service';
import { GovernanceOverviewService } from './governance-overview.service';
import { GovernanceFinanceReport } from './entities/governance-finance-report.entity';
import { GovernanceOverview } from './entities/governance-overview.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([GovernanceFinanceReport, GovernanceOverview]),
  ],
  controllers: [GovernanceController],
  providers: [GovernanceFinanceService, GovernanceOverviewService],
})
export class GovernanceModule {}
