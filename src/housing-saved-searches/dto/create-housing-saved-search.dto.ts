import { Type } from 'class-transformer';
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
  MinLength,
  ValidateNested,
} from 'class-validator';
import { HousingListingType } from '../../housing-listings/entities/housing-listing.entity';

/**
 * The validated shape of a saved search's stored `criteria` jsonb. Proper types
 * (not query-string coercions) because it arrives as a JSON body. Mirrors
 * `BrowseHousingListingsQuery` field-for-field — see `HousingSearchCriteria`.
 */
export class HousingSavedSearchCriteriaDto {
  @IsOptional() @IsEnum(HousingListingType) type?: HousingListingType;
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(120) area?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  areas?: string[];
  @IsOptional() @IsInt() @Min(0) priceMin?: number;
  @IsOptional() @IsInt() @Min(0) priceMax?: number;
  @IsOptional() @IsInt() @Min(0) bedroomsMin?: number;
  @IsOptional() @IsBoolean() billsIncluded?: boolean;
  @IsOptional() @IsBoolean() hasAccessibilityInfo?: boolean;
  @IsOptional() @IsBoolean() verifiedOnly?: boolean;
  @IsOptional() @IsDateString() availableBy?: string;
}

/** POST /housing-saved-searches body. The owner is the session member. */
export class CreateHousingSavedSearchDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;

  @ValidateNested()
  @Type(() => HousingSavedSearchCriteriaDto)
  criteria!: HousingSavedSearchCriteriaDto;

  // Defaults to ON at the column when omitted.
  @IsOptional() @IsBoolean() alertsEnabled?: boolean;
}
