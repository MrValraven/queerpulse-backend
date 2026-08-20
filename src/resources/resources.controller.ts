import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CreateResourceSuggestionDto } from './dto/create-resource-suggestion.dto';
import { ListGlossaryQuery } from './dto/list-glossary.query';
import { ListResourceListingsQuery } from './dto/list-resource-listings.query';
import { ListResourcesQuery } from './dto/list-resources.query';
import { ResourceListingsService } from './resource-listings.service';
import { ResourceSuggestionsService } from './resource-suggestions.service';
import { ResourcesService } from './resources.service';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

// Read-only resource directory (guides — housing/health/legal/finance/trans
// life). Any active member can browse it; there's no ownership/authorship
// concept and no write endpoint on the guide side (seed + read only). Also
// hosts CNT-14's two additions: the real Legal Aid / Sexual Health Testing
// listings directory (`GET /listings`) and the "suggest a resource"
// submission pathway (`POST /suggestions`) that feeds the admin review queue
// (`AdminResourceSuggestionsController`).
@Feature('resources')
@ApiTags('Resources')
@ApiCookieAuth('access_token')
@Controller('resources')
@UseGuards(ActiveMemberGuard)
export class ResourcesController {
  constructor(
    private readonly resourcesService: ResourcesService,
    private readonly resourceListingsService: ResourceListingsService,
    private readonly resourceSuggestionsService: ResourceSuggestionsService,
  ) {}

  // NOTE: this MUST stay declared before `getBySlug(':slug')` below — Nest
  // matches routes on the same controller in declaration order, and a
  // `:slug` wildcard registered first would swallow `/resources/listings` as
  // slug="listings" before this handler ever ran.
  @Get('listings')
  @ApiOperation({
    summary: 'List active resource listings, optionally by category',
  })
  @ApiOkResponse({
    description: 'Active Legal Aid / Sexual Health Testing listings.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  listListings(@Query() query: ListResourceListingsQuery) {
    return this.resourceListingsService.list(query.category);
  }

  @Post('suggestions')
  @ApiOperation({
    summary: 'Suggest a Legal Aid / Sexual Health Testing resource',
  })
  @ApiCreatedResponse({
    description: 'The suggestion was recorded as pending.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  createSuggestion(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateResourceSuggestionDto,
  ) {
    return this.resourceSuggestionsService.create(user.userId, dto);
  }

  @ApiOperation({ summary: 'List published resources, optionally by category' })
  @ApiOkResponse({ description: 'A page of published resources.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @Get()
  list(@Query() query: ListResourcesQuery) {
    return this.resourcesService.list(query);
  }

  @ApiOperation({ summary: 'Get a published resource by slug' })
  @ApiOkResponse({ description: 'The resource.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @ApiNotFoundResponse({
    description: 'No published resource with that slug.',
  })
  @Get(':slug')
  getBySlug(@Param('slug') slug: string) {
    return this.resourcesService.getBySlug(slug);
  }
}

// Split from `ResourcesController` (mirrors `PartnerApplicationsController`
// being split from `PartnersController`) since the glossary is a distinct
// resource under the same `resources` feature flag, sharing `ResourcesService`.
@Feature('resources')
@ApiTags('Resources')
@ApiCookieAuth('access_token')
@Controller('glossary')
@UseGuards(ActiveMemberGuard)
export class GlossaryController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @ApiOperation({ summary: 'List glossary terms, optionally by category' })
  @ApiOkResponse({ description: 'The matching glossary terms, alphabetical.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @Get()
  list(@Query() query: ListGlossaryQuery) {
    return this.resourcesService.listGlossary(query.category);
  }

  @ApiOperation({ summary: 'Get a glossary term by slug' })
  @ApiOkResponse({ description: 'The glossary term.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @ApiNotFoundResponse({ description: 'No glossary term with that slug.' })
  @Get(':slug')
  getBySlug(@Param('slug') slug: string) {
    return this.resourcesService.getGlossaryBySlug(slug);
  }
}
