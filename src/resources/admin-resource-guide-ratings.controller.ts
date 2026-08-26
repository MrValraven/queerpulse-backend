import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminResourceGuideRatingsService } from './admin-resource-guide-ratings.service';

/**
 * Admin oversight of guide helpful-feedback (CNT-18) — every rated guide's
 * split, worst-ratio-first. Read-only: no approve/decline transitions here
 * (unlike `admin-reading-group-proposals.controller.ts`), so the class-level
 * `@Roles(Admin)` needs no method-level `@Roles(Moderator, Admin)` override.
 */
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles('resource_curator')
@ApiTags('Admin — Guide feedback')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Requires the admin role, or the `resource_curator` staff role.',
})
@Controller('admin/resources/guide-ratings')
export class AdminResourceGuideRatingsController {
  constructor(
    private readonly adminRatings: AdminResourceGuideRatingsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List guide helpful-rating aggregates, worst ratio first.',
  })
  @ApiOkResponse({ description: 'One row per rated guide content key.' })
  list() {
    return this.adminRatings.list();
  }
}
