import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import { isStaffRoleId } from '../users/staff-roles.registry';
import { AdminMembersService } from './admin-members.service';
import { GrantStaffRoleDto } from './dto/grant-staff-role.dto';
import { ListAdminMembersQuery } from './dto/list-admin-members.query';
import { UpdateInviteQuotaDto } from './dto/update-invite-quota.dto';
import { UpdatePlatformMemberRoleDto } from './dto/update-member-role.dto';
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

  // Declared before ':id' for the same reason as 'flagged' above.
  @ApiOperation({
    summary: 'List every member holding an additive staff-role grant.',
  })
  @ApiOkResponse({ description: 'The grant holders and what each one holds.' })
  @Get('staff-roles')
  listStaffRoleHolders() {
    return this.adminMembers.listStaffRoleHolders();
  }

  @ApiOperation({ summary: "One member's full admin detail view." })
  @ApiOkResponse({ description: 'The member detail.' })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  @Get(':id')
  getMember(@Param('id', ParseUUIDPipe) id: string) {
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
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdatePlatformMemberRoleDto,
  ) {
    return this.adminMembers.updateRole(currentUser.userId, id, body.role);
  }

  // Grant/revoke an additive "staff role" (STAFF_ROLES) — orthogonal to the
  // moderator/admin tier above. Guardrails (house-account lock, idempotency)
  // live in the service, same split as updateRole.
  @ApiOperation({ summary: 'Grant a staff role to a member.' })
  @ApiOkResponse({ description: "The member's updated staff roles." })
  @ApiBadRequestResponse({ description: 'Malformed request body.' })
  @ApiForbiddenResponse({
    description: 'Requires the admin role, or the target is a house account.',
  })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  @Post(':id/staff-roles')
  grantStaffRole(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: GrantStaffRoleDto,
  ) {
    return this.adminMembers.grantStaffRole(currentUser.userId, id, body.role);
  }

  @ApiOperation({ summary: 'Revoke a staff role from a member.' })
  @ApiOkResponse({ description: "The member's updated staff roles." })
  @ApiBadRequestResponse({ description: 'Unknown staff role.' })
  @ApiForbiddenResponse({
    description: 'Requires the admin role, or the target is a house account.',
  })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  @Delete(':id/staff-roles/:role')
  revokeStaffRole(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('role') role: string,
  ) {
    if (!isStaffRoleId(role)) {
      throw new BadRequestException('Unknown staff role.');
    }
    return this.adminMembers.revokeStaffRole(currentUser.userId, id, role);
  }

  // Resource-limits lever, not a moderation action — no self-change or
  // house-account guardrail (unlike updateRole/grantStaffRole), just the
  // class-level Admin-only guard already on this controller. It IS audited
  // (`invite_quota_changed`, old → new) — see the service.
  //
  // NOTE the deliberately missing `ParseUUIDPipe`, unlike every sibling route
  // above. `AdminMembersService.resolveMemberProfile` accepts a profile slug
  // OR a raw userId, and the admin invites UI calls this one with the
  // member's SLUG (`PATCH /admin/members/:memberSlug/invite-quota`), so a
  // UUID pipe here would 400 every real request (BE-COM-34 read the
  // inconsistency the other way round). The param is named `idOrSlug` to make
  // that contract visible at the call site.
  @ApiOperation({
    summary: "Set or clear a member's monthly invite quota override.",
  })
  @ApiOkResponse({ description: 'The updated invite quota.' })
  @ApiBadRequestResponse({ description: 'Malformed request body.' })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  @Patch(':id/invite-quota')
  updateInviteQuota(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('id') idOrSlug: string,
    @Body() body: UpdateInviteQuotaDto,
  ) {
    return this.adminMembers.updateInviteQuota(
      idOrSlug,
      body.quota,
      currentUser.userId,
    );
  }
}
