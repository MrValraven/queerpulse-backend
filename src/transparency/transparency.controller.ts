import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { Feature } from '../common/feature.decorator';
import {
  PUBLIC_READ_CACHE,
  PUBLIC_READ_CDN_CACHE,
} from '../common/public-read-cache';
import { TransparencyReportQuery } from './dto/transparency-report.query';
import { TransparencyService } from './transparency.service';

/**
 * The public Transparency Report, behind `/about/governance/transparency`.
 *
 * Unauthenticated on purpose: a report the collective only shows its own
 * members is not a transparency report, and the Constitution promises it to
 * anyone reading. It is a separate module from `governance` (whose controller
 * carries member-facing routes) for the same reason `RoadmapPublicController`
 * is separate from `RoadmapController`: the public read has a different
 * audience, a different cache policy, and a different privacy contract, and
 * keeping it in its own file makes that contract auditable in one place.
 *
 * The response is aggregate-only. `TransparencyService`'s header comment
 * states the rule and `transparency-response.ts` justifies it field by field.
 */
@Feature('governance')
@ApiTags('Transparency')
@Controller('transparency')
export class TransparencyController {
  constructor(private readonly transparency: TransparencyService) {}

  @ApiOperation({
    summary: 'Get the public Transparency Report (unauthenticated)',
  })
  @ApiOkResponse({
    description:
      'Aggregate moderation figures for one calendar quarter: reports ' +
      'received by category, reports resolved, median and p90 hours to ' +
      'resolution, moderator actions by type, appeals filed and their ' +
      'outcomes, communities frozen, and legal, government and ' +
      'law-enforcement demands for member data by type and outcome with the ' +
      'accounts affected and notified. Counts below the published ' +
      'small-count floor are withheld. The legal-request section is always ' +
      'present and publishes an explicit zero on an empty register. No ' +
      'per-member data is served.',
  })
  @Public()
  @Get('report')
  // Identical for every anonymous caller across the whole period, so it is
  // exactly the kind of response a shared cache should hold. `Cache-Control`
  // and `CDN-Cache-Control` are split rather than fused: a
  // `stale-while-revalidate` that reaches a browser is not scoped to shared
  // caches and breaks read-your-own-writes elsewhere on the site. See
  // `../common/public-read-cache.ts`.
  @Header('Cache-Control', PUBLIC_READ_CACHE)
  @Header('CDN-Cache-Control', PUBLIC_READ_CDN_CACHE)
  getReport(@Query() query: TransparencyReportQuery) {
    return this.transparency.getReport(query.period ?? 'current');
  }
}
