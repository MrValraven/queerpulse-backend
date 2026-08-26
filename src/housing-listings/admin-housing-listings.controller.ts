import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { HousingModerationGuard } from '../auth/guards/housing-moderation.guard';
import { Feature } from '../common/feature.decorator';
import { DecideHousingListingDto } from './dto/decide-housing-listing.dto';
import { HousingReviewQueueQuery } from './dto/housing-review-queue.query';
import { HousingListingModerationService } from './housing-listing-moderation.service';
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

/**
 * The housing review console's backend: the queue, and the four decisions that
 * move a listing through it.
 *
 * Both routes are gated by `HousingModerationGuard`, which passes a platform
 * Moderator or Admin (the `@Roles(UserRole.Moderator, UserRole.Admin)` tier that
 * `ListingsController.setStatus` uses; co-ops are Admin-only) OR a member
 * holding the additive `housing_moderator` staff role. Nothing here is reachable
 * by a plain member.
 *
 * ADDRESS PRIVACY: these are the only routes that return
 * `AdminHousingListingDTO`, which carries the exact point and the full street
 * address. That is correct for somebody reviewing a real home and must not be
 * returned from anywhere else. Public browse gets the neighbourhood centroid.
 */
@Feature('housingListings')
@ApiTags('Admin — Housing')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Not authenticated.',
})
@ApiForbiddenResponse({
  description:
    'Requires moderator or admin role, or the housing_moderator staff role.',
})
@Controller('admin/housing-listings')
@UseGuards(ActiveMemberGuard, HousingModerationGuard)
export class AdminHousingListingsController {
  constructor(private readonly service: HousingListingModerationService) {}

  @Get()
  @ApiOperation({
    summary: 'The housing review queue, riskiest first',
    description:
      'Defaults to pending listings (status=review) sorted by the deterministic ' +
      'pre-publish risk score, highest first, ties oldest-first. Pass ' +
      'status=question|live|rejected|taken_down|all to widen it, and ' +
      'sort=oldest|newest to reorder. Each row carries the lister, their prior ' +
      'record, the risk signals, the photos and any decision already recorded.',
  })
  @ApiOkResponse({ description: 'A paginated page of the review queue.' })
  reviewQueue(@Query() query: HousingReviewQueueQuery) {
    return this.service.reviewQueue(query);
  }

  @Post(':ref/decision')
  @ApiOperation({
    summary: 'Approve, request changes on, reject, or take down a listing',
    description:
      'Records one moderator decision. A reason is required for every decision ' +
      'except approve, and the lister is notified in-app and by push with that ' +
      'reason verbatim (QueerPulse sends no email). Approving publishes the ' +
      'listing and fires the saved-search alerts.',
  })
  @ApiOkResponse({ description: 'The listing after the decision.' })
  @ApiBadRequestResponse({
    description:
      'A required reason was missing, the listing is already in that state, or ' +
      'a take-down was attempted on a listing that is not live.',
  })
  @ApiNotFoundResponse({ description: 'Housing listing not found.' })
  decide(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: DecideHousingListingDto,
  ) {
    return this.service.decide(ref, user.userId, dto);
  }
}
