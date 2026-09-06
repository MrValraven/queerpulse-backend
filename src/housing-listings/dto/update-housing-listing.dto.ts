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

/** PATCH /housing-listings/:ref body — every field optional; only the present
 * fields are applied (see `HousingListingsService.applyUpdate`). */
export class UpdateHousingListingDto {
  @IsOptional() @IsEnum(HousingListingType) type?: HousingListingType;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(200) blurb?: string;
  /** Accepted and normalised the same way as on create: the stored city is
   * always `"Lisbon"`. See `CreateHousingListingDto.city`. */
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(120) area?: string;
  /**
   * PRIVATE, same gate and same normalisation as on create (see
   * `CreateHousingListingDto.addressLine`). Sending `""` CLEARS the stored
   * address and the precise coordinates derived from it, which is how an owner
   * takes their exact address back off the record; omitting the field leaves
   * both untouched.
   */
  @IsOptional() @IsString() @MaxLength(200) addressLine?: string;
  @IsOptional() @IsInt() @Min(0) rentEuros?: number;
  /**
   * Up-front deposit in whole euros. See `CreateHousingListingDto`.
   *
   * Sending `null` CLEARS a stored deposit, the same way sending `""` clears
   * `addressLine` above; omitting the field leaves it untouched. A deposit is a
   * money term renters filter on, so a lister who set one by mistake, or whose
   * deposit went away, has to be able to take it back off, and `applyUpdate`'s
   * present-keys-only rule means an omitted blank never could. `@IsOptional()`
   * already skips validation for `null`, so no rule below has to change.
   */
  @IsOptional() @IsInt() @Min(0) @Max(100000) depositEuros?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(20) bedrooms?: number;
  @IsOptional() @IsBoolean() billsIncluded?: boolean;
  /** @deprecated Accepted and IGNORED — see `CreateHousingListingDto`
   * (BE-HSG-07). `applyUpdate` no longer reads it. */
  @IsOptional() @IsBoolean() lgbtqFriendly?: boolean;
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  accessibilityInfo?: string;
  @IsOptional() @IsEnum(HousingListerKind) listerKind?: HousingListerKind;
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

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  virtualTourUrl?: string;
}
