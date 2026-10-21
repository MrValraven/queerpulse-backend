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
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import {
  CreateStudioPlaylistFolderDto,
  MoveStudioPlaylistToFolderDto,
  UpdateStudioPlaylistFolderDto,
} from './dto/studio-playlist-folder.dto';
import { StudioAccessGuard } from './studio-access.guard';
import {
  StudioPlaylistFolderResponse,
  StudioPlaylistFoldersResponse,
} from './studio-playlist-folder-response';
import { StudioPlaylistFoldersService } from './studio-playlist-folders.service';

/**
 * Playlist folders, private to the caller. The same class guards as
 * `StudioPlaylistsController`. Every path sits under `/studio/playlists/`,
 * so `isStudioListeningRequest` keeps them all out of the request log and
 * the HTTP metrics: a folder name beside a member id reads as a listening
 * list. `StudioModule` registers this controller BEFORE
 * `StudioPlaylistsController`, so `GET folders` is matched here and never
 * reaches that controller's `GET :id` uuid pipe.
 */
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: '`studio_access_required`.' })
@Controller('studio/playlists')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioPlaylistFoldersController {
  constructor(private readonly folders: StudioPlaylistFoldersService) {}

  @Get('folders')
  @ApiOperation({ summary: 'Your playlist folders, in your order.' })
  @ApiOkResponse({ description: '`StudioPlaylistFolders`.' })
  list(
    @CurrentUser() user: CurrentUserData,
  ): Promise<StudioPlaylistFoldersResponse> {
    return this.folders.list(user.userId);
  }

  @Post('folders')
  @ApiOperation({ summary: 'Create a playlist folder, placed last.' })
  @ApiCreatedResponse({ description: '`StudioPlaylistFolder`.' })
  @ApiConflictResponse({ description: '`studio_playlist_folder_limit`.' })
  @ApiNotFoundResponse({
    description:
      'With `playlistId`: `studio_playlist_folder_playlist_unavailable`, and no folder is made.',
  })
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() body: CreateStudioPlaylistFolderDto,
  ): Promise<StudioPlaylistFolderResponse> {
    return this.folders.create(user.userId, body);
  }

  @Patch('folders/:folderId')
  @ApiOperation({ summary: 'Rename a folder, or move it among yours.' })
  @ApiOkResponse({ description: '`StudioPlaylistFolder`.' })
  @ApiNotFoundResponse({ description: '`studio_playlist_folder_not_found`.' })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('folderId', ParseUUIDPipe) folderId: string,
    @Body() body: UpdateStudioPlaylistFolderDto,
  ): Promise<StudioPlaylistFolderResponse> {
    return this.folders.update(user.userId, folderId, body);
  }

  @Delete('folders/:folderId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a folder. Its playlists go back to the top level.',
  })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiNotFoundResponse({ description: '`studio_playlist_folder_not_found`.' })
  remove(
    @CurrentUser() user: CurrentUserData,
    @Param('folderId', ParseUUIDPipe) folderId: string,
  ): Promise<void> {
    return this.folders.remove(user.userId, folderId);
  }

  @Put(':id/folder')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'File a playlist you own, edit or saved in one of your folders, or take it out with `folderId: null`.',
  })
  @ApiNoContentResponse({ description: 'Moved.' })
  @ApiNotFoundResponse({
    description:
      '`studio_playlist_folder_not_found` or `studio_playlist_folder_playlist_unavailable`.',
  })
  movePlaylist(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) playlistId: string,
    @Body() body: MoveStudioPlaylistToFolderDto,
  ): Promise<void> {
    return this.folders.movePlaylist(user.userId, playlistId, body.folderId);
  }
}
