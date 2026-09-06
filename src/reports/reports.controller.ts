import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Ip,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UserStatus } from '../users/entities/user.entity';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { Throttle, seconds } from '@nestjs/throttler';
import { ReportFilingThrottlerGuard } from './report-filing-throttler.guard';
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

// Always-on safety infrastructure (no `@Feature` gate, like `blocks`/`mutes`).
// Frontend contract: `queerpulse/src/features/safety/api/reports.api.ts`.
//
// `ActiveMemberGuard` stays bound at the CLASS level so no handler can silently
// miss it, and the two routes that are genuinely public carry `@Public()`,
// which that guard steps aside for (see `ActiveMemberGuard`). Auth per route:
//
//  - `POST /reports`         PUBLIC (PRD-280). Anyone can file, signed in or
//                            not. `OptionalJwtAuthGuard` attaches `req.user`
//                            when a session cookie is present so a member's
//                            report is still attributed to them.
//  - `GET /reports/reasons`  PUBLIC. The taxonomy the form renders from. It
//                            has to be readable by whoever the form is open
//                            to, or a signed-out visitor reaches a report
//                            page with no reasons to choose from. It carries
//                            nothing about anybody: a static code-to-label map
//                            already mirrored in the frontend's own
//                            `reportReasons.ts` for demo mode, so making it
//                            public discloses nothing that is not already
//                            shipped in the client bundle.
//  - `GET /reports/mine`     GATED, and it stays that way. It is one member's
//                            own filing history, which is the reporter's
//                            identity joined to who they reported, and there
//                            is no anonymous equivalent to open it to: a
//                            signed-out reporter has no account to scope it
//                            by, and scoping it by anything a signed-out
//                            caller carries would hand whoever holds an
//                            address a window onto whatever was filed from it.
//
// A public POST is still a CSRF-guarded POST. `CsrfGuard` is global and knows
// nothing about auth state, so a signed-out filing sends `X-CSRF-Token` with
// the matching cookie exactly as a signed-in one does. `POST /intakes/:kind`
// has worked this way for signed-out visitors all along.
@ApiTags('Reports')
@ApiCookieAuth('access_token')
@Controller('reports')
@UseGuards(ActiveMemberGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  // Tight cap on report filing (mirrors `VouchController`): nobody has a
  // legitimate reason to file more than a handful of reports a minute, and this
  // blunts spam/abuse-report floods.
  //
  // This is only the BURST layer. It keys on client IP and keeps its counters
  // in process memory, so it says nothing about sustained behaviour: ten a
  // minute is 14,400 a day. The durable rolling caps that close report
  // flooding as a harassment vector (TS-05) live in `report-flood-limits.ts`
  // and are enforced in `ReportsService.create`. Both layers answer with 429,
  // so a client needs no new branch to tell them apart.
  //
  // The 10 declared here is the SIGNED-IN number and it is unchanged.
  // `ReportFilingThrottlerGuard` reads it off this decorator and tightens it
  // for a signed-out caller, who has neither of the durable member layers
  // behind them; that guard carries the argument and the second bucket that
  // keeps the two from spending each other's allowance.
  @ApiOperation({ summary: 'File a report against a subject' })
  @ApiCreatedResponse({
    description:
      'The created report (or the caller’s existing open report on the same subject).',
  })
  @ApiForbiddenResponse({
    description:
      'A signed-in caller who is not an active member, or a missing/mismatched CSRF token.',
  })
  @ApiTooManyRequestsResponse({
    description:
      'Too many reports. TWO different refusals share this status, and the body is what tells them apart. ' +
      'A rolling flood cap (see `report-flood-limits.ts`) answers with ' +
      '`{ statusCode: 429, error: "Too Many Requests", code: "REPORT_FLOOD_CAP", cap: "daily" | "subject", message: string }`, ' +
      'where `message` is member-facing copy a client should surface verbatim and `cap` is additive detail that is safe to ignore. ' +
      'The `@nestjs/throttler` burst refusal carries NO `code`, and its `message` is a framework exception string that must never be shown to a member. ' +
      'Branch on the presence of `code === "REPORT_FLOOD_CAP"`, never on message text.',
  })
  @Public()
  @UseGuards(OptionalJwtAuthGuard, ReportFilingThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post()
  create(
    // Populated best-effort by `OptionalJwtAuthGuard`; undefined when the
    // caller is signed out, which this route now serves.
    @CurrentUser() user: CurrentUserData | undefined,
    @Body() dto: CreateReportDto,
    // The raw client address, resolved through `trust proxy` (`main.ts`). Used
    // for ONE thing and never stored: deriving the durable flood-cap key for a
    // signed-out filing. `ReportsService.create` ignores it entirely when
    // there is a member behind the report.
    @Ip() clientIp: string,
  ) {
    // `@Public()` makes the class-level `ActiveMemberGuard` step aside, which
    // is what lets a signed-out visitor through. It also means a SIGNED-IN
    // caller who is not an active member would now reach here, where before
    // they got a 403, so the check is re-stated for exactly that caller and
    // nothing else. A suspended or pending account must not be able to file
    // under its own id and spend the per-member allowances that come with one.
    // Signing out and filing anonymously stays open to them, under the tighter
    // anonymous caps, which is the right shape: the report still lands.
    // `CurrentUserData.status` is typed `string` on the JWT principal; the
    // assertion says what it actually holds, which is what
    // `ActiveMemberGuard` compares against.
    if (user && (user.status as UserStatus) !== UserStatus.Active) {
      throw new ForbiddenException('Active membership required');
    }
    return this.reportsService.create(user?.userId ?? null, dto, clientIp);
  }

  // PUBLIC, and it has to be. `POST /reports` is open to a signed-out person,
  // and the form they file from renders its reason list out of this call, so
  // gating it would leave a visitor on the report page with an empty select
  // and a submit button that cannot produce a valid `reasonCode`. Making the
  // taxonomy public gives away nothing: it is a static code-to-label map with
  // no member data in it, the frontend already ships its own copy as the
  // demo-mode fallback (`safety/reportReasons.ts`), and the codes are on the
  // wire of every filing anyway.
  //
  // No `@Throttle` of its own. It reads no database at all — `reasonsFor` is a
  // lookup in a module-scope object — so the global 120/60s per-IP default is
  // the right ceiling for it and a tighter one would only risk emptying a
  // form somebody is trying to fill in.
  @Public()
  @ApiOperation({ summary: 'List the report reasons for a subject type' })
  @ApiOkResponse({
    description: 'The reason taxonomy for the given subject type.',
  })
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
