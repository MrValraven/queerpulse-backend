import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { GetFeedQuery } from './dto/get-feed.query';
import { FeedService } from './feed.service';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

@Feature('feed')
@ApiTags('Feed')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('feed')
@UseGuards(ActiveMemberGuard)
export class FeedController {
  constructor(private readonly feedService: FeedService) {}

  @Get()
  @ApiOperation({ summary: 'Get your feed (cursor paginated, by tab).' })
  @ApiOkResponse({ description: 'A cursor page of feed items.' })
  getFeed(@CurrentUser() user: CurrentUserData, @Query() query: GetFeedQuery) {
    return this.feedService.getFeed(user.userId, query.tab, query.cursor);
  }
}
