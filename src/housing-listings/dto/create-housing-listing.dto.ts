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

  /**
   * OPTIONAL, and the value is NOT trusted. QueerPulse housing is Lisbon-only,
   * so the backend is the authority: an omitted, empty or unrecognised city all
   * store `"Lisbon"` (`resolveHousingLocation`, `housing-city.ts`). A client
   * that sends a NEIGHBOURHOOD here (the old form sent `city: area.trim()`)
   * has that value moved into `area` when `area` is otherwise empty, so the
   * neighbourhood survives instead of corrupting the city column.
   */
  @IsOptional() @IsString() @MaxLength(120) city?: string;

  @IsOptional() @IsString() @MaxLength(120) area?: string;

  /**
   * PRIVATE. The full street address of a real person's home, and the most
   * sensitive field on this DTO.
   *
   * It is never returned on public browse or search: `toHousingListingDTO`
   * emits it only behind the `precise` gate, which is the owner, a moderator, a
   * mutually-connected member, or an enquirer whose viewing the lister accepted
   * (`HousingDirectoryService.detail`). Optional, because a lister is free to
   * publish an area-only home; a value that strips to nothing is stored as NULL
   * so "no address on file" is one state rather than two.
   *
   * Length matches the column (`varchar(200)`), like `title`/`blurb`. Markup is
   * stripped at the write boundary (`toStoredPlainTextOrNull`), so no trimming
   * decorator is needed here, matching every other free-text field on this DTO.
   */
  @IsOptional() @IsString() @MaxLength(200) addressLine?: string;

  @IsInt() @Min(0) rentEuros!: number;

  // Up-front deposit in whole euros, same unit as the rent. Optional: omitting
  // it stores NULL, which the board reads as "not stated" and never as zero.
  // Capped well above any honest Lisbon deposit so a typo'd amount is refused
  // at the edge rather than stored and filtered on.
  // `null` is accepted alongside an omitted field and means the same thing:
  // the create form always sends the key, blank or not, because the same body
  // builder feeds the PATCH where a blank has to clear a stored deposit.
  @IsOptional() @IsInt() @Min(0) @Max(100000) depositEuros?: number | null;

  // Bedroom count (0 = studio). Optional; powers the "beds" browse filter.
  @IsOptional() @IsInt() @Min(0) @Max(20) bedrooms?: number;

  @IsOptional() @IsBoolean() billsIncluded?: boolean;

  /**
   * @deprecated Accepted and IGNORED (BE-HSG-07). Posting a home requires the
   * mandatory LGBTQ+ affirming pledge, so every listing is affirming by
   * definition and the service hard-sets the column to `true`. Kept on the DTO
   * only because the global ValidationPipe runs `forbidNonWhitelisted` and
   * would 400 a client still sending the field. Never model affirmation as an
   * opt-in per-listing flag or a browse filter.
   */
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
