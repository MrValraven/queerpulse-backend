import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { AttachEventPhotoDto } from './dto/attach-event-photo.dto';
import { EventPhotosService } from './event-photos.service';
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

// Event photo album. `ActiveMemberGuard` (class-level, mirrors EventsController)
// requires an active member; per-action authorization (organizer vs. attendee)
// lives in the service.
@ApiTags('Events')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('events')
@UseGuards(ActiveMemberGuard)
export class EventPhotosController {
  constructor(private readonly eventPhotos: EventPhotosService) {}

  @Post(':slug/photos')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: "Attach an uploaded photo to an event's album." })
  @ApiCreatedResponse({ description: 'The attached photo view.' })
  @ApiForbiddenResponse({
    description:
      'Only organizers can add photos, or the key is not a gathering photo.',
  })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  @ApiConflictResponse({
    description:
      'The photo is already attached to another event, or a moderator has taken it down.',
  })
  attach(
    @Param('slug') slug: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: AttachEventPhotoDto,
  ) {
    return this.eventPhotos.attach(slug, user, dto);
  }

  @Get(':slug/photos')
  @ApiOperation({
    summary: "List an event's photo album.",
    description:
      'Participants only (host, co-hosts, and members who RSVPd going). Any photo a moderator has hidden or removed under the `event_photo` subject is dropped from the album for every viewer, organizers included: an organizer is often the person a photo report is about, so there is no staff view of a taken-down photograph here.',
  })
  @ApiOkResponse({ description: 'The event photo views.' })
  @ApiForbiddenResponse({ description: 'Event photos are for attendees only.' })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  list(@Param('slug') slug: string, @CurrentUser() user: CurrentUserData) {
    return this.eventPhotos.list(slug, user);
  }

  @Delete(':slug/photos/:photoId')
  @ApiOperation({
    summary: "Remove a photo from an event's album.",
    description:
      'Takes down all three pieces: the stored object, its crop, and the album row. The uploader or an organizer may call it. Ordering is deliberate (see `EventPhotosService.remove`): a storage failure removes nothing and answers 5xx, so the take-down can simply be repeated. Repeating it after a fully successful removal answers 404.',
  })
  @ApiOkResponse({ description: 'Removal acknowledged.' })
  @ApiForbiddenResponse({ description: 'You cannot remove this photo.' })
  @ApiNotFoundResponse({ description: 'No such event or photo.' })
  @ApiBadRequestResponse({ description: 'Malformed photo id.' })
  remove(
    @Param('slug') slug: string,
    @Param('photoId', ParseUUIDPipe) photoId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.eventPhotos.remove(slug, user, photoId);
  }
}
