import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
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
import { CommunityInvitesService } from './community-invites.service';
import { CreateCommunityInvitesDto } from './dto/create-community-invites.dto';

/**
 * `@Controller('communities/:slug/invites')` — standalone controller on a
 * nested path, the convention this module follows for `CommunityPulseController`
 * and `CommunityInsightsController`. See that controller's doc comment.
 *
 * One route, owner/co-owner/moderator only, throttled to `10 per 60s`. That
 * is tighter than the `20 per 60s` the post/reply writes carry, because each
 * accepted call already fans out to up to 25 people: the pair of limits is
 * what keeps this from becoming a way to page the member directory.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('communities/:slug/invites')
@UseGuards(ActiveMemberGuard)
export class CommunityInvitesController {
  constructor(
    private readonly communityInvitesService: CommunityInvitesService,
  ) {}

  @Post()
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Invite members to a community (owner, co-owner or moderator). Sends an invitation; never adds anyone to the roster.',
  })
  @ApiCreatedResponse({
    description:
      'A summary of who was invited and who was skipped, with the reason for each skip.',
  })
  @ApiBadRequestResponse({
    description: 'No slugs were sent, or more than the per-call cap.',
  })
  @ApiForbiddenResponse({
    description: 'Owner, co-owner or moderator role required.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  invite(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateCommunityInvitesDto,
  ) {
    return this.communityInvitesService.invite(slug, user.userId, dto);
  }
}
