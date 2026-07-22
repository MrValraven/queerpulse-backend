import { Controller, Get, UseGuards } from '@nestjs/common';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminOverviewService } from './admin-overview.service';

/**
 * Read-only admin dashboard overview: platform-wide stats, triage counts,
 * the reports-by-type / member-growth charts, response-time distribution,
 * and the merged activity feed. Mirrors `AdminMembersController`: deliberately
 * NOT `@LockdownExempt()` since nothing here can lift a lockdown.
 */
@UseGuards(RolesGuard)
@Roles(UserRole.Admin)
@Controller('admin/overview')
export class AdminOverviewController {
  constructor(private readonly adminOverview: AdminOverviewService) {}

  @Get()
  getOverview() {
    return this.adminOverview.getOverview();
  }
}
