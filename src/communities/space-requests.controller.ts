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
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { CreateSpaceRequestDto } from './dto/create-space-request.dto';
import { SpaceRequestsService } from './space-requests.service';

/**
 * A community's own request to switch spaces on
 * (`communities/:slug/space-requests`), decided from the
 * `admin/community-space-requests` queue.
 *
 * Reading the latest request is open to any owner, co-owner or moderator;
 * filing and withdrawing are owner-level decisions, enforced in
 * `SpaceRequestsService`.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('communities')
@UseGuards(ActiveMemberGuard)
export class SpaceRequestsController {
  constructor(private readonly spaceRequests: SpaceRequestsService) {}

  @Get(':slug/space-requests/latest')
  @ApiOperation({
    summary:
      "This community's most recent request to host spaces (staff only).",
  })
  @ApiOkResponse({
    description: '`{ request }`, null when the community never asked.',
  })
  @ApiForbiddenResponse({
    description: 'Owner, co-owner or moderator role required.',
  })
  @ApiNotFoundResponse({ description: 'No community exists for this slug.' })
  latest(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.spaceRequests.latest(slug, user.userId);
  }

  @Post(':slug/space-requests')
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Ask platform staff to let this community host spaces (owner or co-owner).',
  })
  @ApiCreatedResponse({ description: 'The new open request.' })
  @ApiConflictResponse({
    description: 'A space, spaces already on, or a request already open.',
  })
  @ApiForbiddenResponse({
    description:
      'Owner or co-owner role required, or the community is frozen or under review.',
  })
  @ApiNotFoundResponse({ description: 'No community exists for this slug.' })
  @ApiTooManyRequestsResponse({ description: 'Too many requests.' })
  create(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateSpaceRequestDto,
  ) {
    return this.spaceRequests.create(slug, user.userId, dto);
  }

  @Delete(':slug/space-requests/open')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Withdraw the open space request (owner or co-owner).',
  })
  @ApiOkResponse({ description: 'The withdrawn request.' })
  @ApiForbiddenResponse({ description: 'Owner or co-owner role required.' })
  @ApiNotFoundResponse({
    description: 'No open request, or no community for this slug.',
  })
  withdraw(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.spaceRequests.withdraw(slug, user.userId);
  }
}
