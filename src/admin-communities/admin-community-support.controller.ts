import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminCommunitySupportService } from './admin-community-support.service';
import { CreateCommunitySupportOfferDto } from './dto/create-community-support-offer.dto';

/**
 * Offering a struggling community support from the admin console (OPS-05).
 *
 * Its own controller rather than a method on `AdminCommunitiesController`,
 * for the same reason `AdminCommunityModeratorsController` is separate: that
 * class is admin-only, and this write is open to platform moderators and to
 * the additive `communities` grant as well. `RolesOrStaffGuard` reads the
 * class-level decorators through `getAllAndOverride`, so the read
 * controller's admin-only gate does not leak onto this one.
 *
 * Why the wider gate is right here: offering help is supportive, it takes
 * nothing away from anyone, the community can decline it in one click, and it
 * lands in the community's own governance log either way. The overrides that
 * are NOT reversible like that (freeze, archive, reassign ownership, remove a
 * roster member) stay admin-only where they are.
 *
 * There is deliberately no withdraw route. The moment an offer is written its
 * recipients hold a notification about it, and nothing can un-ring that; a
 * DELETE would leave the bell pointing at a row that no longer exists. The
 * community's own answer ("not needed right now") is the honest close.
 */
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@StaffRoles('communities')
@ApiTags('Admin — Communities')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description:
    'Requires the moderator or admin role, or the `communities` staff grant.',
})
@Controller('admin/communities/:slug/support-offers')
export class AdminCommunitySupportController {
  constructor(
    private readonly adminCommunitySupport: AdminCommunitySupportService,
  ) {}

  @Post()
  @ApiOperation({
    summary:
      "Offer a community support. Notifies the community's owner, co-owners and moderators in-app.",
  })
  @ApiCreatedResponse({ description: 'The offer that was recorded.' })
  @ApiBadRequestResponse({
    description: 'Malformed body, or an option outside the support registry.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  @ApiConflictResponse({
    description: 'This community already has an offer waiting for an answer.',
  })
  create(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateCommunitySupportOfferDto,
  ) {
    return this.adminCommunitySupport.create(slug, currentUser.userId, dto);
  }
}
