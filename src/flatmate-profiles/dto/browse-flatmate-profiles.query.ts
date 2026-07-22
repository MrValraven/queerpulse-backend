import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { FlatmateProfileType } from '../entities/flatmate-profile.entity';

/** Optional filters for GET /flatmate-directory. `tags` may arrive as repeated
 * query params (`?tags=a&tags=b`) or a single value; coerced to an array. */
export class BrowseFlatmateProfilesQuery {
  @IsOptional() @IsEnum(FlatmateProfileType) type?: FlatmateProfileType;

  @IsOptional() @IsString() @MaxLength(120) neighbourhood?: string;

  // Matches profiles whose budgetEuros <= budgetMax.
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) budgetMax?: number;

  // Matches profiles whose moveInFrom is null or <= moveInBy (YYYY-MM-DD).
  @IsOptional() @IsDateString() moveInBy?: string;

  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value) ? value : value == null ? undefined : [value],
  )
  @IsArray()
  @ArrayMaxSize(12)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}
