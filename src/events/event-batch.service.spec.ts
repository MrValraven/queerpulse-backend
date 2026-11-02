import { HttpException } from '@nestjs/common';
import { emptyAccessibilityAnswers } from '../listings/listing-accessibility';
import type {
  CreateEventBatchDto,
  EventBatchRowDto,
  EventBatchSharedDto,
} from './dto/create-event-batch.dto';
import {
  Event,
  EventStatus,
  EventVisibility,
  GatheringFamily,
} from './entities/event.entity';
import { templateCreateInput } from './event-batch';
import type { ResolvedEventBatchTemplate } from './event-batch-template.service';
import { EventBatchService } from './event-batch.service';
import type {
  CreateEventInput,
  ResolvedNewEventFields,
} from './events.service';
import { seatHostAsGoing } from './host-seat';

jest.mock('./host-seat');

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const COHOST_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '44444444-4444-4444-8444-444444444444';
const RUN_BY_ID = '66666666-6666-4666-8666-666666666666';
const VENUE_LISTING_ID = '77777777-7777-4777-8777-777777777777';
const SHARED_VENUE_LISTING_ID = '99999999-9999-4999-8999-999999999999';
const TEMPLATE_SLUG = 'quiz-night';
const TEMPLATE_COVER = `event-covers/${HOST_ID}/88888888-8888-4888-8888-888888888888.webp`;
const SHARED_COVER = `event-covers/${COHOST_ID}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp`;
const ROW_COVER = `event-covers/${COHOST_ID}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.webp`;

const NOW = new Date('2026-11-02T10:00:00.000Z');
const OCTOBER_NOW = new Date('2026-10-01T10:00:00.000Z');

const RUN_BY_REF = {
  id: RUN_BY_ID,
  ref: 'QPL-2026-0042',
  slug: 'bar-name',
  name: 'Bar Name',
};
const VENUE_WITHOUT_OWNER = {
  id: VENUE_LISTING_ID,
  slug: 'bar-a',
  name: 'Bar A',
  ownerId: null,
};
const VENUE_WITH_OWNER = { ...VENUE_WITHOUT_OWNER, ownerId: 'venue-owner-id' };

function templateEvent(overrides: Partial<Event> = {}): Event {
  const storedFields: Partial<Event> = {
    id: EVENT_ID,
    slug: TEMPLATE_SLUG,
    title: 'Quiz Night',
    description: 'Teams of four, prizes for the top three',
    status: EventStatus.Published,
    visibility: EventVisibility.Public,
    timezone: 'Europe/Lisbon',
    startAt: new Date('2026-10-10T20:00:00.000Z'),
    endAt: null,
    hostId: HOST_ID,
    communityId: null,
    listingId: null,
    runByListingId: null,
    coverImageUrl: TEMPLATE_COVER,
    gatheringFamily: GatheringFamily.Meet,
    eventType: 'quiz',
    formatDetails: null,
    neighbourhood: 'Intendente',
    venue: 'Bar A',
    isOnline: false,
    onlineUrl: null,
    address: 'Rua dos Anjos 1',
    arrivalNotes: 'Ring the bell',
    capacity: 40,
    language: 'en',
    cost: '5 EUR',
    costKind: 'fixed',
    paymentUrl: null,
    paymentInstructions: 'Pay at the door',
    accessibilityAnswers: emptyAccessibilityAnswers(),
    accessibilityNote: 'Two steps at the door',
    themes: ['sapphic'],
    contentNotes: [],
    houseRules: 'Be kind',
    rsvpCutoff: null,
    rsvpQuestions: { dietary: false, pronouns: true, access: false },
    customRsvpQuestion: null,
    allowWaitlist: true,
    showAttendeeCount: true,
  };
  return Object.assign(new Event(), storedFields, overrides);
}

/** A public Lisbon starting event the host made, as the resolver hands it to
 *  a co-host: community, run by and venue all absent unless overridden. */
function resolvedTemplate(
  options: {
    template?: Partial<Event>;
    resolved?: Partial<Omit<ResolvedEventBatchTemplate, 'template'>>;
  } = {},
): ResolvedEventBatchTemplate {
  const template = templateEvent(options.template);
  const kept = {
    community: null,
    runByListing: null,
    venueListing: null,
    ...options.resolved,
  };
  return {
    template,
    templateFields: templateCreateInput(template, {
      communitySlug: kept.community?.slug ?? null,
      listingId: kept.venueListing?.id ?? null,
      runByListingId: kept.runByListing?.id ?? null,
    }),
    communityDropped: null,
    runByDropped: null,
    venueListingDropped: false,
    ...kept,
  };
}

function batchRow(
  date: string,
  overrides: Partial<EventBatchRowDto> = {},
): EventBatchRowDto {
  return {
    date,
    title: 'Quiz Night',
    description: 'Teams of four, prizes for the top three',
    ...overrides,
  };
}

function batchBody(
  rows: EventBatchRowDto[],
  shared: Partial<EventBatchSharedDto> = { startTime: '21:00' },
): CreateEventBatchDto {
  return {
    templateSlug: TEMPLATE_SLUG,
    shared: { startTime: '21:00', ...shared },
    rows,
  };
}

/** The 31 dates from 3 November to 3 December 2026, all valid on `NOW`. */
function thirtyOneRows(): EventBatchRowDto[] {
  return Array.from({ length: 31 }, (_unused, dayIndex) => {
    const date = new Date(Date.UTC(2026, 10, 3 + dayIndex));
    return batchRow(date.toISOString().slice(0, 10));
  });
}

function rowErrorOf(failure: unknown): Record<string, unknown> {
  return (failure as HttpException).getResponse() as Record<string, unknown>;
}

/** The entry at `index`, or a failure that names the missing `label`, so an
 *  assertion on a call that never happened says which call it expected. */
function entryAt<Entry>(
  entries: readonly Entry[],
  index: number,
  label: string,
): Entry {
  const entry = entries[index];
  if (entry === undefined) {
    throw new Error(
      `Expected ${label} at index ${index}, found ${entries.length} entries`,
    );
  }
  return entry;
}

async function failureOf(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('EventBatchService', () => {
  const transactionManager = { marker: 'transaction' };
  const seatHostAsGoingMock = jest.mocked(seatHostAsGoing);
  let dataSource: { transaction: jest.Mock };
  let eventsService: {
    buildNewEventEntity: jest.Mock;
    saveWithUniqueSlug: jest.Mock;
    notifyVenueOwnerBestEffort: jest.Mock;
    notifyDescriptionMentions: jest.Mock;
  };
  let templates: { resolveForCaller: jest.Mock };
  let listingLookup: { findAttachable: jest.Mock };
  let service: EventBatchService;
  let saveCounter: number;

  function builtInputs(): CreateEventInput[] {
    return (eventsService.buildNewEventEntity.mock.calls as unknown[][]).map(
      (call) => call[1] as CreateEventInput,
    );
  }

  function builtResolvedFields(): ResolvedNewEventFields[] {
    return (eventsService.buildNewEventEntity.mock.calls as unknown[][]).map(
      (call) => call[2] as ResolvedNewEventFields,
    );
  }

  function useTemplate(
    options: Parameters<typeof resolvedTemplate>[0],
  ): ResolvedEventBatchTemplate {
    const resolved = resolvedTemplate(options);
    templates.resolveForCaller.mockResolvedValue(resolved);
    return resolved;
  }

  beforeEach(() => {
    saveCounter = 0;
    seatHostAsGoingMock.mockReset();
    seatHostAsGoingMock.mockResolvedValue(undefined);
    dataSource = {
      transaction: jest.fn(
        async (runInTransaction: (manager: unknown) => Promise<unknown>) =>
          runInTransaction(transactionManager),
      ),
    };
    eventsService = {
      buildNewEventEntity: jest.fn(
        (
          hostId: string,
          input: CreateEventInput,
          resolved: ResolvedNewEventFields,
        ) => ({
          hostId,
          title: input.title,
          description: input.description,
          coverImageUrl: input.coverImageUrl ?? null,
          ...resolved,
        }),
      ),
      saveWithUniqueSlug: jest.fn(
        async (entity: Record<string, unknown>, title: string) => {
          saveCounter += 1;
          return {
            ...entity,
            id: `event-${saveCounter}`,
            slug: `${title.toLowerCase().replace(/ /g, '-')}-${saveCounter}`,
          };
        },
      ),
      notifyVenueOwnerBestEffort: jest.fn().mockResolvedValue(undefined),
      notifyDescriptionMentions: jest.fn().mockResolvedValue(new Set()),
    };
    templates = {
      resolveForCaller: jest.fn().mockResolvedValue(resolvedTemplate()),
    };
    listingLookup = { findAttachable: jest.fn().mockResolvedValue(null) };
    service = new EventBatchService(
      dataSource as never,
      eventsService as never,
      templates as never,
      listingLookup as never,
    );
  });

  it('answers EVENT_BATCH_TOO_MANY_DATES for 32 rows before it reads the template', async () => {
    const rows = [...thirtyOneRows(), batchRow('2026-12-04')];

    const failure = await failureOf(
      service.createBatch(COHOST_ID, batchBody(rows), NOW),
    );

    expect(rowErrorOf(failure)).toEqual(
      expect.objectContaining({
        statusCode: 400,
        code: 'EVENT_BATCH_TOO_MANY_DATES',
        limit: 31,
      }),
    );
    expect(templates.resolveForCaller).not.toHaveBeenCalled();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('reads the template once for the whole batch', async () => {
    await service.createBatch(
      COHOST_ID,
      batchBody([
        batchRow('2026-11-07'),
        batchRow('2026-11-14'),
        batchRow('2026-11-21'),
      ]),
      NOW,
    );

    expect(templates.resolveForCaller).toHaveBeenCalledTimes(1);
    expect(templates.resolveForCaller).toHaveBeenCalledWith(
      'quiz-night',
      COHOST_ID,
    );
  });

  it('writes every event inside one transaction, in date order', async () => {
    const result = await service.createBatch(
      COHOST_ID,
      batchBody([
        batchRow('2026-11-21'),
        batchRow('2026-11-07'),
        batchRow('2026-11-14'),
      ]),
      NOW,
    );

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    const managersUsed = (
      eventsService.saveWithUniqueSlug.mock.calls as unknown[][]
    ).map((call) => call[2]);
    expect(managersUsed).toEqual([
      transactionManager,
      transactionManager,
      transactionManager,
    ]);
    expect(result.events.map((event) => event.startAt)).toEqual([
      '2026-11-07T21:00:00.000Z',
      '2026-11-14T21:00:00.000Z',
      '2026-11-21T21:00:00.000Z',
    ]);
    for (const event of result.events) {
      expect(Object.keys(event).sort()).toEqual(['slug', 'startAt', 'title']);
      expect(typeof event.startAt).toBe('string');
    }
  });

  it('seats the caller as going on every event through the transaction', async () => {
    await service.createBatch(
      COHOST_ID,
      batchBody([
        batchRow('2026-11-07'),
        batchRow('2026-11-14'),
        batchRow('2026-11-21'),
      ]),
      NOW,
    );

    expect(seatHostAsGoingMock.mock.calls).toEqual([
      [transactionManager, 'event-1', COHOST_ID],
      [transactionManager, 'event-2', COHOST_ID],
      [transactionManager, 'event-3', COHOST_ID],
    ]);
  });

  it('hosts every event as the caller when the caller co-hosts the template', async () => {
    await service.createBatch(
      COHOST_ID,
      batchBody([batchRow('2026-11-07'), batchRow('2026-11-14')]),
      NOW,
    );

    const hostIds = (
      eventsService.buildNewEventEntity.mock.calls as unknown[][]
    ).map((call) => call[0]);
    expect(hostIds).toEqual([COHOST_ID, COHOST_ID]);
  });

  it('publishes every event outside any series', async () => {
    useTemplate({ template: { visibility: EventVisibility.Members } });

    await service.createBatch(
      COHOST_ID,
      batchBody([batchRow('2026-11-07'), batchRow('2026-11-14')]),
      NOW,
    );

    for (const resolved of builtResolvedFields()) {
      expect(resolved).toEqual(
        expect.objectContaining({
          status: EventStatus.Published,
          seriesId: null,
          seriesIndex: null,
          visibility: EventVisibility.Members,
        }),
      );
    }
  });

  it('layers template, shared block and row', async () => {
    useTemplate({ template: { venue: 'Bar A', cost: '5 EUR' } });

    await service.createBatch(
      COHOST_ID,
      batchBody(
        [
          batchRow('2026-11-07', {
            title: 'Quiz Night: Film',
            description: 'Movie round tonight',
          }),
        ],
        { venue: 'Bar B', address: null },
      ),
      NOW,
    );

    expect(entryAt(builtInputs(), 0, 'the first built input')).toEqual(
      expect.objectContaining({
        venue: 'Bar B',
        address: null,
        cost: '5 EUR',
        title: 'Quiz Night: Film',
        description: 'Movie round tonight',
      }),
    );
  });

  it('copies the template cover the host uploaded when a co-host starts the month', async () => {
    await service.createBatch(
      COHOST_ID,
      batchBody([batchRow('2026-11-07'), batchRow('2026-11-14')]),
      NOW,
    );

    expect(builtInputs().map((input) => input.coverImageUrl)).toEqual([
      TEMPLATE_COVER,
      TEMPLATE_COVER,
    ]);
  });

  it('uses a row cover over the shared cover', async () => {
    await service.createBatch(
      COHOST_ID,
      batchBody(
        [
          batchRow('2026-11-07', { coverImageUrl: ROW_COVER }),
          batchRow('2026-11-14'),
        ],
        { coverImageUrl: SHARED_COVER },
      ),
      NOW,
    );

    expect(builtInputs().map((input) => input.coverImageUrl)).toEqual([
      ROW_COVER,
      SHARED_COVER,
    ]);
  });

  it('leaves run by off every event when the template resolver dropped it', async () => {
    useTemplate({
      template: { runByListingId: RUN_BY_ID },
      resolved: {
        runByListing: null,
        runByDropped: { name: 'Bar Name', reason: 'notManager' },
      },
    });

    await service.createBatch(
      COHOST_ID,
      batchBody([batchRow('2026-11-07'), batchRow('2026-11-14')]),
      NOW,
    );

    expect(
      builtResolvedFields().map((resolved) => resolved.runByListingId),
    ).toEqual([null, null]);
  });

  it('keeps run by on every event when the resolver kept it', async () => {
    useTemplate({
      template: { runByListingId: RUN_BY_ID },
      resolved: { runByListing: RUN_BY_REF },
    });

    await service.createBatch(
      COHOST_ID,
      batchBody([batchRow('2026-11-07'), batchRow('2026-11-14')]),
      NOW,
    );

    expect(
      builtResolvedFields().map((resolved) => resolved.runByListingId),
    ).toEqual([RUN_BY_ID, RUN_BY_ID]);
  });

  describe('a starting event saved before cost kinds existed', () => {
    it.each([
      ['5 EUR', 'fixed'],
      ['Free', 'free'],
      ['  ', 'free'],
      [null, 'free'],
    ])(
      'reads the cost text %p as %p, the kind a seeded wizard would carry',
      async (legacyCost, expectedCostKind) => {
        useTemplate({ template: { costKind: null, cost: legacyCost } });

        await service.createBatch(
          COHOST_ID,
          batchBody([batchRow('2026-11-07'), batchRow('2026-11-14')]),
          NOW,
        );

        expect(builtInputs().map((input) => input.costKind)).toEqual([
          expectedCostKind,
          expectedCostKind,
        ]);
        expect(entryAt(builtInputs(), 0, 'the first built input').cost).toBe(
          legacyCost,
        );
      },
    );

    it('keeps a cost kind the starting event already carries', async () => {
      useTemplate({
        template: { costKind: 'pay-what-you-can', cost: '5 EUR' },
      });

      await service.createBatch(
        COHOST_ID,
        batchBody([batchRow('2026-11-07')]),
        NOW,
      );

      expect(entryAt(builtInputs(), 0, 'the first built input').costKind).toBe(
        'pay-what-you-can',
      );
    });
  });

  it('leaves the starting event values every row shares as they were', async () => {
    const resolved = useTemplate({
      template: {
        themes: ['sapphic', 'trans-led'],
        formatDetails: { bring: 'A pen' },
      },
    });
    const { templateFields } = resolved;
    const sharedValues = [
      templateFields.themes,
      templateFields.contentNotes,
      templateFields.rsvpQuestions,
      templateFields.formatDetails,
      templateFields.accessibility,
      templateFields.accessibility?.answers,
    ];
    const before = JSON.stringify(templateFields);
    // Frozen, so a write through any of them fails the batch in strict mode.
    for (const value of sharedValues) if (value) Object.freeze(value);

    await service.createBatch(
      COHOST_ID,
      batchBody([
        batchRow('2026-11-07'),
        batchRow('2026-11-14'),
        batchRow('2026-11-21'),
      ]),
      NOW,
    );

    expect(JSON.stringify(templateFields)).toBe(before);
    expect(eventsService.buildNewEventEntity).toHaveBeenCalledTimes(3);
  });

  describe('times', () => {
    it('keeps 21:00 local across the October clock change', async () => {
      await service.createBatch(
        COHOST_ID,
        batchBody([batchRow('2026-10-24'), batchRow('2026-10-31')]),
        OCTOBER_NOW,
      );

      expect(
        builtResolvedFields().map((resolved) => resolved.startAt.toISOString()),
      ).toEqual(['2026-10-24T20:00:00.000Z', '2026-10-31T21:00:00.000Z']);
    });

    it('ends a 23:00 to 02:00 night on the next day', async () => {
      await service.createBatch(
        COHOST_ID,
        batchBody([
          batchRow('2026-10-24', { startTime: '23:00', endTime: '02:00' }),
        ]),
        OCTOBER_NOW,
      );

      const resolved = entryAt(builtResolvedFields(), 0, 'the resolved fields');
      expect(resolved.startAt.toISOString()).toBe('2026-10-24T22:00:00.000Z');
      expect(resolved.endAt?.toISOString()).toBe('2026-10-25T02:00:00.000Z');
    });
  });

  describe('row errors', () => {
    it('answers EVENT_BATCH_DUPLICATE_DATE on the second row holding a date', async () => {
      const failure = await failureOf(
        service.createBatch(
          COHOST_ID,
          batchBody([
            batchRow('2026-11-07'),
            batchRow('2026-11-14'),
            batchRow('2026-11-07'),
          ]),
          NOW,
        ),
      );

      expect(rowErrorOf(failure)).toEqual(
        expect.objectContaining({
          code: 'EVENT_BATCH_DUPLICATE_DATE',
          rowIndex: 2,
          field: 'date',
          date: '2026-11-07',
        }),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('answers EVENT_BATCH_DATE_IN_PAST for a start earlier today', async () => {
      const failure = await failureOf(
        service.createBatch(
          COHOST_ID,
          batchBody([batchRow('2026-11-02', { startTime: '09:00' })]),
          NOW,
        ),
      );

      expect(rowErrorOf(failure)).toEqual(
        expect.objectContaining({
          code: 'EVENT_BATCH_DATE_IN_PAST',
          rowIndex: 0,
          field: 'startTime',
          date: '2026-11-02',
        }),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('lets a start later today through', async () => {
      await service.createBatch(
        COHOST_ID,
        batchBody([batchRow('2026-11-02', { startTime: '11:00' })]),
        NOW,
      );

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('answers EVENT_BATCH_DATE_TOO_FAR past the twelve-month window', async () => {
      const failure = await failureOf(
        service.createBatch(
          COHOST_ID,
          batchBody([batchRow('2027-11-03')]),
          NOW,
        ),
      );

      expect(rowErrorOf(failure)).toEqual(
        expect.objectContaining({
          code: 'EVENT_BATCH_DATE_TOO_FAR',
          rowIndex: 0,
          field: 'date',
          date: '2027-11-03',
          lastDate: '2027-11-02',
        }),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('lets the last date of the window through', async () => {
      await service.createBatch(
        COHOST_ID,
        batchBody([batchRow('2027-11-02')]),
        NOW,
      );

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('answers EVENT_BATCH_ROW_INVALID when the skipped spring hour folds the end before the start', async () => {
      const failure = await failureOf(
        service.createBatch(
          COHOST_ID,
          batchBody([
            batchRow('2027-03-28', { startTime: '01:30', endTime: '02:00' }),
          ]),
          NOW,
        ),
      );

      expect(rowErrorOf(failure)).toEqual(
        expect.objectContaining({
          code: 'EVENT_BATCH_ROW_INVALID',
          rowIndex: 0,
          field: 'endTime',
          date: '2027-03-28',
        }),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('answers the first failing row in request order', async () => {
      const failure = await failureOf(
        service.createBatch(
          COHOST_ID,
          batchBody([
            batchRow('2026-11-07'),
            batchRow('2026-11-01'),
            batchRow('2026-11-14'),
            batchRow('2026-11-07'),
          ]),
          NOW,
        ),
      );

      expect(rowErrorOf(failure)).toEqual(
        expect.objectContaining({
          code: 'EVENT_BATCH_DATE_IN_PAST',
          rowIndex: 1,
        }),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  describe('venue', () => {
    it('answers EVENT_BATCH_VENUE_NOT_FOUND for a shared venue the directory refuses', async () => {
      listingLookup.findAttachable.mockResolvedValue(null);

      const failure = await failureOf(
        service.createBatch(
          COHOST_ID,
          batchBody([batchRow('2026-11-07')], {
            listingId: SHARED_VENUE_LISTING_ID,
          }),
          NOW,
        ),
      );

      expect(rowErrorOf(failure)).toEqual(
        expect.objectContaining({
          code: 'EVENT_BATCH_VENUE_NOT_FOUND',
          field: 'listingId',
        }),
      );
      expect(listingLookup.findAttachable).toHaveBeenCalledWith(
        SHARED_VENUE_LISTING_ID,
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('links a shared venue the directory accepts', async () => {
      listingLookup.findAttachable.mockResolvedValue({
        ...VENUE_WITHOUT_OWNER,
        id: SHARED_VENUE_LISTING_ID,
      });

      await service.createBatch(
        COHOST_ID,
        batchBody([batchRow('2026-11-07')], {
          listingId: SHARED_VENUE_LISTING_ID,
        }),
        NOW,
      );

      expect(
        entryAt(builtResolvedFields(), 0, 'the first resolved fields')
          .listingId,
      ).toBe(SHARED_VENUE_LISTING_ID);
    });

    it('detaches the venue when the shared block sends null', async () => {
      useTemplate({
        template: { listingId: VENUE_LISTING_ID },
        resolved: { venueListing: VENUE_WITH_OWNER },
      });

      await service.createBatch(
        COHOST_ID,
        batchBody([batchRow('2026-11-07')], { listingId: null }),
        NOW,
      );

      expect(
        entryAt(builtResolvedFields(), 0, 'the first resolved fields')
          .listingId,
      ).toBeNull();
      expect(listingLookup.findAttachable).not.toHaveBeenCalled();
    });

    it('keeps the venue the resolver kept when the shared block leaves it out', async () => {
      useTemplate({
        template: { listingId: VENUE_LISTING_ID },
        resolved: { venueListing: VENUE_WITHOUT_OWNER },
      });

      await service.createBatch(
        COHOST_ID,
        batchBody([batchRow('2026-11-07')]),
        NOW,
      );

      expect(
        entryAt(builtResolvedFields(), 0, 'the first resolved fields')
          .listingId,
      ).toBe(VENUE_LISTING_ID);
    });
  });

  describe('after commit', () => {
    it('asks the venue owner once, about the first date, and stamps every event', async () => {
      useTemplate({
        template: { listingId: VENUE_LISTING_ID },
        resolved: { venueListing: VENUE_WITH_OWNER },
      });

      await service.createBatch(
        COHOST_ID,
        batchBody([
          batchRow('2026-11-21'),
          batchRow('2026-11-07'),
          batchRow('2026-11-14'),
        ]),
        NOW,
      );

      for (const resolved of builtResolvedFields()) {
        expect(resolved.venueOwnerNotifiedAt).toBeInstanceOf(Date);
      }
      expect(eventsService.notifyVenueOwnerBestEffort).toHaveBeenCalledTimes(1);
      const [askedAbout, listing] = entryAt(
        eventsService.notifyVenueOwnerBestEffort.mock.calls as [
          Event,
          unknown,
        ][],
        0,
        'the venue owner ask',
      );
      expect(askedAbout.startAt.toISOString()).toBe('2026-11-07T21:00:00.000Z');
      expect(askedAbout.id).toBe('event-1');
      expect(listing).toBe(VENUE_WITH_OWNER);
    });

    it.each([
      ['a venue without an owner', EventVisibility.Public, VENUE_WITHOUT_OWNER],
      ['a network-only template', EventVisibility.Network, VENUE_WITH_OWNER],
    ])('asks nobody for %s', async (_case, visibility, venueListing) => {
      useTemplate({
        template: { listingId: VENUE_LISTING_ID, visibility },
        resolved: { venueListing },
      });

      await service.createBatch(
        COHOST_ID,
        batchBody([batchRow('2026-11-07'), batchRow('2026-11-14')]),
        NOW,
      );

      expect(eventsService.notifyVenueOwnerBestEffort).not.toHaveBeenCalled();
      expect(
        builtResolvedFields().map((resolved) => resolved.venueOwnerNotifiedAt),
      ).toEqual([null, null]);
    });

    it('tells a member tagged on three dates once, on the first', async () => {
      eventsService.notifyDescriptionMentions
        .mockResolvedValueOnce(new Set(['ana-id']))
        .mockResolvedValue(new Set());

      await service.createBatch(
        COHOST_ID,
        batchBody([
          batchRow('2026-11-21', { description: 'Third round with @ana' }),
          batchRow('2026-11-07', { description: 'First round with @ana' }),
          batchRow('2026-11-14', { description: 'Second round with @ana' }),
        ]),
        NOW,
      );

      const calls = eventsService.notifyDescriptionMentions.mock.calls as [
        Event,
        string,
        string,
        readonly string[],
      ][];
      expect(calls).toHaveLength(3);
      expect(calls.map(([savedEvent]) => savedEvent.description)).toEqual([
        'First round with @ana',
        'Second round with @ana',
        'Third round with @ana',
      ]);
      for (const [savedEvent, mentionText, authorId] of calls) {
        expect(mentionText).toBe(savedEvent.description);
        expect(authorId).toBe(COHOST_ID);
      }
      expect(entryAt(calls, 0, 'mention call')[3]).not.toContain('ana-id');
      expect(entryAt(calls, 1, 'mention call')[3]).toContain('ana-id');
      expect(entryAt(calls, 2, 'mention call')[3]).toContain('ana-id');
    });

    it('never calls notifyDescriptionMentions for a description with no mention', async () => {
      await service.createBatch(
        COHOST_ID,
        batchBody([
          batchRow('2026-11-07', { description: 'Email me@host.com to join' }),
          batchRow('2026-11-14', { description: 'Doors open at nine' }),
        ]),
        NOW,
      );

      expect(eventsService.notifyDescriptionMentions).not.toHaveBeenCalled();
    });

    it('notifies only after the transaction has returned', async () => {
      useTemplate({
        template: { listingId: VENUE_LISTING_ID },
        resolved: { venueListing: VENUE_WITH_OWNER },
      });
      // Flips once the mocked transaction's work has resolved, the moment a
      // real transaction commits; each sender records what it saw.
      let isCommitted = false;
      const commitStateSeenByNotifiers: boolean[] = [];
      dataSource.transaction.mockImplementation(
        async (runInTransaction: (manager: unknown) => Promise<unknown>) => {
          const result = await runInTransaction(transactionManager);
          isCommitted = true;
          return result;
        },
      );
      eventsService.notifyVenueOwnerBestEffort.mockImplementation(async () => {
        commitStateSeenByNotifiers.push(isCommitted);
      });
      eventsService.notifyDescriptionMentions.mockImplementation(async () => {
        commitStateSeenByNotifiers.push(isCommitted);
        return new Set<string>();
      });

      await service.createBatch(
        COHOST_ID,
        batchBody([
          batchRow('2026-11-07', { description: 'First round with @ana' }),
          batchRow('2026-11-14', { description: 'Second round with @ana' }),
        ]),
        NOW,
      );

      // One venue ask and one mention fan-out per date, all after the commit.
      expect(commitStateSeenByNotifiers).toEqual([true, true, true]);
      const firstMentionCall = entryAt(
        eventsService.notifyDescriptionMentions.mock.invocationCallOrder,
        0,
        'the first mention call',
      );
      const venueAskCall = entryAt(
        eventsService.notifyVenueOwnerBestEffort.mock.invocationCallOrder,
        0,
        'the venue owner ask',
      );
      expect(firstMentionCall).toBeGreaterThan(
        entryAt(
          dataSource.transaction.mock.invocationCallOrder,
          0,
          'the transaction call',
        ),
      );
      for (const saveCall of eventsService.saveWithUniqueSlug.mock
        .invocationCallOrder) {
        expect(firstMentionCall).toBeGreaterThan(saveCall);
        expect(venueAskCall).toBeGreaterThan(saveCall);
      }
      for (const seatCall of seatHostAsGoingMock.mock.invocationCallOrder) {
        expect(firstMentionCall).toBeGreaterThan(seatCall);
        expect(venueAskCall).toBeGreaterThan(seatCall);
      }
    });
  });

  describe('all or nothing', () => {
    beforeEach(() => {
      useTemplate({
        template: { listingId: VENUE_LISTING_ID },
        resolved: { venueListing: VENUE_WITH_OWNER },
      });
    });

    function expectNothingOutsideTheTransaction(): void {
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      for (const call of eventsService.saveWithUniqueSlug.mock
        .calls as unknown[][]) {
        expect(call[2]).toBe(transactionManager);
      }
      for (const [manager] of seatHostAsGoingMock.mock.calls) {
        expect(manager).toBe(transactionManager);
      }
      expect(eventsService.notifyVenueOwnerBestEffort).not.toHaveBeenCalled();
      expect(eventsService.notifyDescriptionMentions).not.toHaveBeenCalled();
    }

    it('fails the whole month when row 20 cannot be saved, and tells nobody', async () => {
      const slugRaceLost = new Error('Could not allocate a unique event slug');
      const saveOnce = eventsService.saveWithUniqueSlug.getMockImplementation();
      eventsService.saveWithUniqueSlug.mockImplementation(
        async (entity: Record<string, unknown>, title: string) => {
          if (eventsService.saveWithUniqueSlug.mock.calls.length === 20) {
            throw slugRaceLost;
          }
          return saveOnce?.(entity, title) as unknown;
        },
      );

      const failure = await failureOf(
        service.createBatch(COHOST_ID, batchBody(thirtyOneRows()), NOW),
      );

      expect(failure).toBe(slugRaceLost);
      expect(eventsService.saveWithUniqueSlug).toHaveBeenCalledTimes(20);
      expect(seatHostAsGoingMock).toHaveBeenCalledTimes(19);
      expectNothingOutsideTheTransaction();
    });

    it('fails the whole month when a host seat cannot be written', async () => {
      const seatFailed = new Error('insert into event_rsvps failed');
      seatHostAsGoingMock.mockImplementation(async () => {
        if (seatHostAsGoingMock.mock.calls.length === 20) throw seatFailed;
      });

      const failure = await failureOf(
        service.createBatch(COHOST_ID, batchBody(thirtyOneRows()), NOW),
      );

      expect(failure).toBe(seatFailed);
      expect(seatHostAsGoingMock).toHaveBeenCalledTimes(20);
      expect(eventsService.saveWithUniqueSlug).toHaveBeenCalledTimes(20);
      expectNothingOutsideTheTransaction();
    });
  });
});
