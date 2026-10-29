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
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import {
  AdminStudioSpotlightArtistSearchQuery,
  PlaceAdminStudioSpotlightArtistDto,
  ReorderAdminStudioNewStarsDto,
  UpdateAdminStudioSpotlightArtistDto,
} from './dto/admin-studio-spotlight.dto';
import {
  AdminStudioSpotlight,
  AdminStudioSpotlightArtist,
  AdminStudioSpotlightArtistOption,
} from './admin-studio-spotlight-response';
import { AdminStudioSpotlightService } from './admin-studio-spotlight.service';

/**
 * Studio spotlight: the Artist of the month and New stars sections of Studio
 * home, in the `AdminStudioCurationController` convention. Moderator and
 * Admin, plus the `music_manager_producer` grant, which curates Studio home.
 * Every route here is curation, so none is re-closed with an empty
 * `@StaffRoles()`. Literal routes are declared ahead of `:id`, which uses
 * `ParseUUIDPipe`.
 *
 *   GET    /admin/studio/spotlight                         -> AdminStudioSpotlight
 *   GET    /admin/studio/spotlight/artist-search?q=        -> { items }
 *   PUT    /admin/studio/spotlight/artist-of-the-month     -> AdminStudioSpotlightArtist
 *   DELETE /admin/studio/spotlight/artist-of-the-month     -> 204
 *   POST   /admin/studio/spotlight/new-stars               -> AdminStudioSpotlightArtist (201)
 *   POST   /admin/studio/spotlight/new-stars/reorder       -> AdminStudioSpotlightArtist[]
 *   PATCH  /admin/studio/spotlight/:id                     -> AdminStudioSpotlightArtist
 *   DELETE /admin/studio/spotlight/:id                     -> 204
 */
@Feature('studio')
@ApiTags('Admin: Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description:
    'Requires a moderator or admin role, or the music_manager_producer grant.',
})
@Controller('admin/studio/spotlight')
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@StaffRoles('music_manager_producer')
export class AdminStudioSpotlightController {
  constructor(private readonly spotlight: AdminStudioSpotlightService) {}

  @Get()
  @ApiOperation({
    summary: 'The Artist of the month and every New stars artist.',
  })
  @ApiOkResponse({ description: '`AdminStudioSpotlight`.' })
  getSpotlight(): Promise<AdminStudioSpotlight> {
    return this.spotlight.getSpotlight();
  }

  @Get('artist-search')
  @ApiOperation({
    summary:
      'Studio artist personas by name or handle, for placing in a spotlight slot.',
  })
  @ApiOkResponse({
    description: '`{ items: AdminStudioSpotlightArtistOption[] }`, at most 20.',
  })
  searchArtists(
    @Query() query: AdminStudioSpotlightArtistSearchQuery,
  ): Promise<{ items: AdminStudioSpotlightArtistOption[] }> {
    return this.spotlight.searchArtists(query.q);
  }

  @Put('artist-of-the-month')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Make a persona the Artist of the month, replacing the current one with a fresh row.',
  })
  @ApiOkResponse({ description: '`AdminStudioSpotlightArtist`.' })
  @ApiUnprocessableEntityResponse({
    description:
      '`studio_spotlight_not_an_artist` or `studio_spotlight_no_release`.',
  })
  setArtistOfTheMonth(
    @CurrentUser() user: CurrentUserData,
    @Body() body: PlaceAdminStudioSpotlightArtistDto,
  ): Promise<AdminStudioSpotlightArtist> {
    return this.spotlight.setArtistOfTheMonth(user.userId, body);
  }

  @Delete('artist-of-the-month')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Clear the Artist of the month. Answers 204 when already empty.',
  })
  @ApiNoContentResponse({ description: 'Cleared.' })
  clearArtistOfTheMonth(): Promise<void> {
    return this.spotlight.clearArtistOfTheMonth();
  }

  @Post('new-stars')
  @ApiOperation({ summary: 'Add a persona to New stars, appended last.' })
  @ApiCreatedResponse({ description: '`AdminStudioSpotlightArtist`.' })
  @ApiUnprocessableEntityResponse({
    description:
      '`studio_spotlight_not_an_artist` or `studio_spotlight_no_release`.',
  })
  @ApiConflictResponse({
    description:
      '`studio_spotlight_slot_full` or `studio_spotlight_already_in_slot`.',
  })
  addNewStar(
    @CurrentUser() user: CurrentUserData,
    @Body() body: PlaceAdminStudioSpotlightArtistDto,
  ): Promise<AdminStudioSpotlightArtist> {
    return this.spotlight.addNewStar(user.userId, body);
  }

  @Post('new-stars/reorder')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set the order of every New stars artist.' })
  @ApiOkResponse({
    description: '`AdminStudioSpotlightArtist[]`, the new order.',
  })
  @ApiConflictResponse({ description: '`studio_spotlight_order_mismatch`.' })
  reorderNewStars(
    @Body() body: ReorderAdminStudioNewStarsDto,
  ): Promise<AdminStudioSpotlightArtist[]> {
    return this.spotlight.reorderNewStars(body.spotlightIds);
  }

  @Patch(':id')
  @ApiOperation({ summary: "Edit a spotlight artist's note." })
  @ApiOkResponse({ description: '`AdminStudioSpotlightArtist`.' })
  @ApiNotFoundResponse({ description: '`studio_spotlight_not_found`.' })
  updateNote(
    @Param('id', ParseUUIDPipe) spotlightId: string,
    @Body() body: UpdateAdminStudioSpotlightArtistDto,
  ): Promise<AdminStudioSpotlightArtist> {
    return this.spotlight.updateNote(spotlightId, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a spotlight artist and close the gap in its slot.',
  })
  @ApiNoContentResponse({ description: 'Removed.' })
  @ApiNotFoundResponse({ description: '`studio_spotlight_not_found`.' })
  removeSpotlightArtist(
    @Param('id', ParseUUIDPipe) spotlightId: string,
  ): Promise<void> {
    return this.spotlight.removeSpotlightArtist(spotlightId);
  }
}
