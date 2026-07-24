import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { GetGovernanceFinancesQuery } from './dto/get-governance-finances.query';
import { GovernanceFinanceService } from './governance-finance.service';
import { GovernanceOverviewService } from './governance-overview.service';

// Read-only controller serving the structured data behind `/about/governance`.
// Both endpoints follow the "structure in the DB, words in i18n" model: they
// return content keys, numbers, and non-translatable data (names/initials),
// and the frontend resolves the translated prose from its i18n catalogs.
//   • `GET /governance/overview` — the non-financial page structure (health
//     snapshot, moderation steps, advisory council, principles, decision log).
//   • `GET /governance/finances` — the quarterly financial-transparency
//     snapshot (stats/income/expense/eventNotes) plus the reserve + partner
//     disclosures rendered alongside it.
@Feature('governance')
@Controller('governance')
@UseGuards(ActiveMemberGuard)
export class GovernanceController {
  constructor(
    private readonly governanceFinanceService: GovernanceFinanceService,
    private readonly governanceOverviewService: GovernanceOverviewService,
  ) {}

  @Get('overview')
  getOverview() {
    return this.governanceOverviewService.getOverview();
  }

  @Get('finances')
  getFinances(@Query() query: GetGovernanceFinancesQuery) {
    return this.governanceFinanceService.getFinances(query.quarter);
  }
}
