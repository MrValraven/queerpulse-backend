import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminCommunitiesService } from './admin-communities.service';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * Read-only admin view over every community on the platform.
 *
 * Deliberately NOT `@LockdownExempt()` — unlike the platform-settings
 * kill-switch, nothing here can lift a lockdown, so this surface should go
 * dark with everything else.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin — Communities')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/communities')
export class AdminCommunitiesController {
  constructor(private readonly adminCommunities: AdminCommunitiesService) {}

  @ApiOperation({ summary: 'List every community with admin health metrics.' })
  @ApiOkResponse({ description: 'The community cards.' })
  @Get()
  listCommunities() {
    return this.adminCommunities.listCommunities();
  }

  @ApiOperation({ summary: 'Get one community with its admin detail view.' })
  @ApiOkResponse({ description: 'The community detail.' })
  @ApiNotFoundResponse({ description: 'Community not found.' })
  @Get(':slug')
  getCommunity(@Param('slug') slug: string) {
    return this.adminCommunities.getCommunity(slug);
  }
}
