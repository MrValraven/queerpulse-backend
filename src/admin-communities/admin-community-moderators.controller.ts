import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
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
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminCommunityModeratorsService } from './admin-community-moderators.service';
import { AddModeratorDto } from './dto/add-moderator.dto';

/**
 * Moderator management for the admin communities panel
 * (`AdminCommunitySettings` add/remove controls).
 *
 * A distinct controller from the read-only `AdminCommunitiesController`
 * (which is admin-only): these write actions are open to platform moderators
 * as well as admins, so they carry their own class-level `@Roles`, which
 * `RolesGuard` reads via `getAllAndOverride` — the read controller's
 * admin-only gate does not leak onto them.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@ApiTags('Admin — Communities')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the moderator or admin role.' })
@ApiNotFoundResponse({ description: 'Community or member not found.' })
@Controller('admin/communities/:slug/moderators')
export class AdminCommunityModeratorsController {
  constructor(private readonly moderators: AdminCommunityModeratorsService) {}

  @ApiOperation({ summary: "List a community's moderators." })
  @ApiOkResponse({ description: 'The community moderators, oldest first.' })
  @Get()
  listModerators(@Param('slug') slug: string) {
    return this.moderators.listModerators(slug);
  }

  @ApiOperation({
    summary: 'List the roster members eligible to be promoted to moderator.',
  })
  @ApiOkResponse({ description: 'The promotable plain members.' })
  @Get('candidates')
  listCandidates(@Param('slug') slug: string) {
    return this.moderators.listCandidates(slug);
  }

  @ApiOperation({ summary: 'Promote a roster member to moderator.' })
  @ApiOkResponse({ description: 'The promoted moderator.' })
  @ApiBadRequestResponse({ description: 'The target cannot be a moderator.' })
  @Post()
  addModerator(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('slug') slug: string,
    @Body() body: AddModeratorDto,
  ) {
    return this.moderators.addModerator(
      slug,
      body.memberId,
      currentUser.userId,
    );
  }

  @ApiOperation({ summary: 'Demote a moderator back to a plain member.' })
  @ApiNoContentResponse({ description: 'The moderator was removed.' })
  @ApiBadRequestResponse({
    description: 'The founder cannot be removed, or the target is not a mod.',
  })
  @Delete(':memberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeModerator(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('slug') slug: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ): Promise<void> {
    return this.moderators.removeModerator(slug, memberId, currentUser.userId);
  }
}
