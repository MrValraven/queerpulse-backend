import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AuditFeedQuery } from './dto/audit-feed.query';
import { AuditLogQuery } from './dto/audit-log.query';
import { LiftSuspensionDto } from './dto/lift-suspension.dto';
import { ListModReportsQuery } from './dto/list-mod-reports.query';
import { ModActionDto } from './dto/mod-action.dto';
import { ModBulkActionDto } from './dto/mod-bulk-action.dto';
import { ReviewAppealDto } from './dto/review-appeal.dto';
import { ModerationService } from './moderation.service';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

// Moderator/admin only. Frontend contract:
// `queerpulse/src/features/admin/api/moderation.api.ts`.
@ApiTags('Admin — Moderation')
@ApiCookieAuth()
@Controller('mod')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class ModerationController {
  constructor(private readonly moderationService: ModerationService) {}

  @Get('reports')
  @ApiOperation({ summary: 'List the moderation report queue' })
  @ApiOkResponse({ description: 'The filtered, paginated report queue.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  listReports(@Query() query: ListModReportsQuery) {
    return this.moderationService.list(query);
  }

  // Static path registered before `:id` so `/mod/reports/audit` never gets
  // swallowed by the `:id` param route (mirrors the usual Nest routing
  // pitfall guard other controllers avoid the same way).
  @Get('reports/audit')
  @ApiOperation({ summary: 'Get the audit trail for a single report' })
  @ApiOkResponse({ description: "One report's immutable audit trail." })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  audit(@Query() query: AuditLogQuery) {
    return this.moderationService.auditTrail(query.reportId);
  }

  @Get('reports/:id')
  @ApiOperation({ summary: 'Get a single report with its detail block' })
  @ApiOkResponse({ description: 'The report, including the drawer detail.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  @ApiNotFoundResponse({ description: 'The report does not exist.' })
  getReport(@Param('id', ParseUUIDPipe) id: string) {
    return this.moderationService.getById(id);
  }

  // Global, cross-report moderation audit feed for the admin governance
  // "Audit" tab — a distinct static path from `reports/audit` above (that one
  // is scoped to a single report via `?reportId=`), so there is no routing
  // conflict between the two.
  @Get('audit')
  @ApiOperation({ summary: 'Get the global cross-report moderation audit feed' })
  @ApiOkResponse({ description: 'The platform-wide moderation audit feed.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  auditFeed(@Query() query: AuditFeedQuery) {
    return this.moderationService.auditFeed(query);
  }

  // PATCH (not POST): this updates existing report resources. API CONTRACT
  // CHANGE — the frontend must call PATCH /mod/reports/bulk (was POST).
  //
  // This literal route MUST be declared before `reports/:id` below: both are
  // now @Patch, so with `:id` first a PATCH to `/mod/reports/bulk` would match
  // `reports/:id` with id="bulk" and fail the ParseUUIDPipe.
  @Patch('reports/bulk')
  @ApiOperation({ summary: 'Apply one moderation action to many reports' })
  @ApiOkResponse({ description: 'The ids of the reports that were updated.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  bulkUpdateReports(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ModBulkActionDto,
  ) {
    return this.moderationService.bulkActOnReports(user.userId, dto);
  }

  @Patch('reports/:id')
  @ApiOperation({ summary: 'Apply a moderation action to one report' })
  @ApiOkResponse({ description: 'The updated report.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  @ApiNotFoundResponse({ description: 'The report does not exist.' })
  updateReport(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModActionDto,
  ) {
    return this.moderationService.actOnReport(id, user.userId, dto);
  }

  // Lift a suspension or ban. Without this a `ban` would be irreversible
  // through the API: it never expires, and the only other route back — an
  // appeal overturn — is unreachable while nothing creates appeals.
  //
  // Note this sits under the class-level `@Roles(Moderator, Admin)`, so a
  // moderator can undo another moderator's ban. That is deliberate: the
  // alternative (admin-only) leaves a mistaken ban standing for however long
  // an admin takes to appear.
  @Patch('users/:userId/suspension')
  @ApiOperation({ summary: "Lift a member's suspension or ban" })
  @ApiOkResponse({ description: "The member's id and resulting status." })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  @ApiNotFoundResponse({ description: 'The user does not exist.' })
  liftSuspension(
    @CurrentUser() user: CurrentUserData,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: LiftSuspensionDto,
  ) {
    return this.moderationService.liftSuspension(userId, user.userId, dto);
  }

  @Get('appeals')
  @ApiOperation({ summary: 'List appeals awaiting review' })
  @ApiOkResponse({ description: 'The appeals queue, newest first.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  listAppeals() {
    return this.moderationService.listAppeals();
  }

  @Patch('appeals/:id')
  @ApiOperation({ summary: 'Uphold or overturn an appeal' })
  @ApiOkResponse({ description: 'The decided appeal.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  @ApiNotFoundResponse({ description: 'The appeal does not exist.' })
  @ApiConflictResponse({ description: 'The appeal has already been decided.' })
  reviewAppeal(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewAppealDto,
  ) {
    return this.moderationService.reviewAppeal(id, user.userId, dto);
  }
}
