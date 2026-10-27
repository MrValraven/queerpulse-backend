import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminFeatureUsageDetailService } from './admin-feature-usage-detail.service';
import { AdminFeatureUsageService } from './admin-feature-usage.service';
import { FEATURE_USAGE_DETAIL_ERROR_CODES } from './feature-usage-detail-response';
import {
  FEATURE_USAGE_DEFAULT_RANGE_DAYS,
  FEATURE_USAGE_MAX_RANGE_DAYS,
  FEATURE_USAGE_MIN_RANGE_DAYS,
  FEATURE_USAGE_RANGE_ERROR_CODES,
} from './feature-usage-range';

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
@ApiTags('Admin: Feature usage')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Requires the admin role or the product_manager staff grant.',
})
@Controller('admin/feature-usage')
export class AdminFeatureUsageController {
  constructor(
    private readonly featureUsage: AdminFeatureUsageService,
    private readonly featureUsageDetail: AdminFeatureUsageDetailService,
  ) {}

  @ApiOperation({ summary: 'Reach and depth per product feature.' })
  @ApiQuery({
    name: 'rangeDays',
    required: false,
    type: Number,
    description: `Preset range length in whole days, ending yesterday (UTC). Clamped to ${FEATURE_USAGE_MIN_RANGE_DAYS} to ${FEATURE_USAGE_MAX_RANGE_DAYS}. Defaults to ${FEATURE_USAGE_DEFAULT_RANGE_DAYS} when no range is sent. Send it alone, leaving from and to out.`,
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description:
      'First day of a custom range, YYYY-MM-DD, inclusive. Sent together with to.',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description:
      'Last day of a custom range, YYYY-MM-DD, inclusive. Yesterday (UTC) at the latest. Sent together with from.',
  })
  @ApiOkResponse({
    description:
      'The feature usage panel: per feature reach with zero-filled daily series for the range and the previous range, inclusive range dates, and the reach median.',
  })
  @ApiBadRequestResponse({
    description: `The range was rejected. The body's code names the cause: ${Object.values(
      FEATURE_USAGE_RANGE_ERROR_CODES,
    ).join(', ')}.`,
  })
  @Get()
  getUsage(
    @Query('rangeDays') rangeDays?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    // The service resolves and validates the range (clamp, retention, today)
    // in one place, `resolveUsageRange`, so this route and the detail route
    // share every rule. The DTO echoes the resolved `rangeDays`, so a caller
    // asking for an out-of-range number reads back the clamped value.
    return this.featureUsage.getUsage(
      this.featureUsage.resolveRange({ rangeDays, from, to }),
    );
  }

  @ApiOperation({
    summary: 'Rows created per day for one product feature.',
    description:
      'Fetched lazily when a row of the panel opens. Takes the same range parameters as the main route and resolves them through the same rules.',
  })
  @ApiParam({
    name: 'featureKey',
    type: String,
    description:
      'A launchedFeatures key that the panel measures, for example forum.',
  })
  @ApiQuery({
    name: 'rangeDays',
    required: false,
    type: Number,
    description: `Preset range length in whole days, ending yesterday (UTC). Clamped to ${FEATURE_USAGE_MIN_RANGE_DAYS} to ${FEATURE_USAGE_MAX_RANGE_DAYS}. Defaults to ${FEATURE_USAGE_DEFAULT_RANGE_DAYS} when no range is sent. Send it alone, leaving from and to out.`,
  })
  @ApiQuery({
    name: 'from',
    required: false,
    type: String,
    description:
      'First day of a custom range, YYYY-MM-DD, inclusive. Sent together with to.',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    type: String,
    description:
      'Last day of a custom range, YYYY-MM-DD, inclusive. Yesterday (UTC) at the latest. Sent together with from.',
  })
  @ApiOkResponse({
    description:
      "The feature key, the resolved range with inclusive dates, and createdDaily: rows members created per UTC day, zero-filled and summed across the feature's depth entities. createdDaily is null for a reach-only feature.",
  })
  @ApiBadRequestResponse({
    description: `The range was rejected. The body's code names the cause: ${Object.values(
      FEATURE_USAGE_RANGE_ERROR_CODES,
    ).join(', ')}.`,
  })
  @ApiNotFoundResponse({
    description: `The feature key has no usage detail. The body's code names the cause: ${FEATURE_USAGE_DETAIL_ERROR_CODES.unknownFeature} when the key matches no launchedFeatures entry, ${FEATURE_USAGE_DETAIL_ERROR_CODES.featureNotTracked} when the feature is never measured by design.`,
  })
  @Get(':featureKey/detail')
  getDetail(
    @Param('featureKey') featureKey: string,
    @Query('rangeDays') rangeDays?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    // Same range rules as `getUsage`, through the same `resolveRange`, so the
    // detail for a row always covers exactly the days its Reach cell shows.
    // Like the class, this route carries no `@Feature(...)` tag.
    return this.featureUsageDetail.getDetail(
      featureKey,
      this.featureUsage.resolveRange({ rangeDays, from, to }),
    );
  }
}
