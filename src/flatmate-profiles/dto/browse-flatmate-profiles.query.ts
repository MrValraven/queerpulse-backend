import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';
import { FlatmateProfileType } from '../entities/flatmate-profile.entity';
import {
  FLATMATE_BUDGET_BANDS,
  FLATMATE_MOVE_IN_WINDOWS,
  type FlatmateBudgetBand,
  type FlatmateMoveInWindow,
} from '../flatmate-directory-facets';

/** How a multi-tag `tags` filter combines: `any` (the original reading, a
 *  profile sharing at least one tag) or `all` (a profile carrying every one,
 *  which is what the board's lifestyle chips mean). */
export const FLATMATE_TAG_MATCHES = ['any', 'all'] as const;
export type FlatmateTagMatch = (typeof FLATMATE_TAG_MATCHES)[number];

/** Optional filters for GET /flatmate-directory. `tags` may arrive as repeated
 * query params (`?tags=a&tags=b`) or a single value; coerced to an array. */
export class BrowseFlatmateProfilesQuery {
  @IsOptional() @IsEnum(FlatmateProfileType) type?: FlatmateProfileType;

  @IsOptional() @IsString() @MaxLength(120) neighbourhood?: string;

  // Matches profiles whose budgetEuros <= budgetMax.
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) budgetMax?: number;

  // One budget band (`budgetBandClause` holds each band's range). Applies
  // alongside `budgetMax` when both are sent.
  @IsOptional()
  @IsIn(FLATMATE_BUDGET_BANDS)
  budgetBand?: FlatmateBudgetBand;

  // Matches profiles whose moveInFrom is null or <= moveInBy (YYYY-MM-DD).
  @IsOptional() @IsDateString() moveInBy?: string;

  // One move-in window: `now`, `flex` or a month key (`moveInWindowClause`).
  // Applies alongside `moveInBy` when both are sent.
  @IsOptional()
  @IsIn(FLATMATE_MOVE_IN_WINDOWS)
  moveIn?: FlatmateMoveInWindow;

  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value) ? value : value == null ? undefined : [value],
  )
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  // Defaults to `any`, so a caller that predates this param keeps the overlap
  // reading it was built against.
  @IsOptional() @IsIn(FLATMATE_TAG_MATCHES) tagMatch?: FlatmateTagMatch;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
