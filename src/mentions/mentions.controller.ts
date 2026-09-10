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
import { ResolveMentionNamesQuery } from './dto/resolve-mention-names.query';
import { MentionNameResolveService } from './mention-name-resolve.service';
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
  constructor(
    private readonly mentionsInbox: MentionsInboxService,
    private readonly mentionNames: MentionNameResolveService,
  ) {}

  /**
   * Names the entities a piece of text mentions, so a reader sees "Val Raven"
   * where the author typed `@val-raven`. Addressed by the exact `kind:slug`
   * refs the client parsed out of the text it is about to render — a profile
   * bio, today — so one render costs one request no matter how large the
   * directory is, and a target outside any already-loaded list still resolves.
   *
   * Authenticated like the rest of this controller, and deliberately so: the
   * platform serves a member's name to the open web only when that member has
   * published a public profile, and an ungated `slug -> name` route would hand
   * out the rest. A signed-out reader keeps the raw `@slug`, which is what the
   * public profile page already renders (styled, inert) for the same reason.
   *
   * Every kind is additionally scoped to what THIS viewer could reach by the
   * entity's own route — see `MentionNameResolveService`. Refs that resolve to
   * nothing are omitted rather than erroring: a bio may name something deleted,
   * private, or simply mistyped, and the client renders those unchanged.
   */
  @Get('names')
  @ApiOperation({ summary: 'Resolve mention refs to display names' })
  @ApiOkResponse({ description: 'The refs that resolved, as kind/slug/name.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  resolveNames(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ResolveMentionNamesQuery,
  ) {
    return this.mentionNames.resolve(user.userId, query.refs);
  }

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
