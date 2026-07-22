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
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { HousingListingType } from '../entities/housing-listing.entity';

/** PATCH /housing-listings/:ref body — every field optional; only the present
 * fields are applied (see `HousingListingsService.applyUpdate`). */
export class UpdateHousingListingDto {
  @IsOptional() @IsEnum(HousingListingType) type?: HousingListingType;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(200) blurb?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(120) area?: string;
  @IsOptional() @IsInt() @Min(0) rentEuros?: number;
  @IsOptional() @IsBoolean() billsIncluded?: boolean;
  @IsOptional() @IsBoolean() lgbtqFriendly?: boolean;
  @IsOptional() @IsDateString() availableFrom?: string;
  @IsOptional() @IsInt() @Min(0) minStayMonths?: number;
  @IsOptional() @IsString() @MaxLength(4000) description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  features?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  idealFor?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsImageReference({ each: true })
  gallery?: string[];
}
