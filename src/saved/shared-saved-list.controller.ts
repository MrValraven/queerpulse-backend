import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { UserStatus } from '../users/entities/user.entity';
import { SavedListsService } from './saved-lists.service';

/**
 * The read behind a share link.
 *
 * `@Public()` because the whole point is sending it to a friend who has just
 * moved to the city and may not have an account yet. The token is therefore the
 * ONE credential, which is exactly the trust model
 * `GET /calendar/feed/:token` already runs on, and it is why the token is 32
 * random bytes rather than anything derived from the list or its owner.
 *
 * NO `Cache-Control`. Every other public GET in this codebase carries a
 * positive one so a CDN can answer repeat requests; this one deliberately does
 * not. A cached copy would outlive a revoke, and revoking is the only defence a
 * member has once a link has left their hands. A list of queer venues is a
 * record of where somebody goes, so the revoke has to be immediate.
 *
 * Throttled: the token space is far too large to walk, but there is no reason
 * for one caller to be asking hundreds of times a minute either.
 *
 * OPTIONALLY AUTHENTICATED (PRD-169). The route stays open to somebody with no
 * account, and it now also NOTICES when the recipient does have one, because
 * every saved kind but the business directory sits behind `ActiveMemberGuard`
 * on its own module. Without this, a member opening a friend's list would be
 * told a community and a thread they can plainly read are "no longer
 * available", purely because the endpoint never looked at who was asking. It
 * discloses nothing extra about the LIST (the payload is unchanged and still
 * says nothing about its owner) and nothing about the viewer to the owner.
 */
@ApiTags('Saved')
@Controller('saved-lists')
export class SharedSavedListController {
  constructor(private readonly savedListsService: SavedListsService) {}

  @Public()
  @UseGuards(OptionalJwtAuthGuard)
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
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded.' })
  getShared(
    // Populated best-effort by `OptionalJwtAuthGuard`; undefined when
    // anonymous. Only an ACTIVE member counts as a viewer, matching the bar
    // `ActiveMemberGuard` sets on every subject module's own read (the same
    // narrowing `DirectoryController.getDirectoryListing` applies).
    @CurrentUser() user: CurrentUserData | undefined,
    @Param('token') token: string,
  ) {
    const viewerId =
      user?.status === UserStatus.Active ? (user?.userId ?? null) : null;
    return this.savedListsService.getShared(token, viewerId);
  }
}
