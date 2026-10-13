import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';
import { STUDIO_LIMITS } from '../studio.constants';

// Every entry of the playlist exactly once, unavailable ones included. The
// service compares the set under the playlist lock and answers 409
// `studio_playlist_order_mismatch`, so a repeat is a 409 as well.
export class ReorderStudioPlaylistEntriesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(STUDIO_LIMITS.tracksPerPlaylist)
  @IsUUID('all', { each: true })
  entryIds!: string[];
}
