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

@Controller('events')
@UseGuards(ActiveMemberGuard)
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly rsvpService: RsvpService,
    private readonly eventInvitesService: EventInvitesService,
  ) {}

  @Get()
  list(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListEventsQuery,
  ) {
    return this.eventsService.list(
      user.userId,
      query.filter ?? 'upcoming',
      query.page ?? 1,
    );
  }

  @Post()
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateEventDto,
  ) {
    return this.eventsService.create(user.userId, dto);
  }

  @Get(':slug')
  get(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.eventsService.getBySlug(slug, user.userId);
  }

  @Patch(':slug')
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateEventDto,
  ) {
    return this.eventsService.update(slug, user.userId, dto);
  }

  @Post(':slug/cancel')
  cancel(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.eventsService.cancel(slug, user.userId);
  }

  @Post(':slug/rsvp')
  rsvp(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: RsvpDto,
  ) {
    return this.rsvpService.rsvp(slug, user.userId, dto.status);
  }

  @Delete(':slug/rsvp')
  cancelRsvp(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.rsvpService.cancelRsvp(slug, user.userId);
  }

  @Get(':slug/attendees')
  attendees(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.eventsService.attendees(slug, user.userId);
  }

  @Post(':slug/cohosts')
  addCohost(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CohostDto,
  ) {
    return this.eventsService.addCohost(slug, user.userId, dto.slug);
  }

  @Delete(':slug/cohosts/:cohostSlug')
  removeCohost(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('cohostSlug') cohostSlug: string,
  ) {
    return this.eventsService.removeCohost(slug, user.userId, cohostSlug);
  }

  @Post(':slug/invites')
  invite(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: InviteEventDto,
  ) {
    return this.eventInvitesService.createInvites(slug, user.userId, dto.slugs);
  }
}

@Controller('event-invites')
@UseGuards(ActiveMemberGuard)
export class EventInvitesController {
  constructor(private readonly eventInvitesService: EventInvitesService) {}

  @Patch(':id')
  respond(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondEventInviteDto,
  ) {
    return this.eventInvitesService.respondInvite(id, user.userId, dto.action);
  }
}
