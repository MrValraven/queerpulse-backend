import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, seconds } from '@nestjs/throttler';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { SearchQuery } from './dto/search.query';
import { SearchService } from './search.service';

@ApiTags('Search')
@ApiCookieAuth()
@Controller('search')
@UseGuards(ActiveMemberGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Get()
  @ApiOperation({
    summary:
      'Global search across members, communities, events, forum threads, forum replies, businesses, magazine, jobs, housing, resources, subprofiles and topics. Ranked and accent-insensitive; `type` + `offset` page one category.',
  })
  @ApiOkResponse({
    description: 'Grouped, per-type-capped search results for the query.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  search(@CurrentUser() user: CurrentUserData, @Query() query: SearchQuery) {
    return this.searchService.search(
      user.userId,
      query.q,
      query.type,
      query.limit,
      query.offset,
    );
  }
}
