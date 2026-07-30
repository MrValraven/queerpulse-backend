import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CohostDto } from './dto/cohost.dto';
import { CreateEventDto } from './dto/create-event.dto';
import { InviteEventDto } from './dto/invite-event.dto';
import { ListEventsQuery } from './dto/list-events.query';
import { RespondEventInviteDto } from './dto/respond-event-invite.dto';
import { RsvpDto } from './dto/rsvp.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { EventInvitesService } from './event-invites.service';
import { EventsService } from './events.service';
import { RsvpService } from './rsvp.service';
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

@Feature('events')
@ApiTags('Events')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('events')
@UseGuards(ActiveMemberGuard)
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly rsvpService: RsvpService,
    private readonly eventInvitesService: EventInvitesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List events (filtered, paginated).' })
  @ApiOkResponse({ description: 'Event summaries for the requested filter.' })
  list(@CurrentUser() user: CurrentUserData, @Query() query: ListEventsQuery) {
    return this.eventsService.list(
      user.userId,
      query.filter ?? 'upcoming',
      query.page ?? 1,
    );
  }

  @Post()
  @ApiOperation({ summary: 'Create an event.' })
  @ApiCreatedResponse({ description: 'The created event detail.' })
  @ApiBadRequestResponse({ description: 'Invalid schedule (past start, or end before start).' })
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateEventDto) {
    return this.eventsService.create(user.userId, dto);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get an event by slug.' })
  @ApiOkResponse({ description: 'The event detail.' })
  @ApiNotFoundResponse({ description: 'No event with that slug, or not visible to you.' })
  get(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.eventsService.getBySlug(slug, user.userId);
  }

  @Patch(':slug')
  @ApiOperation({ summary: 'Update an event you organize.' })
  @ApiOkResponse({ description: 'The updated event detail.' })
  @ApiBadRequestResponse({ description: 'Invalid resulting schedule.' })
  @ApiForbiddenResponse({ description: 'Only the host or a co-host can update it.' })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  @ApiConflictResponse({ description: 'A cancelled event cannot be reopened.' })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateEventDto,
  ) {
    return this.eventsService.update(slug, user.userId, dto);
  }

  @Post(':slug/cancel')
  @ApiOperation({ summary: 'Cancel an event you organize.' })
  @ApiCreatedResponse({ description: 'The cancelled event detail.' })
  @ApiForbiddenResponse({ description: 'Only the host or a co-host can cancel it.' })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  cancel(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.eventsService.cancel(slug, user.userId);
  }

  @Post(':slug/rsvp')
  @ApiOperation({ summary: 'RSVP to an event (going or maybe).' })
  @ApiCreatedResponse({ description: 'The resolved RSVP status and waitlist position.' })
  @ApiBadRequestResponse({ description: 'The event is not open for RSVPs.' })
  @ApiForbiddenResponse({ description: 'This event is invite-only.' })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  rsvp(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: RsvpDto,
  ) {
    return this.rsvpService.rsvp(slug, user.userId, dto.status);
  }

  @Delete(':slug/rsvp')
  @ApiOperation({ summary: 'Cancel your RSVP to an event.' })
  @ApiOkResponse({ description: 'Cancellation acknowledged.' })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  cancelRsvp(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.rsvpService.cancelRsvp(slug, user.userId);
  }

  @Get(':slug/attendees')
  @ApiOperation({ summary: "List an event's attendees." })
  @ApiOkResponse({ description: 'The visible attendee views.' })
  @ApiNotFoundResponse({ description: 'No event with that slug, or not visible to you.' })
  attendees(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.eventsService.attendees(slug, user.userId);
  }

  @Post(':slug/cohosts')
  @ApiOperation({ summary: 'Add a co-host to an event you organize.' })
  @ApiCreatedResponse({ description: 'The co-host was added (idempotent).' })
  @ApiBadRequestResponse({ description: 'Co-hosts must be active members.' })
  @ApiForbiddenResponse({ description: 'Only the host or a co-host can do that.' })
  @ApiNotFoundResponse({ description: 'No such event or member.' })
  addCohost(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CohostDto,
  ) {
    return this.eventsService.addCohost(slug, user.userId, dto.slug);
  }

  @Delete(':slug/cohosts/:cohostSlug')
  @ApiOperation({ summary: 'Remove a co-host from an event you organize.' })
  @ApiOkResponse({ description: 'The co-host was removed (idempotent).' })
  @ApiForbiddenResponse({ description: 'Only the host or a co-host can do that.' })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  removeCohost(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('cohostSlug') cohostSlug: string,
  ) {
    return this.eventsService.removeCohost(slug, user.userId, cohostSlug);
  }

  @Post(':slug/invites')
  @ApiOperation({ summary: 'Invite members to an event you organize.' })
  @ApiCreatedResponse({ description: 'How many invites were created.' })
  @ApiBadRequestResponse({ description: 'Only a published event can send invites.' })
  @ApiForbiddenResponse({ description: 'Only the host or a co-host can invite.' })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  invite(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: InviteEventDto,
  ) {
    return this.eventInvitesService.createInvites(slug, user.userId, dto.slugs);
  }
}

@Feature('events')
@ApiTags('Events')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('event-invites')
@UseGuards(ActiveMemberGuard)
export class EventInvitesController {
  constructor(private readonly eventInvitesService: EventInvitesService) {}

  @Get()
  @ApiOperation({ summary: 'List your pending event invites.' })
  @ApiOkResponse({ description: 'Your pending event invites.' })
  listMine(@CurrentUser() user: CurrentUserData) {
    return this.eventInvitesService.listMyPendingInvites(user.userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Respond to an event invite (accept or decline).' })
  @ApiOkResponse({ description: 'The invite id and its new status.' })
  @ApiForbiddenResponse({ description: 'This invite is not addressed to you.' })
  @ApiNotFoundResponse({ description: 'Invite not found.' })
  @ApiConflictResponse({ description: 'This invite has already been answered.' })
  respond(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondEventInviteDto,
  ) {
    return this.eventInvitesService.respondInvite(id, user.userId, dto.action);
  }
}
