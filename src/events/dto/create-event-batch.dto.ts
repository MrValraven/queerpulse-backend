import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { IsCalendarDate } from '../../listings/dto/hours-exceptions.validator';
import { CALENDAR_DATE_PATTERN, WALL_CLOCK_TIME_PATTERN } from '../event-batch';
import { COST_KIND_VALUES, type CostKind } from '../gathering-extras';

/**
 * What every event in the batch shares, laid over the starting event.
 *
 * Each place and cost key follows one three-way rule: an absent key keeps the
 * starting event's value, a present key replaces it, and `null` clears it.
 * The global pipe runs with `exposeUnsetFields: false`, so an absent key is
 * absent from the instance too, which is what `composeBatchEventInput` reads.
 * Lengths and formats match `CreateEventDto`, since each event then passes
 * the same checks `create` applies.
 *
 * The times are wall clock `HH:mm` in the starting event's zone. An absent or
 * `null` end means the events have an open end. An absent cover copies the
 * starting event's stored cover server-side, so the page never sends back a
 * cover the caller did not upload.
 */
export class EventBatchSharedDto {
  // place
  @IsOptional() @IsString() @MaxLength(120) neighbourhood?: string | null;
  @IsOptional() @IsString() @MaxLength(300) venue?: string | null;
  @IsOptional() @IsUUID() listingId?: string | null;
  @IsOptional() @IsBoolean() isOnline?: boolean;
  @IsOptional()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(500)
  onlineUrl?: string | null;
  @IsOptional() @IsString() @MaxLength(300) address?: string | null;
  @IsOptional() @IsString() @MaxLength(500) arrivalNotes?: string | null;
  // cost
  @IsOptional() @IsString() @MaxLength(120) cost?: string | null;
  @IsOptional() @IsIn(COST_KIND_VALUES) costKind?: CostKind | null;
  // A blank link is how the page clears it, as on `CreateEventDto`.
  @IsOptional()
  @ValidateIf(
    (dto: EventBatchSharedDto) =>
      typeof dto.paymentUrl !== 'string' || dto.paymentUrl.trim() !== '',
  )
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(500)
  paymentUrl?: string | null;
  @IsOptional() @IsString() @MaxLength(500) paymentInstructions?: string | null;
  // times, wall clock in the starting event's timezone
  @IsString() @Matches(WALL_CLOCK_TIME_PATTERN) startTime!: string;
  // absent or null: the events have an open end
  @IsOptional()
  @IsString()
  @Matches(WALL_CLOCK_TIME_PATTERN)
  endTime?: string | null;
  // cover: absent copies the starting event's stored cover server-side
  @IsOptional() @IsImageReference() coverImageUrl?: string;
}

/**
 * One date in the batch. The date is a calendar day in the starting event's
 * zone. A row's own times win over the shared ones; a row end of `null` gives
 * this date an open end even when the shared block sets one. A row that
 * leaves its cover out takes the shared cover.
 */
export class EventBatchRowDto {
  // in the starting event's timezone
  @IsString()
  @Matches(CALENDAR_DATE_PATTERN)
  @IsCalendarDate()
  date!: string;
  @IsOptional()
  @IsString()
  @Matches(WALL_CLOCK_TIME_PATTERN)
  startTime?: string;
  // null: no end on this date
  @IsOptional()
  @IsString()
  @Matches(WALL_CLOCK_TIME_PATTERN)
  endTime?: string | null;
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsString() @MinLength(1) @MaxLength(1200) description!: string;
  // absent: the shared cover
  @IsOptional() @IsImageReference() coverImageUrl?: string;
}

/**
 * `POST /events/batch`: publish one event per row from the starting event
 * named by `templateSlug`.
 *
 * `rows` has no upper bound here on purpose. The 31-date cap
 * (`EVENT_BATCH_MAX_ROWS`) is checked by the service so the refusal carries
 * its code, `EVENT_BATCH_TOO_MANY_DATES`; an `@ArrayMaxSize` would answer
 * first with an uncoded 400 the page cannot name.
 */
export class CreateEventBatchDto {
  @IsString() @MinLength(1) @MaxLength(200) templateSlug!: string;
  @IsDefined()
  @ValidateNested()
  @Type(() => EventBatchSharedDto)
  shared!: EventBatchSharedDto;
  // 1 to 31; the 31 cap is a coded service check
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => EventBatchRowDto)
  rows!: EventBatchRowDto[];
}
