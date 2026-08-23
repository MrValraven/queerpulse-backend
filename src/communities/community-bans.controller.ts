import { Controller, Delete, Get, Param, UseGuards } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
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
import { CommunityBansService } from './community-bans.service';

/**
 * `@Controller('communities/:slug/bans')` — standalone controller on a nested
 * path, the convention this module follows for `CommunityPulseController` and
 * `CommunityInsightsController`. See that controller's doc comment.
 *
 * The read and lift side of `community_bans`. Applying a ban belongs to the
 * moderation/removal path in `CommunitiesController`, not here.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('communities/:slug/bans')
@UseGuards(ActiveMemberGuard)
export class CommunityBansController {
  constructor(private readonly communityBansService: CommunityBansService) {}

  @Get()
  @ApiOperation({
    summary:
      'Who is barred from this community, who barred them, when, and why (owner, co-owner or moderator).',
  })
  @ApiOkResponse({ description: "The community's ban list, newest first." })
  @ApiForbiddenResponse({
    description: 'Owner, co-owner or moderator role required.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  list(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.communityBansService.listBySlug(slug, user.userId);
  }

  @Delete(':memberSlug')
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Lift a ban (owner, co-owner or moderator). Reopens the door; it does not put the member back on the roster.',
  })
  @ApiOkResponse({ description: 'The ban was lifted (`{ ok: true }`).' })
  @ApiForbiddenResponse({
    description: 'Owner, co-owner or moderator role required.',
  })
  @ApiNotFoundResponse({
    description:
      'Unknown slug, an archived community, or no ban on that member here.',
  })
  lift(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('memberSlug') memberSlug: string,
  ) {
    return this.communityBansService.liftBan(slug, user.userId, memberSlug);
  }
}
