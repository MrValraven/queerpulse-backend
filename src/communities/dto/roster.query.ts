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
 * Query of `GET /communities/:slug/roster`.
 *
 * `q` searches the roster SERVER-SIDE, across the whole community rather than
 * the pages the client happens to hold. Matching a member by first name, last
 * name, full name or handle, case-insensitively; pagination semantics are
 * unchanged (the filter is applied in-query, so `total` counts matches).
 */
export class RosterQuery {
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
