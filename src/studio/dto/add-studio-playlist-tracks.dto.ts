import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';
import { STUDIO_LIMITS } from '../studio.constants';

// Appended in this order. Repeats collapse and ids already in the playlist
// are skipped; adding a release sends its playable tracks in release order.
export class AddStudioPlaylistTracksDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(STUDIO_LIMITS.tracksPerPlaylistAdd)
  @IsUUID('all', { each: true })
  trackIds!: string[];
}
