import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  STUDIO_GENRES,
  STUDIO_LIMITS,
  STUDIO_SEARCH_TYPES,
  StudioGenre,
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

  /** Studio v2: narrows releases and tracks; playlists and artists ignore it. */
  @IsOptional()
  @IsIn(STUDIO_GENRES)
  genre?: StudioGenre;
}
