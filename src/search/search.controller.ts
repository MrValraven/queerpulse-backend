import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
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
  search(@CurrentUser() user: CurrentUserData, @Query() query: SearchQuery) {
    return this.searchService.search(
      user.userId,
      query.q,
      query.type,
      query.limit,
    );
  }
}
