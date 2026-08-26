import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CreateFeedMuteDto } from './dto/feed-mute.dto';
import { FeedSourceKind } from './entities/feed-source-mute.entity';
import { FeedMuteService } from './feed-mute.service';

/**
 * "Show me less of this" (SOC-18), scoped to the caller's own feed.
 *
 * Kept on `/feed/*` rather than under `/communities/:slug` on purpose: this is
 * a reader's preference about their home screen, not an act inside the room.
 * Nothing here changes membership, and the muted community is never told.
 *
 * The write routes carry the same `20 per 60s` per-route throttle the other
 * cheap toggles in this codebase do, so the flat POST/DELETE pair can't be the
 * cheapest thing on the API to hammer.
 */
@Feature('feed')
@ApiTags('Feed')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('feed/mutes')
@UseGuards(ActiveMemberGuard)
export class FeedMuteController {
  constructor(private readonly feedMuteService: FeedMuteService) {}

  @Get()
  @ApiOperation({ summary: "Sources you've turned down in your feed." })
  @ApiOkResponse({ description: 'The managed list, newest mute first.' })
  list(@CurrentUser() user: CurrentUserData) {
    return this.feedMuteService.list(user.userId);
  }

  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post()
  @ApiOperation({
    summary: 'Show less of a community or thread in your feed (idempotent).',
  })
  @ApiCreatedResponse({ description: 'The source is muted for you.' })
  @ApiNotFoundResponse({ description: 'No such community or thread.' })
  mute(@CurrentUser() user: CurrentUserData, @Body() dto: CreateFeedMuteDto) {
    return this.feedMuteService.mute(user.userId, dto.sourceKind, dto.sourceId);
  }

  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Delete(':sourceKind/:sourceId')
  @ApiOperation({ summary: 'Show this source in your feed again.' })
  @ApiOkResponse({ description: 'The source is no longer muted for you.' })
  unmute(
    @CurrentUser() user: CurrentUserData,
    @Param('sourceKind', new ParseEnumPipe(FeedSourceKind))
    sourceKind: FeedSourceKind,
    @Param('sourceId', ParseUUIDPipe) sourceId: string,
  ) {
    return this.feedMuteService.unmute(user.userId, sourceKind, sourceId);
  }
}
