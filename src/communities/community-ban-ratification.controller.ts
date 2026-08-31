import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiConflictResponse,
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
import { CommunityBanRatificationService } from './community-ban-ratification.service';
import {
  ListCommunityBanRatificationsQuery,
  RatifyCommunityBanDto,
} from './dto/ratify-community-ban.dto';

/**
 * `@Controller('communities/:slug/ban-ratifications')`: the permanent bars
 * this community's staff have asked for and the second signature each one
 * needs (PRD-25).
 *
 * Its own controller on a nested path, the convention this module follows for
 * `CommunityBansController`, `CommunityPulseController` and
 * `CommunityInsightsController`. Owner, co-owner and moderator on both routes,
 * enforced inside the service through `resolveStaffCommunity` so the tier here
 * and the tier the ban list uses can never drift apart.
 *
 * The platform equivalent is `GET /mod/ratifications` +
 * `PATCH /mod/ratifications/:id` on `ModerationController`, and these two are
 * deliberately the same pair of shapes one scope down.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('communities/:slug/ban-ratifications')
@UseGuards(ActiveMemberGuard)
export class CommunityBanRatificationController {
  constructor(
    private readonly ratificationService: CommunityBanRatificationService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Permanent bars waiting on a second owner, co-owner or moderator, soonest to lapse first.',
  })
  @ApiOkResponse({
    description:
      'The holds, each carrying who asked, in whose words, which rule they cited, what the member is serving meanwhile, and when the hold lapses.',
  })
  @ApiForbiddenResponse({
    description: 'Owner, co-owner or moderator role required.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  list(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query() query: ListCommunityBanRatificationsQuery,
  ) {
    return this.ratificationService.listBySlug(slug, user.userId, query.status);
  }

  /**
   * The second signature, or the refusal.
   *
   * The person who ASKED for the permanent bar cannot decide it, whatever
   * their roster role: the guard compares against the hold's `requested_by`
   * with no owner carve-out. A community whose only staff member is its owner
   * therefore never reaches this route at all, because no hold is opened for
   * it and the bar stands at 30 days.
   */
  @Patch(':id')
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary: "Confirm or refuse another moderator's permanent bar.",
  })
  @ApiOkResponse({ description: 'The decided hold.' })
  @ApiForbiddenResponse({
    description:
      'Owner, co-owner or moderator role required, and you may not confirm a bar you asked for yourself.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug, an archived community, or no such hold here.',
  })
  @ApiConflictResponse({
    description:
      'The hold has already been decided, it has lapsed to 30 days, or the bar was lifted underneath it.',
  })
  decide(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RatifyCommunityBanDto,
  ) {
    return this.ratificationService.decide(slug, user.userId, id, dto);
  }
}
