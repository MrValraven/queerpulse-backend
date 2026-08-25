import { Controller, Get, Header } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { Feature } from '../common/feature.decorator';
import { RoadmapService } from './roadmap.service';
import {
  PUBLIC_READ_CACHE,
  PUBLIC_READ_CDN_CACHE,
} from '../common/public-read-cache';

/**
 * Public, read-only surface behind `/about/roadmap`. Deliberately a SEPARATE
 * controller from `RoadmapController`: that one carries a class-level
 * `ActiveMemberGuard`, and `ActiveMemberGuard` does NOT honor `@Public()` (it
 * unconditionally requires an active member), so the public read cannot live
 * under it — mirrors `DirectoryController`'s split from `ListingsController`.
 */
@Feature('roadmap')
@ApiTags('Roadmap')
@Controller('roadmap')
export class RoadmapPublicController {
  constructor(private readonly roadmapService: RoadmapService) {}

  @ApiOperation({ summary: 'Get the public roadmap (unauthenticated)' })
  @ApiOkResponse({
    description:
      'Hero stats (label/value/note) plus shipped, building, planned, ' +
      'backlog, top-idea, and not-building entries. Item cards carry a ' +
      'public-safe `committed`/`latestSlip` (reason only). Only ' +
      '`isPublic && !archived` items surface.',
  })
  @Public()
  @Get()
  // Same caller-agnostic response for every anonymous visitor — see
  // AUDIT-2026-07-30.md §I "No CDN cache headers on public GETs" /
  // `caching-and-cost.md`.
  @Header('Cache-Control', PUBLIC_READ_CACHE)
  @Header('CDN-Cache-Control', PUBLIC_READ_CDN_CACHE)
  getPublic() {
    return this.roadmapService.getPublic();
  }
}
