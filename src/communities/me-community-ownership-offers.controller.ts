import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiConflictResponse,
  ApiCookieAuth,
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
import { CommunitiesService } from './communities.service';

/**
 * `GET /me/community-ownership-offers` and the accept and decline routes
 * under it (PRD-514): the offered member's half of a community ownership
 * offer. The owner's half lives on `CommunitiesController`
 * (`/communities/:slug/ownership-offer`).
 *
 * Its own controller, the module's "a new endpoint brings its own
 * controller" convention (`MeCommunityInvitesController`), and a `/me` path
 * so the routes never compete with `/communities/:slug` patterns.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('me/community-ownership-offers')
@UseGuards(ActiveMemberGuard)
export class MeCommunityOwnershipOffersController {
  constructor(private readonly communitiesService: CommunitiesService) {}

  @Get()
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Open ownership offers addressed to the caller, newest first. Expired, answered and cancelled offers are left out.',
  })
  @ApiOkResponse({ description: 'The open offers, possibly empty.' })
  listMine(@CurrentUser() user: CurrentUserData) {
    return this.communitiesService.listMyOwnershipOffers(user.userId);
  }

  @Post(':offerId/accept')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Accept an ownership offer. The caller becomes the owner and the previous owner becomes a moderator.',
  })
  @ApiOkResponse({ description: 'The offer, now accepted.' })
  @ApiNotFoundResponse({
    description:
      'OWNERSHIP_OFFER_NOT_FOUND: no such offer addressed to the caller.',
  })
  @ApiConflictResponse({
    description:
      'OWNERSHIP_OFFER_ANSWERED, OWNERSHIP_OFFER_CANCELLED, OWNERSHIP_OFFER_EXPIRED, OWNERSHIP_OFFER_OWNER_CHANGED or OWNERSHIP_OFFER_RECIPIENT_NOT_MEMBER.',
  })
  accept(
    @CurrentUser() user: CurrentUserData,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ) {
    return this.communitiesService.respondToOwnershipOffer(
      offerId,
      user.userId,
      true,
    );
  }

  @Post(':offerId/decline')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Decline an ownership offer. Ownership stays where it is and the owner who offered it is notified.',
  })
  @ApiOkResponse({ description: 'The offer, now declined.' })
  @ApiNotFoundResponse({
    description:
      'OWNERSHIP_OFFER_NOT_FOUND: no such offer addressed to the caller.',
  })
  @ApiConflictResponse({
    description:
      'OWNERSHIP_OFFER_ANSWERED, OWNERSHIP_OFFER_CANCELLED or OWNERSHIP_OFFER_EXPIRED.',
  })
  decline(
    @CurrentUser() user: CurrentUserData,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ) {
    return this.communitiesService.respondToOwnershipOffer(
      offerId,
      user.userId,
      false,
    );
  }
}
