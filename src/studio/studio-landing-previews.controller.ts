import {
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
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioLandingPreviewsService } from './studio-landing-previews.service';
import {
  StudioLandingPreviewOwnerItem,
  StudioLandingPreviewOwnerList,
} from './studio-landing-response';

/**
 * The artist dashboard approvals for the Studio page previews. The routes are
 * persona scoped under `studio/artists/:subprofileId`, so the Studio request
 * log exclusion for owner routes covers them.
 */
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio/artists')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioLandingPreviewsController {
  constructor(private readonly previews: StudioLandingPreviewsService) {}

  @Get(':subprofileId/landing-previews')
  @ApiOperation({
    summary: 'The Studio page previews that involve a persona, newest first.',
  })
  @ApiOkResponse({ description: '`StudioLandingPreviewOwnerList`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not yours.' })
  listPreviews(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
  ): Promise<StudioLandingPreviewOwnerList> {
    return this.previews.listForPersona(user.userId, subprofileId);
  }

  @Post(':subprofileId/landing-previews/:previewId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approves a waiting preview request.' })
  @ApiOkResponse({ description: '`StudioLandingPreviewOwnerItem`.' })
  @ApiNotFoundResponse({
    description: 'Missing or not yours, or `studio_landing_preview_not_found`.',
  })
  @ApiConflictResponse({
    description:
      '`studio_landing_preview_not_pending` (another owner answered first).',
  })
  approve(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
    @Param('previewId', ParseUUIDPipe) previewId: string,
  ): Promise<StudioLandingPreviewOwnerItem> {
    return this.previews.approve(user.userId, subprofileId, previewId);
  }

  @Post(':subprofileId/landing-previews/:previewId/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Declines a waiting preview request.' })
  @ApiOkResponse({ description: '`StudioLandingPreviewOwnerItem`.' })
  @ApiNotFoundResponse({
    description: 'Missing or not yours, or `studio_landing_preview_not_found`.',
  })
  @ApiConflictResponse({ description: '`studio_landing_preview_not_pending`.' })
  decline(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
    @Param('previewId', ParseUUIDPipe) previewId: string,
  ): Promise<StudioLandingPreviewOwnerItem> {
    return this.previews.decline(user.userId, subprofileId, previewId);
  }

  @Post(':subprofileId/landing-previews/:previewId/withdraw')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Takes an approved preview off the Studio page.' })
  @ApiOkResponse({ description: '`StudioLandingPreviewOwnerItem`.' })
  @ApiNotFoundResponse({
    description: 'Missing or not yours, or `studio_landing_preview_not_found`.',
  })
  @ApiConflictResponse({
    description: '`studio_landing_preview_not_approved`.',
  })
  withdraw(
    @CurrentUser() user: CurrentUserData,
    @Param('subprofileId', ParseUUIDPipe) subprofileId: string,
    @Param('previewId', ParseUUIDPipe) previewId: string,
  ): Promise<StudioLandingPreviewOwnerItem> {
    return this.previews.withdraw(user.userId, subprofileId, previewId);
  }
}
