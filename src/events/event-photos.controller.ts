import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { AttachEventPhotoDto } from './dto/attach-event-photo.dto';
import { EventPhotosService } from './event-photos.service';
import {
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
  @ApiOperation({ summary: "Attach an uploaded photo to an event's album." })
  @ApiCreatedResponse({ description: 'The attached photo view.' })
  @ApiForbiddenResponse({
    description: 'Only organizers can add photos, or the key is not a gathering photo.',
  })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  @ApiConflictResponse({
    description: 'The photo is already attached to another event.',
  })
  attach(
    @Param('slug') slug: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: AttachEventPhotoDto,
  ) {
    return this.eventPhotos.attach(slug, user, dto);
  }

  @Get(':slug/photos')
  @ApiOperation({ summary: "List an event's photo album." })
  @ApiOkResponse({ description: 'The event photo views.' })
  @ApiForbiddenResponse({ description: 'Event photos are for attendees only.' })
  @ApiNotFoundResponse({ description: 'No event with that slug.' })
  list(@Param('slug') slug: string, @CurrentUser() user: CurrentUserData) {
    return this.eventPhotos.list(slug, user);
  }

  @Delete(':slug/photos/:photoId')
  @ApiOperation({ summary: "Remove a photo from an event's album." })
  @ApiOkResponse({ description: 'Removal acknowledged.' })
  @ApiForbiddenResponse({ description: 'You cannot remove this photo.' })
  @ApiNotFoundResponse({ description: 'No such event or photo.' })
  remove(
    @Param('slug') slug: string,
    @Param('photoId') photoId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.eventPhotos.remove(slug, user, photoId);
  }
}
