import { Type } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';

/** `GET /studio/artists/:id/plays`: the 28-day window is the only one served. */
export class StudioArtistPlaysQuery {
  @IsOptional()
  @Type(() => Number)
  @IsIn([28])
  days?: number;
}
