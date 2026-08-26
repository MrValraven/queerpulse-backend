import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
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
import { Feature } from '../common/feature.decorator';
import { CommunitySupportOffersService } from './community-support-offers.service';
import { RespondCommunitySupportOfferDto } from './dto/respond-community-support-offer.dto';

/**
 * `communities/:slug/support-offers` — what platform staff have offered this
 * community, and the community's answer.
 *
 * A standalone controller nested under `communities/:slug`, the convention
 * this module already follows for resources, invites, bans and owner review.
 * Read and write are both owner/co-owner/moderator: the offer is addressed to
 * the people running the room, and they are exactly who was notified.
 *
 * The matching write that CREATES an offer is admin-side
 * (`AdminCommunitySupportController`); there is no member-facing create path.
 */
@Feature('communities')
@ApiTags('Communities')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('communities/:slug/support-offers')
@UseGuards(ActiveMemberGuard)
export class CommunitySupportOffersController {
  constructor(private readonly supportOffers: CommunitySupportOffersService) {}

  @Get()
  @ApiOperation({
    summary:
      'The support platform staff have offered this community (owner, co-owner or moderator).',
  })
  @ApiOkResponse({
    description: 'The offers newest first, plus how many are unanswered.',
  })
  @ApiForbiddenResponse({
    description: 'Owner, co-owner or moderator role required.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug, or an archived community.',
  })
  list(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.supportOffers.listBySlug(slug, user.userId);
  }

  @Post(':id/respond')
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      'Take up an offer of support, or say it is not needed (owner, co-owner or moderator).',
  })
  @ApiOkResponse({ description: 'The answered offer.' })
  @ApiBadRequestResponse({
    description: 'Malformed offer id, or the offer was already answered.',
  })
  @ApiForbiddenResponse({
    description: 'Owner, co-owner or moderator role required.',
  })
  @ApiNotFoundResponse({
    description: 'Unknown slug or offer, or an archived community.',
  })
  respond(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondCommunitySupportOfferDto,
  ) {
    return this.supportOffers.respond(slug, user.userId, id, dto.response);
  }
}
