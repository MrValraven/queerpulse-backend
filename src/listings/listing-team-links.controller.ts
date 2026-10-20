import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
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
  ListingTeamListingSearchQuery,
  RequestListingTeamLinkDto,
} from './dto/listing-team.dto';
import { ListingTeamLinksService } from './listing-team-links.service';

/**
 * The persona side of "Meet the team": the listings a persona was invited to,
 * the requests it sent and the teams it belongs to.
 *
 * NOTHING HERE IS PUBLIC. Every route sits behind `ActiveMemberGuard` and then
 * behind the persona seat check inside `ListingTeamLinksService` (owner or
 * co-owner). These routes publish nothing about members.
 *
 * The class lives in the listings module and carries the `subprofiles` base
 * path. Every route has two or more segments under `:id`, so none collides
 * with `SubprofilesController`. Inside this class the literal segments
 * (`candidates`, `requests`) are declared ahead of every `:linkId` route.
 */
@Feature('listings')
@ApiTags('Listings')
@ApiCookieAuth()
@Controller('subprofiles')
@UseGuards(ActiveMemberGuard)
export class ListingTeamLinksController {
  constructor(
    private readonly listingTeamLinksService: ListingTeamLinksService,
  ) {}

  @Get(':id/team-links')
  @ApiOperation({ summary: 'List the team links of a persona' })
  @ApiOkResponse({
    description: 'Invites received, requests sent and the accepted teams.',
  })
  @ApiNotFoundResponse({ description: 'listing_team_persona_not_found.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  list(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.listingTeamLinksService.listForPersona(id, user.userId);
  }

  @Get(':id/team-links/candidates')
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Search listings a persona can ask to join' })
  @ApiOkResponse({ description: 'Up to 20 publicly visible listings.' })
  @ApiBadRequestResponse({ description: 'The search text is out of range.' })
  @ApiNotFoundResponse({ description: 'listing_team_persona_not_found.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  searchCandidates(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListingTeamListingSearchQuery,
  ) {
    return this.listingTeamLinksService.searchCandidates(
      id,
      user.userId,
      query.q,
    );
  }

  @Post(':id/team-links/requests')
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Ask a listing to add a persona to its team' })
  @ApiCreatedResponse({
    description:
      'The pending request, or the accepted row when the caller also manages the listing.',
  })
  @ApiBadRequestResponse({ description: 'Malformed body.' })
  @ApiNotFoundResponse({
    description:
      'listing_team_persona_not_found or listing_team_listing_not_found.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'listing_team_persona_ineligible.',
  })
  @ApiConflictResponse({
    description:
      'listing_team_already_pending, listing_team_already_accepted, listing_team_cooldown, listing_team_full, listing_team_pending_full, listing_team_persona_full or listing_team_persona_requests_full.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  request(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RequestListingTeamLinkDto,
  ) {
    return this.listingTeamLinksService.request(id, user.userId, body);
  }

  @Post(':id/team-links/:linkId/accept')
  @UseGuards(NotRestrictedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept the invite of a listing' })
  @ApiOkResponse({ description: 'The accepted row, placed last.' })
  @ApiNotFoundResponse({
    description:
      'listing_team_persona_not_found or listing_team_link_not_found.',
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
  accept(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ) {
    return this.listingTeamLinksService.accept(id, user.userId, linkId);
  }

  @Post(':id/team-links/:linkId/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Decline the invite of a listing' })
  @ApiNoContentResponse({ description: 'The invite is declined.' })
  @ApiNotFoundResponse({
    description:
      'listing_team_persona_not_found or listing_team_link_not_found.',
  })
  @ApiConflictResponse({ description: 'listing_team_not_pending.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  decline(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ) {
    return this.listingTeamLinksService.decline(id, user.userId, linkId);
  }

  @Post(':id/team-links/:linkId/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Take back a request the persona sent' })
  @ApiNoContentResponse({ description: 'The request is cancelled.' })
  @ApiNotFoundResponse({
    description:
      'listing_team_persona_not_found or listing_team_link_not_found.',
  })
  @ApiConflictResponse({ description: 'listing_team_not_pending.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  cancel(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ) {
    return this.listingTeamLinksService.cancel(id, user.userId, linkId);
  }

  @Delete(':id/team-links/:linkId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Leave the team of a listing' })
  @ApiNoContentResponse({ description: 'The persona has left the team.' })
  @ApiNotFoundResponse({
    description:
      'listing_team_persona_not_found or listing_team_link_not_found.',
  })
  @ApiConflictResponse({ description: 'listing_team_not_accepted.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  leave(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ) {
    return this.listingTeamLinksService.leave(id, user.userId, linkId);
  }
}
