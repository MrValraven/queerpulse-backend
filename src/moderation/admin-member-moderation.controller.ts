import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminMemberModerationService } from './admin-member-moderation.service';
import { RestrictMemberDto } from './dto/restrict-member.dto';

/**
 * The admin member-drawer moderation actions — Verify & Restrict (P2-3). A
 * separate controller from `AdminMembersController` (admin-members module,
 * `@Roles(Admin)`) because these are moderator-capable: a moderator can verify
 * and restrict, matching `ModerationController`. Shares the `admin/members`
 * base path (different HTTP methods/subpaths, so no route clash) and lives in
 * the moderation module, next to the enforcement/audit/notification machinery
 * it reuses.
 */
@ApiTags('Admin — Member moderation')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller('admin/members')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminMemberModerationController {
  constructor(private readonly service: AdminMemberModerationService) {}

  @ApiOperation({ summary: 'Verify a member (stamps who/when).' })
  @ApiOkResponse({ description: "The member's verified state." })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  @Post(':id/verify')
  verify(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.verifyMember(currentUser.userId, id);
  }

  @ApiOperation({
    summary: 'Restrict a member platform-wide (suspend, or ban if no duration).',
  })
  @ApiOkResponse({ description: "The member's resulting status + expiry." })
  @ApiBadRequestResponse({ description: 'Malformed body or duration.' })
  @ApiForbiddenResponse({
    description:
      'Requires a moderator/admin role, or the target is yourself, a staff account, or the house account.',
  })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  @Post(':id/restrict')
  restrict(
    @CurrentUser() currentUser: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RestrictMemberDto,
  ) {
    return this.service.restrictMember(currentUser.userId, id, dto);
  }
}
