import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GovernanceController } from './governance.controller';
import { GovernanceFinanceService } from './governance-finance.service';
import { GovernanceFinanceReport } from './entities/governance-finance-report.entity';

@Module({
  imports: [TypeOrmModule.forFeature([GovernanceFinanceReport])],
  controllers: [GovernanceController],
  providers: [GovernanceFinanceService],
})
export class GovernanceModule {}
