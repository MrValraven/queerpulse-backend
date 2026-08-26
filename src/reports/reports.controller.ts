import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Throttle, seconds } from '@nestjs/throttler';
import { CreateReportDto } from './dto/create-report.dto';
import { ListReasonsQuery } from './dto/list-reasons.query';
import { formatReportReference } from './report-reference';
import { ReportsService } from './reports.service';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

// Always-on safety infrastructure (no `@Feature` gate, like `blocks`/`mutes`)
// — any active member can file a report or read the reason taxonomy.
// Frontend contract: `queerpulse/src/features/safety/api/reports.api.ts`.
@ApiTags('Reports')
@ApiCookieAuth('access_token')
@Controller('reports')
@UseGuards(ActiveMemberGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  // Tight per-user cap on report filing (mirrors `VouchController`): a member
  // has no legitimate reason to file more than a handful of reports a minute,
  // and this blunts spam/abuse-report floods.
  //
  // This is only the BURST layer. It keys on client IP and keeps its counters
  // in process memory, so it says nothing about sustained behaviour: ten a
  // minute is 14,400 a day. The durable rolling caps that close report
  // flooding as a harassment vector (TS-05) live in `report-flood-limits.ts`
  // and are enforced in `ReportsService.create`. Both layers answer with 429,
  // so a client needs no new branch to tell them apart.
  @ApiOperation({ summary: 'File a report against a subject' })
  @ApiCreatedResponse({
    description:
      'The created report (or the caller’s existing open report on the same subject).',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @ApiTooManyRequestsResponse({
    description:
      'Too many reports. TWO different refusals share this status, and the body is what tells them apart. ' +
      'A rolling flood cap (see `report-flood-limits.ts`) answers with ' +
      '`{ statusCode: 429, error: "Too Many Requests", code: "REPORT_FLOOD_CAP", cap: "daily" | "subject", message: string }`, ' +
      'where `message` is member-facing copy a client should surface verbatim and `cap` is additive detail that is safe to ignore. ' +
      'The `@nestjs/throttler` burst refusal carries NO `code`, and its `message` is a framework exception string that must never be shown to a member. ' +
      'Branch on the presence of `code === "REPORT_FLOOD_CAP"`, never on message text.',
  })
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post()
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateReportDto) {
    return this.reportsService.create(user.userId, dto);
  }

  @ApiOperation({ summary: 'List the report reasons for a subject type' })
  @ApiOkResponse({
    description: 'The reason taxonomy for the given subject type.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @Get('reasons')
  reasons(@Query() query: ListReasonsQuery) {
    return this.reportsService.reasonsFor(query.subjectType);
  }

  // Static path segment (`mine`), not a `:id`-shaped param route — there is no
  // existing `Get(':id')` on this controller to be swallowed by/ordered
  // against, but this stays ahead of any future one on general principle.
  @ApiOperation({ summary: "List the current member's own filed reports" })
  @ApiOkResponse({
    description:
      'The caller’s own filed reports, newest first, with a human-friendly reference code.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @Get('mine')
  async listMine(@CurrentUser() user: CurrentUserData) {
    const reports = await this.reportsService.listMine(user.userId);
    return reports.map((report) => ({
      id: report.id,
      reference: formatReportReference(report),
      subjectType: report.subjectType,
      reasonCode: report.reasonCode,
      status: report.status,
      createdAt: report.createdAt.toISOString(),
      // When the report was closed, or `null` while it is still open. The
      // companion to the `report_resolved` notification: a reporter who missed
      // or cleared the bell can still see for themselves that their report was
      // dealt with, which is the whole point of closing this loop.
      //
      // Deliberately the TIMESTAMP only. `resolutionAction`, `resolutionNote`,
      // `resolutionDuration` and `resolutionActorId` all sit on the same row and
      // none of them belong here: they are the moderator's reasoning, their
      // identity, and a consequence report about another member. See
      // `ModerationService.notifyReporterOfOutcomeBestEffort` for the same
      // boundary drawn on the notification side.
      resolvedAt: report.resolvedAt ? report.resolvedAt.toISOString() : null,
    }));
  }
}
