import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
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
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AddStudioTrackWarningsDto } from './dto/add-studio-track-warnings.dto';
import { MarkStudioTrackExplicitDto } from './dto/mark-studio-track-explicit.dto';
import { StudioAdminTracksService } from './studio-admin-tracks.service';
import { StudioAdminTrack } from './studio-claim-response';

// Studio safety and moderation: the reports tab's track card and the two
// track actions. No Studio grant needed, like the other Studio staff routes.
@Feature('studio')
@ApiTags('Admin: Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller('admin/studio/tracks')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminStudioTracksController {
  constructor(private readonly adminTracks: StudioAdminTracksService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Any track, any status, for the track card.' })
  @ApiOkResponse({ description: '`StudioAdminTrack`.' })
  @ApiNotFoundResponse({ description: 'Track not found.' })
  getTrack(
    @Param('id', ParseUUIDPipe) trackId: string,
  ): Promise<StudioAdminTrack> {
    return this.adminTracks.getTrack(trackId);
  }

  @Post(':id/mark-explicit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Mark a track explicit and lock the flag; resolves the named report.',
  })
  @ApiOkResponse({ description: '`StudioAdminTrack`.' })
  @ApiNotFoundResponse({ description: 'Track not found.' })
  @ApiUnprocessableEntityResponse({
    description: '`studio_track_report_mismatch`.',
  })
  @ApiConflictResponse({ description: '`studio_track_report_not_open`.' })
  markExplicit(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) trackId: string,
    @Body() body: MarkStudioTrackExplicitDto,
  ): Promise<StudioAdminTrack> {
    return this.adminTracks.markExplicit(user.userId, trackId, body.reportId);
  }

  @Post(':id/content-warnings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Add content warnings the artist cannot remove; resolves the named report.',
  })
  @ApiOkResponse({ description: '`StudioAdminTrack`.' })
  @ApiNotFoundResponse({ description: 'Track not found.' })
  @ApiUnprocessableEntityResponse({
    description: '`studio_track_report_mismatch`.',
  })
  @ApiConflictResponse({ description: '`studio_track_report_not_open`.' })
  addContentWarnings(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) trackId: string,
    @Body() body: AddStudioTrackWarningsDto,
  ): Promise<StudioAdminTrack> {
    return this.adminTracks.addContentWarnings(
      user.userId,
      trackId,
      body.warnings,
      body.reportId,
    );
  }
}
