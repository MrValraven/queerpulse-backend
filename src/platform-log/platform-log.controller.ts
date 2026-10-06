import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { PlatformLogQuery } from './dto/platform-log-query.dto';
import { PlatformLogService } from './platform-log.service';

/**
 * The admin platform log: staff actions for moderators and admins, plus the
 * public-record member events for admins. Read-only, and deliberately NOT
 * `@LockdownExempt()`.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@ApiTags('Admin: Platform log')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the moderator or admin role.' })
@Controller('admin/log')
export class PlatformLogController {
  constructor(private readonly platformLog: PlatformLogService) {}

  @ApiOperation({ summary: 'Page through the platform log, newest first.' })
  @ApiOkResponse({ description: 'One page of log entries.' })
  @Get()
  list(@Query() query: PlatformLogQuery, @CurrentUser() user: CurrentUserData) {
    return this.platformLog.list(query, { role: user.role });
  }
}
