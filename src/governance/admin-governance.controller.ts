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
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { Feature } from '../common/feature.decorator';
import { ListFinanceChangesQuery } from './dto/list-finance-changes.query';
import { ListOverviewChangesQuery } from './dto/list-overview-changes.query';
import { UpdateAdminFinancesDto } from './dto/update-admin-finances.dto';
import { UpdateAdminOverviewDto } from './dto/update-admin-overview.dto';
import { GovernanceFinanceService } from './governance-finance.service';
import { GovernanceOverviewService } from './governance-overview.service';

const DEFAULT_FINANCE_CHANGES_LIMIT = 50;
const DEFAULT_OVERVIEW_CHANGES_LIMIT = 50;

/**
 * Staff surface behind `/admin/governance` (the Finances and Policy tabs).
 *
 * These handlers used to live on `GovernanceController` under a `admin/*`
 * path prefix, each repeating its own method-level `@UseGuards(RolesGuard)`
 * on top of a member-facing class — one forgotten decorator would have
 * exposed an admin route to every active member (BE-COM-14). They now sit on
 * a dedicated `Admin*Controller` with class-level default-deny
 * (`ActiveMemberGuard` + `RolesGuard` + `@Roles`), matching every other admin
 * surface in the repo (`AdminForumController`,
 * `AdminReadingGroupProposalsController`).
 *
 * The class default is Moderator-or-Admin (read access). The two writes
 * narrow to Admin with a method-level `@Roles`, which `RolesGuard` honours via
 * `Reflector.getAllAndOverride` — a *narrowing* override, so a missing one
 * fails closed at Moderator rather than opening the route up.
 *
 * The member-facing reads (`GET /governance/overview`, `/governance/finances`)
 * and the proposal/vote routes stay on `GovernanceController`.
 */
@Feature('governance')
@ApiTags('Admin — Governance')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires moderator or admin role.' })
@Controller('admin/governance')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin, UserRole.Moderator)
export class AdminGovernanceController {
  constructor(
    private readonly governanceFinanceService: GovernanceFinanceService,
    private readonly governanceOverviewService: GovernanceOverviewService,
  ) {}

  @Get('finances')
  @ApiOperation({
    summary: 'Get the admin Finances tab data (latest quarter + history)',
  })
  @ApiOkResponse({
    description: 'Latest quarter metrics plus the historical series.',
  })
  getAdminFinances() {
    return this.governanceFinanceService.getAdminFinances();
  }

  // Admin-only (NOT moderators, unlike the GET above): correcting the
  // published finance figures is a higher-blast-radius action, mirroring the
  // admin-only-write stance of `PlatformSettingsController`. State-changing,
  // so it carries a CSRF token behind the global guard chain.
  @Patch('finances')
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
  @Get('finances/changes')
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

  // Stamps `governance_overview.published_at = now()` so the public overview
  // can show a "last published" line. State-changing, so it carries a CSRF
  // token like every other POST behind the global guard chain.
  @Post('publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish the current governance overview snapshot' })
  @ApiOkResponse({
    description: 'The timestamp the snapshot was published at.',
  })
  @ApiNotFoundResponse({ description: 'No governance overview is configured.' })
  publish() {
    return this.governanceOverviewService.publish();
  }

  @Get('overview')
  @ApiOperation({
    summary:
      'Get the admin Policy tab data (overview + per-section audit meta)',
  })
  @ApiOkResponse({
    description: 'The overview sections plus per-section last-edited info.',
  })
  @ApiNotFoundResponse({ description: 'No governance overview is configured.' })
  getAdminOverview() {
    return this.governanceOverviewService.getAdminOverview();
  }

  // Admin-only (NOT moderators): replacing overview sections is a
  // higher-blast-radius action, mirroring `updateAdminFinances` above.
  @Patch('overview')
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
  @Get('overview/changes')
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
