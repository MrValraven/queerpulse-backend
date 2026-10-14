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
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { Throttle, seconds } from '@nestjs/throttler';
import { CreateStudioReleaseDto } from './dto/create-studio-release.dto';
import { CreateStudioDisputeDto } from './dto/create-studio-dispute.dto';
import { UpdateStudioReleaseDto } from './dto/update-studio-release.dto';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioDisputesService } from './studio-disputes.service';
import { StudioReleasesService } from './studio-releases.service';
import { StudioReleaseResponse } from './studio-response';

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
export class StudioReleasesController {
  constructor(
    private readonly releases: StudioReleasesService,
    private readonly disputes: StudioDisputesService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a draft release for a persona.' })
  @ApiOkResponse({ description: 'The draft, as `StudioRelease`.' })
  @ApiConflictResponse({ description: '`studio_release_type_mismatch`.' })
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() body: CreateStudioReleaseDto,
  ): Promise<StudioReleaseResponse> {
    return this.releases.create(user.userId, body);
  }

  // Named `update` on purpose: `PERSONA_SCOPED_KEY_HANDLERS` lists
  // `StudioReleasesController.update`, so a persona-scoped cover key may ride
  // in this body.
  @Patch(':id')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Edit a draft or published release.' })
  @ApiOkResponse({ description: '`StudioRelease`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not yours.' })
  @ApiConflictResponse({
    description:
      '`studio_release_not_draft`, `studio_release_type_mismatch`, or `studio_publish_missing_cover` when clearing the cover of a published release.',
  })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
    @Body() body: UpdateStudioReleaseDto,
  ): Promise<StudioReleaseResponse> {
    return this.releases.update(user.userId, releaseId, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a draft release and its audio.' })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiConflictResponse({ description: '`studio_release_not_draft`.' })
  remove(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
  ): Promise<void> {
    return this.releases.remove(user.userId, releaseId);
  }

  @Post(':id/publish')
  @UseGuards(NotRestrictedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish a draft that meets the publish rule.' })
  @ApiOkResponse({ description: '`StudioRelease`.' })
  @ApiConflictResponse({
    description: 'A `studio_publish_*` code, or `studio_release_not_draft`.',
  })
  publish(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
  ): Promise<StudioReleaseResponse> {
    return this.releases.publish(user.userId, releaseId);
  }

  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Take a published release back to draft.' })
  @ApiOkResponse({ description: '`StudioRelease`.' })
  @ApiConflictResponse({ description: '`studio_release_not_draft`.' })
  unpublish(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
  ): Promise<StudioReleaseResponse> {
    return this.releases.unpublish(user.userId, releaseId);
  }

  // Studio open demo pages. No `NotRestrictedGuard`: a restricted member can
  // still dispute a takedown of their own release. Throttled like the other
  // member flag routes.
  @Post(':id/disputes')
  @Throttle({ default: { limit: 5, ttl: seconds(300) } })
  @ApiOperation({ summary: 'Dispute a takedown of your release.' })
  @ApiCreatedResponse({
    description: 'The release, owner view, with the new dispute.',
  })
  @ApiNotFoundResponse({ description: 'Missing, or not yours.' })
  @ApiConflictResponse({
    description:
      '`studio_release_not_taken_down`, `studio_dispute_already_open` or `studio_dispute_limit_reached`.',
  })
  fileDispute(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
    @Body() body: CreateStudioDisputeDto,
  ): Promise<StudioReleaseResponse> {
    return this.disputes.file(user.userId, releaseId, body.note);
  }
}
