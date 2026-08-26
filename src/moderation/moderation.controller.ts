import {
  Body,
  Controller,
  Get,
  Header,
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
import { ListAppealsQuery } from './dto/list-appeals.query';
import { ListModReportsQuery } from './dto/list-mod-reports.query';
import { ModActionDto } from './dto/mod-action.dto';
import { ModBulkActionDto } from './dto/mod-bulk-action.dto';
import { ListRatificationsQuery, RatifyBanDto } from './dto/ratify-ban.dto';
import { ReportAssignmentDto } from './dto/report-assignment.dto';
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

// Moderator/admin only, EXCEPT `PATCH reports/:id` below, which also admits a
// community owner/mod dismissing a report scoped to their own community (see
// that route's own doc comment). Frontend contract:
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
  listReports(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListModReportsQuery,
  ) {
    return this.moderationService.list(query, user.userId);
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
  @ApiOperation({
    summary: 'Get the global cross-report moderation audit feed',
  })
  @ApiOkResponse({ description: 'The platform-wide moderation audit feed.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  auditFeed(@Query() query: AuditFeedQuery) {
    return this.moderationService.auditFeed(query);
  }

  // Download the filtered audit feed as CSV (P3-8) for the governance "Audit"
  // tab's export. `audit.csv` is a distinct literal segment from `audit`
  // above and from `reports/audit` — no route-order concern (mirrors the
  // roadmap controller's `admin/audit` / `admin/audit.csv` split). Honours the
  // same moderator/action/range/q filters; `page`/`pageSize` are ignored (an
  // export dumps every matching row up to the service's hard cap).
  @Get('audit.csv')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="governance-audit.csv"')
  @ApiOperation({ summary: 'Download the moderation audit feed as CSV' })
  @ApiOkResponse({
    description: 'The filtered audit feed as CSV, newest first.',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  auditFeedCsv(@Query() query: AuditFeedQuery) {
    return this.moderationService.auditFeedCsv(query);
  }

  // PATCH (not POST): this updates existing report resources. API CONTRACT
  // CHANGE — the frontend must call PATCH /mod/reports/bulk (was POST).
  //
  // This literal route MUST be declared before `reports/:id` below: both are
  // now @Patch, so with `:id` first a PATCH to `/mod/reports/bulk` would match
  // `reports/:id` with id="bulk" and fail the ParseUUIDPipe.
  //
  // TS-12: a bulk `ban` opens one ratification hold per MEMBER (not per
  // report), and removes nobody until a second moderator confirms each one.
  // That is the exact hole this closes: 100 reports used to be 100 permanent
  // bans in one call, by one person.
  @Patch('reports/bulk')
  @ApiOperation({ summary: 'Apply one moderation action to many reports' })
  @ApiOkResponse({
    description:
      'The ids of the reports that were updated, plus any that failed with a reason (continue-on-error — one bad report no longer fails the whole batch).',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  bulkUpdateReports(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ModBulkActionDto,
  ) {
    return this.moderationService.bulkActOnReports(user.userId, dto);
  }

  // Class-level `@Roles(Moderator, Admin)` is overridden with an empty
  // `@Roles()` here so `RolesGuard` steps aside for ANY active member (the
  // class-level `ActiveMemberGuard` still applies) — the real authorization
  // now lives in `ModerationService.assertCanActOnReport`: platform
  // Moderator/Admin (unchanged) OR a community owner/mod `dismiss`-ing a
  // report scoped to a post/reply in the community they moderate. Every
  // other action on this route still requires the platform role. This does
  // NOT loosen `GET /mod/reports*` or `PATCH /mod/reports/bulk` above —
  // those keep the class-level guard, so a community mod still cannot see or
  // bulk-act on the platform-wide queue.
  //
  // TS-12: a `ban` on this route no longer removes the account. It takes the
  // content action immediately, suspends the member for the length of a
  // ratification hold, and waits for a second, different moderator to confirm
  // it on `PATCH /mod/ratifications/:id`. If nobody does, the hold lapses and
  // the suspension lapses with it.
  @Patch('reports/:id')
  @Roles()
  @ApiOperation({ summary: 'Apply a moderation action to one report' })
  @ApiOkResponse({ description: 'The updated report.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description:
      'Requires a moderator or admin role, except `dismiss`, `remove_content` ' +
      'and `escalate`, which a community owner/mod may also apply to a report ' +
      "on their own community's post or reply. An emergency-severity report " +
      '(outing/doxxing) accepts only `escalate` from them.',
  })
  @ApiConflictResponse({
    description:
      'The report is already resolved (a terminal state), or another ' +
      'moderator actioned it first.',
  })
  @ApiNotFoundResponse({ description: 'The report does not exist.' })
  updateReport(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModActionDto,
  ) {
    return this.moderationService.actOnReport(id, user.userId, user.role, dto);
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

  // Self-assign/unassign a report (COM-5) — a moderator claiming a report
  // (or releasing it) so the queue's "Assigned to me" filter has a real
  // column to filter by. Platform Moderator/Admin only, unlike
  // `PATCH reports/:id` above — claiming a report is a workflow action, not a
  // decision, so it stays under the class-level role guard rather than the
  // community-mod carve-out.
  @Patch('reports/:id/assignment')
  @ApiOperation({ summary: 'Self-assign or unassign a report' })
  @ApiOkResponse({ description: 'The updated report.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  @ApiNotFoundResponse({ description: 'The report does not exist.' })
  @ApiConflictResponse({
    description: 'The report is already assigned to another moderator.',
  })
  setAssignment(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportAssignmentDto,
  ) {
    return this.moderationService.setAssignment(
      id,
      user.userId,
      user.role,
      dto.assign,
    );
  }

  // TS-12. The permanent bans one moderator has asked for and no second
  // moderator has confirmed yet. Declared before `ratifications/:id` so there
  // is no route-order concern, and kept under the class-level
  // `@Roles(Moderator, Admin)` guard: a hold names a member and carries the
  // requesting moderator's internal reason, so it is staff-only in the same way
  // the report queue is. A community owner/mod has no carve-out here, because
  // a platform ban is never theirs to confirm.
  @Get('ratifications')
  @ApiOperation({
    summary: 'List permanent bans waiting on a second moderator',
  })
  @ApiOkResponse({
    description:
      'The holds, soonest to lapse first, each carrying the requesting moderator and their reason.',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  listRatifications(@Query() query: ListRatificationsQuery) {
    return this.moderationService.listRatifications(query.status);
  }

  /**
   * PATCH /mod/ratifications/:id — the second signature Article VIII promises,
   * or the refusal.
   *
   * The moderator who ASKED for the ban cannot decide it, and neither can an
   * admin who asked: the guard compares against `requested_by`, with no role
   * carve-out. See `BanRatificationService` for why an admin exemption would
   * put the hole exactly where the risk is.
   */
  @Patch('ratifications/:id')
  @ApiOperation({ summary: "Confirm or refuse another moderator's ban" })
  @ApiOkResponse({ description: 'The decided hold.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description:
      'Requires a moderator or admin role, and you may not confirm a ban you asked for yourself.',
  })
  @ApiNotFoundResponse({ description: 'No such hold.' })
  @ApiConflictResponse({
    description: 'The hold has already been decided, or it has lapsed.',
  })
  decideRatification(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RatifyBanDto,
  ) {
    return this.moderationService.decideRatification(
      id,
      user.userId,
      user.role,
      dto,
    );
  }

  /**
   * GET /mod/appeals — the appeals queue, split into `awaiting` and `decided`
   * tabs (TS-11).
   *
   * The awaiting tab is ordered by §05's 7-day decision deadline, soonest
   * first, so the appeal the platform is closest to being late on is the one at
   * the top. It used to be one unpaginated list of everything, newest first,
   * with decided appeals mixed in — which put the most urgent appeal at the
   * BOTTOM.
   */
  @Get('appeals')
  @ApiOperation({ summary: 'List appeals, awaiting or decided' })
  @ApiOkResponse({
    description:
      'A page of appeals: awaiting ones soonest-due first, decided ones newest first, with the awaiting/decided/overdue totals alongside.',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
  listAppeals(@Query() query: ListAppealsQuery) {
    return this.moderationService.listAppeals(query);
  }

  @Patch('appeals/:id')
  @ApiOperation({ summary: 'Uphold or overturn an appeal' })
  @ApiOkResponse({ description: 'The decided appeal.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description:
      'Requires a moderator or admin role — or the caller made the ' +
      'original decision being appealed (conflict-of-interest guard, COM-10).',
  })
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
