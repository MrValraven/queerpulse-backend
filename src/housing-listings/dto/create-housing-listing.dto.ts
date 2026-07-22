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

/** POST /housing-listings body. The lister/owner is taken from the session,
 * never the body; `status` is always forced to `review` server-side. */
export class CreateHousingListingDto {
  @IsEnum(HousingListingType)
  type: HousingListingType;

  @IsString() @MinLength(1) @MaxLength(200) title: string;

  @IsOptional() @IsString() @MaxLength(200) blurb?: string;

  @IsString() @MinLength(1) @MaxLength(120) city: string;

  @IsOptional() @IsString() @MaxLength(120) area?: string;

  @IsInt() @Min(0) rentEuros: number;

  @IsOptional() @IsBoolean() billsIncluded?: boolean;

  @IsOptional() @IsBoolean() lgbtqFriendly?: boolean;

  // YYYY-MM-DD; stored as a Postgres `date`.
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
