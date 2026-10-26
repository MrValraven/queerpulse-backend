import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { HideEventCommunityDto } from './dto/hide-event-community.dto';
import { HiddenEventCommunitiesService } from './hidden-event-communities.service';

/**
 * The caller's own hidden event communities: communities whose events stay
 * off their upcoming browse. The resource is always "mine", so it sits under
 * `me/` beside `me/communities` and `me/saved`.
 *
 * Hiding is a reader's preference about their events browse. Nothing here
 * changes membership, and the hidden community is never told. The write
 * routes carry the `20 per 60s` per-route throttle the other cheap toggles
 * use (`/feed/mutes`).
 */
@Feature('events')
@ApiTags('Events')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('me/hidden-event-communities')
@UseGuards(ActiveMemberGuard)
export class HiddenEventCommunitiesController {
  constructor(
    private readonly hiddenEventCommunitiesService: HiddenEventCommunitiesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Communities whose events you have hidden from your browse.',
  })
  @ApiOkResponse({
    description:
      'A bare array, newest first ({ communityId, slug, name, avatarImageUrl, hiddenAt }).',
  })
  list(@CurrentUser() user: CurrentUserData) {
    return this.hiddenEventCommunitiesService.list(user.userId);
  }

  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post()
  @ApiOperation({
    summary: 'Hide events from a community in your browse (idempotent).',
  })
  @ApiCreatedResponse({
    description:
      'The hidden community row (an existing row is returned as is).',
  })
  @ApiNotFoundResponse({
    description:
      'code HIDDEN_COMMUNITY_NOT_FOUND: no community with that slug is visible to you.',
  })
  @ApiConflictResponse({
    description:
      'code HIDDEN_COMMUNITIES_LIMIT_REACHED: you already hide the most communities allowed (`limit`).',
  })
  @ApiTooManyRequestsResponse({ description: 'Throttled: 20 per 60s.' })
  hide(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: HideEventCommunityDto,
  ) {
    return this.hiddenEventCommunitiesService.hide(
      user.userId,
      dto.communitySlug,
    );
  }

  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Delete(':communityId')
  @ApiOperation({
    summary: 'Show events from this community in your browse again.',
  })
  @ApiOkResponse({ description: '{ hidden: false } (idempotent).' })
  @ApiTooManyRequestsResponse({ description: 'Throttled: 20 per 60s.' })
  unhide(
    @CurrentUser() user: CurrentUserData,
    @Param('communityId', ParseUUIDPipe) communityId: string,
  ) {
    return this.hiddenEventCommunitiesService.unhide(user.userId, communityId);
  }
}
