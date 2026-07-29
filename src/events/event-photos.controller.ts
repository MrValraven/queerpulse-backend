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
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';

// Event photo album. `ActiveMemberGuard` (class-level, mirrors EventsController)
// requires an active member; per-action authorization (organizer vs. attendee)
// lives in the service.
@ApiTags('Events')
@ApiCookieAuth()
@Controller('events')
@UseGuards(ActiveMemberGuard)
export class EventPhotosController {
  constructor(private readonly eventPhotos: EventPhotosService) {}

  @Post(':slug/photos')
  attach(
    @Param('slug') slug: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: AttachEventPhotoDto,
  ) {
    return this.eventPhotos.attach(slug, user, dto);
  }

  @Get(':slug/photos')
  list(@Param('slug') slug: string, @CurrentUser() user: CurrentUserData) {
    return this.eventPhotos.list(slug, user);
  }

  @Delete(':slug/photos/:photoId')
  remove(
    @Param('slug') slug: string,
    @Param('photoId') photoId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.eventPhotos.remove(slug, user, photoId);
  }
}
