import {
  Controller,
  DefaultValuePipe,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiCookieAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
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
 *
 * SECOND ROUTE (PRD-145): `GET /communities/:slug/upcoming-gatherings`, the
 * Events tab a signed-in member sees for a community they have NOT joined.
 * That one is authenticated (a method-level `ActiveMemberGuard`, never a
 * class-level one, so the teaser above keeps reaching anonymous visitors) and
 * uncached. It shares this file because it asks the same question the teaser
 * asks: what may somebody outside the roster be shown.
 *
 * THIRD ROUTE: `GET /communities/:slug/gate`, the gate card a signed-in
 * caller sees for a community they are not on the roster of and whose tier is
 * not `public`. Also a method-level `ActiveMemberGuard`, also uncached, for
 * the same reasons as the second route. All three routes in this controller
 * answer the same question, "what may somebody outside a community's roster
 * be shown of it", at three different distances.
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

  /**
   * The gate card behind a closed community's link, for a signed-in caller who
   * is not on its roster. Paired with the `COMMUNITY_MEMBERS_ONLY` 403 that
   * `CommunitiesService.getBySlug` now answers for the same community: the
   * client turns that refusal into this card.
   *
   * NO `Cache-Control`, for the same reason `upcoming-gatherings` below
   * carries none: the answer depends on the caller. An invited viewer gets a
   * private community's card where an uninvited one gets a 404, so a shared
   * cache must never hold it.
   */
  @UseGuards(ActiveMemberGuard)
  @Get(':slug/gate')
  @ApiCookieAuth()
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiOperation({
    summary:
      'What a signed-in non-member may see of a community whose tier is not public.',
  })
  @ApiOkResponse({
    description:
      'Name, tagline, purpose, type, tier, tags, place, languages, member count, images, and the next public gathering. Never the roster, any post, the owner, or the rules.',
  })
  @ApiNotFoundResponse({
    description:
      'Unknown slug, a private community the caller holds no invitation to, or one archived or taken down. Always 404, never 403, so existence is not leaked.',
  })
  getGateCard(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.communityPublicService.getGateCard(slug, user.userId);
  }

  /**
   * PRD-145 — the Events tab a PROSPECTIVE member sees.
   *
   * SIGNED IN, and deliberately so: this is not a second signed-out surface.
   * The guard is bound at the METHOD level rather than the class, because
   * `getPublicTeaser` above is `@Public()` and this controller's whole reason
   * to exist separately is that it carries no class-level `ActiveMemberGuard`
   * (see the class doc). The route lives here because the "who is allowed to
   * see this community, and which of its gatherings" reasoning is already in
   * `CommunityPublicService`, next to the signed-out teaser's own
   * next-gathering lookup.
   *
   * It carries NO `Cache-Control`: unlike the teaser, the answer depends on
   * the caller (a private community's roster member gets a page where a
   * stranger gets a 404), so a shared cache must never hold it.
   */
  @UseGuards(ActiveMemberGuard)
  @Get(':slug/upcoming-gatherings')
  @ApiCookieAuth()
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiOperation({
    summary:
      "A community's upcoming gatherings, for a signed-in member who is not on its roster.",
  })
  @ApiOkResponse({
    description:
      'One bounded page of published, upcoming, public- or members-visibility gatherings, soonest first. Never a members-only gathering, never a post, never the roster.',
  })
  @ApiNotFoundResponse({
    description:
      'Unknown slug, a private community the caller is not on the roster of, or one archived or taken down. Always 404, never 403, so existence is not leaked.',
  })
  listUpcomingGatherings(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
  ) {
    return this.communityPublicService.listUpcomingGatherings(
      slug,
      user.userId,
      page,
    );
  }
}
