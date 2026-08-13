import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import {
  HousingListerKind,
  HousingListingType,
} from '../entities/housing-listing.entity';

/** POST /housing-listings body. The lister/owner is taken from the session,
 * never the body; `status` is always forced to `review` server-side. */
export class CreateHousingListingDto {
  @IsEnum(HousingListingType)
  type!: HousingListingType;

  @IsString() @MinLength(1) @MaxLength(200) title!: string;

  @IsOptional() @IsString() @MaxLength(200) blurb?: string;

  @IsString() @MinLength(1) @MaxLength(120) city!: string;

  @IsOptional() @IsString() @MaxLength(120) area?: string;

  @IsInt() @Min(0) rentEuros!: number;

  // Bedroom count (0 = studio). Optional; powers the "beds" browse filter.
  @IsOptional() @IsInt() @Min(0) @Max(20) bedrooms?: number;

  @IsOptional() @IsBoolean() billsIncluded?: boolean;

  @IsOptional() @IsBoolean() lgbtqFriendly?: boolean;

  // Transparency (P2.6): required on create so every listing carries an honest
  // access line (step-free entrance, lift, etc.).
  @IsString() @MinLength(1) @MaxLength(300) accessibilityInfo!: string;

  // Broker disclosure (P2.6): omitted → `member`. Agents are labelled, not barred.
  @IsOptional() @IsEnum(HousingListerKind) listerKind?: HousingListerKind;

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

  // Optional 360°/virtual-tour link. Must be an https URL (a tour link a member
  // pastes is either public or nothing — never an http/mixed-content embed).
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  virtualTourUrl?: string;
}
