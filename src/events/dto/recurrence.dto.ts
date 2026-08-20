import { IsIn, IsInt, IsISO8601, IsOptional, Max, Min } from 'class-validator';

/** How often a series' occurrences repeat. */
export type RecurrenceCadence = 'weekly' | 'biweekly' | 'monthly';
/** How a series' occurrences stop generating. */
export type RecurrenceEndType = 'count' | 'date';

/**
 * A gathering's repeat rule, accepted only on CREATE — see `CreateEventDto`.
 * Deliberately minimal, not an RFC5545/RRULE engine: a fixed cadence plus one
 * of two end conditions. `EventsService.create` generates one independent,
 * fully RSVPable/editable/cancelable `Event` row per occurrence up front
 * (capped at `MAX_OCCURRENCES`) rather than lazily via a generation job — see
 * its class doc.
 */
export class RecurrenceDto {
  @IsIn(['weekly', 'biweekly', 'monthly'])
  cadence!: RecurrenceCadence;

  @IsIn(['count', 'date'])
  endType!: RecurrenceEndType;

  // Required when `endType === 'count'` — checked in `EventsService.create`,
  // not here: class-validator has no clean "required only if a sibling field
  // equals X" for a nested DTO short of `@ValidateIf`, and the service
  // already owns the cross-field schedule checks (`assertScheduleValid`)
  // this rule belongs next to.
  @IsOptional() @IsInt() @Min(2) @Max(52) endCount?: number;

  // Required when `endType === 'date'` — same "checked in the service" note
  // as `endCount` above. Must be after the gathering's own `startAt`.
  @IsOptional() @IsISO8601() endUntil?: string;
}
