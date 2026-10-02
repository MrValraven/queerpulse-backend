import {
  Controller,
  Get,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminFeatureUsageService } from './admin-feature-usage.service';

/** Smallest `rangeDays` this endpoint accepts. */
const MINIMUM_RANGE_DAYS = 1;

/** Largest `rangeDays` this endpoint accepts. Bounds the historical scan
 *  `AdminFeatureUsageService.getUsage` runs across every depth-tracked
 *  entity table, and keeps the UTC day-boundary arithmetic inside `Date`'s
 *  safe range. */
const MAXIMUM_RANGE_DAYS = 365;

/**
 * Read-only feature usage panel: reach and depth per product feature, with a
 * state for each. Carries no `@Feature(...)` tag deliberately, so the panel
 * never counts itself: tagging this controller would make every admin visit
 * inflate one of the numbers the panel reports. Mirrors `AdminOverviewController`:
 * deliberately NOT `@LockdownExempt()` since nothing here can lift a lockdown.
 *
 * Opened to the `product_manager` grant through `RolesOrStaffGuard`: every
 * figure here is an aggregate per feature, so the panel serves no member row
 * a grant holder could not otherwise see.
 */
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles('product_manager')
@ApiTags('Admin — Feature usage')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Requires the admin role or the product_manager staff grant.',
})
@Controller('admin/feature-usage')
export class AdminFeatureUsageController {
  constructor(private readonly featureUsage: AdminFeatureUsageService) {}

  @ApiOperation({ summary: 'Reach and depth per product feature.' })
  @ApiOkResponse({ description: 'The feature usage panel.' })
  @Get()
  getUsage(
    @Query('rangeDays', new ParseIntPipe({ optional: true }))
    rangeDays = 30,
  ) {
    // Clamped here, in the controller, rather than in the service, so the
    // service keeps taking a plain number and its own unit tests stay
    // simple. The DTO's `rangeDays` field echoes back whatever value is
    // passed to `getUsage`, so the clamped value is what a caller asking
    // for an out-of-range number is told it actually got.
    const clampedRangeDays = Math.min(
      Math.max(rangeDays, MINIMUM_RANGE_DAYS),
      MAXIMUM_RANGE_DAYS,
    );
    return this.featureUsage.getUsage(clampedRangeDays);
  }
}
