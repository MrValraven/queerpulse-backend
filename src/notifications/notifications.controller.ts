import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ListNotificationsQuery } from './dto/list-notifications.query';
import { NotificationsService } from './notifications.service';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

// No ActiveMemberGuard: a pending user may receive vouch_received /
// promoted_to_member notifications and must be able to read them.
@ApiTags('Notifications')
@ApiCookieAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: "List the current member's notifications" })
  @ApiOkResponse({ description: 'A paginated page of notifications.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  list(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListNotificationsQuery,
  ) {
    return this.notificationsService.list(user.userId, {
      unread: query.unread,
      page: query.page,
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Get the count of unread notifications' })
  @ApiOkResponse({ description: 'The unread notification count.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  async unreadCount(
    @CurrentUser() user: CurrentUserData,
  ): Promise<{ count: number }> {
    const count = await this.notificationsService.unreadCount(user.userId);
    return { count };
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  @ApiCreatedResponse({ description: 'All notifications were marked read.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  readAll(@CurrentUser() user: CurrentUserData) {
    return this.notificationsService.markAllRead(user.userId);
  }

  @Post(':id/read')
  @ApiOperation({ summary: 'Mark a single notification as read' })
  @ApiCreatedResponse({ description: 'The notification was marked read.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiNotFoundResponse({ description: 'The notification does not exist.' })
  read(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notificationsService.markRead(id, user.userId);
  }
}
