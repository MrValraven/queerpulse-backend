import { StudioPlaylistFolder } from './entities/studio-playlist-folder.entity';

/** One of the caller's folders. Private: only its owner ever reads it. */
export interface StudioPlaylistFolderResponse {
  id: string;
  name: string;
  /** The folder's place among the member's folders, lowest first. */
  position: number;
  createdAt: string;
  /** The playlists filed in it, earliest filed first. Only playlists the
   *  member still owns, edits or saved: the rail resolves each id against
   *  the lists it already reads. */
  playlistIds: string[];
}

/** `GET /studio/playlists/folders`: every folder, in `position` order. */
export interface StudioPlaylistFoldersResponse {
  items: StudioPlaylistFolderResponse[];
}

export function toStudioPlaylistFolderResponse(
  folder: StudioPlaylistFolder,
  playlistIds: string[],
): StudioPlaylistFolderResponse {
  return {
    id: folder.id,
    name: folder.name,
    position: folder.position,
    createdAt: folder.createdAt.toISOString(),
    playlistIds,
  };
}
