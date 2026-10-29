import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminStudioLandingContentService } from './admin-studio-landing-content.service';
import { AdminStudioLandingPhotosService } from './admin-studio-landing-photos.service';
import { AdminStudioLandingPreviewsService } from './admin-studio-landing-previews.service';
import {
  AdminStudioFoundingArtist,
  AdminStudioLanding,
  AdminStudioLandingArtistCard,
  AdminStudioLandingPersonaOption,
  AdminStudioLandingPhoto,
  AdminStudioLandingPreview,
  AdminStudioLandingSettings,
  AdminStudioLandingTrackOption,
} from './admin-studio-landing-response';
import { AdminStudioSearchQuery } from './dto/admin-studio-curation.dto';
import {
  CreateStudioFoundingArtistDto,
  CreateStudioLandingArtistCardDto,
  CreateStudioLandingPreviewDto,
  PutStudioLandingPhotoDto,
  ReorderStudioFoundingArtistsDto,
  ReorderStudioLandingArtistCardsDto,
  ReorderStudioLandingPreviewsDto,
  StudioLandingPhotoSlotParams,
  UpdateStudioLandingArtistCardDto,
  UpdateStudioLandingSettingsDto,
} from './dto/admin-studio-landing.dto';

/**
 * Studio landing page: the staff content routes, in the
 * `AdminStudioCurationController` convention. Moderator and Admin only; no
 * Studio grant needed. Every write answers after commit and drops the public
 * landing memo (the services do that).
 *
 *   GET    /admin/studio/landing                                    -> AdminStudioLanding
 *   GET    /admin/studio/landing/track-search?q=                    -> { items }
 *   GET    /admin/studio/landing/persona-search?q=                  -> { items }
 *   POST   /admin/studio/landing/previews                           -> AdminStudioLandingPreview (201)
 *   POST   /admin/studio/landing/previews/reorder                   -> AdminStudioLandingPreview[]
 *   DELETE /admin/studio/landing/previews/:previewId                -> 204
 *   POST   /admin/studio/landing/artist-cards                       -> AdminStudioLandingArtistCard (201)
 *   POST   /admin/studio/landing/artist-cards/reorder               -> AdminStudioLandingArtistCard[]
 *   PATCH  /admin/studio/landing/artist-cards/:cardId               -> AdminStudioLandingArtistCard
 *   DELETE /admin/studio/landing/artist-cards/:cardId               -> 204
 *   PUT    /admin/studio/landing/photos/:slot                       -> AdminStudioLandingPhoto
 *   DELETE /admin/studio/landing/photos/:slot                       -> 204
 *   POST   /admin/studio/landing/founding-artists                   -> AdminStudioFoundingArtist (201)
 *   POST   /admin/studio/landing/founding-artists/reorder           -> AdminStudioFoundingArtist[]
 *   DELETE /admin/studio/landing/founding-artists/:foundingArtistId -> 204
 *   PUT    /admin/studio/landing/settings                           -> AdminStudioLandingSettings
 */
@Feature('studio')
@ApiTags('Admin: Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller('admin/studio/landing')
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminStudioLandingController {
  constructor(
    private readonly previews: AdminStudioLandingPreviewsService,
    private readonly content: AdminStudioLandingContentService,
    private readonly photos: AdminStudioLandingPhotosService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Previews, artist cards, photos, founding artists and settings.',
  })
  @ApiOkResponse({ description: '`AdminStudioLanding`.' })
  async getLanding(): Promise<AdminStudioLanding> {
    const [previews, content, photos] = await Promise.all([
      this.previews.listPreviews(),
      this.content.getContent(),
      this.photos.getPhotos(),
    ]);
    return { previews, ...content, photos };
  }

  @Get('track-search')
  @ApiOperation({
    summary: 'Tracks of published releases by title or artist name.',
  })
  @ApiOkResponse({
    description: '`{ items: AdminStudioLandingTrackOption[] }`.',
  })
  searchTracks(
    @Query() query: AdminStudioSearchQuery,
  ): Promise<{ items: AdminStudioLandingTrackOption[] }> {
    return this.previews.searchTracks(query.q);
  }

  @Get('persona-search')
  @ApiOperation({ summary: 'Artist personas by display name or handle.' })
  @ApiOkResponse({
    description: '`{ items: AdminStudioLandingPersonaOption[] }`.',
  })
  searchPersonas(
    @Query() query: AdminStudioSearchQuery,
  ): Promise<{ items: AdminStudioLandingPersonaOption[] }> {
    return this.content.searchPersonas(query.q);
  }

  @Post('previews')
  @ApiOperation({ summary: 'Ask an artist to show a track on the landing.' })
  @ApiCreatedResponse({ description: '`AdminStudioLandingPreview`.' })
  @ApiConflictResponse({
    description:
      '`studio_landing_preview_exists`, `studio_landing_previews_full` or `studio_landing_preview_no_reachable_owner`.',
  })
  @ApiUnprocessableEntityResponse({
    description: '`studio_landing_preview_track_not_eligible`.',
  })
  requestPreview(
    @CurrentUser() user: CurrentUserData,
    @Body() body: CreateStudioLandingPreviewDto,
  ): Promise<AdminStudioLandingPreview> {
    return this.previews.requestPreview(user.userId, body.trackId);
  }

  @Post('previews/reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set the order of every open preview.' })
  @ApiOkResponse({
    description:
      '`AdminStudioLandingPreview[]`, the open rows in the new order.',
  })
  @ApiConflictResponse({ description: '`studio_landing_order_mismatch`.' })
  reorderPreviews(
    @Body() body: ReorderStudioLandingPreviewsDto,
  ): Promise<AdminStudioLandingPreview[]> {
    return this.previews.reorderPreviews(body.previewIds);
  }

  @Delete('previews/:previewId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a preview whatever its status.' })
  @ApiNoContentResponse({ description: 'Removed.' })
  @ApiNotFoundResponse({ description: '`studio_landing_preview_not_found`.' })
  removePreview(
    @Param('previewId', ParseUUIDPipe) previewId: string,
  ): Promise<void> {
    return this.previews.removePreview(previewId);
  }

  @Post('artist-cards')
  @ApiOperation({ summary: 'Add an artist card to the landing.' })
  @ApiCreatedResponse({ description: '`AdminStudioLandingArtistCard`.' })
  @ApiBadRequestResponse({ description: '`studio_landing_consent_required`.' })
  @ApiConflictResponse({
    description: '`studio_landing_card_exists` or `studio_landing_cards_full`.',
  })
  @ApiUnprocessableEntityResponse({
    description: '`studio_landing_persona_not_eligible`.',
  })
  createArtistCard(
    @CurrentUser() user: CurrentUserData,
    @Body() body: CreateStudioLandingArtistCardDto,
  ): Promise<AdminStudioLandingArtistCard> {
    return this.content.createArtistCard(user.userId, body);
  }

  @Post('artist-cards/reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set the order of every artist card.' })
  @ApiOkResponse({
    description: '`AdminStudioLandingArtistCard[]`, the new order.',
  })
  @ApiConflictResponse({ description: '`studio_landing_order_mismatch`.' })
  reorderArtistCards(
    @Body() body: ReorderStudioLandingArtistCardsDto,
  ): Promise<AdminStudioLandingArtistCard[]> {
    return this.content.reorderArtistCards(body.cardIds);
  }

  @Patch('artist-cards/:cardId')
  @ApiOperation({ summary: "Edit an artist card's quote." })
  @ApiOkResponse({ description: '`AdminStudioLandingArtistCard`.' })
  @ApiBadRequestResponse({ description: '`studio_landing_consent_required`.' })
  @ApiNotFoundResponse({ description: '`studio_landing_card_not_found`.' })
  updateArtistCard(
    @Param('cardId', ParseUUIDPipe) cardId: string,
    @Body() body: UpdateStudioLandingArtistCardDto,
  ): Promise<AdminStudioLandingArtistCard> {
    return this.content.updateArtistCard(cardId, body);
  }

  @Delete('artist-cards/:cardId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove an artist card.' })
  @ApiNoContentResponse({ description: 'Removed.' })
  @ApiNotFoundResponse({ description: '`studio_landing_card_not_found`.' })
  deleteArtistCard(
    @Param('cardId', ParseUUIDPipe) cardId: string,
  ): Promise<void> {
    return this.content.deleteArtistCard(cardId);
  }

  @Put('photos/:slot')
  @ApiOperation({ summary: 'Set the hero or manifesto photo.' })
  @ApiOkResponse({ description: '`AdminStudioLandingPhoto`.' })
  @ApiBadRequestResponse({ description: '`studio_landing_consent_required`.' })
  @ApiForbiddenResponse({
    description:
      '`studio_landing_photo_not_yours`, or a codeless refusal for an upload another member made.',
  })
  putPhoto(
    @CurrentUser() user: CurrentUserData,
    @Param() params: StudioLandingPhotoSlotParams,
    @Body() body: PutStudioLandingPhotoDto,
  ): Promise<AdminStudioLandingPhoto> {
    return this.photos.putPhoto(user.userId, params.slot, body);
  }

  @Delete('photos/:slot')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Clear a photo slot (idempotent).' })
  @ApiNoContentResponse({ description: 'Cleared.' })
  deletePhoto(@Param() params: StudioLandingPhotoSlotParams): Promise<void> {
    return this.photos.deletePhoto(params.slot);
  }

  @Post('founding-artists')
  @ApiOperation({ summary: 'List an artist as a founding artist.' })
  @ApiCreatedResponse({ description: '`AdminStudioFoundingArtist`.' })
  @ApiConflictResponse({
    description:
      '`studio_founding_artist_exists` or `studio_founding_artists_full`.',
  })
  @ApiUnprocessableEntityResponse({
    description: '`studio_founding_persona_not_eligible`.',
  })
  addFoundingArtist(
    @CurrentUser() user: CurrentUserData,
    @Body() body: CreateStudioFoundingArtistDto,
  ): Promise<AdminStudioFoundingArtist> {
    return this.content.addFoundingArtist(user.userId, body.subprofileId);
  }

  @Post('founding-artists/reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set the order of every founding artist.' })
  @ApiOkResponse({
    description: '`AdminStudioFoundingArtist[]`, the new order.',
  })
  @ApiConflictResponse({ description: '`studio_landing_order_mismatch`.' })
  reorderFoundingArtists(
    @Body() body: ReorderStudioFoundingArtistsDto,
  ): Promise<AdminStudioFoundingArtist[]> {
    return this.content.reorderFoundingArtists(body.foundingArtistIds);
  }

  @Delete('founding-artists/:foundingArtistId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a founding artist.' })
  @ApiNoContentResponse({ description: 'Removed.' })
  @ApiNotFoundResponse({ description: '`studio_founding_artist_not_found`.' })
  removeFoundingArtist(
    @Param('foundingArtistId', ParseUUIDPipe) foundingArtistId: string,
  ): Promise<void> {
    return this.content.removeFoundingArtist(foundingArtistId);
  }

  @Put('settings')
  @ApiOperation({ summary: 'Show or hide the founding artists shelf.' })
  @ApiOkResponse({ description: '`AdminStudioLandingSettings`.' })
  updateSettings(
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdateStudioLandingSettingsDto,
  ): Promise<AdminStudioLandingSettings> {
    return this.content.updateSettings(
      user.userId,
      body.isFoundingShelfVisible,
    );
  }
}
