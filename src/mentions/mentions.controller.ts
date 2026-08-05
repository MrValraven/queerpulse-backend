import { Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ListMentionsQuery } from './dto/list-mentions.query';
import { MentionsInboxService } from './mentions-inbox.service';

/**
 * The `@`-mentions inbox — the read endpoint the mentions feature was missing
 * (it previously only fanned mentions OUT as notifications). Auth is enforced by
 * the global JWT guard; every route is scoped to the current member. No
 * `ActiveMemberGuard` — mirrors `NotificationsController`, since a mention is
 * just a notification and a member must always be able to read their own.
 *
 * Per-mention "mark read" reuses `POST /notifications/:id/read` (a mention id is
 * a notification id); only the *scoped* "mark all" needs a route of its own, so
 * "mark all read" here never clears the member's other notification categories.
 */
@ApiTags('Mentions')
@ApiCookieAuth()
@Controller('mentions')
export class MentionsController {
  constructor(private readonly mentionsInbox: MentionsInboxService) {}

  @Get()
  @ApiOperation({ summary: "List the current member's @-mentions" })
  @ApiOkResponse({ description: 'A paginated page of mentions.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  list(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListMentionsQuery,
  ) {
    return this.mentionsInbox.list(user.userId, {
      unread: query.unread,
      page: query.page,
    });
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark all of the member’s mentions as read' })
  @ApiCreatedResponse({ description: 'All mentions were marked read.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  readAll(@CurrentUser() user: CurrentUserData) {
    return this.mentionsInbox.markAllRead(user.userId);
  }
}
