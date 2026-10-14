import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { CreateStudioReleaseVersionDto } from './dto/create-studio-release-version.dto';
import { ScheduleStudioReleaseDto } from './dto/schedule-studio-release.dto';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioPreviewsService } from './studio-previews.service';
import { StudioReleaseRemindersService } from './studio-release-reminders.service';
import { StudioReleaseVersionsService } from './studio-release-versions.service';
import { StudioPreviewLink, StudioReleaseResponse } from './studio-response';
import { StudioSchedulingService } from './studio-scheduling.service';

// Studio v3 release tools: scheduling, Notify me, version notes and the
// private preview link. The v1 release routes stay in
// `StudioReleasesController`.
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description:
    '`studio_access_required`, `studio_not_persona_owner` or `studio_persona_kind_not_allowed`.',
})
@Controller('studio/releases')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioReleaseToolsController {
  constructor(
    private readonly scheduling: StudioSchedulingService,
    private readonly reminders: StudioReleaseRemindersService,
    private readonly versions: StudioReleaseVersionsService,
    private readonly previews: StudioPreviewsService,
  ) {}

  @Post(':id/schedule')
  @UseGuards(NotRestrictedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Schedule a draft, or move a scheduled release.' })
  @ApiOkResponse({ description: '`StudioRelease`.' })
  @ApiConflictResponse({
    description:
      '`studio_release_not_schedulable` or a `studio_publish_*` code.',
  })
  @ApiUnprocessableEntityResponse({
    description: '`studio_schedule_out_of_range`.',
  })
  schedule(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
    @Body() body: ScheduleStudioReleaseDto,
  ): Promise<StudioReleaseResponse> {
    return this.scheduling.schedule(user.userId, releaseId, body);
  }

  @Post(':id/unschedule')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Take a scheduled release back to draft.' })
  @ApiOkResponse({ description: '`StudioRelease`.' })
  @ApiConflictResponse({ description: '`studio_release_not_schedulable`.' })
  unschedule(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
  ): Promise<StudioReleaseResponse> {
    return this.scheduling.unschedule(user.userId, releaseId);
  }

  @Post(':id/versions')
  @UseGuards(NotRestrictedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add a version note to a published release.' })
  @ApiOkResponse({ description: '`StudioRelease`.' })
  @ApiConflictResponse({
    description: '`studio_release_no_changes` or `studio_release_not_draft`.',
  })
  addVersion(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
    @Body() body: CreateStudioReleaseVersionDto,
  ): Promise<StudioReleaseResponse> {
    return this.versions.addVersion(user.userId, releaseId, body);
  }

  // The link plays unreleased audio to other members, so restricted members
  // cannot mint one.
  @Post(':id/preview-link')
  @UseGuards(NotRestrictedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Make a private preview link, replacing the old.' })
  @ApiOkResponse({ description: '`StudioPreviewLink`.' })
  @ApiConflictResponse({ description: '`studio_preview_not_available`.' })
  mintPreviewLink(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
  ): Promise<StudioPreviewLink> {
    return this.previews.mintLink(user.userId, releaseId);
  }

  @Delete(':id/preview-link')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Turn the private preview link off.' })
  @ApiNoContentResponse({ description: 'Off (idempotent).' })
  revokePreviewLink(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
  ): Promise<void> {
    return this.previews.revokeLink(user.userId, releaseId);
  }

  @Put(':id/reminder')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Notify me when this scheduled release is out.' })
  @ApiNoContentResponse({ description: 'Set (idempotent).' })
  @ApiNotFoundResponse({ description: 'Not a scheduled release you can see.' })
  setReminder(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
  ): Promise<void> {
    return this.reminders.setReminder(user.userId, releaseId);
  }

  @Delete(':id/reminder')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Stop waiting for this release.' })
  @ApiNoContentResponse({ description: 'Cleared (idempotent).' })
  clearReminder(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
  ): Promise<void> {
    return this.reminders.clearReminder(user.userId, releaseId);
  }
}
