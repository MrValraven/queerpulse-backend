import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminReportsService } from './admin-reports.service';
import { ReportsRangeQuery } from './dto/reports-range.query';

/**
 * The consolidated `/admin/reports` page (ADM-17 real adjustable date
 * ranges, ADM-19 CSV export): member growth, reports-by-type, governance
 * finance history, and a current community-health snapshot — all read-only.
 * Moderator/admin tier, mirroring `ModerationController`'s guard stack
 * (this is oversight reporting at the same tier as the moderation console),
 * not `AdminOverviewController`'s admin-only gate.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@ApiTags('Admin — Reports')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller('admin/reports')
export class AdminReportsController {
  constructor(private readonly adminReports: AdminReportsService) {}

  @Get('growth')
  @ApiOperation({ summary: 'Member growth over an adjustable weekly range.' })
  @ApiOkResponse({ description: 'Weekly join-cohort points, oldest first.' })
  getGrowth(@Query() query: ReportsRangeQuery) {
    return this.adminReports.getGrowth(query.weeks);
  }

  // Distinct literal path from `growth` above — no routing-order concern
  // (mirrors `ModerationController`'s `audit` / `audit.csv` split).
  @Get('growth.csv')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="member-growth.csv"')
  @ApiOperation({ summary: 'Download member growth as CSV.' })
  @ApiOkResponse({ description: 'Weekly join-cohort points as CSV.' })
  getGrowthCsv(@Query() query: ReportsRangeQuery) {
    return this.adminReports.getGrowthCsv(query.weeks);
  }

  @Get('reports-by-type')
  @ApiOperation({
    summary: 'Reports filed by type over an adjustable weekly range.',
  })
  @ApiOkResponse({ description: 'Weekly reason-code buckets, oldest first.' })
  getReportsByType(@Query() query: ReportsRangeQuery) {
    return this.adminReports.getReportsByType(query.weeks);
  }

  @Get('reports-by-type.csv')
  @Header('Content-Type', 'text/csv')
  @Header(
    'Content-Disposition',
    'attachment; filename="reports-by-type.csv"',
  )
  @ApiOperation({ summary: 'Download reports-by-type as CSV.' })
  @ApiOkResponse({ description: 'Weekly reason-code buckets as CSV.' })
  getReportsByTypeCsv(@Query() query: ReportsRangeQuery) {
    return this.adminReports.getReportsByTypeCsv(query.weeks);
  }

  @Get('finance')
  @ApiOperation({
    summary: 'Governance finance: the latest quarter plus full history.',
  })
  @ApiOkResponse({
    description: 'The latest published quarter plus quarterly history.',
  })
  getFinance() {
    return this.adminReports.getFinance();
  }

  @Get('community-health')
  @ApiOperation({
    summary: 'Platform-wide community health, current snapshot.',
  })
  @ApiOkResponse({
    description:
      'Average health score, needing-support count, and the per-community breakdown, as of now.',
  })
  getCommunityHealth() {
    return this.adminReports.getCommunityHealth();
  }
}
