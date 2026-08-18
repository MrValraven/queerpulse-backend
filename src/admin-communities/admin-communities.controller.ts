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
import { AdminCommunitiesService } from './admin-communities.service';
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
 * member-facing endpoint can reach: freeze/unfreeze, archive, reassign
 * ownership, and remove any roster member outright. Those exist for exactly
 * the case a community's own owner/mods can't be trusted or reached — every
 * one of them bypasses the normal owner/mod-only authorization on purpose
 * (see each method's doc on `AdminCommunitiesService`) and is logged via
 * `CommunityGovernanceLogService` with `adminOverride: true`.
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
  @ApiOkResponse({ description: 'The community detail.' })
  @Get(':slug')
  getCommunity(@Param('slug') slug: string) {
    return this.adminCommunities.getCommunity(slug);
  }

  @ApiOperation({ summary: "Update a community's safety-policy settings." })
  @ApiOkResponse({ description: 'The updated community detail.' })
  @Patch(':slug')
  updateSettings(
    @Param('slug') slug: string,
    @Body() dto: UpdateAdminCommunitySettingsDto,
  ) {
    return this.adminCommunities.updateSettings(slug, dto);
  }

  @ApiOperation({
    summary:
      'Freeze a community regardless of its owner/mods (admin override).',
  })
  @ApiOkResponse({ description: 'The updated community detail.' })
  @Post(':slug/freeze')
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
  @Post(':slug/unfreeze')
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
  @Post(':slug/archive')
  archive(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.adminCommunities.archive(slug, currentUser.userId);
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
  @Post(':slug/reassign-owner')
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
  @Delete(':slug/members/:memberSlug')
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
