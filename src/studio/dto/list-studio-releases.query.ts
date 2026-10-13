import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { STUDIO_GENRES, StudioGenre } from '../studio.constants';

export class ListStudioReleasesQuery {
  /** Opaque; a malformed value reads as the first page. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  /** Studio v2 browse by genre. Anything outside `STUDIO_GENRES` is a 400. */
  @IsOptional()
  @IsIn(STUDIO_GENRES)
  genre?: StudioGenre;
}
