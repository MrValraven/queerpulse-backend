import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { HousingListingType } from '../entities/housing-listing.entity';

/**
 * Optional server-side filters for the public housing directory. Omitting all
 * of them returns every live listing (newest first). Numeric/boolean query
 * params arrive as strings, so each is coerced before validation.
 */
export class BrowseHousingListingsQuery {
  @IsOptional() @IsEnum(HousingListingType) type?: HousingListingType;

  @IsOptional() @IsString() @MaxLength(120) city?: string;

  // Neighbourhood/area, matched case-insensitively (exact) against `area`.
  @IsOptional() @IsString() @MaxLength(120) area?: string;

  // Neighbourhood/area multi-select: match listings whose `area` equals ANY of
  // these (case-insensitive). A single `?areas=Arroios` and repeated
  // `?areas=a&areas=b` both arrive here; coerce the scalar case to an array.
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined ? undefined : Array.isArray(value) ? value : [value],
  )
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  areas?: string[];

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) priceMin?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) priceMax?: number;

  // Minimum bedroom count (0 = studio). Matches listings with `bedrooms >=` it;
  // a listing with no bedroom count set is excluded once this is applied.
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) bedroomsMin?: number;

  // Only `true` narrows the result; any other value is treated as "no filter".
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  billsIncluded?: boolean;

  // Only listings that disclosed an accessibility line (non-empty).
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  hasAccessibilityInfo?: boolean;

  // Only listings the backend derives as "verified" (id-verified lister + live
  // + low risk). Applied server-side as risk_score < threshold AND an
  // id_verified lister — never a self-set flag.
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  verifiedOnly?: boolean;

  // Return listings available on or before this date (YYYY-MM-DD), plus those
  // with no `availableFrom` set.
  @IsOptional() @IsDateString() availableBy?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}
