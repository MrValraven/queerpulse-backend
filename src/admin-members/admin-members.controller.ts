import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminMembersService } from './admin-members.service';
import { ListAdminMembersQuery } from './dto/list-admin-members.query';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * Admin view over platform members: the paginated roster, the flagged-members
 * queue, one member's full detail view, and role management (grant/revoke
 * `moderator` / `admin`).
 *
 * Deliberately NOT `@LockdownExempt()` — mirrors `AdminCommunitiesController`:
 * nothing here can lift a lockdown, so this surface should go dark with
 * everything else.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin — Members')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/members')
export class AdminMembersController {
  constructor(private readonly adminMembers: AdminMembersService) {}

  @ApiOperation({ summary: 'List the paginated member roster.' })
  @ApiOkResponse({ description: 'One page of members.' })
  @ApiBadRequestResponse({ description: 'Malformed query parameters.' })
  @Get()
  list(@Query() query: ListAdminMembersQuery) {
    return this.adminMembers.list(query);
  }

  // Declared before ':id' so 'flagged' is not captured as an id param.
  @ApiOperation({ summary: 'List the flagged-members queue.' })
  @ApiOkResponse({ description: 'The flagged members.' })
  @Get('flagged')
  listFlagged() {
    return this.adminMembers.listFlagged();
  }

  @ApiOperation({ summary: "One member's full admin detail view." })
  @ApiOkResponse({ description: 'The member detail.' })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  @Get(':id')
  getMember(@Param('id') id: string) {
    return this.adminMembers.getMember(id);
  }

  // Grant or revoke `moderator` / `admin`. Guardrails (no self-change, no
  // house-account change, never demote the last admin) live in the service.
  @ApiOperation({ summary: "Grant or revoke a member's moderator/admin role." })
  @ApiOkResponse({ description: 'The updated role.' })
  @ApiBadRequestResponse({ description: 'Malformed request body.' })
  @ApiForbiddenResponse({
    description:
      'Requires the admin role, or the change is disallowed (own role, or a house account).',
  })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  @ApiConflictResponse({
    description: 'Cannot demote the last remaining admin.',
  })
  @Patch(':id/role')
  updateRole(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('id') id: string,
    @Body() body: UpdateMemberRoleDto,
  ) {
    return this.adminMembers.updateRole(currentUser.userId, id, body.role);
  }
}
