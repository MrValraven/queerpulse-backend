import { Body, Controller, Param, Patch, UseGuards } from '@nestjs/common';
import {
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
import { AdminForumService } from './admin-forum.service';
import { SetThreadOfficialDto } from './dto/set-thread-official.dto';

/**
 * Admin-only forum moderation surface. Under the global Throttler → CSRF →
 * JWT chain, plus `ActiveMemberGuard` + `RolesGuard` here — same guard stack
 * as `AdminBotsController`.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin — Forum')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/forum')
export class AdminForumController {
  constructor(private readonly adminForum: AdminForumService) {}

  @ApiOperation({
    summary:
      'Toggle a thread between its real author and "QueerPulse Official".',
  })
  @ApiOkResponse({ description: 'The updated thread.' })
  @ApiNotFoundResponse({ description: 'Thread not found.' })
  @Patch('threads/:slug/official')
  setThreadOfficial(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: SetThreadOfficialDto,
  ) {
    return this.adminForum.setThreadOfficial(slug, user, dto.isOfficial);
  }
}
