import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type {
  EventBatchRowDto,
  EventBatchSharedDto,
} from './dto/create-event-batch.dto';
import type {
  Event,
  EventVisibility,
  FormatDetails,
  GatheringFamily,
} from './entities/event.entity';
import { isFreeCost } from './event-response';
import type { CreateEventInput } from './events.service';
import type {
  ContentNote,
  CostKind,
  GatheringTheme,
  RsvpCutoff,
} from './gathering-extras';
import {
  instantForWallClock,
  wallClockAt,
  type WallClock,
} from './series-occurrences';

/**
 * Add a month of events: the pure rules behind `GET /events/:slug/batch-template`
 * and `POST /events/batch`.
 *
 * A host starts from one of their events and publishes up to 31 dated copies
 * of it at once. Everything in this file is free of the database and of the
 * process clock zone, so the spec can pin exact instants on any machine: the
 * wire shapes, the wall clock arithmetic that turns a row's date and times
 * into instants in the starting event's zone, the 12-month window, the order
 * in which the starting event, the shared block and the row build each event,
 * and the coded errors the frontend names.
 *
 * The DTO classes are imported as types only. The DTO file reads the regex
 * constants below at decoration time, so a runtime import in this direction
 * would close a cycle and leave those constants undefined when the
 * decorators run.
 */

/** The most dates one batch may carry. A service check, so it carries its code. */
export const EVENT_BATCH_MAX_ROWS = 31;

/** How far ahead a batch may reach, in calendar months from today in the
 *  starting event's zone. */
export const EVENT_BATCH_MAX_MONTHS_AHEAD = 12;

/** A time of day on a 24-hour clock, `HH:mm`, from 00:00 to 23:59. */
export const WALL_CLOCK_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A calendar date, `YYYY-MM-DD`. Whether the date exists is `IsCalendarDate`'s
 *  job; this only pins the shape. */
export const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Every `CreateEventInput` field a batch copies from the starting event.
 *
 * The list mirrors the frontend's `gatheringToFormSeed`
 * (`queerpulse/src/features/gatherings/gatheringSeed.ts`), which is what the
 * create wizard's "same as last time" copies, plus run by, timezone and the
 * cover. Change both together, so a batch and a seeded wizard carry the same
 * things over. Dates and times, pledges, co-hosts, guest communities,
 * recurrence, Go together and the Pulse Live quiz stay behind on purpose.
 */
export const EVENT_BATCH_COPIED_FIELDS = [
  'gatheringFamily',
  'eventType',
  'formatDetails',
  'neighbourhood',
  'venue',
  'listingId',
  'isOnline',
  'onlineUrl',
  'address',
  'arrivalNotes',
  'capacity',
  'language',
  'cost',
  'costKind',
  'paymentUrl',
  'paymentInstructions',
  'accessibility',
  'visibility',
  'communitySlug',
  'themes',
  'contentNotes',
  'houseRules',
  'rsvpCutoff',
  'rsvpQuestions',
  'customRsvpQuestion',
  'allowWaitlist',
  'showAttendeeCount',
  'runByListingId',
  'timezone',
  'coverImageUrl',
] as const satisfies readonly (keyof CreateEventInput)[];

export type EventBatchCopiedField = (typeof EVENT_BATCH_COPIED_FIELDS)[number];

/** What the starting event contributes to every event in the batch. */
export type EventBatchTemplateFields = Pick<
  CreateEventInput,
  EventBatchCopiedField
>;

/**
 * The fields the shared block may override, the place and cost fields the
 * page's Edit panels show. Times and the cover have their own rules
 * (`resolveBatchRowSchedule`, `composeBatchEventInput`).
 */
export const EVENT_BATCH_SHARED_OVERRIDE_FIELDS = [
  'neighbourhood',
  'venue',
  'listingId',
  'isOnline',
  'onlineUrl',
  'address',
  'arrivalNotes',
  'cost',
  'costKind',
  'paymentUrl',
  'paymentInstructions',
] as const;

export type EventBatchSharedOverrideField =
  (typeof EVENT_BATCH_SHARED_OVERRIDE_FIELDS)[number];

/**
 * The starting event as the batch will copy it for this caller, after the
 * run by, community and venue link rules have dropped what the caller cannot
 * keep. Flat and in `CreateEventDto` wire names, so the page fills its summary
 * and its place and cost Edit fields from one read.
 */
export interface EventBatchTemplateView {
  slug: string;
  title: string;
  /** For the row action "Same as the starting event". */
  description: string;
  /** IANA zone. Every date and time in the batch is read on this clock. */
  timezone: string;
  /** `HH:mm`, the starting event's start read in `timezone`. */
  startTime: string;
  /** `HH:mm` in `timezone`, null when the starting event has no end. */
  endTime: string | null;
  /** Display URL (`toImageUrl`) for the preview. The page does not send it
   *  back; the batch reads the stored cover server-side. */
  coverImageUrl: string | null;
  gatheringFamily: GatheringFamily | null;
  eventType: string | null;
  formatDetails: FormatDetails | null;
  neighbourhood: string | null;
  venue: string | null;
  /** Null when dropped, see `venueListingDropped`. */
  listingId: string | null;
  venueListing: { slug: string; name: string } | null;
  isOnline: boolean;
  onlineUrl: string | null;
  address: string | null;
  arrivalNotes: string | null;
  capacity: number | null;
  language: string | null;
  cost: string | null;
  costKind: CostKind | null;
  paymentUrl: string | null;
  paymentInstructions: string | null;
  accessibility: {
    answers: Record<string, 'yes' | 'no' | 'unknown'>;
    note: string;
  };
  visibility: EventVisibility;
  /** The community the batch keeps. */
  community: { slug: string; name: string } | null;
  communityDropped: {
    name: string;
    reason: 'notModerator' | 'unavailable';
  } | null;
  /** The run by listing the batch keeps. */
  runByListing: { ref: string; slug: string; name: string } | null;
  runByDropped: { name: string; reason: 'notManager' | 'unavailable' } | null;
  /** The venue's directory link cannot be attached any more. */
  venueListingDropped: boolean;
  themes: GatheringTheme[];
  contentNotes: ContentNote[];
  houseRules: string | null;
  rsvpCutoff: RsvpCutoff | null;
  rsvpQuestions: { dietary: boolean; pronouns: boolean; access: boolean };
  customRsvpQuestion: string | null;
  allowWaitlist: boolean;
  showAttendeeCount: boolean;
}

/** One published event, as the 201 answers it. */
export interface CreatedEventBatchEvent {
  slug: string;
  title: string;
  /** ISO 8601. */
  startAt: string;
}

/** The 201 body: every event in date order, ascending `startAt`, ties in
 *  request order. */
export interface CreatedEventBatch {
  events: CreatedEventBatchEvent[];
}

/** A row's start and end as instants. A null end is an event with an open end. */
export interface BatchRowSchedule {
  startAt: Date;
  endAt: Date | null;
}

const MONTHS_PER_YEAR = 12;

// The same shapes as `CALENDAR_DATE_PATTERN` and `WALL_CLOCK_TIME_PATTERN`,
// with a capture group per number so each part is read by position.
const CALENDAR_DATE_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_CLOCK_TIME_PARTS = /^(\d{2}):(\d{2})$/;

/** Reads `YYYY-MM-DD` and `HH:mm` into a wall clock, `dayOffset` days later.
 *  `Date.UTC` folds an overflowing day into the next month or year before the
 *  zone is asked about it, the way `occurrenceStartAt` steps a series. The
 *  DTO lets only these shapes through; any other string reads as an invalid
 *  date, a wall clock of `NaN` parts, as `Date.UTC` reads unparsable numbers. */
function wallClockOn(date: string, time: string, dayOffset: number): WallClock {
  const dateMatch = CALENDAR_DATE_PARTS.exec(date);
  const timeMatch = WALL_CLOCK_TIME_PARTS.exec(time);
  const normalised =
    dateMatch && timeMatch
      ? new Date(
          Date.UTC(
            Number(dateMatch[1]),
            Number(dateMatch[2]) - 1,
            Number(dateMatch[3]) + dayOffset,
            Number(timeMatch[1]),
            Number(timeMatch[2]),
          ),
        )
      : new Date(Number.NaN);
  return {
    year: normalised.getUTCFullYear(),
    month: normalised.getUTCMonth(),
    day: normalised.getUTCDate(),
    hour: normalised.getUTCHours(),
    minute: normalised.getUTCMinutes(),
    second: 0,
    millisecond: 0,
  };
}

function padTwoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The instants a row starts and ends, read on `timeZone`'s wall clock.
 *
 * The row's own times win over the shared ones. A row end of `null` means this
 * date has an open end even when the shared block sets one; a row that leaves
 * its end out takes the shared end. An end at or before the start on the
 * clock falls on the next calendar day, the wizard's `schedulePair.ts` rule,
 * so 23:00 to 02:00 is a late night and 21:00 to 21:00 is a full day.
 *
 * Each wall time goes through `instantForWallClock`, which lands a time the
 * spring clock change skips one hour later and takes the first of a repeated
 * autumn hour. The skipped hour can therefore fold an end onto or before its
 * start (01:30 to 02:00 on the last Sunday of March in Lisbon); this function
 * returns that schedule as it reads, and the create checks refuse it with
 * `EVENT_BATCH_ROW_INVALID`.
 */
export function resolveBatchRowSchedule(
  row: Pick<EventBatchRowDto, 'date' | 'startTime' | 'endTime'>,
  shared: Pick<EventBatchSharedDto, 'startTime' | 'endTime'>,
  timeZone: string,
): BatchRowSchedule {
  const startTime = row.startTime ?? shared.startTime;
  const endTime =
    row.endTime !== undefined ? row.endTime : (shared.endTime ?? null);
  const startAt = instantForWallClock(
    wallClockOn(row.date, startTime, 0),
    timeZone,
  );
  if (endTime === null) return { startAt, endAt: null };
  // `HH:mm` strings compare in clock order, both being zero-padded.
  const endDayOffset = endTime <= startTime ? 1 : 0;
  const endAt = instantForWallClock(
    wallClockOn(row.date, endTime, endDayOffset),
    timeZone,
  );
  return { startAt, endAt };
}

/**
 * The last date a batch may hold, `YYYY-MM-DD`: today on `timeZone`'s clock
 * plus `EVENT_BATCH_MAX_MONTHS_AHEAD` calendar months. A day the target month
 * lacks is clamped to its last day, so the 29th of February reaches the 28th
 * a year on.
 */
export function lastAllowedBatchDate(now: Date, timeZone: string): string {
  const today = wallClockAt(now, timeZone);
  const monthsFromYearStart = today.month + EVENT_BATCH_MAX_MONTHS_AHEAD;
  const targetYear =
    today.year + Math.floor(monthsFromYearStart / MONTHS_PER_YEAR);
  const targetMonth = monthsFromYearStart % MONTHS_PER_YEAR;
  // Day 0 of the following month is the last day of the target month.
  const daysInTargetMonth = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();
  const targetDay = Math.min(today.day, daysInTargetMonth);
  return `${targetYear}-${padTwoDigits(targetMonth + 1)}-${padTwoDigits(targetDay)}`;
}

/** What a clock in `timeZone` reads at `instant`, as `HH:mm`. */
export function wallClockTimeOf(instant: Date, timeZone: string): string {
  const wallClock = wallClockAt(instant, timeZone);
  return `${padTwoDigits(wallClock.hour)}:${padTwoDigits(wallClock.minute)}`;
}

/**
 * The cost kind an event carries, or the reading of an event saved before cost
 * kinds existed, which holds only its free-text `cost`. A cost that
 * `isFreeCost` reads as free, a blank one and none at all are `free`; any
 * other text is `fixed`, with the host's own words kept beside it. The
 * preview sends this kind and every batch event is published with it, so the
 * page and the write agree, and a legacy "Free" never comes back as a fixed
 * price called "Free". The frontend's `seedCostKind` (`gatheringSeed.ts`) reads
 * a legacy event for the create wizard the same way.
 */
export function seededCostKind(
  costKind: CostKind | null | undefined,
  cost: string | null | undefined,
): CostKind {
  if (costKind) return costKind;
  return isFreeCost(cost ?? null) ? 'free' : 'fixed';
}

/**
 * The starting event's copied fields as `CreateEventInput` values.
 *
 * The community, venue link and run by come from `kept`: the template service
 * has already decided which of them this caller may carry over, and a dropped
 * one arrives here as `null`. The four columns whose `CreateEventInput` type
 * has no `null` (venue, online link, capacity, cover) map a stored `null` to
 * an absent value, which `create` reads the same way.
 */
export function templateCreateInput(
  template: Event,
  kept: {
    communitySlug: string | null;
    listingId: string | null;
    runByListingId: string | null;
  },
): EventBatchTemplateFields {
  return {
    gatheringFamily: template.gatheringFamily,
    eventType: template.eventType,
    formatDetails: template.formatDetails,
    neighbourhood: template.neighbourhood,
    venue: template.venue ?? undefined,
    listingId: kept.listingId,
    isOnline: template.isOnline,
    onlineUrl: template.onlineUrl ?? undefined,
    address: template.address,
    arrivalNotes: template.arrivalNotes,
    capacity: template.capacity ?? undefined,
    language: template.language,
    cost: template.cost,
    costKind: template.costKind,
    paymentUrl: template.paymentUrl,
    paymentInstructions: template.paymentInstructions,
    accessibility: {
      answers: template.accessibilityAnswers,
      note: template.accessibilityNote,
    },
    visibility: template.visibility,
    communitySlug: kept.communitySlug,
    themes: template.themes,
    contentNotes: template.contentNotes,
    houseRules: template.houseRules,
    rsvpCutoff: template.rsvpCutoff,
    rsvpQuestions: template.rsvpQuestions,
    customRsvpQuestion: template.customRsvpQuestion,
    allowWaitlist: template.allowWaitlist,
    showAttendeeCount: template.showAttendeeCount,
    runByListingId: kept.runByListingId,
    timezone: template.timezone,
    coverImageUrl: template.coverImageUrl ?? undefined,
  };
}

function hasOwnKey(source: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(source, key);
}

/**
 * The shared block's overrides, read by own key. The validation pipe runs
 * with `exposeUnsetFields: false`, so a key the page left out is absent from
 * the instance and the starting event's value stands; a key it sent replaces
 * that value, and `null` clears it. `venue` and `onlineUrl` take no `null` in
 * `CreateEventInput`, so a cleared one is sent as absent, which `create`
 * stores as `null`.
 */
function sharedOverrides(
  shared: EventBatchSharedDto,
): Partial<EventBatchTemplateFields> {
  const sentFields = new Set<EventBatchSharedOverrideField>(
    EVENT_BATCH_SHARED_OVERRIDE_FIELDS.filter((field) =>
      hasOwnKey(shared, field),
    ),
  );
  const overrides: Partial<EventBatchTemplateFields> = {};
  if (sentFields.has('neighbourhood')) {
    overrides.neighbourhood = shared.neighbourhood;
  }
  if (sentFields.has('venue')) overrides.venue = shared.venue ?? undefined;
  if (sentFields.has('listingId')) overrides.listingId = shared.listingId;
  if (sentFields.has('isOnline')) overrides.isOnline = shared.isOnline;
  if (sentFields.has('onlineUrl')) {
    overrides.onlineUrl = shared.onlineUrl ?? undefined;
  }
  if (sentFields.has('address')) overrides.address = shared.address;
  if (sentFields.has('arrivalNotes')) {
    overrides.arrivalNotes = shared.arrivalNotes;
  }
  if (sentFields.has('cost')) overrides.cost = shared.cost;
  if (sentFields.has('costKind')) overrides.costKind = shared.costKind;
  if (sentFields.has('paymentUrl')) overrides.paymentUrl = shared.paymentUrl;
  if (sentFields.has('paymentInstructions')) {
    overrides.paymentInstructions = shared.paymentInstructions;
  }
  return overrides;
}

/**
 * The cover for one event: the row's own cover first, then the shared cover,
 * then the starting event's stored cover. Presence is read by own key at each
 * level, so a row or shared block that sends `null` publishes that event
 * without a cover.
 */
function batchCover(
  templateCover: string | undefined,
  shared: EventBatchSharedDto,
  row: EventBatchRowDto,
): string | undefined {
  if (hasOwnKey(row, 'coverImageUrl')) return row.coverImageUrl ?? undefined;
  if (hasOwnKey(shared, 'coverImageUrl')) {
    return shared.coverImageUrl ?? undefined;
  }
  return templateCover;
}

/**
 * One event's `CreateEventInput`, built in the contract's order: the starting
 * event's fields, then the shared overrides, then the row (title,
 * description, schedule, cover). The result then passes the same checks
 * `create` applies, so cost-kind clearing and family stripping happen there.
 */
export function composeBatchEventInput(
  templateFields: EventBatchTemplateFields,
  shared: EventBatchSharedDto,
  row: EventBatchRowDto,
  schedule: BatchRowSchedule,
): CreateEventInput {
  return {
    ...templateFields,
    ...sharedOverrides(shared),
    title: row.title,
    description: row.description,
    startAt: schedule.startAt.toISOString(),
    ...(schedule.endAt === null ? {} : { endAt: schedule.endAt.toISOString() }),
    coverImageUrl: batchCover(templateFields.coverImageUrl, shared, row),
  };
}

/** The reason codes this feature adds, contract section 7. */
export type EventBatchErrorCode =
  | 'EVENT_BATCH_TEMPLATE_NOT_FOUND'
  | 'EVENT_BATCH_TEMPLATE_COMMUNITY_ONLY'
  | 'EVENT_BATCH_TOO_MANY_DATES'
  | 'EVENT_BATCH_DUPLICATE_DATE'
  | 'EVENT_BATCH_DATE_IN_PAST'
  | 'EVENT_BATCH_DATE_TOO_FAR'
  | 'EVENT_BATCH_ROW_INVALID'
  | 'EVENT_BATCH_VENUE_NOT_FOUND';

/** The row field a row error points the page at. */
export type EventBatchRowField = 'date' | 'startTime' | 'endTime';

// Every builder below answers `{ statusCode, code, message, ...extra }`, the
// shape `RUN_BY_NOT_MANAGER` and `HIDDEN_COMMUNITIES_LIMIT_REACHED` use, so
// the page names the exact cause of every refusal. A row error also carries
// `rowIndex` (0-based, into the request's `rows`), `field` and the row's
// `date`, so the page can mark the row that failed.

function rowErrorBody(
  code: EventBatchErrorCode,
  message: string,
  rowIndex: number,
  field: EventBatchRowField,
  date: string,
) {
  return { statusCode: 400, code, message, rowIndex, field, date };
}

/** 404: the event is missing, cancelled, taken down, or not the caller's to
 *  host or co-host. One answer for all four, so the route never confirms that
 *  someone else's event exists. */
export function eventBatchTemplateNotFound(): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    code: 'EVENT_BATCH_TEMPLATE_NOT_FOUND',
    message:
      "We couldn't find that event among the events you host or co-host, or it was cancelled.",
  });
}

/** 409: the starting event is community-only and the caller cannot post in
 *  that community. Any other audience would change who sees the events. A
 *  community whose row is gone reads as `null` and the message says "its
 *  community". */
export function eventBatchTemplateCommunityOnly(
  communityName: string | null,
): ConflictException {
  const audience = communityName ?? 'its community';
  return new ConflictException({
    statusCode: 409,
    code: 'EVENT_BATCH_TEMPLATE_COMMUNITY_ONLY',
    message: `The event you started from is only for members of ${audience}, and only its moderators can post events there.`,
    communityName,
  });
}

/** 400: more rows than `EVENT_BATCH_MAX_ROWS`, checked before any row. */
export function eventBatchTooManyDates(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: 'EVENT_BATCH_TOO_MANY_DATES',
    message: `You can add up to ${EVENT_BATCH_MAX_ROWS} dates at a time.`,
    limit: EVENT_BATCH_MAX_ROWS,
  });
}

/** 400: the row repeats a date an earlier row already holds. */
export function eventBatchDuplicateDate(
  rowIndex: number,
  date: string,
): BadRequestException {
  return new BadRequestException(
    rowErrorBody(
      'EVENT_BATCH_DUPLICATE_DATE',
      `${date} appears twice. Each date holds one event.`,
      rowIndex,
      'date',
      date,
    ),
  );
}

/** 400: the row's start instant is already behind us. */
export function eventBatchDateInPast(
  rowIndex: number,
  date: string,
): BadRequestException {
  return new BadRequestException(
    rowErrorBody(
      'EVENT_BATCH_DATE_IN_PAST',
      `The start time on ${date} has already passed.`,
      rowIndex,
      'startTime',
      date,
    ),
  );
}

/** 400: the row's date is past `lastAllowedBatchDate`, which it names. */
export function eventBatchDateTooFar(
  rowIndex: number,
  date: string,
  lastDate: string,
): BadRequestException {
  return new BadRequestException({
    ...rowErrorBody(
      'EVENT_BATCH_DATE_TOO_FAR',
      `${date} is more than ${EVENT_BATCH_MAX_MONTHS_AHEAD} months away. The last date you can add is ${lastDate}.`,
      rowIndex,
      'date',
      date,
    ),
    lastDate,
  });
}

/** 400: the row's resolved schedule fails a create check. Once past dates are
 *  their own code, the only check a batch row can still fail is an end on or
 *  before the start, which a spring clock change can cause, so the field is
 *  always the end. */
export function eventBatchRowInvalid(
  rowIndex: number,
  date: string,
): BadRequestException {
  return new BadRequestException(
    rowErrorBody(
      'EVENT_BATCH_ROW_INVALID',
      `The times on ${date} don't work: the end has to come after the start.`,
      rowIndex,
      'endTime',
      date,
    ),
  );
}

/** 400: the venue listing the page picked in the shared block cannot be
 *  attached. A dropped starting-event link never answers this; it reads as
 *  `venueListingDropped` on the preview. */
export function eventBatchVenueNotFound(): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: 'EVENT_BATCH_VENUE_NOT_FOUND',
    message: 'The venue you picked is no longer listed in the directory.',
    field: 'listingId',
  });
}
