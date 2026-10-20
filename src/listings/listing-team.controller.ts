import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
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
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import {
  ApproveListingTeamRequestDto,
  InviteListingTeamMemberDto,
  ListingTeamPersonaSearchQuery,
  ReorderListingTeamDto,
  UpdateListingTeamMemberDto,
} from './dto/listing-team.dto';
import { ListingTeamService } from './listing-team.service';

/**
 * The business side of "Meet the team": the people a listing's managers invite,
 * the requests personas send, and the order the accepted team shows in.
 *
 * NOTHING HERE IS PUBLIC. Every route sits behind `ActiveMemberGuard` and then
 * behind the owner-or-co-manager check inside `ListingTeamService`. These
 * routes publish nothing about members; the public team list is a field of the
 * directory detail response and follows its own eligibility rule.
 *
 * ROUTE ORDERING, which is load-bearing. `ListingsController` declares
 * `@Get(':ref')` on the same `listings` base path and Nest resolves handlers in
 * controller-registration order, so this controller is registered BEFORE
 * `ListingsController` in `ListingsModule`. Inside this class the literal
 * segments (`candidates`, `invites`, `order`) are declared ahead of every
 * `:memberId` route so a literal never reads as a member id.
 */
@Feature('listings')
@ApiTags('Listings')
@ApiCookieAuth()
@Controller('listings')
@UseGuards(ActiveMemberGuard)
export class ListingTeamController {
  constructor(private readonly listingTeamService: ListingTeamService) {}

  @Get(':ref/team')
  @ApiOperation({ summary: 'List the team of a listing for its managers' })
  @ApiOkResponse({
    description:
      'Requests received, invites sent and the accepted team in order.',
  })
  @ApiNotFoundResponse({
    description: 'No such listing, or the caller does not manage it.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  list(@CurrentUser() user: CurrentUserData, @Param('ref') ref: string) {
    return this.listingTeamService.listForManager(ref, user.userId);
  }

  @Get(':ref/team/candidates')
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Search personas a listing can invite to its team' })
  @ApiOkResponse({ description: 'Up to 20 eligible personas.' })
  @ApiBadRequestResponse({ description: 'The search text is out of range.' })
  @ApiNotFoundResponse({
    description: 'No such listing, or the caller does not manage it.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  searchCandidates(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Query() query: ListingTeamPersonaSearchQuery,
  ) {
    return this.listingTeamService.searchCandidates(ref, user.userId, query.q);
  }

  @Post(':ref/team/invites')
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Invite a persona to the team of a listing' })
  @ApiCreatedResponse({
    description:
      'The pending invite, or the accepted row when the caller co-owns the persona.',
  })
  @ApiBadRequestResponse({ description: 'Malformed body.' })
  @ApiNotFoundResponse({
    description:
      'listing_team_persona_not_found, or a 404 without a code when no such listing exists for the caller.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'listing_team_persona_ineligible.',
  })
  @ApiConflictResponse({
    description:
      'listing_team_listing_not_live, listing_team_already_pending, listing_team_already_accepted, listing_team_cooldown, listing_team_full, listing_team_pending_full or listing_team_persona_full.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  invite(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() body: InviteListingTeamMemberDto,
  ) {
    return this.listingTeamService.invite(ref, user.userId, body);
  }

  @Put(':ref/team/order')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Put the accepted team of a listing in a new order',
  })
  @ApiOkResponse({ description: 'The accepted team in the saved order.' })
  @ApiBadRequestResponse({ description: 'Malformed or repeated ids.' })
  @ApiNotFoundResponse({
    description: 'No such listing, or the caller does not manage it.',
  })
  @ApiConflictResponse({
    description:
      'listing_team_order_mismatch when the ids differ from the accepted team.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  reorder(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() body: ReorderListingTeamDto,
  ) {
    return this.listingTeamService.reorder(ref, user.userId, body);
  }

  @Post(':ref/team/:memberId/approve')
  @UseGuards(NotRestrictedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a persona request to join the team' })
  @ApiOkResponse({ description: 'The accepted row, placed last.' })
  @ApiBadRequestResponse({ description: 'Malformed body or id.' })
  @ApiNotFoundResponse({
    description:
      'listing_team_link_not_found, or a 404 without a code when no such listing exists for the caller.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'listing_team_persona_ineligible.',
  })
  @ApiConflictResponse({
    description:
      'listing_team_not_pending, listing_team_listing_not_live, listing_team_full or listing_team_persona_full.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  approve(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() body: ApproveListingTeamRequestDto,
  ) {
    return this.listingTeamService.approve(ref, user.userId, memberId, body);
  }

  @Post(':ref/team/:memberId/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Decline a persona request to join the team' })
  @ApiNoContentResponse({ description: 'The request is declined.' })
  @ApiNotFoundResponse({
    description:
      'listing_team_link_not_found, or a 404 without a code when no such listing exists for the caller.',
  })
  @ApiConflictResponse({ description: 'listing_team_not_pending.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  decline(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ) {
    return this.listingTeamService.decline(ref, user.userId, memberId);
  }

  @Post(':ref/team/:memberId/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Take back an invite the listing sent' })
  @ApiNoContentResponse({ description: 'The invite is cancelled.' })
  @ApiNotFoundResponse({
    description:
      'listing_team_link_not_found, or a 404 without a code when no such listing exists for the caller.',
  })
  @ApiConflictResponse({ description: 'listing_team_not_pending.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  cancel(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ) {
    return this.listingTeamService.cancel(ref, user.userId, memberId);
  }

  @Patch(':ref/team/:memberId')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Edit the role label of a team row' })
  @ApiOkResponse({ description: 'The updated row.' })
  @ApiBadRequestResponse({ description: 'Malformed body or id.' })
  @ApiNotFoundResponse({
    description:
      'listing_team_link_not_found, or a 404 without a code when no such listing exists for the caller.',
  })
  @ApiConflictResponse({
    description:
      'listing_team_not_pending when the row has ended (declined, cancelled, removed or left).',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  updateRoleLabel(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() body: UpdateListingTeamMemberDto,
  ) {
    return this.listingTeamService.updateRoleLabel(
      ref,
      user.userId,
      memberId,
      body,
    );
  }

  @Delete(':ref/team/:memberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove an accepted member from the team' })
  @ApiNoContentResponse({ description: 'The member is removed.' })
  @ApiNotFoundResponse({
    description:
      'listing_team_link_not_found, or a 404 without a code when no such listing exists for the caller.',
  })
  @ApiConflictResponse({ description: 'listing_team_not_accepted.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  remove(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ) {
    return this.listingTeamService.remove(ref, user.userId, memberId);
  }
}
