import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsUUID,
} from 'class-validator';

/** How many tracks one batch read may name: the Continue listening shelf
 *  reads 15 places at most, so 20 leaves room without opening a crawl. */
export const MAX_STUDIO_TRACK_BATCH_IDS = 20;

/** `?ids=a,b,c` arrives as one string; anything else is left for the
 *  validators to refuse (mirrors `ResolveMentionNamesQuery`). */
function splitIdList(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** `GET /studio/tracks?ids=a,b,c`: a batch of the single track read. */
export class ListStudioTracksQuery {
  @Transform(({ value }) => splitIdList(value))
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_STUDIO_TRACK_BATCH_IDS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids!: string[];
}
