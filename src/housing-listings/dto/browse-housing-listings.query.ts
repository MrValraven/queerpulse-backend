import { Transform, Type } from 'class-transformer';
import {
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

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) priceMin?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) priceMax?: number;

  // Only `true` narrows the result; any other value is treated as "no filter".
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  lgbtqFriendly?: boolean;

  // Return listings available on or before this date (YYYY-MM-DD), plus those
  // with no `availableFrom` set.
  @IsOptional() @IsDateString() availableBy?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}
