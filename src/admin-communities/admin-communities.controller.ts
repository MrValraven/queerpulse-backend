import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { isPlatformStaffTier } from '../auth/platform-staff-tier';
import { UserRole } from '../users/entities/user.entity';
import { AdminCommunitiesService } from './admin-communities.service';
import { ListAdminCommunityGovernanceLogQuery } from './dto/list-community-governance-log.query';
import { ReassignOwnerDto } from './dto/reassign-owner.dto';
import { UpdateAdminCommunitySettingsDto } from './dto/update-admin-community-settings.dto';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * Admin view over every community on the platform — health metrics, the
 * safety-policy toggles, and (below) the moderation-of-last-resort actions no
 * member-facing endpoint can reach: freeze/unfreeze, archive/unarchive,
 * reassign ownership, and remove any roster member outright. Those exist for exactly
 * the case a community's own owner/mods can't be trusted or reached — every
 * one of them bypasses the normal owner/mod-only authorization on purpose
 * (see each method's doc on `AdminCommunitiesService`) and is logged via
 * `CommunityGovernanceLogService` with `adminOverride: true`.
 *
 * Deliberately NOT `@LockdownExempt()` — unlike the platform-settings
 * kill-switch, nothing here can lift a lockdown, so this surface should go
 * dark with everything else.
 *
 * TWO READERS, TWO BODIES. The class-level `@StaffRoles('communities')` means
 * a plain member holding that grant reaches the reads below, so the handlers
 * can no longer assume a Moderator/Admin caller. Two of them carry things the
 * registry reserves for platform staff and therefore hand the service the
 * caller's account tier (`isPlatformStaffTier`) so it can serve a narrower
 * body: `GET :slug` withholds `scopedQueue[].detail`, the reporter's own
 * free-text account of what happened, and `GET :slug/governance-log` swaps the
 * raw `metadata` jsonb (which on a ban entry carries `banReason` and
 * `bannedByUserId` beside a named target) for the allowlisted `details` shape
 * the community's own moderators already read. Nothing about who may CALL
 * these changes; only how much of the answer they get.
 */
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles('communities')
@ApiTags('Admin — Communities')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description:
    'Requires the admin role, or the `communities` staff role (which does not reach the last-resort overrides below).',
})
@ApiNotFoundResponse({ description: 'Community not found.' })
@Controller('admin/communities')
export class AdminCommunitiesController {
  constructor(private readonly adminCommunities: AdminCommunitiesService) {}

  @ApiOperation({ summary: 'List every community with admin health metrics.' })
  @ApiOkResponse({
    description: 'The community cards, plus a truncation flag.',
  })
  @Get()
  listCommunities() {
    return this.adminCommunities.listCommunities();
  }

  @ApiOperation({ summary: 'Get one community with its admin detail view.' })
  @ApiOkResponse({
    description:
      "The community detail. `scopedQueue[].detail`, the reporter's own " +
      'free text, is present only for a platform moderator or admin.',
  })
  @Get(':slug')
  getCommunity(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.adminCommunities.getCommunity(
      slug,
      isPlatformStaffTier(currentUser.role),
    );
  }

  @ApiOperation({
    summary: "Read a community's governance audit trail (paginated).",
  })
  @ApiOkResponse({
    description:
      'Governance entries newest first, with actor/target resolved to a ' +
      'compact member ref. A platform moderator or admin gets the raw ' +
      '`metadata`; a `communities` grant holder gets the allowlisted ' +
      '`details` the community’s own moderators read.',
  })
  @ApiBadRequestResponse({ description: 'Malformed query parameters.' })
  @Get(':slug/governance-log')
  getGovernanceLog(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('slug') slug: string,
    @Query() query: ListAdminCommunityGovernanceLogQuery,
  ) {
    return this.adminCommunities.getGovernanceLog(
      slug,
      query,
      isPlatformStaffTier(currentUser.role),
    );
  }

  @ApiOperation({ summary: "Update a community's safety-policy settings." })
  @ApiOkResponse({ description: 'The updated community detail.' })
  @Patch(':slug')
  updateSettings(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateAdminCommunitySettingsDto,
  ) {
    return this.adminCommunities.updateSettings(
      slug,
      dto,
      currentUser.userId,
      isPlatformStaffTier(currentUser.role),
    );
  }

  @ApiOperation({
    summary:
      'Freeze a community regardless of its owner/mods (admin override).',
  })
  @ApiOkResponse({ description: 'The updated community detail.' })
  // Moderation of last resort, kept Admin-only: the empty @StaffRoles()
  // overrides the class-level `communities` grant, so RolesOrStaffGuard
  // falls back to @Roles(Admin) alone here.
  @Post(':slug/freeze')
  @StaffRoles()
  freeze(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.adminCommunities.freeze(slug, currentUser.userId);
  }

  @ApiOperation({
    summary:
      "Lift a community's freeze regardless of its owner/mods (admin override).",
  })
  @ApiOkResponse({ description: 'The updated community detail.' })
  // Moderation of last resort, kept Admin-only: the empty @StaffRoles()
  // overrides the class-level `communities` grant, so RolesOrStaffGuard
  // falls back to @Roles(Admin) alone here.
  @Post(':slug/unfreeze')
  @StaffRoles()
  unfreeze(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.adminCommunities.unfreeze(slug, currentUser.userId);
  }

  @ApiOperation({
    summary:
      'Archive a community regardless of its ownership state (admin override).',
  })
  @ApiOkResponse({ description: 'The updated community detail.' })
  // Moderation of last resort, kept Admin-only: the empty @StaffRoles()
  // overrides the class-level `communities` grant, so RolesOrStaffGuard
  // falls back to @Roles(Admin) alone here.
  @Post(':slug/archive')
  @StaffRoles()
  archive(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.adminCommunities.archive(slug, currentUser.userId);
  }

  @ApiOperation({
    summary:
      'Reverse an archive, regardless of ownership state (admin override).',
  })
  @ApiOkResponse({ description: 'The updated community detail.' })
  // Moderation of last resort, kept Admin-only: the empty @StaffRoles()
  // overrides the class-level `communities` grant, so RolesOrStaffGuard
  // falls back to @Roles(Admin) alone here.
  @Post(':slug/unarchive')
  @StaffRoles()
  unarchive(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.adminCommunities.unarchive(slug, currentUser.userId);
  }

  @ApiOperation({
    summary:
      'Reassign ownership to any roster member, even when the community currently has no owner (admin override).',
  })
  @ApiOkResponse({ description: 'The updated community detail.' })
  @ApiBadRequestResponse({
    description: 'Malformed request body, or the target is the house account.',
  })
  @ApiNotFoundResponse({ description: 'Community or target member not found.' })
  // Moderation of last resort, kept Admin-only: the empty @StaffRoles()
  // overrides the class-level `communities` grant, so RolesOrStaffGuard
  // falls back to @Roles(Admin) alone here.
  @Post(':slug/reassign-owner')
  @StaffRoles()
  reassignOwner(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('slug') slug: string,
    @Body() body: ReassignOwnerDto,
  ) {
    return this.adminCommunities.reassignOwner(
      slug,
      currentUser.userId,
      body.memberSlug,
    );
  }

  @ApiOperation({
    summary: 'Remove any roster member outright (admin override).',
  })
  @ApiNoContentResponse({
    description: 'The member was removed from the roster.',
  })
  @ApiBadRequestResponse({
    description:
      'The owner cannot be removed directly — reassign ownership first.',
  })
  @ApiNotFoundResponse({ description: 'Community or member not found.' })
  // Moderation of last resort, kept Admin-only: the empty @StaffRoles()
  // overrides the class-level `communities` grant, so RolesOrStaffGuard
  // falls back to @Roles(Admin) alone here.
  @Delete(':slug/members/:memberSlug')
  @StaffRoles()
  @HttpCode(HttpStatus.NO_CONTENT)
  removeMember(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('slug') slug: string,
    @Param('memberSlug') memberSlug: string,
  ): Promise<void> {
    return this.adminCommunities.removeMember(
      slug,
      currentUser.userId,
      memberSlug,
    );
  }
}
