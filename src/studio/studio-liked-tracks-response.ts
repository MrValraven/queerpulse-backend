import { StudioPlaylistEntryResponse } from './studio-playlist-response';
import { StudioPage } from './studio-response';

/**
 * Liked songs: one of the caller's own `studio_track` saves, shaped like a
 * playlist entry so the frontend reuses the playlist row. `entryId` is the
 * `saved_item` id, `position` is 1-based and contiguous across pages,
 * `addedAt` is when the member liked the track, and `isAvailable` follows
 * the playlist playability rule plus the block filter. An unavailable row
 * keeps `track: null` and carries `unavailableReason: 'withdrawn'` when
 * staff took its release down.
 */
export interface StudioLikedTrackEntry extends StudioPlaylistEntryResponse {
  /** The liked track's id (`saved_item.subject_id`), always present. */
  trackId: string;
  /** The member's own title snapshot from the save (`saved_item.title`). */
  savedTitle: string;
}

/**
 * `GET /studio/playlists/liked`: one page plus whole-set totals. The totals
 * are filled on the first page only (no cursor); every cursor page answers
 * them as 0, so a client keeps the first page's values.
 */
export interface StudioLikedTracksPage extends StudioPage<StudioLikedTrackEntry> {
  /** Playable liked tracks across the whole set; 0 on a cursor page. */
  trackCount: number;
  /** Their total length; 0 on a cursor page. */
  totalDurationSeconds: number;
}
