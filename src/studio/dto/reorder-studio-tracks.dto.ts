import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';
import { STUDIO_LIMITS } from '../studio.constants';

// Every track of the release exactly once. The service compares the set
// under the release lock and answers 409 `studio_track_order_mismatch`, so a
// duplicate is a 409 as well.
export class ReorderStudioTracksDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(STUDIO_LIMITS.tracksPerRelease)
  @IsUUID('all', { each: true })
  trackIds!: string[];
}
