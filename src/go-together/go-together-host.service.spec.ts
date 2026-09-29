import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { Event, EventStatus } from '../events/entities/event.entity';
import { EventsService } from '../events/events.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { HostConfigDto } from './dto/host-config.dto';
import { EventMatchConfig } from './entities/event-match-config.entity';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import { EventMatchGroup } from './entities/event-match-group.entity';
import {
  GoTogetherHostService,
  HOST_SWITCHED_OFF_REASON,
} from './go-together-host.service';
import { GoTogetherHouseService } from './go-together-house.service';

/** One UPDATE built through `createQueryBuilder()`, recorded for asserts. */
interface UpdateQueryMock {
  update: jest.Mock;
  set: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  returning: jest.Mock;
  execute: jest.Mock;
}

function updateQueryMock(returnedRows: () => unknown[]): UpdateQueryMock {
  const query = {} as UpdateQueryMock;
  for (const step of [
    'update',
    'set',
    'where',
    'andWhere',
    'returning',
  ] as const) {
    query[step] = jest.fn(() => query);
  }
  query.execute = jest.fn(() =>
    Promise.resolve({
      raw: query.returning.mock.calls.length > 0 ? returnedRows() : [],
    }),
  );
  return query;
}

async function expectRejection(
  pending: Promise<unknown>,
  expectedClass: new (...args: never[]) => HttpException,
  body: Record<string, unknown>,
): Promise<void> {
  const caught: unknown = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(expectedClass);
  expect((caught as HttpException).getResponse()).toMatchObject(body);
}

describe('GoTogetherHostService', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const startAt = new Date('2026-10-10T20:00:00Z');
  const event = {
    id: 'event-1',
    slug: 'picnic',
    hostId: 'host-1',
    status: EventStatus.Published,
    startAt,
  } as Event;
  const baseDto: HostConfigDto = {
    enabled: true,
    hostQuestions: [],
  };

  let service: GoTogetherHostService;
  let events: { findOne: jest.Mock };
  let configs: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let configInsert: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    orIgnore: jest.Mock;
    execute: jest.Mock;
  };
  let entries: { count: jest.Mock; createQueryBuilder: jest.Mock };
  let groups: { count: jest.Mock };
  let eventsService: { isOrganizer: jest.Mock };
  let house: { houseUserId: jest.Mock };
  let notifications: { createForRecipients: jest.Mock };
  let builtQueries: UpdateQueryMock[];
  let closedRows: { user_id: string }[];

  beforeEach(async () => {
    events = { findOne: jest.fn().mockResolvedValue(event) };
    configInsert = {
      insert: jest.fn(),
      into: jest.fn(),
      values: jest.fn(),
      orIgnore: jest.fn(),
      execute: jest.fn().mockResolvedValue({ raw: [] }),
    };
    for (const step of ['insert', 'into', 'values', 'orIgnore'] as const) {
      configInsert[step].mockReturnValue(configInsert);
    }
    configs = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row: Partial<EventMatchConfig>) => ({ ...row })),
      save: jest.fn((row: EventMatchConfig) => Promise.resolve(row)),
      createQueryBuilder: jest.fn(() => configInsert),
    };
    builtQueries = [];
    closedRows = [];
    entries = {
      count: jest.fn(),
      createQueryBuilder: jest.fn(() => {
        const query = updateQueryMock(() => closedRows);
        builtQueries.push(query);
        return query;
      }),
    };
    groups = { count: jest.fn() };
    eventsService = { isOrganizer: jest.fn().mockResolvedValue(true) };
    house = { houseUserId: jest.fn().mockResolvedValue('house-account') };
    notifications = { createForRecipients: jest.fn().mockResolvedValue([]) };
    const manager = {
      getRepository: (entity: unknown) =>
        entity === EventMatchConfig ? configs : entries,
    };
    const dataSource = {
      transaction: jest.fn((work: (inner: typeof manager) => unknown) =>
        work(manager),
      ),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        GoTogetherHostService,
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(EventMatchConfig), useValue: configs },
        { provide: getRepositoryToken(EventMatchEntry), useValue: entries },
        { provide: getRepositoryToken(EventMatchGroup), useValue: groups },
        { provide: EventsService, useValue: eventsService },
        { provide: GoTogetherHouseService, useValue: house },
        { provide: DataSource, useValue: dataSource },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = moduleRef.get(GoTogetherHostService);
  });

  it('answers a member who is not the host or a co-host as if the gathering did not exist', async () => {
    eventsService.isOrganizer.mockResolvedValue(false);
    await expect(service.getConfig('picnic', 'member-1')).rejects.toThrow(
      NotFoundException,
    );
    await expect(
      service.putConfig('picnic', 'member-1', baseDto, now),
    ).rejects.toThrow(NotFoundException);
    await expect(service.summary('picnic', 'member-1')).rejects.toThrow(
      NotFoundException,
    );
    expect(eventsService.isOrganizer).toHaveBeenCalledWith(
      'event-1',
      'member-1',
    );
    expect(configs.save).not.toHaveBeenCalled();
  });

  it('rejects a matching time outside six hours to seven days before the start', async () => {
    await expectRejection(
      service.putConfig(
        'picnic',
        'host-1',
        { ...baseDto, cutoffAt: '2026-10-10T15:00:00.000Z' },
        now,
      ),
      BadRequestException,
      { code: 'GO_TOGETHER_BAD_CUTOFF' },
    );
    await expectRejection(
      service.putConfig(
        'picnic',
        'host-1',
        { ...baseDto, cutoffAt: '2026-10-03T19:00:00.000Z' },
        now,
      ),
      BadRequestException,
      { code: 'GO_TOGETHER_BAD_CUTOFF' },
    );
    expect(configs.save).not.toHaveBeenCalled();
  });

  it('locks the settings once matching has run', async () => {
    configs.findOne.mockResolvedValue({
      eventId: 'event-1',
      enabled: true,
      cutoffAt: new Date('2026-10-08T20:00:00Z'),
      hostQuestions: [],
      meetingPointNote: null,
      matchedAt: new Date('2026-10-08T20:01:00Z'),
    });
    await expectRejection(
      service.putConfig(
        'picnic',
        'host-1',
        { ...baseDto, enabled: false },
        now,
      ),
      ConflictException,
      { code: 'GO_TOGETHER_LOCKED' },
    );
    expect(configs.save).not.toHaveBeenCalled();
  });

  it('stores host questions with server ids and trims an empty meeting point to null', async () => {
    const response = await service.putConfig(
      'picnic',
      'host-1',
      {
        enabled: true,
        cutoffAt: '2026-10-09T20:00:00.000Z',
        hostQuestions: [
          { prompt: ' Coffee or tea? ', options: ['Coffee', ' Tea '] },
        ],
        meetingPointNote: '   ',
      },
      now,
    );
    expect(configs.save).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: 'event-1',
        enabled: true,
        cutoffAt: new Date('2026-10-09T20:00:00.000Z'),
        hostQuestions: [
          {
            id: 'q1',
            prompt: 'Coffee or tea?',
            options: [
              { id: 'o1', label: 'Coffee' },
              { id: 'o2', label: 'Tea' },
            ],
          },
        ],
        meetingPointNote: null,
        matchedAt: null,
      }),
    );
    expect(response).toEqual({
      enabled: true,
      cutoffAt: '2026-10-09T20:00:00.000Z',
      earliestCutoffAt: '2026-10-03T20:00:00.000Z',
      latestCutoffAt: '2026-10-10T14:00:00.000Z',
      hostQuestions: [
        {
          id: 'q1',
          prompt: 'Coffee or tea?',
          options: [
            { id: 'o1', label: 'Coffee' },
            { id: 'o2', label: 'Tea' },
          ],
        },
      ],
      meetingPointNote: null,
      isLocked: false,
    });
  });

  it('defaults the matching time to 48 hours before the start', async () => {
    await service.putConfig('picnic', 'host-1', baseDto, now);
    expect(configs.save).toHaveBeenCalledWith(
      expect.objectContaining({
        cutoffAt: new Date('2026-10-08T20:00:00.000Z'),
      }),
    );
  });

  it('gives an official event with no row a virtual enabled config without saving it', async () => {
    const officialEvent = { ...event, hostId: 'house-account' } as Event;
    const config = await service.effectiveConfig(officialEvent, now);
    expect(config).toEqual(
      expect.objectContaining({
        eventId: 'event-1',
        enabled: true,
        cutoffAt: new Date('2026-10-08T20:00:00.000Z'),
        hostQuestions: [],
        matchedAt: null,
      }),
    );
    expect(configs.save).not.toHaveBeenCalled();

    expect(await service.effectiveConfig(event, now)).toBeNull();
    expect(configs.save).not.toHaveBeenCalled();
  });

  it('never gives an official event a past matching time', async () => {
    const officialEvent = { ...event, hostId: 'house-account' } as Event;
    const thirtyHoursBefore = new Date('2026-10-09T14:00:00Z');
    const config = await service.effectiveConfig(
      officialEvent,
      thirtyHoursBefore,
    );
    expect(config?.cutoffAt).toEqual(new Date('2026-10-09T15:00:00.000Z'));

    const fiveHoursBefore = new Date('2026-10-10T15:00:00Z');
    expect(
      await service.effectiveConfig(officialEvent, fiveHoursBefore),
    ).toBeNull();
    expect(configs.save).not.toHaveBeenCalled();
  });

  it('moves the default matching time to one hour from now when enabled 30 hours before the start', async () => {
    const thirtyHoursBefore = new Date('2026-10-09T14:00:00Z');
    const response = await service.putConfig(
      'picnic',
      'host-1',
      baseDto,
      thirtyHoursBefore,
    );
    expect(configs.save).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        cutoffAt: new Date('2026-10-09T15:00:00.000Z'),
      }),
    );
    expect(response.cutoffAt).toBe('2026-10-09T15:00:00.000Z');
  });

  it('refuses to enable Go together once opt-in has closed', async () => {
    const fiveHoursBefore = new Date('2026-10-10T15:00:00Z');
    await expectRejection(
      service.putConfig('picnic', 'host-1', baseDto, fiveHoursBefore),
      ConflictException,
      { code: 'GO_TOGETHER_UNAVAILABLE', reason: 'closed' },
    );
    expect(configs.save).not.toHaveBeenCalled();
  });

  it('refuses a past matching time the host chose unless it is the saved one', async () => {
    const thirtyHoursBefore = new Date('2026-10-09T14:00:00Z');
    await expectRejection(
      service.putConfig(
        'picnic',
        'host-1',
        { ...baseDto, cutoffAt: '2026-10-09T10:00:00.000Z' },
        thirtyHoursBefore,
      ),
      BadRequestException,
      { code: 'GO_TOGETHER_BAD_CUTOFF' },
    );
    expect(configs.save).not.toHaveBeenCalled();

    configs.findOne.mockResolvedValue({
      eventId: 'event-1',
      enabled: true,
      cutoffAt: new Date('2026-10-09T10:00:00.000Z'),
      hostQuestions: [],
      meetingPointNote: null,
      matchedAt: null,
    });
    await service.putConfig(
      'picnic',
      'host-1',
      {
        ...baseDto,
        cutoffAt: '2026-10-09T10:00:00.000Z',
        meetingPointNote: 'By the fountain',
      },
      thirtyHoursBefore,
    );
    expect(configs.save).toHaveBeenCalledWith(
      expect.objectContaining({
        cutoffAt: new Date('2026-10-09T10:00:00.000Z'),
        meetingPointNote: 'By the fountain',
      }),
    );
  });

  it('shows the matching time that applies after the gathering moved', async () => {
    configs.findOne.mockResolvedValue({
      eventId: 'event-1',
      enabled: true,
      // Saved for an earlier date; the gathering now starts 2026-10-10 20:00.
      cutoffAt: new Date('2026-09-20T20:00:00.000Z'),
      hostQuestions: [],
      meetingPointNote: null,
      matchedAt: null,
    });
    const response = await service.getConfig('picnic', 'host-1', now);
    expect(response.cutoffAt).toBe('2026-10-03T20:00:00.000Z');
    expect(response.earliestCutoffAt).toBe('2026-10-03T20:00:00.000Z');
  });

  it('accepts the shown matching time sent back after the gathering moved, even once it has passed', async () => {
    configs.findOne.mockResolvedValue({
      eventId: 'event-1',
      enabled: false,
      // Saved for an earlier date; the gathering now starts 2026-10-10 20:00.
      cutoffAt: new Date('2026-09-20T20:00:00.000Z'),
      hostQuestions: [],
      meetingPointNote: null,
      matchedAt: null,
    });
    const afterShownCutoff = new Date('2026-10-05T12:00:00Z');
    const shown = await service.getConfig('picnic', 'host-1', afterShownCutoff);
    expect(shown.cutoffAt).toBe('2026-10-03T20:00:00.000Z');

    await service.putConfig(
      'picnic',
      'host-1',
      { ...baseDto, cutoffAt: shown.cutoffAt },
      afterShownCutoff,
    );
    expect(configs.save).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        cutoffAt: new Date('2026-10-03T20:00:00.000Z'),
      }),
    );
  });

  it('shows a disabled default to a host who never turned Go together on', async () => {
    expect(await service.getConfig('picnic', 'host-1', now)).toEqual({
      enabled: false,
      cutoffAt: '2026-10-08T20:00:00.000Z',
      earliestCutoffAt: '2026-10-03T20:00:00.000Z',
      latestCutoffAt: '2026-10-10T14:00:00.000Z',
      hostQuestions: [],
      meetingPointNote: null,
      isLocked: false,
    });
  });

  it('summarises counts per status and open groups without any member ids', async () => {
    const countByStatus: Record<string, number> = {
      waiting: 3,
      grouped: 9,
      unmatched: 1,
    };
    entries.count.mockImplementation(
      ({ where }: { where: { status: string } }) =>
        Promise.resolve(countByStatus[where.status] ?? 0),
    );
    groups.count.mockResolvedValue(2);
    const summary = await service.summary('picnic', 'host-1');
    expect(summary).toEqual({
      waiting: 3,
      grouped: 9,
      unmatched: 1,
      groups: 2,
    });
    expect(Object.keys(summary).sort()).toEqual([
      'grouped',
      'groups',
      'unmatched',
      'waiting',
    ]);
    expect(groups.count).toHaveBeenCalledWith({
      where: { eventId: 'event-1', dissolvedAt: IsNull() },
    });
  });

  describe('switching Go together off', () => {
    const savedConfig = (enabled: boolean) => ({
      eventId: 'event-1',
      enabled,
      cutoffAt: new Date('2026-10-08T20:00:00Z'),
      hostQuestions: [],
      meetingPointNote: null,
      matchedAt: null,
    });

    it('closes every waiting entry and pending invite and tells those members why', async () => {
      configs.findOne.mockResolvedValue(savedConfig(true));
      closedRows = [{ user_id: 'member-1' }, { user_id: 'member-2' }];
      await service.putConfig(
        'picnic',
        'host-1',
        { ...baseDto, enabled: false },
        now,
      );

      expect(configs.save).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      );
      expect(builtQueries).toHaveLength(1);
      const [closing] = builtQueries as [UpdateQueryMock];
      expect(closing.set).toHaveBeenCalledWith({
        status: 'withdrawn',
        pairStatus: 'none',
        pairPartnerId: null,
        mergeOfferGroupId: null,
        lens: null,
        lensConsentedAt: null,
      });
      expect(closing.where).toHaveBeenCalledWith('event_id = :eventId', {
        eventId: 'event-1',
      });
      expect(closing.andWhere).toHaveBeenCalledWith("status = 'waiting'");
      expect(notifications.createForRecipients).toHaveBeenCalledWith(
        ['member-1', 'member-2'],
        NotificationType.GoTogetherUnmatched,
        expect.objectContaining({
          eventId: 'event-1',
          eventSlug: 'picnic',
          isFinal: true,
          reason: HOST_SWITCHED_OFF_REASON,
        }),
      );
    });

    it('sweeps waiting entries left behind when the host saves while already off', async () => {
      configs.findOne.mockResolvedValue(savedConfig(false));
      closedRows = [{ user_id: 'member-3' }];
      await service.putConfig(
        'picnic',
        'host-1',
        { ...baseDto, enabled: false },
        now,
      );
      expect(builtQueries).toHaveLength(1);
      expect(builtQueries[0]?.andWhere).toHaveBeenCalledWith(
        "status = 'waiting'",
      );
      expect(notifications.createForRecipients).toHaveBeenCalledWith(
        ['member-3'],
        NotificationType.GoTogetherUnmatched,
        expect.objectContaining({ reason: HOST_SWITCHED_OFF_REASON }),
      );
    });

    it('sends no notice when nobody was waiting', async () => {
      configs.findOne.mockResolvedValue(savedConfig(true));
      await service.putConfig(
        'picnic',
        'host-1',
        { ...baseDto, enabled: false },
        now,
      );
      expect(builtQueries).toHaveLength(1);
      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    });

    it('revives nobody when the host switches it back on', async () => {
      configs.findOne.mockResolvedValue(savedConfig(false));
      await service.putConfig('picnic', 'host-1', baseDto, now);
      expect(configs.save).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      );
      expect(entries.createQueryBuilder).not.toHaveBeenCalled();
      expect(notifications.createForRecipients).not.toHaveBeenCalled();
    });

    it('refuses the save when a cutoff run claimed the config meanwhile', async () => {
      configs.findOne
        .mockResolvedValueOnce(savedConfig(true))
        .mockResolvedValueOnce({
          ...savedConfig(true),
          matchedAt: new Date('2026-10-01T11:59:00Z'),
        });
      await expectRejection(
        service.putConfig(
          'picnic',
          'host-1',
          { ...baseDto, enabled: false },
          now,
        ),
        ConflictException,
        { code: 'GO_TOGETHER_LOCKED' },
      );
      expect(configs.findOne).toHaveBeenLastCalledWith({
        where: { eventId: 'event-1' },
        lock: { mode: 'pessimistic_write' },
      });
      expect(configs.save).not.toHaveBeenCalled();
      expect(entries.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('editing host questions', () => {
    const coffeeQuestion = {
      id: 'q1',
      prompt: 'Coffee or tea?',
      options: [
        { id: 'o1', label: 'Coffee' },
        { id: 'o2', label: 'Tea' },
      ],
    };
    const walkQuestion = {
      id: 'q2',
      prompt: 'Walk there together?',
      options: [
        { id: 'o1', label: 'Yes' },
        { id: 'o2', label: 'No' },
      ],
    };

    beforeEach(() => {
      configs.findOne.mockResolvedValue({
        eventId: 'event-1',
        enabled: true,
        cutoffAt: new Date('2026-10-08T20:00:00Z'),
        hostQuestions: [coffeeQuestion, walkQuestion],
        meetingPointNote: null,
        matchedAt: null,
      });
    });

    it('clears the saved answers to a question whose options changed', async () => {
      await service.putConfig(
        'picnic',
        'host-1',
        {
          ...baseDto,
          hostQuestions: [
            { prompt: 'Coffee or tea?', options: ['Tea', 'Coffee'] },
            { prompt: 'Walk there together?', options: ['Yes', 'No'] },
          ],
        },
        now,
      );
      expect(builtQueries).toHaveLength(1);
      const [clearing] = builtQueries as [UpdateQueryMock];
      expect(clearing.andWhere).toHaveBeenCalledWith(
        'host_answers - CAST(:questionIds AS text[]) <> host_answers',
        { questionIds: ['q1'] },
      );
      expect(clearing.where).toHaveBeenCalledWith('event_id = :eventId', {
        eventId: 'event-1',
      });
    });

    it('clears the answers to a removed question', async () => {
      await service.putConfig(
        'picnic',
        'host-1',
        {
          ...baseDto,
          hostQuestions: [
            { prompt: 'Coffee or tea?', options: ['Coffee', 'Tea'] },
          ],
        },
        now,
      );
      expect(builtQueries[0]?.andWhere).toHaveBeenCalledWith(
        expect.any(String),
        { questionIds: ['q2'] },
      );
    });

    it('clears nothing when the host saves the same questions again', async () => {
      await service.putConfig(
        'picnic',
        'host-1',
        {
          ...baseDto,
          hostQuestions: [
            { prompt: 'Coffee or tea?', options: ['Coffee', 'Tea'] },
            { prompt: 'Walk there together?', options: ['Yes', 'No'] },
          ],
          meetingPointNote: 'By the fountain',
        },
        now,
      );
      expect(entries.createQueryBuilder).not.toHaveBeenCalled();
      expect(configs.save).toHaveBeenCalledWith(
        expect.objectContaining({ meetingPointNote: 'By the fountain' }),
      );
    });
  });

  describe('ensureConfigRow', () => {
    const officialEvent = { ...event, hostId: 'house-account' } as Event;

    it('returns a saved row as it is and never writes it back', async () => {
      const savedRow = {
        eventId: 'event-1',
        enabled: false,
        matchedAt: new Date('2026-10-01T11:59:00Z'),
      };
      configs.findOne.mockResolvedValue(savedRow);
      expect(await service.ensureConfigRow(officialEvent, now)).toBe(savedRow);
      expect(configs.save).not.toHaveBeenCalled();
      expect(configs.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('inserts an official event virtual config, skipping on conflict, then re-reads it', async () => {
      const insertedRow = { eventId: 'event-1', enabled: true };
      configs.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(insertedRow);
      expect(await service.ensureConfigRow(officialEvent, now)).toBe(
        insertedRow,
      );
      expect(configInsert.into).toHaveBeenCalledWith(EventMatchConfig);
      expect(configInsert.values).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: 'event-1', enabled: true }),
      );
      expect(configInsert.orIgnore).toHaveBeenCalled();
      expect(configs.save).not.toHaveBeenCalled();
    });

    it('refuses a gathering whose host never turned Go together on', async () => {
      await expectRejection(
        service.ensureConfigRow(event, now),
        ConflictException,
        { code: 'GO_TOGETHER_UNAVAILABLE', reason: 'notEnabled' },
      );
      expect(configs.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});
