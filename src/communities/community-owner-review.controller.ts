import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
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
import { Feature } from '../common/feature.decorator';
import { CommunityOwnerReviewService } from './community-owner-review.service';
import { CreateCommunityOwnerReviewDto } from './dto/create-community-owner-review.dto';

/**
 * `@Controller('communities/:slug/owner-review')` — standalone controller on
 * a nested path, the convention this module follows for
 * `CommunityPulseController` and `CommunityInsightsController`. See that
 * controller's doc comment.
 *
 * Filing and reading are open to ANY roster member since GOV-02, with the
 * owner refused on the filing route only (they read, and they withdraw).
 * Withdrawal is the member who filed it or the owner. One open request per
 * community, enforced by a partial unique index and answered as a 409.
 *
 * The `@Throttle` decorators below are burst control and nothing more. The
 * rule that actually matters, one owner review per member per 24 hours across
 * every community, is enforced in `CommunityOwnerReviewService` against the
 * request table, because the global throttler keys on client IP and keeps its
 * counters in process memory. See that service's doc comment.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('communities/:slug/owner-review')
@UseGuards(ActiveMemberGuard)
export class CommunityOwnerReviewController {
  constructor(
    private readonly communityOwnerReviewService: CommunityOwnerReviewService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "This community's owner-review state (any roster member).",
  })
  @ApiOkResponse({
    description:
      "The open request if there is one, the community's review stamp, and what this viewer may do. `canOpen` is true for any roster member who is not the owner while no request is open.",
  })
  @ApiForbiddenResponse({
    description: 'Roster membership required.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  get(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.communityOwnerReviewService.getState(slug, user.userId);
  }

  @Post()
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Report an unreachable owner (any roster member). Flags the community for platform staff.',
  })
  @ApiCreatedResponse({ description: 'The owner-review state after filing.' })
  @ApiBadRequestResponse({ description: 'The reason is missing or too short.' })
  @ApiForbiddenResponse({
    description:
      'Roster membership required. A community owner cannot file one for their own community.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  @ApiConflictResponse({
    description: 'This community already has an open owner review.',
  })
  @ApiTooManyRequestsResponse({
    description:
      'This member already filed an owner review in the last 24 hours (counted across every community they belong to).',
  })
  open(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateCommunityOwnerReviewDto,
  ) {
    return this.communityOwnerReviewService.open(slug, user.userId, dto);
  }

  @Delete()
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      "Withdraw the open owner review (the member who filed it, or the owner). The owner withdrawing also clears the community's review flag.",
  })
  @ApiOkResponse({ description: 'The owner-review state after withdrawal.' })
  @ApiForbiddenResponse({
    description: 'Only the filer or the community owner can withdraw it.',
  })
  @ApiNotFoundResponse({
    description:
      'Unknown slug, an archived community, or no open owner review.',
  })
  withdraw(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.communityOwnerReviewService.withdraw(slug, user.userId);
  }
}
