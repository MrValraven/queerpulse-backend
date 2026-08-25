import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { InviteListingCoManagerDto } from './dto/invite-listing-co-manager.dto';
import { ListingCoManagersService } from './listing-co-managers.service';

/**
 * Co-manager seats on a business directory listing.
 *
 * A listing has exactly one `owner_id`, so a venue run by two people could not
 * share its page. A co-manager can do everything day to day and none of the
 * owner-only acts: they cannot delete the listing, they cannot manage this
 * roster, and they never see or write the owner's personal fields (see
 * `listing-owner-personal-fields.ts`).
 *
 * NOTHING HERE IS PUBLIC. Every route is behind `ActiveMemberGuard` and then
 * behind an owner or owner-or-co-manager check in the service. No public
 * directory response carries a co-manager field of any kind. Publishing who
 * works at a queer venue is a safety decision, and this feature does not make
 * it on anyone's behalf.
 *
 * ROUTE ORDERING, which is load-bearing. `ListingsController` declares
 * `@Get(':ref')` on the same `listings` base path, and Nest resolves handlers
 * in controller-registration order. This controller is therefore registered
 * BEFORE `ListingsController` in `ListingsModule`, so the literal
 * `listings/co-manager-invites` segment wins over `listings/:ref`. Moving it
 * down that array silently turns every invite route into a listing lookup for a
 * listing whose ref is "co-manager-invites". The `:ref/co-managers` routes are
 * unaffected either way, having one more segment than anything on the other
 * controller.
 *
 * Guard shape matches `ListingsController` exactly: `ActiveMemberGuard` and no
 * `RolesGuard`. These are owner and co-manager gates, which are a different
 * thing from a moderator gate; nothing here is reachable by role.
 */
@Feature('listings')
@ApiTags('Listings')
@ApiCookieAuth()
@Controller('listings')
@UseGuards(ActiveMemberGuard)
export class ListingCoManagersController {
  constructor(
    private readonly listingCoManagersService: ListingCoManagersService,
  ) {}

  // --- The invited member's own surface -------------------------------------
  // Declared first, and on the literal `co-manager-invites` segment, per the
  // class doc comment.

  @Get('co-manager-invites')
  @ApiOperation({
    summary: 'List the current member’s unanswered co-manager invitations',
  })
  @ApiOkResponse({
    description: 'Unanswered invitations, newest first.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listMyInvites(@CurrentUser() user: CurrentUserData) {
    return this.listingCoManagersService.listMyInvites(user.userId);
  }

  // Accept and decline are separate routes rather than one PATCH carrying a
  // decision, matching how this codebase already models a two-way answer as two
  // acts. The seat id is scoped to the caller in the service, so an invitation
  // addressed to somebody else 404s.
  @Post('co-manager-invites/:id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept an invitation to co-manage a listing' })
  @ApiOkResponse({ description: 'The accepted invitation.' })
  @ApiNotFoundResponse({
    description: 'No unanswered invitation with that id for the caller.',
  })
  @ApiConflictResponse({
    description: 'The invitation has already been answered.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  acceptInvite(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.listingCoManagersService.respondToInvite(
      id,
      user.userId,
      'accept',
    );
  }

  @Post('co-manager-invites/:id/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline an invitation to co-manage a listing' })
  @ApiOkResponse({ description: 'The declined invitation.' })
  @ApiNotFoundResponse({
    description: 'No unanswered invitation with that id for the caller.',
  })
  @ApiConflictResponse({
    description: 'The invitation has already been answered.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  declineInvite(@CurrentUser() user: CurrentUserData, @Param('id') id: string) {
    return this.listingCoManagersService.respondToInvite(
      id,
      user.userId,
      'decline',
    );
  }

  // --- The listing's roster --------------------------------------------------

  // Owner OR active co-manager. Reading is not managing: someone who can
  // already edit the page needs to know who else can, while inviting and
  // revoking stay owner-only below.
  @Get(':ref/co-managers')
  @ApiOperation({ summary: 'List a listing’s co-managers' })
  @ApiOkResponse({
    description: 'Live seats (accepted and invited), never the ended ones.',
  })
  @ApiNotFoundResponse({
    description: 'No listing with that reference the caller manages.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listCoManagers(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
  ) {
    return this.listingCoManagersService.listSeats(ref, user.userId);
  }

  // OWNER ONLY. Throttled like the other member-addressing write surfaces in
  // this module (`dispute`, `claim`): an invitation puts a notification in
  // somebody else's bell, so the limit is here to stop a script doing that in
  // bulk, not to ration a real owner adding their colleagues.
  @Post(':ref/co-managers')
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Invite a member to co-manage a listing' })
  @ApiCreatedResponse({ description: 'The pending invitation.' })
  @ApiBadRequestResponse({
    description: 'The owner cannot invite themselves.',
  })
  @ApiNotFoundResponse({
    description:
      'No listing with that reference owned by the caller, or no such active member.',
  })
  @ApiConflictResponse({
    description:
      'That member already holds or has been offered a seat, or the listing is at its co-manager cap.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  invite(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: InviteListingCoManagerDto,
  ) {
    return this.listingCoManagersService.invite(ref, user.userId, dto);
  }

  // Declared BEFORE `:memberSlug` so Nest resolves the literal `mine` segment
  // rather than treating it as a member slug — the same "static path before
  // dynamic param" ordering `GET /listings/mine` follows on the other
  // controller. This is the co-manager stepping down, and it is the one write
  // on this class that is not owner-gated.
  @Delete(':ref/co-managers/mine')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Step down as a co-manager of a listing' })
  @ApiNoContentResponse({ description: 'The seat was given up.' })
  @ApiNotFoundResponse({
    description:
      'No listing with that reference, or the caller holds no seat on it.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  leave(@CurrentUser() user: CurrentUserData, @Param('ref') ref: string) {
    return this.listingCoManagersService.leave(ref, user.userId);
  }

  // OWNER ONLY: take a seat back, accepted or still unanswered.
  @Delete(':ref/co-managers/:memberSlug')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a co-manager from a listing' })
  @ApiNoContentResponse({ description: 'The seat was removed.' })
  @ApiNotFoundResponse({
    description:
      'No listing with that reference owned by the caller, or that member holds no live seat on it.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  revoke(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Param('memberSlug') memberSlug: string,
  ) {
    return this.listingCoManagersService.revoke(ref, user.userId, memberSlug);
  }
}
