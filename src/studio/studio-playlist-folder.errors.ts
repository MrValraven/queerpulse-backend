import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';

/**
 * Playlist folders answer with the Studio error body (`statusCode`, `code`,
 * `message`), so the frontend names each refusal. The codes live here, beside
 * the folder routes, and never in `STUDIO_ERRORS`, which the rest of Studio
 * shares.
 */
export type StudioPlaylistFolderErrorCode =
  | 'studio_playlist_folder_not_found'
  | 'studio_playlist_folder_limit'
  | 'studio_playlist_folder_playlist_unavailable';

/** A ceiling that keeps the rail a list a member can scan. */
export const STUDIO_PLAYLIST_FOLDER_LIMITS = {
  foldersPerMember: 50,
  nameMaxLength: 80,
} as const;

const STUDIO_PLAYLIST_FOLDER_ERRORS: Record<
  StudioPlaylistFolderErrorCode,
  { status: HttpStatus; message: string }
> = {
  studio_playlist_folder_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This folder is missing, or it is not yours.',
  },
  studio_playlist_folder_limit: {
    status: HttpStatus.CONFLICT,
    message: `You can keep up to ${STUDIO_PLAYLIST_FOLDER_LIMITS.foldersPerMember} folders.`,
  },
  // A 404 either way, so a refusal never confirms that a playlist the
  // caller cannot open exists.
  studio_playlist_folder_playlist_unavailable: {
    status: HttpStatus.NOT_FOUND,
    message: 'A folder holds only playlists you own, edit or saved.',
  },
};

export function studioPlaylistFolderError(
  code: StudioPlaylistFolderErrorCode,
): HttpException {
  const { status, message } = STUDIO_PLAYLIST_FOLDER_ERRORS[code];
  const body = { statusCode: status, code, message };
  if (status === HttpStatus.NOT_FOUND) {
    return new NotFoundException(body);
  }
  return new HttpException(body, status);
}
