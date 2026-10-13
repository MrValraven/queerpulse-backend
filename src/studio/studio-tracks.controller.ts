import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
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
import { ConfirmStudioAudioDto } from './dto/confirm-studio-audio.dto';
import { CreateStudioTrackDto } from './dto/create-studio-track.dto';
import { ReorderStudioTracksDto } from './dto/reorder-studio-tracks.dto';
import { UpdateStudioTrackDto } from './dto/update-studio-track.dto';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioAudioConfirmService } from './studio-audio-confirm.service';
import { StudioReleaseResponse, StudioTrackResponse } from './studio-response';
import { StudioTracksService } from './studio-tracks.service';

@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description:
    '`studio_access_required`, `studio_not_persona_owner` or `studio_persona_kind_not_allowed`.',
})
@Controller('studio')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioTracksController {
  constructor(
    private readonly tracks: StudioTracksService,
    private readonly audioConfirm: StudioAudioConfirmService,
  ) {}

  @Post('releases/:id/tracks')
  @ApiOperation({ summary: 'Add a track to a draft release.' })
  @ApiOkResponse({ description: '`StudioTrack`.' })
  @ApiConflictResponse({
    description: '`studio_release_not_draft` or `studio_track_limit`.',
  })
  createTrack(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
    @Body() body: CreateStudioTrackDto,
  ): Promise<StudioTrackResponse> {
    return this.tracks.create(user.userId, releaseId, body);
  }

  @Patch('tracks/:id')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Edit a track title, credits, lyrics or flag.' })
  @ApiOkResponse({ description: '`StudioTrack`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not yours.' })
  updateTrack(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) trackId: string,
    @Body() body: UpdateStudioTrackDto,
  ): Promise<StudioTrackResponse> {
    return this.tracks.update(user.userId, trackId, body);
  }

  @Delete('tracks/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a track of a draft release.' })
  @ApiNoContentResponse({ description: 'Deleted; positions closed up.' })
  @ApiConflictResponse({ description: '`studio_release_not_draft`.' })
  removeTrack(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) trackId: string,
  ): Promise<void> {
    return this.tracks.remove(user.userId, trackId);
  }

  @Put('releases/:id/track-order')
  @ApiOperation({ summary: 'Set the order of every track of a draft.' })
  @ApiOkResponse({ description: '`StudioRelease`.' })
  @ApiConflictResponse({
    description: '`studio_track_order_mismatch` or `studio_release_not_draft`.',
  })
  reorderTracks(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
    @Body() body: ReorderStudioTracksDto,
  ): Promise<StudioReleaseResponse> {
    return this.tracks.reorder(user.userId, releaseId, body);
  }

  @Post('tracks/:id/audio')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Attach an uploaded file as the track's audio." })
  @ApiOkResponse({ description: '`StudioTrack`.' })
  @ApiUnprocessableEntityResponse({
    description: '`studio_audio_unreadable` or `studio_audio_wrong_owner`.',
  })
  confirmAudio(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) trackId: string,
    @Body() body: ConfirmStudioAudioDto,
  ): Promise<StudioTrackResponse> {
    return this.audioConfirm.confirm(user.userId, trackId, body.key);
  }
}
