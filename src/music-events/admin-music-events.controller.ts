import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
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
  ApiCookieAuth,
  ApiForbiddenResponse,
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
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { Feature } from '../common/feature.decorator';
import { ChangeLineupRoleDto } from '../events/dto/change-lineup-role.dto';
import { CheckInDto } from '../events/dto/check-in.dto';
import { CohostDto } from '../events/dto/cohost.dto';
import { CreateEventAnnouncementDto } from '../events/dto/create-event-announcement.dto';
import { CreateEventBanDto } from '../events/dto/create-event-ban.dto';
import { CreateLineupInviteDto } from '../events/dto/create-lineup-invite.dto';
import { GuestPreviewQuery } from '../events/dto/guest-preview.query';
import { InviteEventDto } from '../events/dto/invite-event.dto';
import { ListAttendeesQuery } from '../events/dto/list-attendees.query';
import { SeriesScopeQuery } from '../events/dto/series-scope.query';
import { HostConfigDto } from '../go-together/dto/host-config.dto';
import { GoTogetherLaunchGuard } from '../go-together/go-together-launch.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminMusicEventGuestsService } from './admin-music-event-guests.service';
import { AdminMusicEventProgramService } from './admin-music-event-program.service';
import { AdminMusicEventsService } from './admin-music-events.service';
import { CreateMusicEventDto } from './dto/create-music-event.dto';
import { ListMusicEventsQuery } from './dto/list-music-events.query';
import { StudioArtistSearchQuery } from './dto/studio-artist-search.query';
import { UpdateMusicEventDto } from './dto/update-music-event.dto';
import { StudioArtistSearchService } from './studio-artist-search.service';

/**
 * The QueerPulse music manager and producer page. Every route acts as the
 * house account on a Music event the house hosts, and `:slug` routes answer
 * 404 `music_event_not_found` for any other event. The two-segment
 * `studio-artists/search` route is declared first and `GET /` before every
 * `:slug` route. There is no route that deletes an event.
 */
@Feature('events')
@ApiTags('Admin, Music events')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@ApiForbiddenResponse({
  description:
    'Requires the admin tier or the music_manager_producer staff grant.',
})
@Controller('admin/music-events')
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles('music_manager_producer')
export class AdminMusicEventsController {
  constructor(
    private readonly studioArtistSearch: StudioArtistSearchService,
    private readonly musicEvents: AdminMusicEventsService,
    private readonly guests: AdminMusicEventGuestsService,
    private readonly program: AdminMusicEventProgramService,
  ) {}

  @Get('studio-artists/search')
  @ApiOperation({
    summary: 'Search Studio artists to book onto an event lineup.',
  })
  @ApiOkResponse({
    description:
      'A page of active members who created a linked, listenable artist persona.',
  })
  searchStudioArtists(
    @CurrentUser() user: CurrentUserData,
    @Query() query: StudioArtistSearchQuery,
  ) {
    return this.studioArtistSearch.search(user.userId, query.q, query.page);
  }

  @Get()
  @ApiOperation({ summary: 'List the Music events QueerPulse hosts.' })
  @ApiOkResponse({
    description:
      'A page of events for one bucket, with lineup counts, pending invite request counts and the attention totals.',
  })
  list(@Query() query: ListMusicEventsQuery) {
    return this.musicEvents.list(query);
  }

  @Post()
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Create a Music event hosted by QueerPulse.' })
  @ApiForbiddenResponse({
    description:
      'Requires the admin tier or the music_manager_producer staff grant, or the family was set to anything other than music (house_event_family_locked).',
  })
  @ApiBadRequestResponse({
    description:
      'A QueerPulse music event is open to every member, so the community-only audience is refused (music_event_community_unavailable).',
  })
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateMusicEventDto,
  ) {
    return this.musicEvents.create(user.userId, dto);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Read a Music event QueerPulse hosts.' })
  @ApiNotFoundResponse({
    description: 'No Music event hosted by QueerPulse has that slug.',
  })
  read(@Param('slug') slug: string, @Query() query: GuestPreviewQuery) {
    return this.musicEvents.read(slug, query.viewAs);
  }

  @Patch(':slug')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Update a Music event QueerPulse hosts.' })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateMusicEventDto,
    @Query() query: SeriesScopeQuery,
  ) {
    return this.musicEvents.update(
      user.userId,
      slug,
      dto,
      query.scope ?? 'this',
    );
  }

  @Post(':slug/cancel')
  @ApiOperation({ summary: 'Cancel a Music event QueerPulse hosts.' })
  cancel(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query() query: SeriesScopeQuery,
  ) {
    return this.musicEvents.cancel(user.userId, slug, query.scope ?? 'this');
  }

  @Get(':slug/lineup')
  @ApiOperation({ summary: 'The lineup of an event, every row.' })
  lineup(@Param('slug') slug: string, @Query() query: GuestPreviewQuery) {
    return this.program.lineup(slug, query.viewAs);
  }

  @Post(':slug/lineup')
  @UseGuards(NotRestrictedGuard)
  // Each booking lands in a performer's bell.
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @ApiOperation({
    summary: 'Book a Studio artist onto the lineup as QueerPulse.',
  })
  @ApiForbiddenResponse({
    description:
      'Requires the admin tier or the music_manager_producer staff grant, or the member is not a Studio artist or a block exists with you (music_event_performer_not_studio_artist).',
  })
  book(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateLineupInviteDto,
  ) {
    return this.program.book(user.userId, slug, dto);
  }

  @Patch(':slug/lineup/:memberSlug')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: "Change a performer's role on the lineup." })
  changeRole(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('memberSlug') memberSlug: string,
    @Body() dto: ChangeLineupRoleDto,
  ) {
    return this.program.changeRole(user.userId, slug, memberSlug, dto);
  }

  @Delete(':slug/lineup/:memberSlug')
  @ApiOperation({ summary: 'Remove a performer from the lineup.' })
  removePerformer(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('memberSlug') memberSlug: string,
  ) {
    return this.program.removePerformer(user.userId, slug, memberSlug);
  }

  @Get(':slug/announcements')
  @ApiOperation({ summary: 'The announcements posted on an event.' })
  announcements(@Param('slug') slug: string) {
    return this.program.announcements(slug);
  }

  @Post(':slug/announcements')
  @UseGuards(NotRestrictedGuard)
  // Each announcement notifies every guest.
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Post an announcement on an event as QueerPulse.' })
  postAnnouncement(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateEventAnnouncementDto,
  ) {
    return this.program.postAnnouncement(user.userId, slug, dto);
  }

  @Get(':slug/attendees')
  @ApiOperation({
    summary: 'The guest list and door counts of an event, organizer view.',
  })
  attendees(@Param('slug') slug: string, @Query() query: ListAttendeesQuery) {
    return this.guests.roster(slug, query);
  }

  @Get(':slug/attendees.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="event-guests.csv"')
  @ApiOperation({ summary: 'Download the full guest list of an event as CSV.' })
  @ApiOkResponse({ description: 'A CSV body: going first, then the waitlist.' })
  attendeesCsv(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.guests.exportCsv(user.userId, slug);
  }

  @Post(':slug/waitlist/:memberSlug/promote')
  @ApiOperation({ summary: 'Move a waitlisted guest onto the guest list.' })
  promote(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('memberSlug') memberSlug: string,
  ) {
    return this.guests.promote(user.userId, slug, memberSlug);
  }

  @Delete(':slug/attendees/:memberSlug')
  @ApiOperation({ summary: 'Remove a guest from an event.' })
  removeGuest(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('memberSlug') memberSlug: string,
  ) {
    return this.guests.removeGuest(user.userId, slug, memberSlug);
  }

  @Post(':slug/bans')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Bar a member from an event.' })
  bar(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateEventBanDto,
  ) {
    return this.guests.bar(user.userId, slug, dto);
  }

  @Get(':slug/bans')
  @ApiOperation({ summary: 'The members barred from an event.' })
  listBars(@Param('slug') slug: string) {
    return this.guests.listBars(slug);
  }

  @Delete(':slug/bans/:memberSlug')
  @ApiOperation({ summary: 'Lift a bar on a member.' })
  liftBar(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('memberSlug') memberSlug: string,
  ) {
    return this.guests.liftBar(user.userId, slug, memberSlug);
  }

  @Post(':slug/invites')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Invite members to an event as QueerPulse.' })
  sendInvites(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: InviteEventDto,
  ) {
    return this.guests.sendInvites(user.userId, slug, dto);
  }

  @Get(':slug/invite-requests')
  @ApiOperation({ summary: 'The open invite requests on an event.' })
  listInviteRequests(@Param('slug') slug: string) {
    return this.guests.listInviteRequests(slug);
  }

  @Post(':slug/invite-requests/:inviteId/approve')
  @ApiOperation({ summary: 'Approve an invite request on an event.' })
  @ApiNotFoundResponse({
    description:
      'The request is not on this event (music_event_invite_request_not_found).',
  })
  approveInviteRequest(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
  ) {
    return this.guests.decideInviteRequest(
      user.userId,
      slug,
      inviteId,
      'approve',
    );
  }

  @Post(':slug/invite-requests/:inviteId/decline')
  @ApiOperation({ summary: 'Decline an invite request on an event.' })
  @ApiNotFoundResponse({
    description:
      'The request is not on this event (music_event_invite_request_not_found).',
  })
  declineInviteRequest(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
  ) {
    return this.guests.decideInviteRequest(
      user.userId,
      slug,
      inviteId,
      'decline',
    );
  }

  @Post(':slug/check-ins')
  // A door desk taps fast and scans faster. Generous, and still a ceiling.
  @Throttle({ default: { limit: 120, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Check a guest in at the door.' })
  checkIn(@Param('slug') slug: string, @Body() dto: CheckInDto) {
    return this.guests.checkIn(slug, dto);
  }

  @Delete(':slug/check-ins/:memberSlug')
  @ApiOperation({ summary: 'Undo a door check-in. Idempotent.' })
  undoCheckIn(
    @Param('slug') slug: string,
    @Param('memberSlug') memberSlug: string,
  ) {
    return this.guests.undoCheckIn(slug, memberSlug);
  }

  @Get(':slug/cohosts')
  @ApiOperation({ summary: 'The co-hosts of an event.' })
  cohosts(@Param('slug') slug: string) {
    return this.program.cohosts(slug);
  }

  @Post(':slug/cohosts')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Add a co-host to an event directly.' })
  addCohost(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CohostDto,
  ) {
    return this.program.addCohost(user.userId, slug, dto);
  }

  @Delete(':slug/cohosts/:cohostSlug')
  @ApiOperation({ summary: 'Remove a co-host from an event.' })
  removeCohost(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('cohostSlug') cohostSlug: string,
  ) {
    return this.program.removeCohost(user.userId, slug, cohostSlug);
  }

  @Get(':slug/go-together/config')
  @Feature('goTogether')
  @UseGuards(GoTogetherLaunchGuard)
  @ApiOperation({ summary: 'The Go together settings for an event.' })
  goTogetherConfig(@Param('slug') slug: string) {
    return this.program.goTogetherConfig(slug);
  }

  @Put(':slug/go-together/config')
  @Feature('goTogether')
  @UseGuards(GoTogetherLaunchGuard, NotRestrictedGuard)
  @ApiOperation({ summary: 'Save the Go together settings for an event.' })
  saveGoTogetherConfig(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: HostConfigDto,
  ) {
    return this.program.saveGoTogetherConfig(user.userId, slug, dto);
  }

  @Get(':slug/go-together/summary')
  @Feature('goTogether')
  @UseGuards(GoTogetherLaunchGuard)
  @ApiOperation({ summary: 'How many members are waiting for Go together.' })
  goTogetherSummary(@Param('slug') slug: string) {
    return this.program.goTogetherSummary(slug);
  }
}
