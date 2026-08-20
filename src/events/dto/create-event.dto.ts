import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
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
import { EventStatus, EventVisibility } from '../entities/event.entity';
import { RecurrenceDto } from './recurrence.dto';

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
