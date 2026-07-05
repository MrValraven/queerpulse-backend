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

// No ActiveMemberGuard: a pending user may receive vouch_received /
// promoted_to_member notifications and must be able to read them.
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
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
  async unreadCount(
    @CurrentUser() user: CurrentUserData,
  ): Promise<{ count: number }> {
    const count = await this.notificationsService.unreadCount(user.userId);
    return { count };
  }

  @Post('read-all')
  readAll(@CurrentUser() user: CurrentUserData) {
    return this.notificationsService.markAllRead(user.userId);
  }

  @Post(':id/read')
  read(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notificationsService.markRead(id, user.userId);
  }
}
