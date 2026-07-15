import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

// Fixed-shape nested pieces of `ListingDraft` — each maps 1:1 to a frontend
// interface (`WitLine`, `ListingDraft["social"]`, the `PhotoKey`-keyed photo
// records) so they get real per-field validation instead of a bare `IsObject`.

export class ListingWitLineDto {
  @IsString() @MinLength(1) @MaxLength(60) id: string;
  @IsOptional() @IsString() @MaxLength(300) text?: string;
}

export class ListingSocialDto {
  @IsOptional() @IsString() @MaxLength(200) instagram?: string;
  @IsOptional() @IsString() @MaxLength(300) website?: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(60) phone?: string;
}

export class ListingPhotoSetDto {
  @IsOptional() @IsString() @MaxLength(2000) wide?: string;
  @IsOptional() @IsString() @MaxLength(2000) d1?: string;
  @IsOptional() @IsString() @MaxLength(2000) d2?: string;
  @IsOptional() @IsString() @MaxLength(2000) vibe?: string;
}

/**
 * POST /listings body — the wizard's full draft, verbatim
 * (`CreateListingDto = ListingDraft` on the frontend; see `listings.api.ts`).
 * `hours` is a `Record<string, DayHours>` keyed by the frontend's `DAYS` ids,
 * which aren't fixed here — validated loosely (`IsObject`) and passed through
 * as-is, matching the "no presentation fields" precedent for opaque
 * passthrough blobs.
 */
export class CreateListingDto {
  @IsOptional() @IsIn(['claim', 'suggest', '']) path?: string;
  @IsOptional() @IsString() @MaxLength(120) verify?: string;

  @IsString() @MinLength(1) @MaxLength(200) name: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
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

  @IsOptional() @IsObject() hours?: Record<string, unknown>;

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
  @Type(() => ListingPhotoSetDto)
  alt?: ListingPhotoSetDto;

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
