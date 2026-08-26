import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
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
import { UpdateCommunityBanDto } from './dto/update-community-ban.dto';

/**
 * `@Controller('communities/:slug/bans')` — standalone controller on a nested
 * path, the convention this module follows for `CommunityPulseController` and
 * `CommunityInsightsController`. See that controller's doc comment.
 *
 * The read, revise and lift side of `community_bans`. Applying a ban belongs
 * to the moderation/removal path in `CommunitiesController`.
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
      'Who is barred from this community, who barred them, when, why, until when, and under which house rule (owner, co-owner or moderator).',
  })
  @ApiOkResponse({
    description:
      "The community's ban list, newest first, with its current house rules for the citation picker.",
  })
  @ApiForbiddenResponse({
    description: 'Owner, co-owner or moderator role required.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  list(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.communityBansService.listBySlug(slug, user.userId);
  }

  @Patch(':memberSlug')
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Revise a ban in place: give it an end date, make it permanent again, rewrite the reason, or cite a house rule.',
  })
  @ApiOkResponse({ description: 'The revised ban.' })
  @ApiBadRequestResponse({
    description:
      "Contradictory fields (an end date with `makePermanent`, or a rule with `clearRule`), a rule index outside the community's current rules, or an empty body.",
  })
  @ApiForbiddenResponse({
    description: 'Owner, co-owner or moderator role required.',
  })
  @ApiNotFoundResponse({
    description:
      'Unknown slug, an archived community, or no ban on that member here.',
  })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('memberSlug') memberSlug: string,
    @Body() dto: UpdateCommunityBanDto,
  ) {
    return this.communityBansService.updateBan(
      slug,
      user.userId,
      memberSlug,
      dto,
    );
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
