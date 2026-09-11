import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsTimeZone,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { IsAccessibilityAnswerMap } from '../../listings/dto/accessibility-answers.validator';
import {
  ListingAccessibilityAnswer,
  MAX_ACCESSIBILITY_NOTE_LENGTH,
} from '../../listings/listing-accessibility';
import { EventStatus, EventVisibility } from '../entities/event.entity';
import {
  CONTENT_NOTE_KEYS,
  COST_KIND_VALUES,
  GATHERING_THEME_KEYS,
  MAX_CUSTOM_RSVP_QUESTION_LENGTH,
  MAX_GATHERING_THEMES,
  MAX_HOUSE_RULES_LENGTH,
  RSVP_CUTOFF_VALUES,
  type ContentNote,
  type CostKind,
  type GatheringTheme,
  type RsvpCutoff,
} from '../gathering-extras';
import {
  GatheringFamily,
  MAX_BRING_LENGTH,
  MAX_RUNTIME_MINUTES,
  MIN_RUNTIME_MINUTES,
  TERRAIN_VALUES,
  type Terrain,
} from '../gathering-family';
import { RecurrenceDto } from './recurrence.dto';

/**
 * A gathering's accessibility answers plus the host's free-text note.
 *
 * The SAME shape a business listing uses (`ListingAccessibilityDto`), reading
 * the same vocabulary out of `listings/listing-accessibility.ts` and reusing
 * the same `IsAccessibilityAnswerMap` validator, deliberately rather than as
 * a convenience: a member who uses a wheelchair should learn the same six
 * facts in the same three-valued language whether they are reading a bar's
 * page or a Tuesday supper club's, and "unknown" has to stay distinct from
 * "no" in both.
 *
 * `answers` is partial on the wire: a client sends what it has an answer for
 * and the service fills the rest with a real `unknown`. On PATCH the answers
 * MERGE per question, so a host correcting one answer does not blank the
 * other five; the note replaces wholesale.
 */
export class EventAccessibilityDto {
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
 * The one or two questions a gathering's FAMILY raises, answered.
 *
 * Validated for shape only. WHICH of these six a given family may store is
 * decided in `../gathering-family.ts` and enforced by `EventsService`, which
 * strips the rest before writing. Validating membership here instead would
 * turn a host switching family into a 400 with a stale field they cannot see,
 * which is precisely the failure the stripping rule exists to avoid.
 */
export class FormatDetailsDto {
  /** What to bring, one line. */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_BRING_LENGTH)
  bring?: string;

  /** The door checks age. */
  @IsOptional() @IsBoolean() isAdultsOnly?: boolean;

  /** There is something good to drink that is not alcohol. */
  @IsOptional() @IsBoolean() isSoberFriendly?: boolean;

  /** How hard the ground is underfoot. */
  @IsOptional() @IsIn(TERRAIN_VALUES) terrain?: Terrain;

  /** Nobody needs to have done this before. */
  @IsOptional() @IsBoolean() isBeginnerFriendly?: boolean;

  /** How long the film, set or performance runs. */
  @IsOptional()
  @IsInt()
  @Min(MIN_RUNTIME_MINUTES)
  @Max(MAX_RUNTIME_MINUTES)
  runtimeMinutes?: number;
}

/**
 * Which optional questions the RSVP details modal asks.
 *
 * Every key is optional on the wire. On create, a missing key is `false`; on
 * PATCH the map MERGES per key (`mergeRsvpQuestions`), so a host switching
 * pronouns on does not silently switch dietary off.
 */
export class RsvpQuestionsDto {
  @IsOptional() @IsBoolean() dietary?: boolean;
  @IsOptional() @IsBoolean() pronouns?: boolean;
  @IsOptional() @IsBoolean() access?: boolean;
}

export class CreateEventDto {
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsString() @MinLength(1) @MaxLength(10000) description!: string;
  @IsISO8601() startAt!: string;
  @IsOptional() @IsISO8601() endAt?: string;
  @IsTimeZone() timezone!: string;
  @IsOptional() @IsString() @MaxLength(300) venue?: string;
  // `string | null` (not just optional) — mirrors `communitySlug` below: on
  // UPDATE, `null` explicitly detaches the venue from a directory listing
  // (falling back to plain-text `venue`), distinct from omitting the field
  // ("leave the existing link, if any, unchanged"). `create()` has no
  // existing link to detach, so it treats `null`/absent identically.
  @IsOptional() @IsUUID() listingId?: string | null;
  @IsOptional() @IsBoolean() isOnline?: boolean;
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(500)
  onlineUrl?: string;
  @IsOptional() @IsInt() @Min(1) capacity?: number;
  // `EventVisibility.Community` is mutually exclusive with "no community":
  // enforced in `EventsService.create`/`update` (400), not here, because the
  // rule is cross-field (`communitySlug` below) and, on update, must weigh the
  // EXISTING `event.communityId` too (a patch can flip visibility without
  // resending `communitySlug`).
  @IsOptional() @IsEnum(EventVisibility) visibility?: EventVisibility;
  @IsOptional() @IsIn([EventStatus.Draft, EventStatus.Published]) status?:
    EventStatus.Draft | EventStatus.Published;
  @IsOptional() @IsImageReference() coverImageUrl?: string;
  // ── Where it actually is (LOC-04) — see `Event.address`'s doc ───────────
  // Every one of these is `string | null` rather than merely optional, for
  // the same reason `communitySlug` below is: on UPDATE, `null` (or `''`)
  // clears the stored value, which is a different instruction from omitting
  // the field ("leave it alone"). `create()` treats null/''/absent alike.
  @IsOptional() @IsString() @MaxLength(300) address?: string | null;
  @IsOptional() @IsString() @MaxLength(500) arrivalNotes?: string | null;
  @IsOptional() @IsString() @MaxLength(120) neighbourhood?: string | null;
  @IsOptional() @IsString() @MaxLength(80) language?: string | null;
  @IsOptional() @IsString() @MaxLength(80) eventType?: string | null;
  /**
   * The gathering's family: the closed vocabulary its format sits inside.
   *
   * `string | null` in spirit like the LOC-04 fields above: `null` on UPDATE
   * clears it (a host un-classifying a gathering), absent leaves it alone,
   * a value sets it. `@IsOptional()` already skips validation for `null`.
   */
  @IsOptional()
  @IsEnum(GatheringFamily)
  gatheringFamily?: GatheringFamily | null;
  /**
   * The answers to this family's one or two questions. Same absent/null/value
   * three-way. The service strips whatever the effective family does not
   * allow, and stores `null` when nothing is left.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => FormatDetailsDto)
  formatDetails?: FormatDetailsDto | null;
  @IsOptional()
  @ValidateNested()
  @Type(() => EventAccessibilityDto)
  accessibility?: EventAccessibilityDto;
  // Free-text door price (LOC-18) — "5 to 15 EUR sliding scale", "pay what
  // you can", "free". DISPLAY ONLY: this platform has no payment
  // integration, so neither this field nor any message about it may promise
  // a charge, a ticket or a refund.
  @IsOptional() @IsString() @MaxLength(120) cost?: string | null;
  // How it is paid for. `free` makes the service store `cost` as null.
  // Same absent/null/value three-way as `cost` on update.
  @IsOptional() @IsIn(COST_KIND_VALUES) costKind?: CostKind | null;
  // ── Care (create-gathering v2), vocabularies in `../gathering-extras.ts` ──
  // An unknown key is a 400 and so is a duplicate, which makes the
  // three-theme cap count distinct themes. On update both arrays REPLACE
  // wholesale; `null` clears.
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(MAX_GATHERING_THEMES)
  @IsIn(GATHERING_THEME_KEYS, { each: true })
  themes?: GatheringTheme[];
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(CONTENT_NOTE_KEYS.length)
  @IsIn(CONTENT_NOTE_KEYS, { each: true })
  contentNotes?: ContentNote[];
  // Nullable strings follow the LOC-04 rule: `null` or blank clears on
  // update, and the service trims what it stores.
  @IsOptional()
  @IsString()
  @MaxLength(MAX_HOUSE_RULES_LENGTH)
  houseRules?: string | null;
  // `null` means RSVPs stay open until the gathering ends; `at-start` closes
  // them when it starts.
  @IsOptional() @IsIn(RSVP_CUTOFF_VALUES) rsvpCutoff?: RsvpCutoff | null;
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => RsvpQuestionsDto)
  rsvpQuestions?: RsvpQuestionsDto;
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CUSTOM_RSVP_QUESTION_LENGTH)
  customRsvpQuestion?: string | null;
  // `string | null` (not just optional): on UPDATE, `null` (or `''`) is a
  // meaningful "detach the community" signal, distinct from omitting the
  // field entirely ("leave unchanged") — see `EventsService.update`.
  // `@IsOptional()` already treats `null` as "skip further validators"
  // (class-validator: empty === null || undefined), so a `null` payload
  // reaches the service untouched; a non-empty string still gets validated
  // as a normal slug. `create()` has no existing community to detach from,
  // so it treats `null`/`''`/absent identically (all "no community").
  @IsOptional()
  @IsString()
  @MaxLength(200)
  communitySlug?: string | null;
  // Manage-dashboard "Options" toggles — see `Event.allowWaitlist`'s doc.
  // Create-time default is `true` for both (`EventsService.create`); these
  // are realistically only ever changed later via `UpdateEventDto`, but are
  // accepted at create time too for symmetry.
  @IsOptional() @IsBoolean() allowWaitlist?: boolean;
  @IsOptional() @IsBoolean() showAttendeeCount?: boolean;
  // Optional repeat rule (MSG-10) — see `RecurrenceDto`'s doc. When present,
  // `EventsService.create` generates a full `EventSeries` plus one
  // independent `Event` row per occurrence instead of just this one event.
  // CREATE-only: `UpdateEventDto` omits this field — converting an existing
  // standalone event into a series after the fact is out of scope.
  @IsOptional()
  @ValidateNested()
  @Type(() => RecurrenceDto)
  recurrence?: RecurrenceDto;
}
