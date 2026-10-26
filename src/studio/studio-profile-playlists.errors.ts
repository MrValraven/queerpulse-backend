import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Profile playlist refusals answer with the Studio error body
 * (`statusCode`, `code`, `message`). The codes live here, beside the
 * routes, and never in `STUDIO_ERRORS`.
 */
export type StudioProfilePlaylistErrorCode =
  'studio_profile_playlist_not_yours';

const STUDIO_PROFILE_PLAYLIST_ERRORS: Record<
  StudioProfilePlaylistErrorCode,
  { status: HttpStatus; message: string }
> = {
  studio_profile_playlist_not_yours: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message:
      'You can feature only playlists you own or that are credited to you. One of the chosen playlists is neither.',
  },
};

export function studioProfilePlaylistError(
  code: StudioProfilePlaylistErrorCode,
): HttpException {
  const { status, message } = STUDIO_PROFILE_PLAYLIST_ERRORS[code];
  return new HttpException({ statusCode: status, code, message }, status);
}
