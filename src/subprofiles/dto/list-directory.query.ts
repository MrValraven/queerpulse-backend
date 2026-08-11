import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SubprofileKind } from '../entities/subprofile.entity';

// Sane paging defaults for the authenticated directory browse — replaces the
// old fixed `take: 5000` full-catalogue materialisation. `@Max` caps keep a
// hostile `?limit=999999` from pulling the whole table (plus its per-row
// social-count/tag/follower fan-out) into one response.
export const DIRECTORY_DEFAULT_LIMIT = 40;
export const DIRECTORY_MAX_LIMIT = 100;

export class ListDirectoryQuery {
  @IsOptional() @IsEnum(SubprofileKind) kind?: SubprofileKind;

  @IsOptional() @IsString() @MaxLength(100) query?: string;

  // 1-based page index. `@Type` coerces the raw query string to a number before
  // the numeric validators run (the global ValidationPipe has `transform: true`
  // but query params arrive as strings).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(DIRECTORY_MAX_LIMIT)
  limit?: number;
}
