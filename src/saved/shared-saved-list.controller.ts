import { Controller, Get, Param } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
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
 */
@ApiTags('Saved')
@Controller('saved-lists')
export class SharedSavedListController {
  constructor(private readonly savedListsService: SavedListsService) {}

  @Public()
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
  getShared(@Param('token') token: string) {
    return this.savedListsService.getShared(token);
  }
}
