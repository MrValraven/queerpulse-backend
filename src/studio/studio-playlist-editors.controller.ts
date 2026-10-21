import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
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
import { Throttle, seconds } from '@nestjs/throttler';
import { Response } from 'express';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { AddStudioPlaylistEditorsDto } from './dto/add-studio-playlist-editors.dto';
import { ListStudioPlaylistEditorCandidatesQuery } from './dto/list-studio-playlist-editor-candidates.query';
import { RespondStudioPlaylistEditorInviteDto } from './dto/respond-studio-playlist-editor-invite.dto';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioPlaylistEditorsService } from './studio-playlist-editors.service';
import {
  StudioPlaylistEditorCandidateList,
  StudioPlaylistEditorList,
  StudioPlaylistResponse,
} from './studio-playlist-response';

/**
 * Collaborative playlists: the editor roster of a Studio playlist. Same
 * class guards as `StudioPlaylistsController`; the two writes that put a
 * row in someone else's bell add `NotRestrictedGuard`. Nothing here is
 * public: every route answers the owner, an editor or an invitee, and a
 * caller without the role gets 404 when they cannot open the playlist and
 * 403 `studio_playlist_owner_only` when they can. Every path names a
 * playlist id, so `isStudioListeningRequest` keeps it out of the request
 * log and the HTTP metrics.
 */
@Feature('studio')
@ApiTags('Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: '`studio_access_required`, or `studio_playlist_owner_only`.',
})
@Controller('studio/playlists')
@UseGuards(ActiveMemberGuard, StudioAccessGuard)
export class StudioPlaylistEditorsController {
  constructor(private readonly playlistEditors: StudioPlaylistEditorsService) {}

  @Get(':id/editors')
  @ApiOperation({ summary: 'The editors of a playlist you own or edit.' })
  @ApiOkResponse({ description: '`{ items: StudioPlaylistEditor[] }`.' })
  @ApiNotFoundResponse({ description: '`studio_playlist_not_found`.' })
  listEditors(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) playlistId: string,
  ): Promise<StudioPlaylistEditorList> {
    return this.playlistEditors.listEditors(user.userId, playlistId);
  }

  // An invitation or pick puts a row in somebody else's bell, so it is
  // throttled like the other member-addressing writes.
  @Post(':id/editors')
  @HttpCode(HttpStatus.OK)
  @UseGuards(NotRestrictedGuard)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @ApiOperation({
    summary: 'Invite connections or pick persona co-owners as editors.',
  })
  @ApiOkResponse({ description: 'The full editor list after the change.' })
  @ApiNotFoundResponse({ description: '`studio_playlist_not_found`.' })
  @ApiConflictResponse({ description: '`studio_playlist_editor_cap`.' })
  @ApiUnprocessableEntityResponse({
    description:
      '`studio_playlist_editor_ineligible` with `memberSlugs` and `ineligibleMembers` ({ memberSlug, reason }[], request order). `reason` is the first failing check: `not_found`, `is_owner`, `blocked`, `no_studio_access`, then `not_connected` (member invite) or `not_co_owner` (persona pick); `persona_credit_lapsed` marks every member when the persona credit stopped standing.',
  })
  addEditors(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) playlistId: string,
    @Body() body: AddStudioPlaylistEditorsDto,
  ): Promise<StudioPlaylistEditorList> {
    return this.playlistEditors.addEditors(user.userId, playlistId, body);
  }

  // Declared before `:editorId`, so the literal `me` wins.
  @Delete(':id/editors/me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Leave a playlist you edit.' })
  @ApiNoContentResponse({ description: 'Left; your tracks stay.' })
  @ApiNotFoundResponse({ description: '`studio_playlist_not_found`.' })
  leave(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) playlistId: string,
  ): Promise<void> {
    return this.playlistEditors.leave(user.userId, playlistId);
  }

  @Delete(':id/editors/:editorId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove an editor or cancel an invitation.' })
  @ApiNoContentResponse({ description: 'Done, also for a row that ended.' })
  @ApiNotFoundResponse({
    description:
      '`studio_playlist_not_found` or `studio_playlist_editor_not_found`.',
  })
  removeEditor(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) playlistId: string,
    @Param('editorId', ParseUUIDPipe) editorId: string,
  ): Promise<void> {
    return this.playlistEditors.removeEditor(user.userId, playlistId, editorId);
  }

  @Post(':id/editor-invite')
  @HttpCode(HttpStatus.OK)
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Accept or decline an invitation to edit.' })
  @ApiOkResponse({ description: 'Accepted: `StudioPlaylist`.' })
  @ApiNoContentResponse({ description: 'Declined.' })
  @ApiNotFoundResponse({ description: '`studio_playlist_invite_not_found`.' })
  @ApiConflictResponse({ description: '`studio_playlist_invite_unavailable`.' })
  async respondToInvite(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) playlistId: string,
    @Body() body: RespondStudioPlaylistEditorInviteDto,
    @Res({ passthrough: true }) reply: Response,
  ): Promise<StudioPlaylistResponse | undefined> {
    const playlist = await this.playlistEditors.respondToInvite(
      user.userId,
      playlistId,
      body.response,
    );
    if (!playlist) {
      reply.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    return playlist;
  }

  @Get(':id/editor-candidates')
  @ApiOperation({
    summary: 'Co-owners of the credit persona who can edit this playlist.',
  })
  @ApiOkResponse({ description: '`{ items: [{ member, isEditor }] }`.' })
  @ApiNotFoundResponse({ description: '`studio_playlist_not_found`.' })
  @ApiConflictResponse({
    description: '`studio_playlist_editor_source_mismatch`.',
  })
  listCandidates(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) playlistId: string,
    @Query() query: ListStudioPlaylistEditorCandidatesQuery,
  ): Promise<StudioPlaylistEditorCandidateList> {
    return this.playlistEditors.listCandidates(
      user.userId,
      playlistId,
      query.q,
    );
  }
}
