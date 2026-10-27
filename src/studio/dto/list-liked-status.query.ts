import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsUUID,
} from 'class-validator';

/** How many tracks one liked-status read may name: a track list page holds
 *  up to 100 rows, and the hearts on screen ask for what they show. */
export const MAX_STUDIO_LIKED_STATUS_IDS = 100;

/** `?ids=a,b,c` arrives as one string; anything else is left for the
 *  validators to refuse. */
function splitIdList(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** `GET /studio/playlists/liked/status?ids=a,b,c`. */
export class ListLikedStatusQuery {
  @Transform(({ value }) => splitIdList(value))
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_STUDIO_LIKED_STATUS_IDS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids!: string[];
}
