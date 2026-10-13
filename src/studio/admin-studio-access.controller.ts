import {
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
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import {
  StudioAccessGrantResponse,
  StudioAccessService,
} from './studio-access.service';

// The member drawer's Studio access line. Shares the `admin/members` prefix
// with `AdminMembersController` (Admin only) and
// `AdminMemberIdentityController`; these three routes are moderator work, so
// this controller opens them to Moderator and Admin.
@Feature('studio')
@ApiTags('Admin: Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller('admin/members')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminStudioAccessController {
  constructor(private readonly access: StudioAccessService) {}

  @Get(':id/studio-access')
  @ApiOperation({ summary: "A member's Studio access grant, or nothing." })
  @ApiOkResponse({ description: 'The grant, or an empty body for none.' })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  getAccess(
    @Param('id', ParseUUIDPipe) memberId: string,
  ): Promise<StudioAccessGrantResponse | null> {
    return this.access.getGrant(memberId);
  }

  @Post(':id/studio-access')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Grant a member Studio access (idempotent).' })
  @ApiOkResponse({ description: 'The grant.' })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  grantAccess(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) memberId: string,
  ): Promise<StudioAccessGrantResponse> {
    return this.access.grant(user.userId, memberId);
  }

  @Delete(':id/studio-access')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Revoke a member's Studio access (idempotent)." })
  @ApiNoContentResponse({ description: 'Access revoked.' })
  @ApiNotFoundResponse({ description: 'Member not found.' })
  revokeAccess(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) memberId: string,
  ): Promise<void> {
    return this.access.revoke(user.userId, memberId);
  }
}
