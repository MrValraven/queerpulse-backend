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
 * Filing is moderators and co-owners; withdrawal is the filer or the owner;
 * reading is any of a community's staff, the owner included. One open request
 * per community, enforced by a partial unique index and answered as a 409.
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
    summary:
      "This community's owner-review state (owner, co-owner or moderator).",
  })
  @ApiOkResponse({
    description:
      "The open request if there is one, the community's review stamp, and what this viewer may do.",
  })
  @ApiForbiddenResponse({
    description: 'Owner, co-owner or moderator role required.',
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
      'Report an unreachable owner (moderators and co-owners). Flags the community for platform staff.',
  })
  @ApiCreatedResponse({ description: 'The owner-review state after filing.' })
  @ApiBadRequestResponse({ description: 'The reason is missing or too short.' })
  @ApiForbiddenResponse({
    description:
      'Moderator or co-owner role required. A community owner cannot file one for their own community.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  @ApiConflictResponse({
    description: 'This community already has an open owner review.',
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
      "Withdraw the open owner review (the moderator who filed it, or the owner). The owner withdrawing also clears the community's review flag.",
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
