import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  STUDIO_FORMATS,
  STUDIO_GENRES,
  STUDIO_LIMITS,
  STUDIO_MOODS,
  STUDIO_SEARCH_TYPES,
  StudioFormat,
  StudioGenre,
  StudioMood,
  StudioSearchType,
} from '../studio.constants';

export class SearchStudioQuery {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(STUDIO_LIMITS.searchQueryMaxLength)
  q!: string;

  @IsOptional()
  @IsIn(STUDIO_SEARCH_TYPES)
  type?: StudioSearchType;

  /** ENG-05: the `nextCursor` of a single-type search page. Opaque; a
   *  malformed value reads as the first page, and the multi-type search
   *  ignores it. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  /** Studio v2: narrows releases and tracks; playlists and artists ignore it. */
  @IsOptional()
  @IsIn(STUDIO_GENRES)
  genre?: StudioGenre;

  /** Studio discovery: narrows releases and tracks, like the genre. */
  @IsOptional()
  @IsIn(STUDIO_MOODS)
  mood?: StudioMood;

  /** Studio artist kinds: narrows releases, tracks and artists to one
   *  format; playlists ignore it. */
  @IsOptional()
  @IsIn(STUDIO_FORMATS)
  format?: StudioFormat;
}
