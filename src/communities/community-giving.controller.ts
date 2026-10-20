import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
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
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { CommunityGivingService } from './community-giving.service';
import { UpdateCommunityGivingDto } from './dto/update-community-giving.dto';

/**
 * `@Controller('communities/:slug/giving')`: a route path nested under
 * `communities/:slug` served by a standalone controller, the same convention
 * `CommunityResourcesController` follows. A community's giving section is
 * shown as "Support" in the UI.
 *
 * Reads pass the same gate as the community post board. The one write
 * replaces the whole section and is owner or co-owner only; it carries the
 * `20 per 60s` per-route throttle the other community writes use, and the
 * global CSRF guard applies as on every state-changing route.
 *
 * The signed-out teaser deliberately has no giving route, so phone numbers
 * and IBANs are never reachable without an account.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('communities/:slug/giving')
@UseGuards(ActiveMemberGuard)
export class CommunityGivingController {
  constructor(
    private readonly communityGivingService: CommunityGivingService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      "A community's Support section: intro and ways to give (same read gate as the post board).",
  })
  @ApiOkResponse({
    description:
      'The intro, the methods in the order the owner chose, and when the section last changed.',
  })
  @ApiForbiddenResponse({
    description:
      'Members only (`COMMUNITY_MEMBERS_ONLY`) for a non-member of a request or invite tier community.',
  })
  @ApiNotFoundResponse({
    description:
      'Unknown slug, a private community the caller is outside of, or a community hidden from the caller.',
  })
  get(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.communityGivingService.getBySlug(slug, user.userId);
  }

  @Put()
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Replace the whole Support section (owner or co-owner). Writes one governance log entry.',
  })
  @ApiOkResponse({ description: 'The stored section after the write.' })
  @ApiBadRequestResponse({
    description:
      'The payload is invalid, or a coded refusal: `GIVING_TOO_MANY_METHODS`, `GIVING_LINK_INVALID`, `GIVING_MBWAY_INVALID` or `GIVING_IBAN_INVALID` (the last three carry the row `index`).',
  })
  @ApiForbiddenResponse({
    description:
      'Owner or co-owner role required, or the account is restricted.',
  })
  @ApiNotFoundResponse({
    description:
      'Unknown slug, an archived community, or a private community the caller is outside of.',
  })
  replace(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateCommunityGivingDto,
  ) {
    return this.communityGivingService.replaceBySlug(slug, user.userId, dto);
  }
}
