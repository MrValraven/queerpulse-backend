import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { Feature } from '../common/feature.decorator';
import { GetGovernanceFinancesQuery } from './dto/get-governance-finances.query';
import { GovernanceFinanceService } from './governance-finance.service';
import { GovernanceOverviewService } from './governance-overview.service';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

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
@ApiTags('Governance')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Not authenticated as an active member.',
})
@Controller('governance')
@UseGuards(ActiveMemberGuard)
export class GovernanceController {
  constructor(
    private readonly governanceFinanceService: GovernanceFinanceService,
    private readonly governanceOverviewService: GovernanceOverviewService,
  ) {}

  @Get('overview')
  @ApiOperation({ summary: 'Get the non-financial governance page structure' })
  @ApiOkResponse({ description: 'The governance overview snapshot.' })
  @ApiNotFoundResponse({ description: 'No governance overview is configured.' })
  getOverview() {
    return this.governanceOverviewService.getOverview();
  }

  @Get('finances')
  @ApiOperation({ summary: 'Get the quarterly financial-transparency snapshot' })
  @ApiOkResponse({ description: 'The finance report for the quarter.' })
  @ApiNotFoundResponse({
    description: 'No finance report exists for the requested quarter.',
  })
  getFinances(@Query() query: GetGovernanceFinancesQuery) {
    return this.governanceFinanceService.getFinances(query.quarter);
  }

  // Admin-only: the governance Finances tab (`/admin/governance`). Layered on
  // top of the class-level `ActiveMemberGuard` with a method-level
  // `RolesGuard`, mirroring `ModerationController`'s pattern.
  @Get('admin/finances')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  @ApiOperation({
    summary: 'Get the admin Finances tab data (latest quarter + history)',
  })
  @ApiOkResponse({
    description: 'Latest quarter metrics plus the historical series.',
  })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  getAdminFinances() {
    return this.governanceFinanceService.getAdminFinances();
  }
}
