import { Type } from 'class-transformer';
import {
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
  @IsOptional()
  @ValidateNested()
  @Type(() => EventAccessibilityDto)
  accessibility?: EventAccessibilityDto;
  // Free-text door price (LOC-18) — "5 to 15 EUR sliding scale", "pay what
  // you can", "free". DISPLAY ONLY: this platform has no payment
  // integration, so neither this field nor any message about it may promise
  // a charge, a ticket or a refund.
  @IsOptional() @IsString() @MaxLength(120) cost?: string | null;
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
