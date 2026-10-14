import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  STUDIO_FORMATS,
  STUDIO_GENRES,
  STUDIO_MOODS,
  StudioFormat,
  StudioGenre,
  StudioMood,
} from '../studio.constants';

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

  /** Studio discovery browse by mood, combined with the genre by AND. */
  @IsOptional()
  @IsIn(STUDIO_MOODS)
  mood?: StudioMood;

  /** Studio artist kinds: narrows the feed to one format's persona kinds. */
  @IsOptional()
  @IsIn(STUDIO_FORMATS)
  format?: StudioFormat;
}
