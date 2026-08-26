import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
import { Feature } from '../common/feature.decorator';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { UserRole } from '../users/entities/user.entity';
import {
  AdminVolunteerHoursCommunityRowDTO,
  AdminVolunteerHoursDTO,
} from './admin-volunteering-response';
import { VolunteerHoursQueryDto } from './dto/volunteer-hours.query';
import {
  HOURS_BREAKDOWN_LIMIT,
  VolunteeringService,
} from './volunteering.service';

/** The widest explicitly-bounded window the report will scan: five years.
 *  Both dates omitted still means all time (the funder answer with no
 *  qualifier); this only stops a mistyped year asking for a window nobody
 *  meant. */
const MAX_HOURS_WINDOW_DAYS = 1830;

const DAY_MS = 86_400_000;

/**
 * Admin oversight of volunteering (SUS-05's last piece).
 *
 * The backlog's motivation, verbatim: when a partner asks how many volunteer
 * hours QueerPulse contributed, there was no answer and no evidence a funder
 * could be shown. The completion record and the aggregate query landed with
 * the backend; this is the route that lets staff read them.
 *
 * Its own `Admin*Controller` rather than a route bolted onto
 * `VolunteeringController`: that one is `ActiveMemberGuard` only, because
 * every route on it belongs to the member who posted an opportunity or applied
 * to one. Nothing here is scoped to the caller.
 *
 * GATE. Plain `@Roles(Moderator, Admin)` with `RolesGuard`, no
 * `RolesOrStaffGuard` union: no entry in `staff-roles.registry.ts` covers
 * volunteering, and inventing a grant for one read-only report would be a
 * bigger decision than this endpoint. Moderators are included because this is
 * an operational count with nothing private in it.
 *
 * PRIVACY. Aggregates only. There is no per-member row here, no ranking and no
 * timeline, and the service has no query that could produce one. "How much did
 * this member volunteer" is readable by that member about themselves
 * (`GET /volunteering/me/contribution`) and nowhere else.
 */
@Feature('volunteering')
@ApiTags('Admin — Volunteering')
@ApiCookieAuth('access_token')
@Controller('admin/volunteering')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the moderator or admin role.' })
export class AdminVolunteeringController {
  constructor(
    private readonly volunteeringService: VolunteeringService,
    private readonly communityMembership: CommunityMembershipService,
  ) {}

  @Get('hours')
  @ApiOperation({
    summary: 'Confirmed volunteer sessions, hours and volunteer count',
  })
  @ApiOkResponse({
    description:
      'Platform totals over the window, plus per-opportunity and per-community breakdowns.',
  })
  @ApiBadRequestResponse({
    description: 'The window starts after it ends, or is longer than 5 years.',
  })
  async hours(
    @Query() query: VolunteerHoursQueryDto,
  ): Promise<AdminVolunteerHoursDTO> {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    assertWindow(from, to);

    const totals = await this.volunteeringService.volunteerHoursTotals({
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(query.communityId ? { communityId: query.communityId } : {}),
    });

    // One batched lookup for every community in the breakdown, rather than a
    // query per row (`refsByIds` exists for exactly this).
    const refs = await this.communityMembership.refsByIds(
      totals.byCommunity.map((row) => row.communityId),
    );

    const byCommunity: AdminVolunteerHoursCommunityRowDTO[] =
      totals.byCommunity.map((row) => {
        const ref = refs.get(row.communityId);
        return {
          communityId: row.communityId,
          communitySlug: ref?.slug ?? null,
          communityName: ref?.name ?? null,
          sessionCount: row.sessionCount,
          hoursContributed: row.hoursContributed,
        };
      });

    return {
      from: totals.from,
      to: totals.to,
      sessionCount: totals.sessionCount,
      hoursContributed: totals.hoursContributed,
      volunteerCount: totals.volunteerCount,
      byOpportunity: totals.byOpportunity.map((row) => ({
        opportunitySlug: row.opportunitySlug,
        role: row.role,
        org: row.org,
        sessionCount: row.sessionCount,
        hoursContributed: row.hoursContributed,
      })),
      byCommunity,
      breakdownLimit: HOURS_BREAKDOWN_LIMIT,
      isOpportunityBreakdownCapped:
        totals.byOpportunity.length >= HOURS_BREAKDOWN_LIMIT,
      isCommunityBreakdownCapped: byCommunity.length >= HOURS_BREAKDOWN_LIMIT,
    };
  }
}

/**
 * The two window checks class-validator cannot express field by field.
 *
 * A backwards window is rejected rather than silently swapped: a report that
 * quietly answers a different question than the one asked is worse than an
 * error, given what these numbers are used for.
 */
function assertWindow(from: Date | undefined, to: Date | undefined): void {
  if (!from || !to) return;
  if (from.getTime() > to.getTime()) {
    throw new BadRequestException('`from` must not be after `to`.');
  }
  if (to.getTime() - from.getTime() > MAX_HOURS_WINDOW_DAYS * DAY_MS) {
    throw new BadRequestException(
      `The window must be ${MAX_HOURS_WINDOW_DAYS} days or shorter. Omit both dates to report over all time.`,
    );
  }
}
