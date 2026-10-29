import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';

export const MUSIC_EVENT_BUCKETS = ['upcoming', 'past', 'cancelled'] as const;
export type MusicEventBucket = (typeof MUSIC_EVENT_BUCKETS)[number];

/** `GET admin/music-events?bucket=&page=`. An absent `bucket` lists upcoming. */
export class ListMusicEventsQuery {
  @IsOptional()
  @IsIn(MUSIC_EVENT_BUCKETS)
  bucket?: MusicEventBucket;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
