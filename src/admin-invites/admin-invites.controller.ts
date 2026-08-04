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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminInvitesService } from './admin-invites.service';
import { ListAdminInvitesQuery } from './dto/list-admin-invites.query';

/**
 * Admin oversight of the invite graph platform-wide: every invite ever minted,
 * filterable by resolved status / invitee email / a single inviter, paginated.
 *
 * Guarded exactly like `AdminMembersController` — `ActiveMemberGuard` +
 * `RolesGuard` with `@Roles(Admin)` — and deliberately NOT `@LockdownExempt()`,
 * so this surface goes dark with the rest of the admin dashboard.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin — Invites')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/invites')
export class AdminInvitesController {
  constructor(private readonly adminInvites: AdminInvitesService) {}

  @ApiOperation({
    summary: 'List platform-wide invites (paginated, filterable).',
  })
  @ApiOkResponse({ description: 'One page of invites.' })
  @ApiBadRequestResponse({ description: 'Malformed query parameters.' })
  @Get()
  list(@Query() query: ListAdminInvitesQuery) {
    return this.adminInvites.list(query);
  }
}
