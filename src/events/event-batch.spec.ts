import { emptyAccessibilityAnswers } from '../listings/listing-accessibility';
import type {
  EventBatchRowDto,
  EventBatchSharedDto,
} from './dto/create-event-batch.dto';
import {
  Event,
  EventVisibility,
  GatheringFamily,
} from './entities/event.entity';
import {
  EVENT_BATCH_COPIED_FIELDS,
  composeBatchEventInput,
  eventBatchDateInPast,
  eventBatchDateTooFar,
  eventBatchDuplicateDate,
  eventBatchRowInvalid,
  eventBatchTemplateCommunityOnly,
  eventBatchTemplateNotFound,
  eventBatchTooManyDates,
  eventBatchVenueNotFound,
  lastAllowedBatchDate,
  resolveBatchRowSchedule,
  templateCreateInput,
  wallClockTimeOf,
  type BatchRowSchedule,
} from './event-batch';

const LISBON = 'Europe/Lisbon';
const SHARED = { startTime: '21:00' };
const MILLISECONDS_PER_HOUR = 3_600_000;

function isoSchedule(schedule: BatchRowSchedule) {
  return {
    startAt: schedule.startAt.toISOString(),
    endAt: schedule.endAt === null ? null : schedule.endAt.toISOString(),
  };
}

const TEMPLATE_ACCESSIBILITY_ANSWERS = emptyAccessibilityAnswers();

function templateEvent(overrides: Partial<Event> = {}): Event {
  const storedFields: Partial<Event> = {
    slug: 'quiz-night',
    title: 'Quiz Night',
    description: 'Teams of four',
    timezone: LISBON,
    gatheringFamily: GatheringFamily.Meet,
    eventType: 'quiz',
    formatDetails: null,
    neighbourhood: 'Intendente',
    venue: 'Bar A',
    listingId: 'venue-listing-id',
    isOnline: false,
    onlineUrl: 'https://meet.example.com/quiz',
    address: 'Rua dos Anjos 1',
    arrivalNotes: 'Ring the bell',
    capacity: 40,
    language: 'en',
    cost: '5 EUR',
    costKind: 'fixed',
    paymentUrl: 'https://pay.example.com/quiz',
    paymentInstructions: 'Pay at the door',
    accessibilityAnswers: TEMPLATE_ACCESSIBILITY_ANSWERS,
    accessibilityNote: 'Two steps at the bar',
    visibility: EventVisibility.Public,
    communityId: 'community-id',
    themes: ['sapphic'],
    contentNotes: [],
    houseRules: 'Be kind',
    rsvpCutoff: null,
    rsvpQuestions: { dietary: false, pronouns: true, access: false },
    customRsvpQuestion: null,
    allowWaitlist: true,
    showAttendeeCount: true,
    runByListingId: 'run-by-listing-id',
    coverImageUrl: 'events/owner-id/cover.jpg',
  };
  return Object.assign(new Event(), storedFields, overrides);
}

const KEPT_ALL = {
  communitySlug: 'queer-runners',
  listingId: 'venue-listing-id',
  runByListingId: 'run-by-listing-id',
};

function rowOf(overrides: Partial<EventBatchRowDto> = {}): EventBatchRowDto {
  return {
    date: '2026-11-07',
    title: 'Quiz Night, round two',
    description: 'Teams of five this time',
    ...overrides,
  };
}

function sharedOf(
  overrides: Partial<EventBatchSharedDto> = {},
): EventBatchSharedDto {
  return { ...SHARED, ...overrides };
}

const WINTER_SCHEDULE: BatchRowSchedule = {
  startAt: new Date('2026-11-07T21:00:00.000Z'),
  endAt: null,
};

describe('resolveBatchRowSchedule', () => {
  it('reads a winter date at the wall clock time in the template zone', () => {
    const schedule = resolveBatchRowSchedule(
      { date: '2026-11-07' },
      SHARED,
      LISBON,
    );
    expect(schedule.startAt.toISOString()).toBe('2026-11-07T21:00:00.000Z');
    expect(schedule.endAt).toBeNull();
  });

  it('keeps 21:00 on both sides of the October clock change', () => {
    const beforeChange = resolveBatchRowSchedule(
      { date: '2026-10-24' },
      SHARED,
      LISBON,
    );
    const afterChange = resolveBatchRowSchedule(
      { date: '2026-10-31' },
      SHARED,
      LISBON,
    );
    expect(beforeChange.startAt.toISOString()).toBe('2026-10-24T20:00:00.000Z');
    expect(afterChange.startAt.toISOString()).toBe('2026-10-31T21:00:00.000Z');
  });

  it('puts an end earlier than the start on the next day', () => {
    const schedule = resolveBatchRowSchedule(
      { date: '2026-11-07' },
      { startTime: '21:00', endTime: '02:00' },
      LISBON,
    );
    expect(schedule.endAt?.toISOString()).toBe('2026-11-08T02:00:00.000Z');
  });

  it('puts an end equal to the start on the next day', () => {
    const schedule = resolveBatchRowSchedule(
      { date: '2026-11-07' },
      { startTime: '21:00', endTime: '21:00' },
      LISBON,
    );
    expect(schedule.endAt).not.toBeNull();
    expect(
      (schedule.endAt as Date).getTime() - schedule.startAt.getTime(),
    ).toBe(24 * MILLISECONDS_PER_HOUR);
  });

  it('counts elapsed hours across the fall-back night', () => {
    const schedule = resolveBatchRowSchedule(
      { date: '2026-10-24' },
      { startTime: '23:00', endTime: '02:00' },
      LISBON,
    );
    expect(isoSchedule(schedule)).toEqual({
      startAt: '2026-10-24T22:00:00.000Z',
      endAt: '2026-10-25T02:00:00.000Z',
    });
  });

  it('moves a start in the skipped spring hour forward and leaves the end before it', () => {
    const schedule = resolveBatchRowSchedule(
      { date: '2027-03-28' },
      { startTime: '01:30', endTime: '02:00' },
      LISBON,
    );
    expect(isoSchedule(schedule)).toEqual({
      startAt: '2027-03-28T01:30:00.000Z',
      endAt: '2027-03-28T01:00:00.000Z',
    });
  });

  it('takes the first instant of a repeated autumn hour', () => {
    const schedule = resolveBatchRowSchedule(
      { date: '2026-10-25' },
      { startTime: '01:30' },
      LISBON,
    );
    expect(schedule.startAt.toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('uses the row times over the shared times', () => {
    const schedule = resolveBatchRowSchedule(
      { date: '2026-11-07', startTime: '19:00', endTime: '22:00' },
      { startTime: '21:00', endTime: '23:00' },
      LISBON,
    );
    expect(isoSchedule(schedule)).toEqual({
      startAt: '2026-11-07T19:00:00.000Z',
      endAt: '2026-11-07T22:00:00.000Z',
    });
  });

  it('reads a row end of null as an event with an open end even when the shared end is set', () => {
    const schedule = resolveBatchRowSchedule(
      { date: '2026-11-07', endTime: null },
      { startTime: '21:00', endTime: '23:00' },
      LISBON,
    );
    expect(schedule.endAt).toBeNull();
  });

  it('falls back to the shared end when the row leaves its end out', () => {
    const schedule = resolveBatchRowSchedule(
      { date: '2026-11-07' },
      { startTime: '21:00', endTime: '23:00' },
      LISBON,
    );
    expect(schedule.endAt?.toISOString()).toBe('2026-11-07T23:00:00.000Z');
  });

  it('reads a zone with a negative offset', () => {
    const schedule = resolveBatchRowSchedule(
      { date: '2026-11-07' },
      { startTime: '20:00' },
      'America/Sao_Paulo',
    );
    expect(schedule.startAt.toISOString()).toBe('2026-11-07T23:00:00.000Z');
  });
});

describe('lastAllowedBatchDate', () => {
  it('adds twelve calendar months to today in the template zone', () => {
    expect(
      lastAllowedBatchDate(new Date('2026-11-02T10:00:00.000Z'), LISBON),
    ).toBe('2027-11-02');
  });

  it('reads today on the template clock', () => {
    expect(
      lastAllowedBatchDate(
        new Date('2026-11-02T23:30:00.000Z'),
        'Pacific/Auckland',
      ),
    ).toBe('2027-11-03');
  });

  it('clamps the 29th of February to the 28th', () => {
    expect(
      lastAllowedBatchDate(new Date('2028-02-29T12:00:00.000Z'), LISBON),
    ).toBe('2029-02-28');
  });
});

describe('wallClockTimeOf', () => {
  it('reads a summer instant on the Lisbon clock', () => {
    expect(wallClockTimeOf(new Date('2026-10-24T20:00:00.000Z'), LISBON)).toBe(
      '21:00',
    );
  });

  it('pads the hour and the minute', () => {
    expect(wallClockTimeOf(new Date('2026-11-08T02:05:00.000Z'), LISBON)).toBe(
      '02:05',
    );
  });
});

describe('templateCreateInput', () => {
  it('returns exactly the copied fields', () => {
    const result = templateCreateInput(templateEvent(), KEPT_ALL);
    expect(Object.keys(result).sort()).toEqual(
      [...EVENT_BATCH_COPIED_FIELDS].sort(),
    );
  });

  it('folds the accessibility columns into one answers and note pair', () => {
    const result = templateCreateInput(templateEvent(), KEPT_ALL);
    expect(result.accessibility).toEqual({
      answers: TEMPLATE_ACCESSIBILITY_ANSWERS,
      note: 'Two steps at the bar',
    });
  });

  it('carries the kept community, venue and run by ids it is given', () => {
    const result = templateCreateInput(templateEvent(), {
      communitySlug: null,
      listingId: null,
      runByListingId: null,
    });
    expect(result.communitySlug).toBeNull();
    expect(result.listingId).toBeNull();
    expect(result.runByListingId).toBeNull();
  });

  it('maps a null venue, online link, capacity and cover to absent values', () => {
    const result = templateCreateInput(
      templateEvent({
        venue: null,
        onlineUrl: null,
        capacity: null,
        coverImageUrl: null,
      }),
      KEPT_ALL,
    );
    expect(result.venue).toBeUndefined();
    expect(result.onlineUrl).toBeUndefined();
    expect(result.capacity).toBeUndefined();
    expect(result.coverImageUrl).toBeUndefined();
  });
});

describe('composeBatchEventInput', () => {
  const templateFields = templateCreateInput(templateEvent(), KEPT_ALL);

  it('takes title and description from the row', () => {
    const result = composeBatchEventInput(
      templateFields,
      sharedOf(),
      rowOf(),
      WINTER_SCHEDULE,
    );
    expect(result.title).toBe('Quiz Night, round two');
    expect(result.description).toBe('Teams of five this time');
  });

  it('takes the template timezone', () => {
    const result = composeBatchEventInput(
      templateFields,
      sharedOf(),
      rowOf(),
      WINTER_SCHEDULE,
    );
    expect(result.timezone).toBe(LISBON);
  });

  it('writes the schedule as ISO strings', () => {
    const withEnd = composeBatchEventInput(
      templateFields,
      sharedOf(),
      rowOf(),
      {
        startAt: new Date('2026-11-07T21:00:00.000Z'),
        endAt: new Date('2026-11-08T02:00:00.000Z'),
      },
    );
    expect(withEnd.startAt).toBe('2026-11-07T21:00:00.000Z');
    expect(withEnd.endAt).toBe('2026-11-08T02:00:00.000Z');

    const withOpenEnd = composeBatchEventInput(
      templateFields,
      sharedOf(),
      rowOf(),
      WINTER_SCHEDULE,
    );
    expect(withOpenEnd.endAt).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(withOpenEnd, 'endAt')).toBe(
      false,
    );
  });

  it('keeps a template field the shared block leaves out', () => {
    const result = composeBatchEventInput(
      templateFields,
      sharedOf(),
      rowOf(),
      WINTER_SCHEDULE,
    );
    expect(result.venue).toBe('Bar A');
  });

  it('replaces a template field the shared block sends', () => {
    const result = composeBatchEventInput(
      templateFields,
      sharedOf({ venue: 'Bar B' }),
      rowOf(),
      WINTER_SCHEDULE,
    );
    expect(result.venue).toBe('Bar B');
  });

  it('clears a template field the shared block sends as null', () => {
    const clearedAddress = composeBatchEventInput(
      templateFields,
      sharedOf({ address: null }),
      rowOf(),
      WINTER_SCHEDULE,
    );
    expect(clearedAddress.address).toBeNull();

    const clearedVenue = composeBatchEventInput(
      templateFields,
      sharedOf({ venue: null }),
      rowOf(),
      WINTER_SCHEDULE,
    );
    expect(clearedVenue.venue).toBeUndefined();
  });

  it('reads presence by own key so an absent cost keeps the template cost', () => {
    const shared = sharedOf({ venue: 'Bar B' });
    expect(Object.prototype.hasOwnProperty.call(shared, 'cost')).toBe(false);
    const result = composeBatchEventInput(
      templateFields,
      shared,
      rowOf(),
      WINTER_SCHEDULE,
    );
    expect(result.cost).toBe('5 EUR');
    expect(result.costKind).toBe('fixed');
  });

  it('lets the row cover win over the shared and template covers', () => {
    const result = composeBatchEventInput(
      templateFields,
      sharedOf({ coverImageUrl: 'events/owner-id/shared.jpg' }),
      rowOf({ coverImageUrl: 'events/owner-id/row.jpg' }),
      WINTER_SCHEDULE,
    );
    expect(result.coverImageUrl).toBe('events/owner-id/row.jpg');
  });

  it('lets the shared cover win over the template cover', () => {
    const result = composeBatchEventInput(
      templateFields,
      sharedOf({ coverImageUrl: 'events/owner-id/shared.jpg' }),
      rowOf(),
      WINTER_SCHEDULE,
    );
    expect(result.coverImageUrl).toBe('events/owner-id/shared.jpg');
  });

  it('keeps the template cover when the shared block has no cover key', () => {
    const result = composeBatchEventInput(
      templateFields,
      sharedOf(),
      rowOf(),
      WINTER_SCHEDULE,
    );
    expect(result.coverImageUrl).toBe('events/owner-id/cover.jpg');
  });
});

describe('error builders', () => {
  it('answers a missing template with its code', () => {
    const error = eventBatchTemplateNotFound();
    expect(error.getStatus()).toBe(404);
    expect(error.getResponse()).toEqual({
      statusCode: 404,
      code: 'EVENT_BATCH_TEMPLATE_NOT_FOUND',
      message:
        "We couldn't find that event among the events you host or co-host, or it was cancelled.",
    });
  });

  it('names the community a community-only template belongs to', () => {
    const error = eventBatchTemplateCommunityOnly('Queer Runners');
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toEqual({
      statusCode: 409,
      code: 'EVENT_BATCH_TEMPLATE_COMMUNITY_ONLY',
      message:
        'The event you started from is only for members of Queer Runners, and only its moderators can post events there.',
      communityName: 'Queer Runners',
    });
  });

  it('says "its community" when the community row is gone', () => {
    const error = eventBatchTemplateCommunityOnly(null);
    expect(error.getResponse()).toEqual({
      statusCode: 409,
      code: 'EVENT_BATCH_TEMPLATE_COMMUNITY_ONLY',
      message:
        'The event you started from is only for members of its community, and only its moderators can post events there.',
      communityName: null,
    });
  });

  it('carries the date limit on too many dates', () => {
    const error = eventBatchTooManyDates();
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual({
      statusCode: 400,
      code: 'EVENT_BATCH_TOO_MANY_DATES',
      message: 'You can add up to 31 dates at a time.',
      limit: 31,
    });
  });

  it('points a duplicate date at its date field', () => {
    expect(eventBatchDuplicateDate(3, '2026-11-14').getResponse()).toEqual({
      statusCode: 400,
      code: 'EVENT_BATCH_DUPLICATE_DATE',
      message: '2026-11-14 appears twice. Each date holds one event.',
      rowIndex: 3,
      field: 'date',
      date: '2026-11-14',
    });
  });

  it('points a past start at its start time field', () => {
    expect(eventBatchDateInPast(0, '2026-11-01').getResponse()).toEqual({
      statusCode: 400,
      code: 'EVENT_BATCH_DATE_IN_PAST',
      message: 'The start time on 2026-11-01 has already passed.',
      rowIndex: 0,
      field: 'startTime',
      date: '2026-11-01',
    });
  });

  it('names the last allowed date on a date too far', () => {
    expect(
      eventBatchDateTooFar(4, '2027-11-03', '2027-11-02').getResponse(),
    ).toEqual({
      statusCode: 400,
      code: 'EVENT_BATCH_DATE_TOO_FAR',
      message:
        '2027-11-03 is more than 12 months away. The last date you can add is 2027-11-02.',
      rowIndex: 4,
      field: 'date',
      date: '2027-11-03',
      lastDate: '2027-11-02',
    });
  });

  it('points an invalid row at its end time field', () => {
    expect(eventBatchRowInvalid(2, '2027-03-28').getResponse()).toEqual({
      statusCode: 400,
      code: 'EVENT_BATCH_ROW_INVALID',
      message:
        "The times on 2027-03-28 don't work: the end has to come after the start.",
      rowIndex: 2,
      field: 'endTime',
      date: '2027-03-28',
    });
  });

  it('points a venue that left the directory at the listing field', () => {
    expect(eventBatchVenueNotFound().getResponse()).toEqual({
      statusCode: 400,
      code: 'EVENT_BATCH_VENUE_NOT_FOUND',
      message: 'The venue you picked is no longer listed in the directory.',
      field: 'listingId',
    });
  });
});
