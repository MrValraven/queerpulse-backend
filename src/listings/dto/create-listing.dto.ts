import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { IsSafeExternalUrl } from '../../common/validators/is-safe-external-url.decorator';
import { LISTING_CATEGORY_SLUGS } from '../listing-categories';
import { IsValidDayHours } from './day-hours.validator';

// Fixed-shape nested pieces of `ListingDraft` — each maps 1:1 to a frontend
// interface (`WitLine`, `ListingDraft["social"]`, the `PhotoKey`-keyed photo
// records) so they get real per-field validation instead of a bare `IsObject`.

export class ListingWitLineDto {
  @IsString() @MinLength(1) @MaxLength(60) id!: string;
  @IsOptional() @IsString() @MaxLength(300) text?: string;
}

export class ListingSocialDto {
  @IsOptional() @IsString() @MaxLength(200) instagram?: string;
  @IsOptional()
  @IsString()
  @IsSafeExternalUrl()
  @MaxLength(300)
  website?: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(60) phone?: string;
}

/**
 * The four uploaded-image slots themselves (`photos`) — each value is either
 * one of our storage keys or an external `https://` URL, so every field is
 * validated with `@IsImageReference()`. Do NOT reuse this for `alt`: alt text
 * is free-form accessibility copy, never an image reference, and running it
 * through `@IsImageReference()` rejects every real alt string. See
 * `ListingPhotoAltSetDto` below for that.
 */
export class ListingPhotoSetDto {
  @IsOptional() @IsImageReference() wide?: string;
  @IsOptional() @IsImageReference() d1?: string;
  @IsOptional() @IsImageReference() d2?: string;
  @IsOptional() @IsImageReference() vibe?: string;
}

/**
 * Accessibility alt text for the same four photo slots (`alt`) — plain
 * descriptive strings, not image references. Kept as a separate class from
 * `ListingPhotoSetDto` on purpose: the two share field names by coincidence
 * (both mirror the `PhotoKey`-keyed shape) but validate completely different
 * kinds of data. Do NOT merge them back together.
 */
export class ListingPhotoAltSetDto {
  @IsOptional() @IsString() @MaxLength(2000) wide?: string;
  @IsOptional() @IsString() @MaxLength(2000) d1?: string;
  @IsOptional() @IsString() @MaxLength(2000) d2?: string;
  @IsOptional() @IsString() @MaxLength(2000) vibe?: string;
}

/**
 * One opening interval within a weekday — mirrors the entity's
 * `ListingHoursInterval`. `from`/`to` are strict `HH:MM` 24h strings; when
 * `to <= from` the interval is OVERNIGHT (closes the next day). Per-interval
 * format is checked here; the cross-interval rules (open ⇒ ≥1 interval,
 * `to === from` invalid, no overlap) live on `ListingDayHoursDto` via
 * `@IsValidDayHours()`.
 */
export class ListingHoursIntervalDto {
  @IsString() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) from!: string;
  @IsString() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) to!: string;
}

/**
 * One weekday's opening hours — mirrors the entity's `ListingDayHours`
 * (`open`/`intervals`, the split-interval + overnight shape from item #6). A
 * closed day carries `intervals: []`; an open day carries 1..2 non-overlapping
 * intervals. `@IsValidDayHours()` enforces those relationships across the whole
 * object (see `day-hours.validator.ts`).
 */
export class ListingDayHoursDto {
  @IsBoolean() @IsValidDayHours() open!: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => ListingHoursIntervalDto)
  intervals?: ListingHoursIntervalDto[];
}

/**
 * The `hours` map — one `ListingDayHoursDto` per weekday, keyed by the
 * frontend's `DAYS` ids (`Mon`..`Sun`, capitalised — see
 * `database/seed-safe-spaces.ts`). Fixed-key shape on purpose (same precedent
 * as `ListingPhotoSetDto`): the global `forbidNonWhitelisted` ValidationPipe
 * then rejects any stray/unknown day key instead of persisting it to jsonb.
 */
export class ListingHoursDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => ListingDayHoursDto)
  Mon?: ListingDayHoursDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => ListingDayHoursDto)
  Tue?: ListingDayHoursDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => ListingDayHoursDto)
  Wed?: ListingDayHoursDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => ListingDayHoursDto)
  Thu?: ListingDayHoursDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => ListingDayHoursDto)
  Fri?: ListingDayHoursDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => ListingDayHoursDto)
  Sat?: ListingDayHoursDto;
  @IsOptional()
  @ValidateNested()
  @Type(() => ListingDayHoursDto)
  Sun?: ListingDayHoursDto;
}

/**
 * A field that is REQUIRED on the `claim` path but OPTIONAL on `suggest`
 * (item #2). On `claim` the field is always validated (so an absent/empty value
 * fails); on `suggest` it is validated only when the submitter actually
 * supplied a non-empty value — so a suggester who fills it in still gets format
 * checking, but leaving it blank never blocks the submission. Attach the
 * value's format validators (`@IsString()`, `@IsIn()`, `@IsNotEmpty()`, …)
 * AFTER this so they run under exactly that condition.
 */
function requiredOnClaim(field: keyof CreateListingDto) {
  return (dto: CreateListingDto) =>
    dto.path === 'claim' || (dto[field] !== undefined && dto[field] !== '');
}

/**
 * POST /listings body — the wizard's full draft, verbatim
 * (`CreateListingDto = ListingDraft` on the frontend; see `listings.api.ts`).
 * `hours` is the per-weekday opening-hours map (`ListingHoursDto`), the one
 * request-body shape that used to be persisted to jsonb with only a loose
 * `@IsObject()` check.
 *
 * Required-field gating is path-branched (item #2): name, cats, hood, address,
 * coordinates, blurb, and ≥1 `whatItIs` line are required for BOTH paths; the
 * owner identity (ownerName/ownerRole/rel), price, and tagline are required
 * only on the `claim` path (via `requiredOnClaim`). Claim-required `hours` and
 * `photos` are nested shapes, so their presence is enforced in
 * `ListingsService` rather than here (see `assertPathRequirements`).
 */
export class CreateListingDto {
  @IsOptional() @IsIn(['claim', 'suggest', '']) path?: string;
  @IsOptional() @IsString() @MaxLength(120) verify?: string;

  @IsString() @MinLength(1) @MaxLength(200) name!: string;

  // Required for both paths: at least one (up to two) category slug.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @IsIn(LISTING_CATEGORY_SLUGS, { each: true })
  cats!: string[];

  // Online-only business (no physical location). When true, address,
  // coordinates and neighbourhood are all optional (see the `@ValidateIf`s
  // below) and the listing is stored without a pin.
  @IsOptional() @IsBoolean() online?: boolean;

  // Required for both paths — UNLESS this is an online-only listing. When
  // online, a neighbourhood is optional, but a supplied one is still checked.
  @ValidateIf((dto: CreateListingDto) => !dto.online || !!dto.hood)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  hood!: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
  @IsOptional() @IsIn(['owned', 'friendly', '']) badge?: string;
  @IsOptional() @IsString() @MaxLength(2000) evidence?: string;

  // Required on `claim`, optional (but format-checked when supplied) on `suggest`.
  @ValidateIf(requiredOnClaim('price'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  price?: string;

  // Required for both paths: the one-line blurb.
  @IsString() @IsNotEmpty() @MaxLength(140) blurb!: string;

  // Required on `claim`, optional on `suggest`.
  @ValidateIf(requiredOnClaim('tagline'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  tagline?: string;

  // Required for both paths: at least one "what it actually is" line.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => ListingWitLineDto)
  whatItIs!: ListingWitLineDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  goodFor?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  langs?: string[];

  // Required for both paths — unless this is an online-only listing, which has
  // no street address at all.
  @ValidateIf((dto: CreateListingDto) => !dto.online)
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  address!: string;
  @IsOptional() @IsBoolean() geocoded?: boolean;

  // Coordinates are required for a physical listing — the frontend always
  // resolves a pin (geocode, a pasted Google Maps link, or a neighbourhood-
  // centroid fallback) before submit, so a physical listing can never land
  // without a location. An online-only listing carries no coordinates.
  @ValidateIf((dto: CreateListingDto) => !dto.online)
  @IsLatitude()
  latitude!: number;

  @ValidateIf((dto: CreateListingDto) => !dto.online)
  @IsLongitude()
  longitude!: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ListingHoursDto)
  hours?: ListingHoursDto;

  @IsOptional() @IsString() @MaxLength(300) hoursNote?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ListingSocialDto)
  social?: ListingSocialDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ListingPhotoSetDto)
  photos?: ListingPhotoSetDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ListingPhotoAltSetDto)
  alt?: ListingPhotoAltSetDto;

  // Owner identity — required on `claim`, optional on `suggest` (item #2). On
  // `claim` a real relationship must be chosen (the empty-string sentinel is
  // NOT in the accepted set); on `suggest` the empty sentinel / omission is
  // fine and only a supplied value is enum-checked.
  @ValidateIf(requiredOnClaim('rel'))
  @IsIn(['own', 'run', 'work', 'regular'])
  rel?: string;

  @ValidateIf(requiredOnClaim('ownerName'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  ownerName?: string;

  @ValidateIf(requiredOnClaim('ownerRole'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  ownerRole?: string;
  @IsOptional() @IsString() @MaxLength(2000) ownerBio?: string;
  @IsOptional() @IsIn(['public', 'role', 'anon']) visibility?: string;
  @IsOptional() @IsBoolean() linkToProfile?: boolean;
  @IsOptional() @IsString() @MaxLength(200) contactEmail?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  notify?: string[];

  @IsOptional() @IsBoolean() consentOuting?: boolean;
  @IsOptional() @IsBoolean() consentGuide?: boolean;
}
