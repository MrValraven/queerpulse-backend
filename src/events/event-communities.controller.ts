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
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
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
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { CreateEventCommunityInviteDto } from './dto/create-event-community-invite.dto';
import { RespondEventCommunityInviteDto } from './dto/respond-event-community-invite.dto';
import { EventCommunitiesService } from './event-communities.service';

// Guest communities, organiser side. A second controller on the `events`
// prefix, the arrangement `EventPhotosController` already uses.
@Feature('events')
@ApiTags('Events')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('events')
@UseGuards(ActiveMemberGuard)
export class EventGuestCommunitiesController {
  constructor(private readonly eventCommunities: EventCommunitiesService) {}

  @Get(':slug/communities')
  @ApiOperation({
    summary: 'List the guest communities of a gathering you organise.',
    description: 'Every status: pending, accepted and declined.',
  })
  @ApiOkResponse({ description: 'Every guest row with its status.' })
  @ApiForbiddenResponse({
    description: 'Only the host or a co-host can do that.',
  })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  list(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.eventCommunities.listForOrganizer(slug, user.userId);
  }

  @Post(':slug/communities')
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @ApiOperation({
    summary: 'Invite a guest community onto a gathering you organise.',
    description:
      'Accepted on the spot when the caller is an owner, co-owner or mod of that community.',
  })
  @ApiCreatedResponse({ description: 'The guest row and its status.' })
  @ApiBadRequestResponse({
    description:
      'The gathering has no lead community, or already has 5 guests.',
  })
  @ApiForbiddenResponse({
    description: 'Only the host or a co-host can do that.',
  })
  @ApiNotFoundResponse({ description: 'No such event or community.' })
  @ApiConflictResponse({
    description:
      'The community leads the gathering, was already invited (a decline included), or is frozen.',
  })
  invite(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateEventCommunityInviteDto,
  ) {
    return this.eventCommunities.invite(slug, user.userId, dto.communitySlug);
  }

  @Delete(':slug/communities/:communitySlug')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a guest community from a gathering you organise.',
  })
  @ApiNoContentResponse({ description: 'The guest was removed.' })
  @ApiForbiddenResponse({
    description: 'Only the host or a co-host can do that.',
  })
  @ApiNotFoundResponse({
    description: 'No such event, community, or guest row.',
  })
  remove(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('communitySlug') communitySlug: string,
  ) {
    return this.eventCommunities.removeByOrganizer(
      slug,
      user.userId,
      communitySlug,
    );
  }
}

// Guest communities, guest side: the invite page and its answers.
@Feature('events')
@ApiTags('Events')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('event-communities')
@UseGuards(ActiveMemberGuard)
export class EventCommunityInvitesController {
  constructor(private readonly eventCommunities: EventCommunitiesService) {}

  @Get(':id')
  @ApiOperation({
    summary:
      'Get a guest community invite (its owners, co-owners and mods, or an organiser).',
  })
  @ApiOkResponse({ description: 'The invite detail.' })
  @ApiForbiddenResponse({ description: 'This invite is not visible to you.' })
  @ApiNotFoundResponse({ description: 'Invite not found.' })
  get(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.eventCommunities.getInvite(id, user.userId);
  }

  @Post(':id/respond')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept or decline a guest community invite.' })
  @ApiOkResponse({ description: 'The invite detail after the answer.' })
  @ApiForbiddenResponse({
    description:
      'Only the owner, a co-owner or a moderator of this community can do that.',
  })
  @ApiNotFoundResponse({ description: 'Invite not found.' })
  @ApiConflictResponse({
    description:
      'Already answered, the gathering was cancelled or has happened, or the community is frozen.',
  })
  respond(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondEventCommunityInviteDto,
  ) {
    return this.eventCommunities.respond(id, user.userId, dto.decision);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Take your community off an accepted collab.' })
  @ApiNoContentResponse({ description: 'The community left the gathering.' })
  @ApiForbiddenResponse({
    description:
      'Only the owner, a co-owner or a moderator of this community can do that.',
  })
  @ApiNotFoundResponse({ description: 'Invite not found.' })
  @ApiConflictResponse({ description: 'Only an accepted collab can be left.' })
  leave(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.eventCommunities.leave(id, user.userId);
  }
}
