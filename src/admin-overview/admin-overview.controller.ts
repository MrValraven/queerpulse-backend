import { Controller, Get, UseGuards } from '@nestjs/common';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminOverviewService } from './admin-overview.service';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * Read-only admin dashboard overview: platform-wide stats, triage counts,
 * the reports-by-type / member-growth charts, response-time distribution,
 * and the merged activity feed. Mirrors `AdminMembersController`: deliberately
 * NOT `@LockdownExempt()` since nothing here can lift a lockdown.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin — Overview')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/overview')
export class AdminOverviewController {
  constructor(private readonly adminOverview: AdminOverviewService) {}

  @ApiOperation({ summary: 'Get the admin dashboard overview.' })
  @ApiOkResponse({ description: 'The dashboard overview.' })
  @Get()
  getOverview() {
    return this.adminOverview.getOverview();
  }
}
