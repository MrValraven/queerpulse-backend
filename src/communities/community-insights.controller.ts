import { Controller, Get, Param, UseGuards } from '@nestjs/common';
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
import { CommunityInsightsService } from './community-insights.service';

/**
 * `@Controller('communities/:slug/insights')` — same "own controller path,
 * not a method on `CommunitiesController`" shape as
 * `CommunityPulseController`; see that controller's doc comment for why.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('communities/:slug/insights')
@UseGuards(ActiveMemberGuard)
export class CommunityInsightsController {
  constructor(
    private readonly communityInsightsService: CommunityInsightsService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Aggregate membership/post-volume stats for a community (owner/mod only).',
  })
  @ApiOkResponse({ description: "The community's insights." })
  @ApiForbiddenResponse({ description: 'Owner or moderator role required.' })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  get(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.communityInsightsService.getInsightsBySlug(slug, user.userId);
  }
}
