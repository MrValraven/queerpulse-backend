import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { ListGlossaryQuery } from './dto/list-glossary.query';
import { ListResourcesQuery } from './dto/list-resources.query';
import { ResourcesService } from './resources.service';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

// Read-only resource directory (guides — housing/health/legal/finance/trans
// life). Any active member can browse it; there's no ownership/authorship
// concept and no write endpoint (seed + read only, per the Tier 5 design
// note).
@Feature('resources')
@ApiTags('Resources')
@ApiCookieAuth('access_token')
@Controller('resources')
@UseGuards(ActiveMemberGuard)
export class ResourcesController {
  constructor(private readonly resourcesService: ResourcesService) {}

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
