import {
  CanActivate,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { isFeatureLaunched } from '../launchedFeatures';
import { COMMUNITY_OPPORTUNITIES_LIMIT } from '../volunteering/volunteering.service';
import { CommunityPublicService } from './community-public.service';
import { CommunityOpportunitiesResponse } from './community-volunteering-response';

/**
 * Second feature gate for the community Volunteering tab, following
 * `GoTogetherLaunchGuard`. `@Feature('volunteering')` lets the global
 * `LaunchedFeaturesGuard` 404 the route while volunteering is off; that guard
 * reads a single key, so this one adds the `communities` half. With
 * communities switched off the route answers the same 404 the global guard
 * gives, so a community slug stays unconfirmable.
 *
 * Bound with `@UseGuards` after `ActiveMemberGuard`, so a signed-out caller
 * sees 401 before 404, which reveals strictly less.
 */
@Injectable()
export class CommunitiesLaunchGuard implements CanActivate {
  canActivate(): boolean {
    if (isFeatureLaunched('communities')) return true;
    throw new NotFoundException('This feature is not available yet.');
  }
}

/**
 * `@Controller('communities/:slug/volunteering')`: the community page's
 * Volunteering tab, a standalone controller nested under `communities/:slug`
 * like `CommunityPulseController`.
 *
 * It is its own class because `LaunchedFeaturesGuard` reads ONE feature key
 * per handler or class (`getAllAndOverride`), and this route belongs to the
 * `volunteering` feature: with volunteering switched off the route answers
 * the guard's 404 while the rest of the community page keeps working.
 * `CommunitiesLaunchGuard` adds the `communities` key, so the route also
 * 404s while communities are dark.
 *
 * The gates live in `CommunityPublicService.listOpenOpportunities`, beside
 * `listUpcomingGatherings`, whose posture it shares: roster members and
 * signed-in visitors of a `public` community are served, and every failing
 * case is a 404.
 */
@Feature('volunteering')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('communities/:slug/volunteering')
@UseGuards(ActiveMemberGuard, CommunitiesLaunchGuard)
export class CommunityVolunteeringController {
  constructor(
    private readonly communityPublicService: CommunityPublicService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      "A community's open volunteer opportunities, newest first, with the total count (roster members, and signed-in visitors of a public community).",
  })
  @ApiOkResponse({
    description: `Up to ${COMMUNITY_OPPORTUNITIES_LIMIT} open opportunities and the total. A space answers an empty page.`,
  })
  @ApiForbiddenResponse({ description: 'Only active members can do that.' })
  @ApiNotFoundResponse({
    description:
      'Unknown slug, a community the caller may not see, or a gated community the caller is off the roster of.',
  })
  list(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ): Promise<CommunityOpportunitiesResponse> {
    return this.communityPublicService.listOpenOpportunities(slug, user.userId);
  }
}
