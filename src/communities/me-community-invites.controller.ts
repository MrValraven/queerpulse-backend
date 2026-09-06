import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
import { CommunityInvitesService } from './community-invites.service';

/**
 * `GET /me/community-invites` and `DELETE /me/community-invites/:id` — the
 * invitee's own half of a community invitation (PRD-140, PRD-141).
 *
 * Its own controller rather than a method bolted onto an existing one, the
 * same "a new endpoint brings its own controller" convention
 * `MeCommunityDigestController` and `CommunityPulseController` follow in this
 * module, so a feature never has to edit a file another effort is holding.
 *
 * Why the endpoint exists at all: until now an invitation was a notification
 * and nothing else, so the only place it lived was a bell that scrolled away.
 * A member who missed it had no way back to it, and for a `private` community
 * there was nothing else to find, since the community itself 404s anybody who
 * is not on its roster. This is the standing list, and it is also where an
 * invitation lands when the bell that should have announced it failed to
 * send. ACCEPTING is not here: the invitee accepts by walking through the
 * ordinary front door, `POST /communities/:slug/join`, which is what keeps
 * the house rules and every other gate between them and the room.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('me/community-invites')
@UseGuards(ActiveMemberGuard)
export class MeCommunityInvitesController {
  constructor(
    private readonly communityInvitesService: CommunityInvitesService,
  ) {}

  @Get()
  // Each response resolves the community cards, the roster and ban checks and
  // the inviter profiles in a handful of batched queries, so it is worth a
  // tighter ceiling than the global default.
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      "The caller's standing community invitations, newest first, each carrying the community card and who sent it.",
  })
  @ApiOkResponse({
    description:
      'Pending invitations only. An invitation to a community that has since been archived or taken down, or one the caller has since joined or been barred from, is left out: it leads nowhere.',
  })
  listMine(@CurrentUser() user: CurrentUserData) {
    return this.communityInvitesService.listMine(user.userId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      "Decline a standing invitation. The community is not notified: saying no is the invitee's own business.",
  })
  @ApiNoContentResponse({ description: 'The invitation was declined.' })
  @ApiForbiddenResponse({
    description: 'The invitation is addressed to somebody else.',
  })
  @ApiNotFoundResponse({ description: 'No such invitation.' })
  @ApiConflictResponse({
    description: 'The invitation has already been answered.',
  })
  declineMine(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.communityInvitesService.declineMine(id, user.userId);
  }
}
