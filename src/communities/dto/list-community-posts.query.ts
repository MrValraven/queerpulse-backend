import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Query of `GET /communities/:slug/posts`.
 *
 * `q` searches the community's posts SERVER-SIDE, across every page rather
 * than the ones the client happens to hold. Matching post bodies
 * case-insensitively; pagination semantics are unchanged (the filter is
 * applied in-query, so `total` counts matches). Sibling of `RosterQuery`,
 * which does the same for the roster.
 */
export class ListCommunityPostsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  q?: string;
}
