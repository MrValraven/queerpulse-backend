import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
  UseGuards,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CalendarFeedService } from './calendar-feed.service';
import { CalendarFeedTokenService } from './calendar-feed-token.service';

/**
 * "Subscribe to your feed" (`CalendarSubscribe`, MyEvents FE): a signed,
 * per-member ICS feed a calendar app polls on its own schedule. Split into
 * two routes with very different trust models:
 *
 *  - `GET /me/calendar-feed-token` — session-authenticated, mints the token.
 *  - `GET /calendar/feed/:token` — deliberately `@Public()`: a calendar app
 *    fetches this unauthenticated (no cookie jar, no login prompt), so the
 *    token itself — HMAC-signed, see `CalendarFeedTokenService` — is the only
 *    credential. `VERSION_NEUTRAL` (mirrors `MetricsController`'s reasoning)
 *    keeps the URL a member pastes into Google/Apple Calendar stable across
 *    API version bumps, since it's meant to be added once and polled forever.
 *
 * Its own module (not `EventsController`) per the task split — a concurrent
 * pass may be touching that controller at the same time.
 */
@Feature('events')
@Controller({ version: VERSION_NEUTRAL })
export class CalendarFeedController {
  constructor(
    private readonly calendarFeed: CalendarFeedService,
    private readonly calendarFeedToken: CalendarFeedTokenService,
  ) {}

  @Get('me/calendar-feed-token')
  @ApiTags('Calendar feed')
  @ApiCookieAuth('access_token')
  @ApiUnauthorizedResponse({
    description: 'Requires an authenticated, active member session.',
  })
  @ApiOperation({
    summary:
      "Mint your calendar-feed token — combine with the API base URL as " +
      "`{apiUrl}/calendar/feed/{token}` for a webcal-style subscribe link.",
  })
  @ApiOkResponse({ description: 'A signed, long-lived feed token.' })
  @UseGuards(ActiveMemberGuard)
  mintToken(@CurrentUser() user: CurrentUserData) {
    return { token: this.calendarFeedToken.mint(user.userId) };
  }

  @Get('calendar/feed/:token')
  @Public()
  @ApiTags('Calendar feed')
  @ApiOperation({
    summary:
      "A member's going/maybe events as an RFC 5545 `.ics` feed. Unauthenticated " +
      '— the signed `:token` (see `GET /me/calendar-feed-token`) is the credential.',
  })
  @ApiOkResponse({ description: 'text/calendar body.' })
  @ApiNotFoundResponse({ description: 'The token is invalid or malformed.' })
  async serveFeed(
    @Param('token') token: string,
    @Res() response: Response,
  ): Promise<void> {
    const userId = this.calendarFeedToken.verify(token);
    if (!userId) {
      throw new NotFoundException('Invalid feed token');
    }
    const ics = await this.calendarFeed.buildFeed(userId);
    response.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      'inline; filename="queerpulse.ics"',
    );
    response.send(ics);
  }
}
