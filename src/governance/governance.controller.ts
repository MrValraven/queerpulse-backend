import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { Feature } from '../common/feature.decorator';
import { GetGovernanceFinancesQuery } from './dto/get-governance-finances.query';
import { ListFinanceChangesQuery } from './dto/list-finance-changes.query';
import { ListOverviewChangesQuery } from './dto/list-overview-changes.query';
import { UpdateAdminFinancesDto } from './dto/update-admin-finances.dto';
import { UpdateAdminOverviewDto } from './dto/update-admin-overview.dto';
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
const DEFAULT_FINANCE_CHANGES_LIMIT = 50;
const DEFAULT_OVERVIEW_CHANGES_LIMIT = 50;

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
  @ApiOperation({
    summary: 'Get the quarterly financial-transparency snapshot',
  })
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

  // Admin-only (NOT moderators, unlike the GET above): correcting the published
  // finance figures is a higher-blast-radius action, mirroring the
  // admin-only-write stance of `PlatformSettingsController`. State-changing, so
  // it carries a CSRF token behind the global guard chain.
  @Patch('admin/finances')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: 'Correct editable figures on the latest report' })
  @ApiOkResponse({
    description: 'The updated Finances tab payload (latest + history).',
  })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  @ApiNotFoundResponse({ description: 'No finance report exists to edit.' })
  updateAdminFinances(
    @Body() dto: UpdateAdminFinancesDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.governanceFinanceService.updateAdminFinances(dto, user.userId);
  }

  // Admin-only: the per-field audit trail behind the "last edited" badges.
  @Get('admin/finances/changes')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: 'List the finance figure change history' })
  @ApiOkResponse({ description: 'The audit history, newest first.' })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  listFinanceChanges(@Query() query: ListFinanceChangesQuery) {
    return this.governanceFinanceService.listChanges(
      query.limit ?? DEFAULT_FINANCE_CHANGES_LIMIT,
      query.offset ?? 0,
    );
  }

  // Admin-only: publish the current governance snapshot (P3-7). Layered on the
  // class-level `ActiveMemberGuard` with a method-level `RolesGuard`, mirroring
  // `getAdminFinances` above. Stamps `governance_overview.published_at = now()`
  // so the public overview can show a "last published" line. State-changing, so
  // it carries a CSRF token like every other POST behind the global guard chain.
  @Post('admin/publish')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  @ApiOperation({ summary: 'Publish the current governance overview snapshot' })
  @ApiOkResponse({
    description: 'The timestamp the snapshot was published at.',
  })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  @ApiNotFoundResponse({ description: 'No governance overview is configured.' })
  publish() {
    return this.governanceOverviewService.publish();
  }

  // Admin-only: the admin Policy tab (`/admin/governance`). Mirrors
  // `getAdminFinances`'s guard stack — moderators can view, only admins can
  // write (see `updateOverview` below).
  @Get('admin/overview')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin, UserRole.Moderator)
  @ApiOperation({
    summary: 'Get the admin Policy tab data (overview + per-section audit meta)',
  })
  @ApiOkResponse({
    description: 'The overview sections plus per-section last-edited info.',
  })
  @ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
  @ApiNotFoundResponse({ description: 'No governance overview is configured.' })
  getAdminOverview() {
    return this.governanceOverviewService.getAdminOverview();
  }

  // Admin-only (NOT moderators): replacing overview sections is a
  // higher-blast-radius action, mirroring `updateAdminFinances`'s
  // admin-only-write stance. State-changing, so it carries a CSRF token
  // behind the global guard chain.
  @Patch('admin/overview')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: 'Replace any subset of the overview sections' })
  @ApiOkResponse({
    description: 'The updated Policy tab payload (overview + audit meta).',
  })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  @ApiNotFoundResponse({ description: 'No governance overview is configured.' })
  updateAdminOverview(
    @Body() dto: UpdateAdminOverviewDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.governanceOverviewService.updateOverview(dto, user.userId);
  }

  // Admin-only: the per-section audit trail behind the "last edited" badges.
  @Get('admin/overview/changes')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: 'List the overview section change history' })
  @ApiOkResponse({ description: 'The audit history, newest first.' })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  listOverviewChanges(@Query() query: ListOverviewChangesQuery) {
    return this.governanceOverviewService.listChanges(
      query.limit ?? DEFAULT_OVERVIEW_CHANGES_LIMIT,
      query.offset ?? 0,
    );
  }
}
