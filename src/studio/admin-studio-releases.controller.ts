import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
import { recordCreatorDraftViewed } from '../creator-drafts/creator-draft-audit';
import { ModAuditService } from '../moderation/mod-audit.service';
import { UserRole } from '../users/entities/user.entity';
import { ListAdminStudioReleasesQuery } from './dto/list-admin-studio-releases.query';
import {
  StudioReleaseStatus,
  StudioReleaseType,
} from './entities/studio-release.entity';
import { TakedownStudioReleaseDto } from './dto/takedown-studio-release.dto';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioAdminWithdrawnRelease } from './studio-dispute-response';
import { StudioModerationService } from './studio-moderation.service';
import { StudioPage, StudioReleaseResponse } from './studio-response';
import { StudioStaffReadsService } from './studio-staff-reads.service';

/** A release a listener cannot see yet: a draft or scheduled release, or a
 * published show that still holds a draft episode. */
function isUnpublishedStudioContent(response: StudioReleaseResponse): boolean {
  if (
    response.status === StudioReleaseStatus.Draft ||
    response.status === StudioReleaseStatus.Scheduled
  ) {
    return true;
  }
  return (
    response.type === StudioReleaseType.Podcast &&
    response.status === StudioReleaseStatus.Published &&
    response.tracks.some((track) => track.publishedAt === null)
  );
}

// The reports queue's Studio actions. No Studio grant needed: staff read and
// act on reported releases whether or not they listen in Studio.
@Feature('studio')
@ApiTags('Admin: Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller('admin/studio/releases')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminStudioReleasesController {
  constructor(
    private readonly catalog: StudioCatalogService,
    private readonly moderation: StudioModerationService,
    private readonly staffReads: StudioStaffReadsService,
    private readonly modAudit: ModAuditService,
  ) {}

  // Studio open demo pages: the flag review's Withdrawn tab. Declared ahead
  // of `:id` so the two read routes stay easy to tell apart.
  @Get()
  @ApiOperation({
    summary: 'Taken-down releases, newest first, with their open dispute.',
  })
  @ApiOkResponse({ description: '`StudioPage<StudioAdminWithdrawnRelease>`.' })
  listReleases(
    @Query() query: ListAdminStudioReleasesQuery,
  ): Promise<StudioPage<StudioAdminWithdrawnRelease>> {
    return this.staffReads.listWithdrawn(query.cursor);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Any release, for the reports queue. An unpublished release writes a Platform log row.',
  })
  @ApiOkResponse({ description: '`StudioRelease`, staff view.' })
  @ApiNotFoundResponse({ description: 'Release not found.' })
  async getRelease(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
  ): Promise<StudioReleaseResponse> {
    const response = await this.catalog.getReleaseForStaff(releaseId);
    if (isUnpublishedStudioContent(response)) {
      await recordCreatorDraftViewed(
        this.modAudit,
        user.userId,
        'studio_release',
        releaseId,
        'studio_staff',
      );
    }
    return response;
  }

  @Post(':id/takedown')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Take a release down, with a reason.' })
  @ApiOkResponse({ description: '`StudioRelease`, staff view.' })
  @ApiNotFoundResponse({ description: 'Release not found.' })
  @ApiUnprocessableEntityResponse({
    description: '`studio_takedown_report_mismatch`.',
  })
  @ApiConflictResponse({ description: '`studio_takedown_report_not_open`.' })
  takedown(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
    @Body() body: TakedownStudioReleaseDto,
  ): Promise<StudioReleaseResponse> {
    return this.moderation.takedown(
      user.userId,
      releaseId,
      body.reason,
      body.reportId,
    );
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore a taken-down release.' })
  @ApiOkResponse({ description: '`StudioRelease`, staff view.' })
  @ApiNotFoundResponse({ description: 'Release not found.' })
  @ApiConflictResponse({
    description:
      '`studio_release_has_open_dispute`: decide the dispute through its uphold.',
  })
  restore(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) releaseId: string,
  ): Promise<StudioReleaseResponse> {
    return this.moderation.restore(user.userId, releaseId);
  }
}
