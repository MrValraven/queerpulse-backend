import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { STUDIO_LIMITS } from '../studio.constants';

/** `GET /studio/episodes/latest` (Studio artist kinds). */
export class ListStudioEpisodesQuery {
  /** Opaque; a malformed value reads as the first page. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  /** 1 to 24 episodes, 12 when left out. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(STUDIO_LIMITS.episodesPerPageMax)
  limit?: number;
}
