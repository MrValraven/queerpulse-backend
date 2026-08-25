import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsObject,
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
import {
  ListingAccessibilityAnswer,
  MAX_ACCESSIBILITY_NOTE_LENGTH,
} from '../listing-accessibility';
import { LISTING_CATEGORY_SLUGS } from '../listing-categories';
import { MAX_LISTING_GALLERY_PHOTOS } from '../listing-photo-gallery';
import { IsAccessibilityAnswerMap } from './accessibility-answers.validator';
import { IsValidDayHours } from './day-hours.validator';
import {
  HasUniqueExceptionDates,
  IsCalendarDate,
} from './hours-exceptions.validator';

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
  // Rendered as a `mailto:` on the public directory detail page
  // (`listing-response.ts`), so it has to actually be an address. `''` is
  // deliberately allowed: the wizard treats every social as optional and sends
  // an empty string rather than omitting the key, and `@IsOptional()` only
  // skips `undefined`/`null`. Same shape as `@IsImageReference`'s empty-string
  // carve-out.
  @ValidateIf((dto: ListingSocialDto) => (dto.email ?? '') !== '')
  @IsEmail()
  @MaxLength(200)
  email?: string;
  @IsOptional() @IsString() @MaxLength(60) phone?: string;
}

/**
 * ONE photo in the listing's ordered gallery (`photoGallery`): an image
 * reference, the alt text that describes it, and an optional caption.
 *
 * The three fields are validated as three different kinds of data and must
 * never be merged:
 *
 * - `image` is a storage key or an allowed external `https://` URL, so it goes
 *   through `@IsImageReference()`.
 * - `alt` is free-form accessibility copy. It is REQUIRED on the wire (no
 *   `@IsOptional()`): a client must state a photo's description explicitly, so
 *   it cannot be dropped from a body and silently defaulted away. The empty
 *   string is accepted, and only because the four-slot model that came before
 *   allowed a photo with no alt text and the backfill carries those rows
 *   forward verbatim; on the `claim` path an empty cover alt is refused
 *   outright (`ListingsService.assertPathRequirements`).
 * - `caption` is copy shown to everyone under the photo, and is genuinely
 *   optional. It is NOT a place to put alt text: a caption is read by people
 *   who can already see the picture.
 */
export class ListingGalleryPhotoDto {
  @IsImageReference() image!: string;

  @IsString() @MaxLength(2000) alt!: string;

  @IsOptional() @IsString() @MaxLength(300) caption?: string;
}

/**
 * LEGACY: the four fixed uploaded-image slots (`photos`) — each value is either
 * one of our storage keys or an external `https://` URL, so every field is
 * validated with `@IsImageReference()`. Do NOT reuse this for `alt`: alt text
 * is free-form accessibility copy, never an image reference, and running it
 * through `@IsImageReference()` rejects every real alt string. See
 * `ListingPhotoAltSetDto` below for that.
 *
 * Superseded by `ListingGalleryPhotoDto` above, and still accepted so a client
 * that has not moved to `photoGallery` yet keeps working. A body carrying
 * `photoGallery` wins; a body carrying only these is converted to the ordered
 * gallery in slot order (`galleryFromLegacySlots`).
 */
export class ListingPhotoSetDto {
  @IsOptional() @IsImageReference() wide?: string;
  @IsOptional() @IsImageReference() d1?: string;
  @IsOptional() @IsImageReference() d2?: string;
  @IsOptional() @IsImageReference() vibe?: string;
}

/**
 * LEGACY: accessibility alt text for the same four photo slots (`alt`) — plain
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
 * How many per-date exceptions one listing may carry. Sized for a full year of
 * a venue's real special dates (national + local holidays, a summer break, a
 * handful of private-event closures) with headroom, while keeping the jsonb
 * column small enough that it is cheap to read on every directory detail. A
 * venue needing more than this is describing a seasonal SCHEDULE, which
 * belongs in the weekly grid plus `hoursNote`, not in one-off overrides.
 */
export const MAX_HOURS_EXCEPTIONS = 60;

/**
 * One calendar date whose hours differ from the weekly grid. Mirrors the
 * entity's `ListingHoursException`.
 *
 * Extends `ListingDayHoursDto`, so `open` and `intervals` carry the very same
 * validation the seven weekday entries do (`@IsValidDayHours()`: a closed day
 * has no intervals; an open day has 1..2 non-overlapping, non-zero-length
 * `HH:MM` intervals, overnight allowed). `open: false` is the "venue is closed
 * that date" case. Nothing about the interval rules is restated here, which is
 * the whole point of the inheritance: one definition, one place to change it.
 *
 * Fixed-shape like `ListingHoursDto`/`ListingPhotoSetDto`, so the global
 * `forbidNonWhitelisted` ValidationPipe rejects a stray key instead of
 * persisting it to jsonb.
 */
export class ListingHoursExceptionDto extends ListingDayHoursDto {
  // Format first, then existence: `@Matches` rejects `24-12-31`, and
  // `@IsCalendarDate` rejects a well-formed but impossible `2026-02-31`.
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsCalendarDate()
  date!: string;

  // "Christmas Eve, closing early": short, optional, shown next to the date.
  @IsOptional() @IsString() @MaxLength(140) note?: string;
}

/**
 * The venue's accessibility answers plus the owner's free-text note.
 *
 * `answers` is a partial map: a client sends only the questions it has an
 * answer for, and the service fills every unsent question with a real
 * `unknown` before storing. Sending `"no"` explicitly is a first-class,
 * expected use of this endpoint, which is the difference between this and the
 * `goodFor` tags it replaced.
 *
 * On PATCH the answers MERGE per question rather than replacing the map, so an
 * owner who corrects one answer does not blank the other five. The note
 * replaces wholesale, being a single value.
 */
export class ListingAccessibilityDto {
  @IsOptional()
  @IsObject()
  @IsAccessibilityAnswerMap()
  answers?: Partial<Record<string, ListingAccessibilityAnswer>>;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_ACCESSIBILITY_NOTE_LENGTH)
  note?: string;
}

/**
 * How many priced services one listing may carry. Sized for a real menu (a
 * barber's full cut list, a clinic's consultation types) with headroom. A
 * business needing more than this is publishing a PRICE LIST, which belongs on
 * their own site behind the `social.website` link, not inlined into a
 * directory card.
 */
export const MAX_LISTING_SERVICES = 30;

/**
 * One priced thing the business sells. Mirrors the entity's
 * `ListingServiceOffering`.
 *
 * `price` is free text and required: a service row with no price is the exact
 * gap this list was added to close. Free text is what lets "from 25 EUR",
 * "sliding scale", "first session free" and "by quote" all be told truthfully.
 */
export class ListingServiceOfferingDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) price!: string;
  @IsOptional() @IsString() @MaxLength(140) note?: string;
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

  // ATMOSPHERE tags only. Accessibility claims belong in `accessibility`
  // below, which can also say no.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  goodFor?: string[];

  // The venue's structured accessibility answers plus its free-text note.
  // Optional here: every unanswered question stores as `unknown`, so omitting
  // this is a truthful "we have not said", never a silent "no".
  @IsOptional()
  @ValidateNested()
  @Type(() => ListingAccessibilityDto)
  accessibility?: ListingAccessibilityDto;

  // What the business sells and what it costs. Optional: plenty of listings
  // (a bar, a gallery) have nothing to price.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LISTING_SERVICES)
  @ValidateNested({ each: true })
  @Type(() => ListingServiceOfferingDto)
  services?: ListingServiceOfferingDto[];

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

  // Per-date overrides of the weekly grid. Optional everywhere (most listings
  // have none); when present, every entry is a full `ListingHoursExceptionDto`
  // and no two entries may name the same date.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_HOURS_EXCEPTIONS)
  @HasUniqueExceptionDates()
  @ValidateNested({ each: true })
  @Type(() => ListingHoursExceptionDto)
  hoursExceptions?: ListingHoursExceptionDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ListingSocialDto)
  social?: ListingSocialDto;

  // The listing's photos, in the owner's chosen order — index 0 is the cover.
  // Supersedes the `photos`/`alt` pair below; when both are sent, this wins.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_LISTING_GALLERY_PHOTOS)
  @ValidateNested({ each: true })
  @Type(() => ListingGalleryPhotoDto)
  photoGallery?: ListingGalleryPhotoDto[];

  // LEGACY four-slot photo pair, still accepted during the transition to
  // `photoGallery`. Converted to the ordered gallery in slot order when
  // `photoGallery` is absent; ignored when it is present.
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
  // Moderators mail this address when they need to reach the owner, so a
  // garbage string here is a dead outreach path. Empty string allowed for the
  // same reason as `ListingSocialDto.email` above.
  @ValidateIf((dto: CreateListingDto) => (dto.contactEmail ?? '') !== '')
  @IsEmail()
  @MaxLength(200)
  contactEmail?: string;

  @IsOptional() @IsBoolean() consentOuting?: boolean;
  @IsOptional() @IsBoolean() consentGuide?: boolean;

  /**
   * The submitter agrees to the LGBTQ+ affirming baseline. REQUIRED, and
   * required to be `true`: every listing agrees to it in order to appear in
   * this directory at all, matching the housing side's mandatory pledge. It is
   * not an optional flag and there is no version of a listing that declines it,
   * so `false` is rejected rather than stored.
   *
   * What is agreed to is a commitment about the business's own conduct: to
   * welcome and serve LGBTQ+ people, and to deal with it when someone in the
   * space does not. It confers no permission to exclude anyone over who they
   * are, and copy built on this field must never suggest otherwise.
   *
   * The acceptance TIME is recorded server-side (`affirmingBaselineAcceptedAt`)
   * rather than accepted from the client, so the record cannot be backdated.
   * Absent from `UpdateListingDto`: a listing cannot un-agree to a baseline it
   * only exists because of, and a PATCH carrying this field is rejected by the
   * global `forbidNonWhitelisted` pipe rather than silently ignored.
   */
  @IsBoolean()
  @Equals(true, {
    message:
      'Every listing agrees to the LGBTQ+ affirming baseline in order to appear in the directory.',
  })
  affirmingBaselineAccepted!: boolean;
}
