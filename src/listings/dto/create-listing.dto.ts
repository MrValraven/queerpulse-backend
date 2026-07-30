import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { IsSafeExternalUrl } from '../../common/validators/is-safe-external-url.decorator';
import { LISTING_CATEGORY_SLUGS } from '../listing-categories';

// Fixed-shape nested pieces of `ListingDraft` — each maps 1:1 to a frontend
// interface (`WitLine`, `ListingDraft["social"]`, the `PhotoKey`-keyed photo
// records) so they get real per-field validation instead of a bare `IsObject`.

export class ListingWitLineDto {
  @IsString() @MinLength(1) @MaxLength(60) id: string;
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
 * One weekday's opening hours — mirrors the entity's `ListingDayHours`
 * (`open`/`from`/`to`). `from`/`to` are `HH:MM` strings (or empty when the day
 * is closed), so they are validated as short strings rather than a strict time
 * format, matching how the frontend wizard emits partial/blank times.
 */
export class ListingDayHoursDto {
  @IsBoolean() open: boolean;
  @IsOptional() @IsString() @MaxLength(20) from?: string;
  @IsOptional() @IsString() @MaxLength(20) to?: string;
}

/**
 * The `hours` map — one `ListingDayHoursDto` per weekday, keyed by the
 * frontend's `DAYS` ids (`Mon`..`Sun`, capitalised — see
 * `database/seed-safe-spaces.ts`). Fixed-key shape on purpose (same precedent
 * as `ListingPhotoSetDto`): the global `forbidNonWhitelisted` ValidationPipe
 * then rejects any stray/unknown day key instead of persisting it to jsonb.
 */
export class ListingHoursDto {
  @IsOptional() @ValidateNested() @Type(() => ListingDayHoursDto) Mon?: ListingDayHoursDto;
  @IsOptional() @ValidateNested() @Type(() => ListingDayHoursDto) Tue?: ListingDayHoursDto;
  @IsOptional() @ValidateNested() @Type(() => ListingDayHoursDto) Wed?: ListingDayHoursDto;
  @IsOptional() @ValidateNested() @Type(() => ListingDayHoursDto) Thu?: ListingDayHoursDto;
  @IsOptional() @ValidateNested() @Type(() => ListingDayHoursDto) Fri?: ListingDayHoursDto;
  @IsOptional() @ValidateNested() @Type(() => ListingDayHoursDto) Sat?: ListingDayHoursDto;
  @IsOptional() @ValidateNested() @Type(() => ListingDayHoursDto) Sun?: ListingDayHoursDto;
}

/**
 * POST /listings body — the wizard's full draft, verbatim
 * (`CreateListingDto = ListingDraft` on the frontend; see `listings.api.ts`).
 * `hours` is the per-weekday opening-hours map (`ListingHoursDto`), the one
 * request-body shape that used to be persisted to jsonb with only a loose
 * `@IsObject()` check.
 */
export class CreateListingDto {
  @IsOptional() @IsIn(['claim', 'suggest', '']) path?: string;
  @IsOptional() @IsString() @MaxLength(120) verify?: string;

  @IsString() @MinLength(1) @MaxLength(200) name: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @IsIn(LISTING_CATEGORY_SLUGS, { each: true })
  cats?: string[];

  @IsOptional() @IsString() @MaxLength(120) hood?: string;
  @IsOptional() @IsIn(['owned', 'friendly', '']) badge?: string;
  @IsOptional() @IsString() @MaxLength(2000) evidence?: string;
  @IsOptional() @IsString() @MaxLength(120) price?: string;
  @IsOptional() @IsString() @MaxLength(140) blurb?: string;
  @IsOptional() @IsString() @MaxLength(200) tagline?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => ListingWitLineDto)
  whatItIs?: ListingWitLineDto[];

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

  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsBoolean() geocoded?: boolean;

  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @IsLongitude()
  longitude?: number;

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

  @IsOptional() @IsIn(['own', 'run', 'work', 'regular', '']) rel?: string;
  @IsOptional() @IsString() @MaxLength(120) ownerName?: string;
  @IsOptional() @IsString() @MaxLength(120) ownerRole?: string;
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
