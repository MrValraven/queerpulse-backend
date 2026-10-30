import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { ListingTeamMemberLinksService } from './listing-team-member-links.service';

/**
 * The member side of "Meet the team": the team invites a member received and
 * the teams they belong to. The caller is the member, so there is no persona
 * seat check; a row that is not theirs answers `listing_team_link_not_found`.
 *
 * NOTHING HERE IS PUBLIC. Every route sits behind `ActiveMemberGuard`. The
 * `me/team-links` base path is used by no other controller, and the persona
 * routes live under `subprofiles/:id/team-links`, so the two never collide.
 */
@Feature('listings')
@ApiTags('Listings')
@ApiCookieAuth()
@Controller('me/team-links')
@UseGuards(ActiveMemberGuard)
export class ListingTeamMemberLinksController {
  constructor(
    private readonly listingTeamMemberLinksService: ListingTeamMemberLinksService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List the team invites and teams of the caller' })
  @ApiOkResponse({
    description: 'Invites received and the accepted teams.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  list(@CurrentUser() user: CurrentUserData) {
    return this.listingTeamMemberLinksService.list(user.userId);
  }

  @Post(':linkId/accept')
  @UseGuards(NotRestrictedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept the team invite of a listing' })
  @ApiOkResponse({ description: 'The accepted row, placed last.' })
  @ApiNotFoundResponse({ description: 'listing_team_link_not_found.' })
  @ApiUnprocessableEntityResponse({
    description: 'listing_team_member_ineligible.',
  })
  @ApiConflictResponse({
    description:
      'listing_team_not_pending, listing_team_listing_not_live, listing_team_full or listing_team_member_full.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  accept(
    @CurrentUser() user: CurrentUserData,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ) {
    return this.listingTeamMemberLinksService.accept(user.userId, linkId);
  }

  @Post(':linkId/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Decline the team invite of a listing' })
  @ApiNoContentResponse({ description: 'The invite is declined.' })
  @ApiNotFoundResponse({ description: 'listing_team_link_not_found.' })
  @ApiConflictResponse({ description: 'listing_team_not_pending.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  decline(
    @CurrentUser() user: CurrentUserData,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ) {
    return this.listingTeamMemberLinksService.decline(user.userId, linkId);
  }

  @Delete(':linkId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Leave the team of a listing' })
  @ApiNoContentResponse({ description: 'The member has left the team.' })
  @ApiNotFoundResponse({ description: 'listing_team_link_not_found.' })
  @ApiConflictResponse({ description: 'listing_team_not_accepted.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  leave(
    @CurrentUser() user: CurrentUserData,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ) {
    return this.listingTeamMemberLinksService.leave(user.userId, linkId);
  }
}
