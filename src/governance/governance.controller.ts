import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { GetGovernanceFinancesQuery } from './dto/get-governance-finances.query';
import { GovernanceFinanceService } from './governance-finance.service';

// `GovernancePage.tsx` is almost entirely fixed editorial/transparency prose
// (moderation steps, advisory council bios, platform principles, decision
// log) — none of that is wired here. The one section built from structured
// figures rather than authored copy is `FinancesSection`'s quarterly
// numbers (`FIN_STATS`/`INCOME`/`EXPENSE`/`EVENTS` in `governance.data.ts`),
// which this read-only controller serves.
@Feature('governance')
@Controller('governance')
@UseGuards(ActiveMemberGuard)
export class GovernanceController {
  constructor(
    private readonly governanceFinanceService: GovernanceFinanceService,
  ) {}

  @Get('finances')
  getFinances(@Query() query: GetGovernanceFinancesQuery) {
    return this.governanceFinanceService.getFinances(query.quarter);
  }
}
