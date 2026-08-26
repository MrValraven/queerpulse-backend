import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
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
import { AdminCommunityTagRequestsService } from './admin-community-tag-requests.service';
import { ListAdminCommunityTagRequestsQuery } from './dto/list-admin-community-tag-requests.query';

/**
 * Admin oversight of the "suggest a tag" feedback inbox: every free-text tag
 * request an owner/mod has submitted from their community's settings
 * (`POST /communities/:slug/tag-requests`), paginated and optionally
 * filtered by status. Guard pattern mirrors
 * `AdminResourceSuggestionsController`: open to both Moderator and Admin
 * (not the read-only-admin-only split some other admin controllers use —
 * this queue has no destructive action, just an ack).
 *
 * INFORMATIONAL ONLY — see `CommunityTagRequest`'s docstring. Resolving a
 * request never adds anything to the live `COMMUNITY_TAGS` vocabulary; an
 * admin who wants to act on a request does so by hand, editing
 * `src/communities/community-tags.ts` in a separate, code-reviewed change.
 */
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@StaffRoles('communities')
@ApiTags('Admin — Community tag requests')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description:
    'Requires a moderator or admin role, or the `communities` staff role.',
})
@Controller('admin/community-tag-requests')
export class AdminCommunityTagRequestsController {
  constructor(
    private readonly adminCommunityTagRequests: AdminCommunityTagRequestsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List community tag requests (paginated).' })
  @ApiOkResponse({ description: 'One page of community tag requests.' })
  @ApiBadRequestResponse({ description: 'Malformed query parameters.' })
  list(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListAdminCommunityTagRequestsQuery,
  ) {
    // `user.role` is the caller's ACCOUNT TIER, passed so the service can
    // withhold the requester's identity from a `communities` grant holder.
    return this.adminCommunityTagRequests.list(query, user.role);
  }

  @Patch(':id/resolve')
  @ApiOperation({ summary: 'Mark a tag request resolved.' })
  @ApiOkResponse({ description: 'The tag request, now resolved.' })
  @ApiNotFoundResponse({ description: 'No tag request with that id.' })
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.adminCommunityTagRequests.resolve(id, user.userId, user.role);
  }
}
