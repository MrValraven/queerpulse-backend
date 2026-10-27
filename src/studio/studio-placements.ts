import { decodeStudioCursor, encodeStudioCursor } from './studio-cursor';
import type { StudioPlaylistCard } from './studio-playlist-response';

export const STUDIO_PLACEMENTS_PER_PAGE = 20;
export const STUDIO_PLACEMENT_TRACKS_SHOWN = 5;

export interface StudioPlacementTrack {
  id: string;
  title: string;
  releaseId: string;
}

export interface StudioPlacement {
  playlist: StudioPlaylistCard;
  tracks: StudioPlacementTrack[];
  trackCount: number;
  latestAddedAt: string;
}

export interface StudioPlacementsPage {
  items: StudioPlacement[];
  nextCursor: string | null;
}

/** The keyset position: the last placement a page returned. */
export interface StudioPlacementCursor {
  latestAddedAt: Date;
  playlistId: string;
}

export function encodePlacementCursor(cursor: StudioPlacementCursor): string {
  return encodeStudioCursor({
    publishedAt: cursor.latestAddedAt,
    id: cursor.playlistId,
  });
}

/** Never throws: anything malformed reads as "no cursor" (the first page). */
export function decodePlacementCursor(
  cursor: string | undefined,
): StudioPlacementCursor | null {
  const decoded = decodeStudioCursor(cursor);
  if (!decoded) {
    return null;
  }
  return { latestAddedAt: decoded.publishedAt, playlistId: decoded.id };
}
