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
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import {
  LANDING_VISIT_PAGES,
  parseLandingVisitPage,
} from './landing-visit-source';
import {
  LANDING_VISIT_RANGE_DAYS,
  LandingVisitRangeDays,
  LandingVisitsService,
} from './landing-visits.service';

function parseRangeDays(
  rawRangeDays: string | undefined,
): LandingVisitRangeDays {
  const parsedRangeDays = Number(rawRangeDays);
  const matchingRange = LANDING_VISIT_RANGE_DAYS.find(
    (allowedRange) => allowedRange === parsedRangeDays,
  );
  if (matchingRange === undefined) {
    throw new BadRequestException({
      message: `rangeDays must be one of ${LANDING_VISIT_RANGE_DAYS.join(', ')}.`,
      reason: 'invalid_range',
    });
  }
  return matchingRange;
}

/**
 * Admin read of the anonymous landing visit counts: daily totals and the top
 * sources over the last 30 or 90 days. Admin only, mirroring
 * `AdminOverviewController`, and deliberately NOT `@LockdownExempt()` since
 * nothing here can lift a lockdown.
 *
 * Its own controller beside `AdminLandingController`, which also lets the
 * `editorial` and `cultural_producer` staff roles in. Visit counts are an
 * admin metric, so this route keeps the stricter guard block.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin - Landing visits')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/landing')
export class AdminLandingVisitsController {
  constructor(private readonly landingVisits: LandingVisitsService) {}

  @ApiOperation({
    summary:
      'Get landing page visit counts per UTC day and the top sources over a range.',
  })
  @ApiQuery({ name: 'rangeDays', enum: [...LANDING_VISIT_RANGE_DAYS] })
  @ApiQuery({
    name: 'page',
    enum: [...LANDING_VISIT_PAGES],
    required: false,
  })
  @ApiOkResponse({
    description:
      'Zero-filled daily visits (oldest first), the range total and the top ten sources.',
  })
  @ApiBadRequestResponse({
    description:
      'rangeDays is missing or is neither 30 nor 90 (reason invalid_range), or page is neither home nor studio (reason invalid_page).',
  })
  @Get('visits')
  getVisits(
    @Query('rangeDays') rawRangeDays?: string,
    @Query('page') rawPage?: string,
  ) {
    return this.landingVisits.getStats(
      parseRangeDays(rawRangeDays),
      parseLandingVisitPage(rawPage),
    );
  }
}
