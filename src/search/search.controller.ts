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
import type { SearchTypesDTO } from './search-response';
import { SearchService } from './search.service';

@ApiTags('Search')
@ApiCookieAuth()
@Controller('search')
@UseGuards(ActiveMemberGuard)
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  /**
   * The result types search can currently answer with.
   *
   * Separate from `GET /search` rather than a field on its response, because
   * a client renders its category tabs BEFORE the member has typed anything:
   * riding along with the results would leave the tab strip wrong until the
   * first query landed, and wrong again on the browse view a cleared input
   * returns to. It reads a compile-time registry and touches no database, so
   * the extra call costs a round trip and nothing else.
   */
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Get('types')
  @ApiOperation({
    summary:
      'The search result types whose feature is currently launched (see `launchedFeatures.ts`). A type missing here runs no query in `GET /search` and asking for it by `type` returns an empty page, so a client should not offer it as a category.',
  })
  @ApiOkResponse({
    description: 'The launched result types, in search grouping order.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  searchTypes(): SearchTypesDTO {
    return this.searchService.launchedTypes();
  }

  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Get()
  @ApiOperation({
    summary:
      'Global search across members, communities, events, forum threads, forum replies, businesses, magazine, jobs, housing, resources, subprofiles and topics. Ranked and accent-insensitive; `type` + `offset` page one category. A result type whose feature is not launched (see `launchedFeatures.ts`) is omitted, and asking for it by `type` returns an empty page.',
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
