import { IsIn } from 'class-validator';

export const STUDIO_PLAYLIST_INVITE_RESPONSES = ['accept', 'decline'] as const;
export type StudioPlaylistInviteResponse =
  (typeof STUDIO_PLAYLIST_INVITE_RESPONSES)[number];

/** `POST /studio/playlists/:id/editor-invite`: the invitee answers. */
export class RespondStudioPlaylistEditorInviteDto {
  @IsIn(STUDIO_PLAYLIST_INVITE_RESPONSES)
  response!: StudioPlaylistInviteResponse;
}
