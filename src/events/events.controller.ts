import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { CheckInDto } from './dto/check-in.dto';
import { CohostDto } from './dto/cohost.dto';
import { CreateCohostInviteDto } from './dto/create-cohost-invite.dto';
import { CreateEventAnnouncementDto } from './dto/create-event-announcement.dto';
import { CreateEventBanDto } from './dto/create-event-ban.dto';
import { CreateEventDto } from './dto/create-event.dto';
import { InviteEventDto } from './dto/invite-event.dto';
import { ListAttendeesQuery } from './dto/list-attendees.query';
import { ListEventsQuery } from './dto/list-events.query';
import { PutLineupDto } from './dto/put-lineup.dto';
import { RespondCohostInviteDto } from './dto/respond-cohost-invite.dto';
import { RespondEventInviteDto } from './dto/respond-event-invite.dto';
import { RsvpDto } from './dto/rsvp.dto';
import { SeriesScopeQuery } from './dto/series-scope.query';
import { UpdateEventDto } from './dto/update-event.dto';
import { UpdateRsvpDetailsDto } from './dto/update-rsvp-details.dto';
import { EventAnnouncementsService } from './event-announcements.service';
import { EventBansService } from './event-bans.service';
import { EventBookmarksService } from './event-bookmarks.service';
import { EventCheckInService } from './event-check-in.service';
import { EventCohostInvitesService } from './event-cohost-invites.service';
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
    private readonly eventBookmarksService: EventBookmarksService,
    private readonly eventCohostInvitesService: EventCohostInvitesService,
    private readonly eventAnnouncementsService: EventAnnouncementsService,
    private readonly eventBansService: EventBansService,
    private readonly eventCheckInService: EventCheckInService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List events (filtered, paginated).',
    description:
      '`filter=saved` returns the caller\'s bookmarked ("saved") events, ' +
      'most-recently-saved first. Every summary carries `isBookmarked`. ' +
      '`from`/`to`/`hood`/`type`/`q`/`cost` are the discovery filters ' +
      '(LOC-17), applied in SQL so a filtered browse survives pagination; ' +
      'they narrow `filter=upcoming` (and `from`/`to`/`q` also narrow ' +
      '`filter=past`).',
  })
  @ApiOkResponse({ description: 'Event summaries for the requested filter.' })
  list(@CurrentUser() user: CurrentUserData, @Query() query: ListEventsQuery) {
    return this.eventsService.list(
      user.userId,
      query.filter ?? 'upcoming',
      query.page ?? 1,
      {
        hostSlug: query.hostSlug,
        excludeSlug: query.excludeSlug,
        from: query.from,
        to: query.to,
        hood: query.hood,
        type: query.type,
        q: query.q,
        cost: query.cost,
      },
    );
  }

  @Post()
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Create an event.' })
  @ApiCreatedResponse({ description: 'The created event detail.' })
  @ApiBadRequestResponse({
    description: 'Invalid schedule (past start, or end before start).',
  })
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateEventDto) {
    return this.eventsService.create(user.userId, dto);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get an event by slug.' })
  @ApiOkResponse({ description: 'The event detail.' })
  @ApiNotFoundResponse({
    description: 'No event with that slug, or not visible to you.',
  })
  get(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.eventsService.getBySlug(slug, user.userId);
  }

  @Patch(':slug')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Update an event you organize.',
    description:
      'For a recurring occurrence, `?scope=future` (MSG-10) also applies ' +
      'the patch to every later occurrence in its series (never `startAt`/' +
      '`endAt` — each occurrence keeps its own date). `?scope=this` (the ' +
      'default) touches only this occurrence.',
  })
  @ApiOkResponse({ description: 'The updated event detail.' })
  @ApiBadRequestResponse({ description: 'Invalid resulting schedule.' })
  @ApiForbiddenResponse({
    description: 'Only the host or a co-host can update it.',
  })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  @ApiConflictResponse({ description: 'A cancelled event cannot be reopened.' })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateEventDto,
    @Query() query: SeriesScopeQuery,
  ) {
    return this.eventsService.update(slug, user.userId, dto, query.scope);
  }

  @Post(':slug/cancel')
  @ApiOperation({
    summary: 'Cancel an event you organize.',
    description:
      'For a recurring occurrence, `?scope=future` (MSG-10) also cancels ' +
      'every later, not-yet-cancelled occurrence in its series. `?scope=this` ' +
      '(the default) cancels only this occurrence.',
  })
  @ApiCreatedResponse({ description: 'The cancelled event detail.' })
  @ApiForbiddenResponse({
    description: 'Only the host or a co-host can cancel it.',
  })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  cancel(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query() query: SeriesScopeQuery,
  ) {
    return this.eventsService.cancel(slug, user.userId, query.scope);
  }

  @Post(':slug/rsvp')
  @ApiOperation({ summary: 'RSVP to an event (going or maybe).' })
  @ApiCreatedResponse({
    description: 'The resolved RSVP status and waitlist position.',
  })
  @ApiBadRequestResponse({ description: 'The event is not open for RSVPs.' })
  @ApiNotFoundResponse({
    description:
      'No event with that slug, or its audience scope does not include you.',
  })
  rsvp(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: RsvpDto,
  ) {
    return this.rsvpService.rsvp(slug, user.userId, dto.status);
  }

  @Patch(':slug/rsvp/details')
  @ApiOperation({
    summary:
      'Update your own RSVP details ("Anything we should know?"): guest ' +
      'count, access/dietary needs, and who can see them.',
  })
  @ApiOkResponse({ description: 'The updated RSVP details.' })
  @ApiNotFoundResponse({
    description: 'No event with that slug, or you have no active RSVP to it.',
  })
  updateRsvpDetails(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateRsvpDetailsDto,
  ) {
    return this.rsvpService.updateRsvpDetails(slug, user.userId, dto);
  }

  @Delete(':slug/rsvp')
  @ApiOperation({
    summary: 'Cancel your RSVP to an event.',
    description:
      'For a recurring occurrence, `?scope=future` (MSG-10) also cancels ' +
      'your own RSVP (if any) on every later occurrence in its series — ' +
      "never anyone else's. `?scope=this` (the default) cancels only this " +
      'occurrence.',
  })
  @ApiOkResponse({ description: 'Cancellation acknowledged.' })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  cancelRsvp(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query() query: SeriesScopeQuery,
  ) {
    return this.rsvpService.cancelRsvp(slug, user.userId, query.scope);
  }

  @Post(':slug/bookmark')
  @ApiOperation({
    summary: 'Bookmark ("save") an event. Idempotent.',
    description:
      'Saving an already-saved event is a no-op that still reports ' +
      '`{ bookmarked: true }`. The event then surfaces under GET ' +
      '/events?filter=saved.',
  })
  @ApiCreatedResponse({ description: '`{ bookmarked: true }`.' })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  bookmark(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.eventBookmarksService.bookmark(user.userId, slug);
  }

  @Delete(':slug/bookmark')
  @ApiOperation({
    summary: 'Remove your bookmark from an event. Idempotent.',
  })
  @ApiOkResponse({ description: '`{ bookmarked: false }`.' })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  removeBookmark(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.eventBookmarksService.removeBookmark(user.userId, slug);
  }

  @Delete(':slug/attendees/:memberSlug')
  @ApiOperation({
    summary: 'Remove an attendee from an event you organize.',
    description:
      "Cancels the member's RSVP (going, maybe, or waitlisted) on their " +
      'behalf and, exactly like a self-cancellation, pulls the waitlist ' +
      "head(s) up when a 'going' seat is freed. Idempotent.",
  })
  @ApiOkResponse({ description: 'The attendee was removed (idempotent).' })
  @ApiForbiddenResponse({
    description: 'Only the host or a co-host can do that.',
  })
  @ApiNotFoundResponse({ description: 'No such event or member.' })
  removeAttendee(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('memberSlug') memberSlug: string,
  ) {
    return this.rsvpService.removeAttendee(slug, user.userId, memberSlug);
  }

  @Post(':slug/waitlist/:memberSlug/promote')
  @ApiOperation({
    summary:
      'Manually promote one waitlisted member to going — host/co-host only.',
    description:
      'Unlike the automatic FIFO sweep that runs on cancellation/capacity ' +
      'increase, this lets the host pick a specific waitlisted member out ' +
      'of order, subject to the same capacity check.',
  })
  @ApiCreatedResponse({ description: 'The member was promoted to going.' })
  @ApiBadRequestResponse({
    description: 'That member is not on the waitlist, or the event is full.',
  })
  @ApiForbiddenResponse({
    description: 'Only the host or a co-host can do that.',
  })
  @ApiNotFoundResponse({ description: 'No such event or member.' })
  promoteAttendee(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('memberSlug') memberSlug: string,
  ) {
    return this.rsvpService.promoteAttendee(slug, user.userId, memberSlug);
  }

  @Get(':slug/attendees')
  @ApiOperation({
    summary:
      "List an event's attendees for one RSVP status (going/waitlisted), paginated.",
  })
  @ApiOkResponse({ description: 'A paginated page of visible attendee views.' })
  @ApiNotFoundResponse({
    description: 'No event with that slug, or not visible to you.',
  })
  attendees(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query() query: ListAttendeesQuery,
  ) {
    return this.eventsService.attendees(
      slug,
      user.userId,
      query.status ?? 'going',
      query.page,
    );
  }

  @Post(':slug/cohosts')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Add a co-host to an event you organize.' })
  @ApiCreatedResponse({ description: 'The co-host was added (idempotent).' })
  @ApiBadRequestResponse({ description: 'Co-hosts must be active members.' })
  @ApiForbiddenResponse({
    description: 'Only the host or a co-host can do that.',
  })
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
  @ApiForbiddenResponse({
    description: 'Only the host or a co-host can do that.',
  })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  removeCohost(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('cohostSlug') cohostSlug: string,
  ) {
    return this.eventsService.removeCohost(slug, user.userId, cohostSlug);
  }

  @Post(':slug/invites')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Invite members to an event you organize.' })
  @ApiCreatedResponse({ description: 'How many invites were created.' })
  @ApiBadRequestResponse({
    description: 'Only a published event can send invites.',
  })
  @ApiForbiddenResponse({
    description: 'Only the host or a co-host can invite.',
  })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  invite(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: InviteEventDto,
  ) {
    return this.eventInvitesService.createInvites(slug, user.userId, dto.slugs);
  }

  @Post(':slug/cohost-invites')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Invite a member to co-host an event you organize.',
  })
  @ApiCreatedResponse({ description: 'The created invite id and status.' })
  @ApiBadRequestResponse({
    description:
      'Co-hosts must be active members, and you cannot invite yourself.',
  })
  @ApiForbiddenResponse({
    description: 'Only the host or a co-host can invite.',
  })
  @ApiNotFoundResponse({ description: 'No such event or member.' })
  @ApiConflictResponse({
    description: 'An invite is already pending for this member.',
  })
  inviteCohost(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateCohostInviteDto,
  ) {
    return this.eventCohostInvitesService.createInvite(slug, user.userId, dto);
  }

  @Put(':slug/lineup')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary:
      'Replace an event\'s lineup ("who performed") — host/co-host only.',
  })
  @ApiOkResponse({ description: 'The replaced lineup.' })
  @ApiForbiddenResponse({
    description: 'Only the host or a co-host can do that.',
  })
  @ApiNotFoundResponse({
    description: 'No event with that slug, or a member slug was not found.',
  })
  putLineup(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: PutLineupDto,
  ) {
    return this.eventsService.replaceLineup(slug, user.userId, dto.entries);
  }

  // ── Host announcements (LOC-06) ─────────────────────────────────────────

  @Post(':slug/announcements')
  @UseGuards(NotRestrictedGuard)
  // A gathering-wide fan-out is a loud act, so it is rate-limited the way
  // every other member-initiated broadcast on this platform is. Ten a minute
  // is far more than "we moved to the back room, and here is the door code"
  // ever needs, and far less than a channel worth abusing.
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @ApiOperation({
    summary: 'Send an announcement to everyone coming — host/co-host only.',
    description:
      'Reaches everyone holding a live RSVP (going, maybe or waitlisted) ' +
      'plus everyone holding a standing invite, minus the sender. Delivered ' +
      'as an in-app notification and a push, and stored on the gathering so ' +
      'a host can see what they already sent and an attendee can find it ' +
      'again at the door.',
  })
  @ApiCreatedResponse({ description: 'The stored announcement.' })
  @ApiBadRequestResponse({ description: 'The announcement body was empty.' })
  @ApiForbiddenResponse({
    description: 'Only the host or a co-host can do that.',
  })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  createAnnouncement(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateEventAnnouncementDto,
  ) {
    return this.eventAnnouncementsService.create(slug, user.userId, dto.body);
  }

  @Get(':slug/announcements')
  @ApiOperation({
    summary: "An event's announcements, newest first.",
    description:
      'Readable by the organisers and by anyone holding a live RSVP or a ' +
      'standing invite. Everyone else gets 403.',
  })
  @ApiOkResponse({ description: 'The announcements.' })
  @ApiForbiddenResponse({
    description: 'You have no stake in this gathering.',
  })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  listAnnouncements(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.eventAnnouncementsService.list(slug, user.userId);
  }

  // ── The host's own door (LOC-08) ────────────────────────────────────────

  @Post(':slug/bans')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({
    summary: 'Bar a member from an event you organize — host/co-host only.',
    description:
      'Cancels any RSVP they hold and stops them RSVPing again. The barred ' +
      'member is not notified, and the `reason` never leaves the organisers.',
  })
  @ApiCreatedResponse({ description: 'The stored bar.' })
  @ApiBadRequestResponse({
    description: 'You cannot bar the host, yourself, or a co-host.',
  })
  @ApiForbiddenResponse({
    description: 'Only the host or a co-host can do that.',
  })
  @ApiNotFoundResponse({ description: 'No such event or member.' })
  banFromEvent(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateEventBanDto,
  ) {
    return this.eventBansService.ban(
      slug,
      user.userId,
      dto.memberSlug,
      dto.reason,
    );
  }

  @Delete(':slug/bans/:memberSlug')
  @ApiOperation({
    summary: 'Lift a bar — host/co-host only. Idempotent.',
    description:
      'Lifting does not re-add them to the guest list; they choose whether ' +
      'to come back.',
  })
  @ApiOkResponse({ description: 'The bar was lifted (idempotent).' })
  @ApiForbiddenResponse({
    description: 'Only the host or a co-host can do that.',
  })
  @ApiNotFoundResponse({ description: 'No such event or member.' })
  liftEventBan(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('memberSlug') memberSlug: string,
  ) {
    return this.eventBansService.lift(slug, user.userId, memberSlug);
  }

  @Get(':slug/bans')
  @ApiOperation({
    summary: 'List the members barred from an event — host/co-host only.',
  })
  @ApiOkResponse({ description: 'The barred members.' })
  @ApiForbiddenResponse({
    description: 'Only the host or a co-host can do that.',
  })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  listEventBans(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.eventBansService.list(slug, user.userId);
  }

  // ── Day-of check-in (LOC-03) ────────────────────────────────────────────

  @Post(':slug/check-ins')
  @ApiOperation({
    summary: 'Check an attendee in at the door — host/co-host only.',
    description:
      'Send exactly one of `memberSlug` (the host tapped a name) or ' +
      '`cardToken` (the host scanned the QR on their membership card). ' +
      'Idempotent: a second check-in keeps the first arrival time.',
  })
  // A door desk taps fast and scans faster. Generous, and still a ceiling.
  @Throttle({ default: { limit: 120, ttl: seconds(60) } })
  @ApiCreatedResponse({
    description: "The attendee's row plus the door's four counts.",
  })
  @ApiBadRequestResponse({
    description:
      'Both or neither identifier was sent, the card could not be read, or ' +
      'that member has no seat yet.',
  })
  @ApiForbiddenResponse({
    description: 'Only the host or a co-host can do that.',
  })
  @ApiNotFoundResponse({
    description: 'No such event, or that member is not on the guest list.',
  })
  checkIn(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CheckInDto,
  ) {
    return this.eventCheckInService.checkIn(slug, user.userId, dto);
  }

  @Delete(':slug/check-ins/:memberSlug')
  @ApiOperation({
    summary: 'Undo a check-in — host/co-host only. Idempotent.',
  })
  @ApiOkResponse({
    description: "The attendee's row plus the door's four counts.",
  })
  @ApiForbiddenResponse({
    description: 'Only the host or a co-host can do that.',
  })
  @ApiNotFoundResponse({
    description: 'No such event, or that member is not on the guest list.',
  })
  undoCheckIn(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('memberSlug') memberSlug: string,
  ) {
    return this.eventCheckInService.undoCheckIn(slug, user.userId, memberSlug);
  }

  @Get(':slug/lineup')
  @ApiOperation({
    summary:
      "Get an event's lineup, plus the caller's own entry if they're on it.",
  })
  @ApiOkResponse({ description: "The lineup and the viewer's own entry." })
  @ApiNotFoundResponse({
    description: 'No event with that slug, or not visible to you.',
  })
  getLineup(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.eventsService.getLineup(slug, user.userId);
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
  @ApiConflictResponse({
    description: 'This invite has already been answered.',
  })
  respond(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondEventInviteDto,
  ) {
    return this.eventInvitesService.respondInvite(id, user.userId, dto.action);
  }
}

@Feature('events')
@ApiTags('Events')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('event-cohost-invites')
@UseGuards(ActiveMemberGuard)
export class EventCohostInvitesController {
  constructor(
    private readonly eventCohostInvitesService: EventCohostInvitesService,
    private readonly eventAnnouncementsService: EventAnnouncementsService,
    private readonly eventBansService: EventBansService,
    private readonly eventCheckInService: EventCheckInService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get a cohost invite (inviter or invitee only).' })
  @ApiOkResponse({ description: 'The invite detail.' })
  @ApiForbiddenResponse({ description: 'This invite is not visible to you.' })
  @ApiNotFoundResponse({ description: 'Invite not found.' })
  get(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.eventCohostInvitesService.getById(id, user.userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Respond to a cohost invite (accept or decline).' })
  @ApiOkResponse({ description: 'The invite id and its new status.' })
  @ApiForbiddenResponse({
    description: 'This invite is not addressed to you.',
  })
  @ApiNotFoundResponse({ description: 'Invite not found.' })
  @ApiConflictResponse({
    description: 'This invite has already been answered.',
  })
  respond(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondCohostInviteDto,
  ) {
    return this.eventCohostInvitesService.respond(id, user.userId, dto.action);
  }
}
