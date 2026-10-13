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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { AddStudioPlaylistTracksDto } from './dto/add-studio-playlist-tracks.dto';
import { CreateStudioPlaylistDto } from './dto/create-studio-playlist.dto';
import { ListStudioPlaylistsQuery } from './dto/list-studio-playlists.query';
import { ReorderStudioPlaylistEntriesDto } from './dto/reorder-studio-playlist-entries.dto';
import { UpdateStudioPlaylistDto } from './dto/update-studio-playlist.dto';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';
import {
  StudioPlaylistCard,
  StudioPlaylistResponse,
} from './studio-playlist-response';
import { StudioPlaylistWritesService } from './studio-playlist-writes.service';
import { StudioPage } from './studio-response';

// Every path that names a playlist id is kept out of the request log and
// HTTP metrics by isStudioListeningRequest.
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio/playlists')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioPlaylistsController {
  constructor(
    private readonly playlistReads: StudioPlaylistReadsService,
    private readonly playlistWrites: StudioPlaylistWritesService,
  ) {}

  // Declared before `:id`, so the uuid pipe never sees `mine`.
  @Get('mine')
  @ApiOperation({ summary: 'Your playlists, most recently updated first.' })
  @ApiOkResponse({ description: '`StudioPage<StudioPlaylistCard>`.' })
  listMine(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListStudioPlaylistsQuery,
  ): Promise<StudioPage<StudioPlaylistCard>> {
    return this.playlistReads.listMine(user.userId, query.cursor);
  }

  @Post()
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Create a playlist.' })
  @ApiCreatedResponse({ description: '`StudioPlaylist`.' })
  @ApiConflictResponse({ description: '`studio_playlist_limit`.' })
  @ApiUnprocessableEntityResponse({
    description: '`studio_playlist_credit_not_allowed`.',
  })
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() body: CreateStudioPlaylistDto,
  ): Promise<StudioPlaylistResponse> {
    return this.playlistWrites.create(user.userId, body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One playlist with its entries.' })
  @ApiOkResponse({ description: '`StudioPlaylist`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not visible to you.' })
  getPlaylist(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) playlistId: string,
  ): Promise<StudioPlaylistResponse> {
    return this.playlistReads.getPlaylist(user.userId, playlistId);
  }

  @Patch(':id')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Edit details, visibility or credit.' })
  @ApiOkResponse({ description: '`StudioPlaylist`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not yours.' })
  @ApiUnprocessableEntityResponse({
    description: '`studio_playlist_credit_not_allowed`.',
  })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) playlistId: string,
    @Body() body: UpdateStudioPlaylistDto,
  ): Promise<StudioPlaylistResponse> {
    return this.playlistWrites.update(user.userId, playlistId, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a playlist.' })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiNotFoundResponse({ description: 'Missing, or not yours.' })
  remove(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) playlistId: string,
  ): Promise<void> {
    return this.playlistWrites.remove(user.userId, playlistId);
  }

  @Post(':id/tracks')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add tracks to the end of a playlist.' })
  @ApiOkResponse({ description: '`StudioPlaylist`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not yours.' })
  @ApiConflictResponse({ description: '`studio_playlist_track_limit`.' })
  @ApiUnprocessableEntityResponse({
    description: '`studio_playlist_track_unavailable`.',
  })
  addTracks(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) playlistId: string,
    @Body() body: AddStudioPlaylistTracksDto,
  ): Promise<StudioPlaylistResponse> {
    return this.playlistWrites.addTracks(user.userId, playlistId, body);
  }

  @Delete(':id/entries/:entryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove one entry from a playlist.' })
  @ApiNoContentResponse({ description: 'Removed; positions closed up.' })
  @ApiNotFoundResponse({ description: 'Missing, or not yours.' })
  removeEntry(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) playlistId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
  ): Promise<void> {
    return this.playlistWrites.removeEntry(user.userId, playlistId, entryId);
  }

  @Put(':id/entry-order')
  @ApiOperation({ summary: 'Set the order of every entry.' })
  @ApiOkResponse({ description: '`StudioPlaylist`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not yours.' })
  @ApiConflictResponse({ description: '`studio_playlist_order_mismatch`.' })
  reorder(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) playlistId: string,
    @Body() body: ReorderStudioPlaylistEntriesDto,
  ): Promise<StudioPlaylistResponse> {
    return this.playlistWrites.reorder(user.userId, playlistId, body);
  }
}
