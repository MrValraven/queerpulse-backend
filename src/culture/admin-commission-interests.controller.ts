import { Controller, Get, Query, UseGuards } from '@nestjs/common';
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
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminCommissionInterestsService } from './admin-commission-interests.service';
import { ListAdminCommissionInterestsQuery } from './dto/list-admin-commission-interests.query';

/**
 * Admin oversight of Commission Board interest: every "express interest" a
 * member has sent, paginated and optionally filtered by category. Guarded
 * exactly like `AdminInvitesController` — `ActiveMemberGuard` + `RolesGuard`
 * with `@Roles(Admin)` — and read-only (this module's writes stay on the
 * member-facing `CommissionInterestsController`).
 */
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles('editorial')
@ApiTags('Admin — Commission interests')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Requires the admin role, or the `editorial` staff role.',
})
@Controller('admin/commission-interests')
export class AdminCommissionInterestsController {
  constructor(
    private readonly adminCommissionInterests: AdminCommissionInterestsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List commission-board interest submissions (paginated).',
  })
  @ApiOkResponse({ description: 'One page of commission interests.' })
  @ApiBadRequestResponse({ description: 'Malformed query parameters.' })
  list(@Query() query: ListAdminCommissionInterestsQuery) {
    return this.adminCommissionInterests.list(query);
  }
}
