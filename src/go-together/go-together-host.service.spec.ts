import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { IsNull } from 'typeorm';
import { Event, EventStatus } from '../events/entities/event.entity';
import { EventsService } from '../events/events.service';
import { HostConfigDto } from './dto/host-config.dto';
import { EventMatchConfig } from './entities/event-match-config.entity';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import { EventMatchGroup } from './entities/event-match-group.entity';
import { GoTogetherHostService } from './go-together-host.service';
import { GoTogetherHouseService } from './go-together-house.service';

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
  let configs: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock };
  let entries: { count: jest.Mock };
  let groups: { count: jest.Mock };
  let eventsService: { isOrganizer: jest.Mock };
  let house: { houseUserId: jest.Mock };

  beforeEach(async () => {
    events = { findOne: jest.fn().mockResolvedValue(event) };
    configs = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((row: Partial<EventMatchConfig>) => ({ ...row })),
      save: jest.fn((row: EventMatchConfig) => Promise.resolve(row)),
    };
    entries = { count: jest.fn() };
    groups = { count: jest.fn() };
    eventsService = { isOrganizer: jest.fn().mockResolvedValue(true) };
    house = { houseUserId: jest.fn().mockResolvedValue('house-account') };
    const moduleRef = await Test.createTestingModule({
      providers: [
        GoTogetherHostService,
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(EventMatchConfig), useValue: configs },
        { provide: getRepositoryToken(EventMatchEntry), useValue: entries },
        { provide: getRepositoryToken(EventMatchGroup), useValue: groups },
        { provide: EventsService, useValue: eventsService },
        { provide: GoTogetherHouseService, useValue: house },
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
});
