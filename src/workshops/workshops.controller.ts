import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { CreateWorkshopDto } from './dto/create-workshop.dto';
import { ListWorkshopsQuery } from './dto/list-workshops.query';
import { UpdateWorkshopDto } from './dto/update-workshop.dto';
import { WorkshopRsvpsService } from './workshop-rsvps.service';
import { WorkshopsService } from './workshops.service';
import {
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

/**
 * Member-hosted, multi-week workshops — the catalogue behind the frontend's
 * Skills & learning page (`SkillsPage` -> `WorkshopsSection`) and each
 * workshop's own page (`WorkshopPage`). FE: `workshops.api.ts`.
 *
 * `list` takes the viewer so block/mute filtering can run inside the query
 * (see `WorkshopsService.list`); `update`/`remove` are host-gated in the
 * service, mirroring `jobs`' poster gating.
 *
 * Reservations live on `:slug/rsvp` + `:slug/attendees`, laid out exactly like
 * `events`' RSVP routes. Unlike `events`, `POST` takes no body: a workshop seat
 * has no "maybe" to choose between (see `WorkshopRsvpStatus`), so there is
 * nothing for a DTO to carry — the route is "give me a seat".
 */
@Feature('workshops')
@ApiTags('Workshops')
@ApiCookieAuth()
@Controller('workshops')
@UseGuards(ActiveMemberGuard)
export class WorkshopsController {
  constructor(
    private readonly workshopsService: WorkshopsService,
    private readonly rsvpsService: WorkshopRsvpsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List workshops' })
  @ApiOkResponse({ description: 'Workshops visible to the viewer.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  list(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListWorkshopsQuery,
  ) {
    return this.workshopsService.list(user.userId, query);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get one workshop by slug' })
  @ApiOkResponse({ description: 'The workshop.' })
  @ApiNotFoundResponse({ description: 'No workshop with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  get(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.workshopsService.getBySlug(slug, user.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Host a workshop' })
  @ApiCreatedResponse({ description: 'The created workshop.' })
  @ApiConflictResponse({ description: 'Could not allocate a unique slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateWorkshopDto) {
    return this.workshopsService.create(user.userId, dto);
  }

  @Patch(':slug')
  @ApiOperation({ summary: 'Update a workshop you host' })
  @ApiOkResponse({ description: 'The updated workshop.' })
  @ApiForbiddenResponse({
    description: 'Only the host can update this workshop.',
  })
  @ApiNotFoundResponse({ description: 'No workshop with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateWorkshopDto,
  ) {
    return this.workshopsService.update(slug, user.userId, dto);
  }

  @Delete(':slug')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a workshop you host' })
  @ApiNoContentResponse({ description: 'Workshop deleted.' })
  @ApiForbiddenResponse({
    description: 'Only the host can delete this workshop.',
  })
  @ApiNotFoundResponse({ description: 'No workshop with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  remove(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.workshopsService.remove(slug, user.userId);
  }

  /** Take a seat, or join the queue when the cohort is full. Idempotent. */
  @Post(':slug/rsvp')
  @ApiOperation({
    summary: 'Reserve a seat (or join the waitlist). Idempotent.',
  })
  @ApiCreatedResponse({ description: 'The viewer’s reservation standing.' })
  @ApiForbiddenResponse({ description: 'You are hosting this workshop.' })
  @ApiNotFoundResponse({ description: 'No workshop with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  rsvp(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.rsvpsService.rsvp(slug, user.userId);
  }

  /** Give the seat back. 204 whether or not there was one to give back. */
  @Delete(':slug/rsvp')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Give up your seat. Idempotent.' })
  @ApiNoContentResponse({
    description: 'Reservation cancelled (whether or not one existed).',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  cancelRsvp(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.rsvpsService.cancelRsvp(slug, user.userId);
  }

  /** Who is coming — host and fellow attendees only (403 otherwise). */
  @Get(':slug/attendees')
  @ApiOperation({ summary: 'List attendees — host and fellow attendees only' })
  @ApiOkResponse({ description: 'The workshop’s attendees.' })
  @ApiForbiddenResponse({
    description: 'Only the host and attendees can view this.',
  })
  @ApiNotFoundResponse({ description: 'No workshop with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  attendees(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.rsvpsService.attendees(slug, user.userId);
  }
}
