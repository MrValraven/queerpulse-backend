import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { SavedListsService } from './saved-lists.service';

/**
 * The read behind a share link.
 *
 * MEMBERS ONLY, by product decision. A shared list is a record of where
 * somebody goes, so a link that leaks beyond the people it was sent to must
 * stay unreadable to anyone without a QueerPulse account. The route carries no
 * `@Public()`, so the global `JwtAuthGuard` answers a signed-out caller with a
 * 401 and `ActiveMemberGuard` answers a suspended or pending one with a 403.
 * Both run before the handler, so a caller who fails either check learns
 * nothing about whether a token exists.
 *
 * The token is the credential for the LIST: holding a valid session gets you
 * past the guards, and only the token gets you a particular list. It is 32
 * random bytes with nothing derived from the list or its owner.
 *
 * NO `Cache-Control`. The public GETs in this codebase carry a positive one so
 * a CDN can answer repeat requests; this route deliberately sets none. A cached
 * copy would outlive a revoke, and revoking is the only defence a
 * member has once a link has left their hands. A list of queer venues is a
 * record of where somebody goes, so the revoke has to be immediate.
 *
 * Throttled: the token space is far too large to walk, but there is no reason
 * for one caller to be asking hundreds of times a minute either.
 *
 * Availability is resolved through the RECIPIENT's eyes (PRD-169): every saved
 * kind but the business directory sits behind `ActiveMemberGuard` on its own
 * module, so the signed-in viewer's id decides which items they can open. The
 * payload still says nothing about the list's owner, and nothing about the
 * viewer reaches the owner.
 */
@ApiTags('Saved')
@ApiCookieAuth('access_token')
@Controller('saved-lists')
@UseGuards(ActiveMemberGuard)
export class SharedSavedListController {
  constructor(private readonly savedListsService: SavedListsService) {}

  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Get(':token')
  @ApiOperation({
    summary: 'Read a shared saved list by its link token.',
  })
  @ApiOkResponse({
    description:
      'The list’s name and its items. Nothing identifying its owner is returned.',
  })
  @ApiNotFoundResponse({
    description:
      'The token is malformed, was revoked, or never existed. The three are deliberately indistinguishable.',
  })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded.' })
  getShared(
    @CurrentUser() user: CurrentUserData,
    @Param('token') token: string,
  ) {
    return this.savedListsService.getShared(token, user.userId);
  }
}
