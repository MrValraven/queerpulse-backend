import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
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
import { SuggestedMembersQuery } from './dto/suggested-members.query';
import { MemberSuggestionsService } from './member-suggestions.service';

/**
 * People discovery (SOC-05).
 *
 * Lives on `/members/suggested` alongside the directory, and deliberately not
 * under `/feed`: the same list backs the feed strip and the empty state on
 * `/account/connections`, and duplicating it per surface is how two surfaces
 * end up disagreeing about who a member has already waved away.
 *
 * There is no `@Feature` tag here for the same reason `MembersController` has
 * none: the member directory is infrastructure that is always on.
 *
 * No route collision: `ProfilesController`'s `@Controller('members')` owns
 * only `GET /members`, and `VouchController`'s member routes are all two
 * segments (`members/:slug/vouch`), so a literal `suggested` segment is
 * unambiguous.
 */
@ApiTags('Profiles')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
@ApiForbiddenResponse({ description: 'Caller is not an active member.' })
@Controller('members/suggested')
@UseGuards(ActiveMemberGuard)
export class MemberSuggestionsController {
  constructor(private readonly memberSuggestions: MemberSuggestionsService) {}

  @Get()
  @ApiOperation({
    summary: 'People you might know, each with the reason behind it.',
  })
  @ApiOkResponse({
    description:
      'Up to `limit` members, strongest tie first. Empty when there is no explainable suggestion to make.',
  })
  async list(
    @CurrentUser() user: CurrentUserData,
    @Query() query: SuggestedMembersQuery,
  ) {
    return {
      items: await this.memberSuggestions.suggest(user.userId, query.limit),
    };
  }

  /**
   * Carries the same `20 per 60s` per-route throttle the codebase's other
   * cheap toggles do, so the flat POST can't be the least expensive thing on
   * the API to hammer.
   */
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post(':slug/dismiss')
  @ApiOperation({
    summary: 'Stop suggesting this member to me (idempotent).',
  })
  @ApiCreatedResponse({
    description: 'They will not be offered in your suggestions again.',
  })
  @ApiNotFoundResponse({ description: 'No such member.' })
  dismiss(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.memberSuggestions.dismiss(user.userId, slug);
  }
}
