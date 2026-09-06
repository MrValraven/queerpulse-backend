import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
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

// Public resource directory (guides — health/legal/trans life/safety/
// community/culture/finance). Anyone can browse it, signed in or not: the four
// reads that back the public pages carry `@Public()` and answer an anonymous
// caller. The write side lives on `AdminResourcesController` (CON-08), so this
// controller stays read-only by design rather than for want of an authoring
// path. Also hosts CNT-14's two additions: the real Legal Aid / Sexual Health
// Testing listings directory (`GET /listings`) and the "suggest a resource"
// submission pathway (`POST /suggestions`) that feeds the admin review queue
// (`AdminResourceSuggestionsController`).
//
// The class guard is still `ActiveMemberGuard`, and it is still the default:
// `POST /suggestions` and `GET /suggestions/mine` are member-only, and
// anything added here later inherits the gate unless it opts out. `@Public()`
// on a handler is sufficient to override it — `ActiveMemberGuard` reads the
// same `IS_PUBLIC_KEY` as the global `JwtAuthGuard` and returns true for a
// public handler.
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
  // `@Public()` for the same reason as the three guide reads below, and with
  // more urgency: this is the legal-aid and HIV/STI-testing directory behind
  // `/resources/legal` and `/resources/sexual-health`, both of them ungated
  // pages. Somebody who needs a lawyer or a testing clinic must not be asked
  // to sign up first, and while this read was member-only they were shown a
  // "could not load, retry" panel that retrying never fixed.
  //
  // Nothing here is caller-specific. `ResourceListingResponseDTO` is an
  // organisation's own published title, description, region and contact
  // details — never `status`, `createdBy`/`updatedBy` or timestamps — so the
  // anonymous response is identical to the member one.
  @Public()
  @Get('listings')
  @ApiOperation({
    summary:
      'List active resource listings, optionally by category (unauthenticated)',
  })
  @ApiOkResponse({
    description: 'Active Legal Aid / Sexual Health Testing listings.',
  })
  listListings(@Query() query: ListResourceListingsQuery) {
    return this.resourceListingsService.list(query.category);
  }

  // Same declaration-order rule as `listListings` above: this MUST stay
  // before `getBySlug(':slug')` or a slug wildcard swallows "/resources/index".
  // `@Public()` on the three guide reads (this one, `list` and `getBySlug`).
  // The guide PAGES are deliberately reachable by a logged-out visitor — a
  // questioning teenager, or somebody in crisis, must not have to sign up
  // first — so the data behind them has to answer an anonymous caller too.
  // Without it the global `JwtAuthGuard` and the class-level
  // `ActiveMemberGuard` both reject before the handler runs, the frontend
  // reads that rejection as "could not ask" and falls open, and the editorial
  // review gate would bind signed-in members only. None of the three
  // responses is caller-specific, so there is nothing here to leak.
  @Public()
  @Get('index')
  @ApiOperation({
    summary: 'Every published, editorially reviewed guide, for the guide index',
  })
  @ApiOkResponse({
    description:
      'Every published guide an editor has reviewed: slug, title, category, route. Never-reviewed guides are omitted.',
  })
  listIndex() {
    return this.resourcesService.listIndex();
  }

  // Declared before `getBySlug(':slug')` for the same declaration-order
  // reason as `listListings` above. `/resources/suggestions/mine` is three
  // segments and `:slug` is one, so it would not actually be swallowed today,
  // but keeping every literal route above the wildcard is the rule this
  // controller already follows and the next literal route may not be so
  // lucky.
  @Get('suggestions/mine')
  @ApiOperation({
    summary: 'Your own resource suggestions and what was decided on each',
  })
  @ApiOkResponse({
    description:
      "Your suggestions, newest first, each with its status, when it was decided, and the reviewer's note.",
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  listMySuggestions(@CurrentUser() user: CurrentUserData) {
    return this.resourceSuggestionsService.listMine(user.userId);
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

  @Public()
  @ApiOperation({
    summary:
      'List published, editorially reviewed resources, optionally by category',
  })
  @ApiOkResponse({
    description: 'A page of published, editorially reviewed resources.',
  })
  @Get()
  list(@Query() query: ListResourcesQuery) {
    return this.resourcesService.list(query);
  }

  @Public()
  @ApiOperation({
    summary: 'Get a published, editorially reviewed resource by slug',
  })
  @ApiOkResponse({ description: 'The resource.' })
  @ApiNotFoundResponse({
    description:
      'No published resource with that slug, or it has never been reviewed by an editor.',
  })
  @Get(':slug')
  getBySlug(@Param('slug') slug: string) {
    return this.resourcesService.getBySlug(slug);
  }
}

// Split from `ResourcesController` (mirrors `PartnerApplicationsController`
// being split from `PartnersController`) since the glossary is a distinct
// resource under the same `resources` feature flag, sharing `ResourcesService`.
//
// Both reads are `@Public()`. `/resources/glossary` is ungated in the
// frontend's `authGate.ts`, and a page whose purpose is to explain the words
// to somebody who does not know them yet is precisely the page a stranger
// arrives on. Neither response takes a caller into account: a glossary term is
// a term, identical for everyone.
//
// The class guard stays bound so that anything added here later (an
// authenticated "suggest a term", say) is member-only by default.
@Feature('resources')
@ApiTags('Resources')
@ApiCookieAuth('access_token')
@Controller('glossary')
@UseGuards(ActiveMemberGuard)
export class GlossaryController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @Public()
  @ApiOperation({
    summary: 'List glossary terms, optionally by category (unauthenticated)',
  })
  @ApiOkResponse({ description: 'The matching glossary terms, alphabetical.' })
  @Get()
  list(@Query() query: ListGlossaryQuery) {
    return this.resourcesService.listGlossary(query.category);
  }

  @Public()
  @ApiOperation({ summary: 'Get a glossary term by slug (unauthenticated)' })
  @ApiOkResponse({ description: 'The glossary term.' })
  @ApiNotFoundResponse({ description: 'No glossary term with that slug.' })
  @Get(':slug')
  getBySlug(@Param('slug') slug: string) {
    return this.resourcesService.getGlossaryBySlug(slug);
  }
}
