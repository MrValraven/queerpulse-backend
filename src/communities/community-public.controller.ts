import { Controller, Get, Header, Param } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { Feature } from '../common/feature.decorator';
import { CommunityPublicService } from './community-public.service';
import {
  PUBLIC_READ_CACHE,
  PUBLIC_READ_CDN_CACHE,
} from '../common/public-read-cache';

/**
 * `GET /communities/:slug/public` — the signed-out teaser behind a shared
 * community link. Owner opt-in, default off; see `CommunityPublicService` for
 * the three conditions and `PublicCommunityResponse` for the closed field
 * list.
 *
 * GUARD CHAIN, which is why this is its own controller with NO class-level
 * guard. The app binds Throttler, then `LaunchedFeaturesGuard`, then CSRF,
 * then JWT globally. `@Public()` opts the route out of JWT (and CSRF has
 * nothing to check on a GET), so an anonymous visitor reaches the handler.
 * `@Feature('communities')` still applies, so the route 404s while the feature
 * is unlaunched, which is the right answer for a public URL. What must NOT
 * happen is this route joining a controller that carries a class-level
 * `ActiveMemberGuard`: that is exactly why `DirectoryController` and
 * `RoadmapPublicController` are split off from their member-facing siblings,
 * and this controller follows them.
 *
 * The route is unauthenticated, so it carries its own `@Throttle` rather than
 * relying on the global 120/minute default. The response is caller-agnostic
 * (no `@CurrentUser()`, no session-scoped filtering), so it also carries a
 * short positive `Cache-Control` and repeat anonymous hits can be answered by
 * the CDN without touching Postgres.
 */
@Feature('communities')
@ApiTags('Communities')
@Controller('communities')
export class CommunityPublicController {
  constructor(
    private readonly communityPublicService: CommunityPublicService,
  ) {}

  @Public()
  @Get(':slug/public')
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Header('Cache-Control', PUBLIC_READ_CACHE)
  @Header('CDN-Cache-Control', PUBLIC_READ_CDN_CACHE)
  @ApiOperation({
    summary:
      'The signed-out teaser for a community whose owner opted into public listing.',
  })
  @ApiOkResponse({
    description:
      'Name, tagline, purpose, type, tags, place, languages, member count, images, and the next public gathering. Never the roster, any post, the owner, or the rules.',
  })
  @ApiNotFoundResponse({
    description:
      'Unknown slug, not publicly listed, archived, or an invite/private community. Always 404, never 403, so the endpoint does not confirm a community exists.',
  })
  getPublicTeaser(@Param('slug') slug: string) {
    return this.communityPublicService.getPublicTeaser(slug);
  }
}
