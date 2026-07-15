import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { ListGlossaryQuery } from './dto/list-glossary.query';
import { ListResourcesQuery } from './dto/list-resources.query';
import { ResourcesService } from './resources.service';

// Read-only resource directory (guides — housing/health/legal/finance/trans
// life). Any active member can browse it; there's no ownership/authorship
// concept and no write endpoint (seed + read only, per the Tier 5 design
// note).
@Feature('resources')
@Controller('resources')
@UseGuards(ActiveMemberGuard)
export class ResourcesController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @Get()
  list(@Query() query: ListResourcesQuery) {
    return this.resourcesService.list(query);
  }

  @Get(':slug')
  getBySlug(@Param('slug') slug: string) {
    return this.resourcesService.getBySlug(slug);
  }
}

// Split from `ResourcesController` (mirrors `PartnerApplicationsController`
// being split from `PartnersController`) since the glossary is a distinct
// resource under the same `resources` feature flag, sharing `ResourcesService`.
@Feature('resources')
@Controller('glossary')
@UseGuards(ActiveMemberGuard)
export class GlossaryController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @Get()
  list(@Query() query: ListGlossaryQuery) {
    return this.resourcesService.listGlossary(query.category);
  }

  @Get(':slug')
  getBySlug(@Param('slug') slug: string) {
    return this.resourcesService.getGlossaryBySlug(slug);
  }
}
