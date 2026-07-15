import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { GetFeedQuery } from './dto/get-feed.query';
import { FeedService } from './feed.service';

@Feature('feed')
@Controller('feed')
@UseGuards(ActiveMemberGuard)
export class FeedController {
  constructor(private readonly feedService: FeedService) {}

  @Get()
  getFeed(@CurrentUser() user: CurrentUserData, @Query() query: GetFeedQuery) {
    return this.feedService.getFeed(user.userId, query.tab, query.cursor);
  }
}
