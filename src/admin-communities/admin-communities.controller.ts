import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminCommunitiesService } from './admin-communities.service';

/**
 * Read-only admin view over every community on the platform.
 *
 * Deliberately NOT `@LockdownExempt()` — unlike the platform-settings
 * kill-switch, nothing here can lift a lockdown, so this surface should go
 * dark with everything else.
 */
@UseGuards(RolesGuard)
@Roles(UserRole.Admin)
@Controller('admin/communities')
export class AdminCommunitiesController {
  constructor(private readonly adminCommunities: AdminCommunitiesService) {}

  @Get()
  listCommunities() {
    return this.adminCommunities.listCommunities();
  }

  @Get(':slug')
  getCommunity(@Param('slug') slug: string) {
    return this.adminCommunities.getCommunity(slug);
  }
}
