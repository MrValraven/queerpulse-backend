import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';

export const STUDIO_ARTIST_SEARCH_MAX_LENGTH = 100;

const trimQueryText = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** `GET admin/music-events/studio-artists/search?q=&page=`. An empty `q`
 *  lists every candidate. */
export class StudioArtistSearchQuery {
  @IsOptional()
  @Transform(trimQueryText)
  @IsString()
  @MaxLength(STUDIO_ARTIST_SEARCH_MAX_LENGTH)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
