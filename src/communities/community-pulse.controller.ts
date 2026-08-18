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
import { CommunityPulseService } from './community-pulse.service';

/**
 * `@Controller('communities/:slug/pulse')` — a route path nested under
 * `communities/:slug`, but a standalone controller (not a method added to
 * `CommunitiesController`). Nest lets a controller's path be any literal
 * string regardless of which other controller "owns" the resource above it
 * in the URL, so this stays out of `communities.controller.ts` entirely —
 * that file belongs to other in-flight work in this effort.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('communities/:slug/pulse')
@UseGuards(ActiveMemberGuard)
export class CommunityPulseController {
  constructor(private readonly communityPulseService: CommunityPulseService) {}

  @Get()
  @ApiOperation({
    summary:
      "A community's own upcoming events, recent threads, and open volunteer opportunities (roster members only).",
  })
  @ApiOkResponse({ description: "The community's pulse." })
  @ApiForbiddenResponse({ description: 'Only roster members can do that.' })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  get(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.communityPulseService.getPulseBySlug(slug, user.userId);
  }
}
