import { Controller, Get, UseGuards } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiCookieAuth,
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
import { CommunityDigestService } from './community-digest.service';

/**
 * `GET /me/communities/digest` — the caller's own week across the communities
 * they belong to.
 *
 * Its own controller rather than a second method on `MeCommunitiesController`,
 * the same "a new endpoint brings its own controller and service" convention
 * `CommunityPulseController` and `CommunityInsightsController` follow in this
 * module, so a feature never has to edit a file another effort is holding.
 * Nest matches the literal `digest` segment here independently of the bare
 * `@Get()` on `MeCommunitiesController`, so the two coexist under the same
 * path prefix with no ordering requirement between them.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('me/communities')
@UseGuards(ActiveMemberGuard)
export class MeCommunityDigestController {
  constructor(
    private readonly communityDigestService: CommunityDigestService,
  ) {}

  @Get('digest')
  // The response is a six-query fan-out over every community the caller
  // belongs to, so it is worth a tighter ceiling than the global default.
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      "The last seven days across the caller's communities: new posts, new members, upcoming gatherings, and a couple of post excerpts each.",
  })
  @ApiOkResponse({
    description:
      "The caller's weekly digest. Muted communities are excluded, and a bare array is never returned: the envelope carries the window start.",
  })
  getDigest(@CurrentUser() user: CurrentUserData) {
    return this.communityDigestService.getDigest(user.userId);
  }
}
