import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, FindOperator, QueryFailedError } from 'typeorm';
import {
  Connection,
  ConnectionStatus,
} from '../connections/entities/connection.entity';
import { ConnectionsService } from '../connections/connections.service';
import { Event } from '../events/entities/event.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { EventMatchConfig } from './entities/event-match-config.entity';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import { EventMatchGroup } from './entities/event-match-group.entity';
import { MatchAvoidance } from './entities/match-avoidance.entity';
import {
  MatchFeedback,
  MeetAgainVerdict,
} from './entities/match-feedback.entity';
import { MatchGroupFeedback } from './entities/match-group-feedback.entity';
import { GoTogetherFeedbackService } from './go-together-feedback.service';

function matchesValue(actual: unknown, expected: unknown): boolean {
  if (expected instanceof FindOperator) {
    const operator = expected as FindOperator<unknown>;
    if (operator.type === 'in') {
      return (operator.value as unknown[]).includes(actual);
    }
    throw new Error(`Unsupported operator ${operator.type}`);
  }
  return actual === expected;
}

function matchesWhere(row: object, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) =>
    matchesValue((row as Record<string, unknown>)[key], expected),
  );
}

async function expectRejection(
  pending: Promise<unknown>,
  expectedClass: new (...args: never[]) => HttpException,
  body?: Record<string, unknown>,
): Promise<void> {
  const caught: unknown = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(expectedClass);
  if (body) {
    expect((caught as HttpException).getResponse()).toMatchObject(body);
  }
}

/**
 * The caller is `user-2` (Ana). The other members are `user-1` (Bea) and
 * `user-3` (Cris), so the caller's id is not always the lower one and the
 * canonical connection pair is actually exercised.
 */
describe('GoTogetherFeedbackService', () => {
  const callerId = 'user-2';
  const promptedAt = new Date('2026-10-11T12:00:00Z');
  const insideWindow = new Date('2026-10-12T12:00:00Z');
  const event = {
    id: 'event-1',
    slug: 'picnic',
    title: 'Picnic in the park',
  } as Event;
  const group = { id: 'group-1', eventId: 'event-1' } as EventMatchGroup;
  const mutualPayload = {
    eventId: 'event-1',
    eventSlug: 'picnic',
    eventTitle: 'Picnic in the park',
    groupId: 'group-1',
  };

  let entryRows: EventMatchEntry[];
  let feedbackRows: MatchFeedback[];
  let groupFeedbackRows: MatchGroupFeedback[];
  let avoidanceRows: { userId: string; avoidedUserId: string }[];
  let service: GoTogetherFeedbackService;
  let entries: { findOne: jest.Mock; find: jest.Mock };
  let groups: { findOne: jest.Mock };
  let configs: { findOne: jest.Mock };
  let events: { findOne: jest.Mock };
  let profiles: { find: jest.Mock };
  let feedback: { find: jest.Mock; findOne: jest.Mock; upsert: jest.Mock };
  let groupFeedback: { findOne: jest.Mock; upsert: jest.Mock };
  let avoidanceInsert: {
    insert: jest.Mock;
    into: jest.Mock;
    values: jest.Mock;
    orIgnore: jest.Mock;
    execute: jest.Mock;
  };
  let avoidances: { createQueryBuilder: jest.Mock; delete: jest.Mock };
  let manager: { findOne: jest.Mock; update: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let blockFilter: { isBlockedEitherWay: jest.Mock; blockedUserIds: jest.Mock };
  let connections: { createConnectionInTransaction: jest.Mock };
  let notifications: { create: jest.Mock };

  beforeEach(async () => {
    entryRows = ['user-1', 'user-2', 'user-3', 'user-5'].map(
      (userId, index) =>
        ({
          id: `entry-${index + 1}`,
          eventId: 'event-1',
          userId,
          groupId: 'group-1',
          status: userId === 'user-5' ? 'withdrawn' : 'grouped',
        }) as EventMatchEntry,
    );
    const profileRows = [
      { userId: 'user-1', slug: 'bea', firstName: 'Bea' },
      { userId: 'user-2', slug: 'ana', firstName: 'Ana' },
      { userId: 'user-3', slug: 'cris', firstName: 'Cris' },
      { userId: 'user-5', slug: 'eli', firstName: 'Eli' },
    ].map(
      (fields) =>
        ({
          ...fields,
          pronouns: null,
          avatarUrl: null,
          photoVisible: true,
        }) as Profile,
    );
    feedbackRows = [];
    groupFeedbackRows = [];
    avoidanceRows = [];

    entries = {
      findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          entryRows.find((row) => matchesWhere(row, where)) ?? null,
        ),
      ),
      find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(entryRows.filter((row) => matchesWhere(row, where))),
      ),
    };
    groups = {
      findOne: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === group.id ? group : null),
      ),
    };
    configs = {
      findOne: jest.fn().mockResolvedValue({
        eventId: 'event-1',
        feedbackPromptedAt: promptedAt,
      }),
    };
    events = { findOne: jest.fn().mockResolvedValue(event) };
    profiles = {
      find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(profileRows.filter((row) => matchesWhere(row, where))),
      ),
    };
    feedback = {
      find: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(feedbackRows.filter((row) => matchesWhere(row, where))),
      ),
      findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          feedbackRows.find((row) => matchesWhere(row, where)) ?? null,
        ),
      ),
      upsert: jest.fn((row: MatchFeedback) => {
        const existing = feedbackRows.find(
          (candidate) =>
            candidate.groupId === row.groupId &&
            candidate.raterId === row.raterId &&
            candidate.rateeId === row.rateeId,
        );
        if (existing) Object.assign(existing, row);
        else feedbackRows.push({ ...row });
        return Promise.resolve({});
      }),
    };
    groupFeedback = {
      findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          groupFeedbackRows.find((row) => matchesWhere(row, where)) ?? null,
        ),
      ),
      upsert: jest.fn((row: MatchGroupFeedback) => {
        const existing = groupFeedbackRows.find(
          (candidate) =>
            candidate.groupId === row.groupId &&
            candidate.raterId === row.raterId,
        );
        if (existing) Object.assign(existing, row);
        else groupFeedbackRows.push({ ...row });
        return Promise.resolve({});
      }),
    };
    let pendingAvoidance: { userId: string; avoidedUserId: string } | null =
      null;
    avoidanceInsert = {
      insert: jest.fn(() => avoidanceInsert),
      into: jest.fn(() => avoidanceInsert),
      values: jest.fn((row: { userId: string; avoidedUserId: string }) => {
        pendingAvoidance = row;
        return avoidanceInsert;
      }),
      orIgnore: jest.fn(() => avoidanceInsert),
      execute: jest.fn(() => {
        const row = pendingAvoidance;
        const isDuplicate = avoidanceRows.some(
          (candidate) =>
            candidate.userId === row?.userId &&
            candidate.avoidedUserId === row?.avoidedUserId,
        );
        if (row && !isDuplicate) avoidanceRows.push({ ...row });
        return Promise.resolve({});
      }),
    };
    avoidances = {
      createQueryBuilder: jest.fn(() => avoidanceInsert),
      delete: jest.fn((where: { userId: string; avoidedUserId: string }) => {
        avoidanceRows = avoidanceRows.filter(
          (row) =>
            row.userId !== where.userId ||
            row.avoidedUserId !== where.avoidedUserId,
        );
        return Promise.resolve({});
      }),
    };
    manager = {
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    dataSource = {
      transaction: jest.fn(
        (work: (transactionManager: typeof manager) => Promise<unknown>) =>
          work(manager),
      ),
    };
    blockFilter = {
      isBlockedEitherWay: jest.fn().mockResolvedValue(false),
      blockedUserIds: jest.fn().mockResolvedValue(new Set<string>()),
    };
    connections = {
      createConnectionInTransaction: jest.fn().mockResolvedValue(true),
    };
    notifications = { create: jest.fn().mockResolvedValue({}) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        GoTogetherFeedbackService,
        { provide: getRepositoryToken(EventMatchEntry), useValue: entries },
        { provide: getRepositoryToken(EventMatchGroup), useValue: groups },
        { provide: getRepositoryToken(EventMatchConfig), useValue: configs },
        { provide: getRepositoryToken(Event), useValue: events },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(MatchFeedback), useValue: feedback },
        {
          provide: getRepositoryToken(MatchGroupFeedback),
          useValue: groupFeedback,
        },
        { provide: getRepositoryToken(MatchAvoidance), useValue: avoidances },
        { provide: DataSource, useValue: dataSource },
        { provide: BlockFilterService, useValue: blockFilter },
        { provide: ConnectionsService, useValue: connections },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = moduleRef.get(GoTogetherFeedbackService);
  });

  function seedVerdict(
    raterId: string,
    rateeId: string,
    verdict: MeetAgainVerdict,
  ): void {
    feedbackRows.push({
      groupId: 'group-1',
      raterId,
      rateeId,
      verdict,
    } as MatchFeedback);
  }

  function expectNothingConnected(): void {
    expect(connections.createConnectionInTransaction).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  }

  it('returns 404 to a member who is not grouped in the group', async () => {
    await expectRejection(
      service.put('group-1', 'user-5', { goAgain: true }, insideWindow),
      NotFoundException,
    );
    await expectRejection(service.get('group-1', 'user-9'), NotFoundException);
    expect(groupFeedback.upsert).not.toHaveBeenCalled();
  });

  it('lists the other members with the caller verdict about each', async () => {
    seedVerdict(callerId, 'user-3', 'maybe');
    seedVerdict('user-1', callerId, 'yes');

    const response = await service.get('group-1', callerId, insideWindow);

    expect(response).toEqual({
      groupId: 'group-1',
      isOpen: true,
      closesAt: new Date('2026-10-18T12:00:00Z').toISOString(),
      members: [
        {
          slug: 'bea',
          firstName: 'Bea',
          pronouns: null,
          avatarUrl: null,
          verdict: null,
        },
        {
          slug: 'cris',
          firstName: 'Cris',
          pronouns: null,
          avatarUrl: null,
          verdict: 'maybe',
        },
      ],
      clicked: null,
      goAgain: false,
    });
  });

  it('leaves out a member blocked either way with the caller and refuses an answer about them', async () => {
    blockFilter.blockedUserIds.mockResolvedValue(new Set(['user-3']));

    const response = await service.get('group-1', callerId, insideWindow);

    expect(blockFilter.blockedUserIds).toHaveBeenCalledWith(callerId, [
      'user-1',
      'user-3',
    ]);
    expect(response.members.map((member) => member.slug)).toEqual(['bea']);
    await expectRejection(
      service.put(
        'group-1',
        callerId,
        { verdicts: { cris: 'no' } },
        insideWindow,
      ),
      BadRequestException,
      { code: 'GO_TOGETHER_INVALID_FEEDBACK' },
    );
    expect(feedback.upsert).not.toHaveBeenCalled();
  });

  it.each<{ label: string; feedbackPromptedAt: Date | null; now: Date }>([
    {
      label: 'after the seven-day window',
      feedbackPromptedAt: promptedAt,
      now: new Date('2026-10-18T12:00:00Z'),
    },
    {
      label: 'before the prompt went out',
      feedbackPromptedAt: null,
      now: insideWindow,
    },
  ])(
    'refuses answers $label with GO_TOGETHER_FEEDBACK_CLOSED',
    async ({ feedbackPromptedAt, now }) => {
      configs.findOne.mockResolvedValue({
        eventId: 'event-1',
        feedbackPromptedAt,
      });

      await expectRejection(
        service.put(
          'group-1',
          callerId,
          { verdicts: { bea: 'yes' }, goAgain: true },
          now,
        ),
        ConflictException,
        { code: 'GO_TOGETHER_FEEDBACK_CLOSED' },
      );
      expect(feedback.upsert).not.toHaveBeenCalled();
      expect(groupFeedback.upsert).not.toHaveBeenCalled();
    },
  );

  it.each<{ label: string; verdicts: Record<string, string> }>([
    { label: 'someone outside the group', verdicts: { zed: 'yes' } },
    { label: 'a former member', verdicts: { eli: 'yes' } },
    { label: 'the caller themselves', verdicts: { ana: 'yes' } },
    { label: 'an unknown answer', verdicts: { bea: 'perhaps' } },
  ])('rejects a verdict about $label with 400', async ({ verdicts }) => {
    await expectRejection(
      service.put('group-1', callerId, { verdicts }, insideWindow),
      BadRequestException,
      { code: 'GO_TOGETHER_INVALID_FEEDBACK' },
    );
    expect(feedback.upsert).not.toHaveBeenCalled();
    expect(avoidanceInsert.execute).not.toHaveBeenCalled();
  });

  it('writes an avoidance for no and deletes it when the answer becomes maybe', async () => {
    await service.put(
      'group-1',
      callerId,
      { verdicts: { cris: 'no' } },
      insideWindow,
    );

    expect(feedback.upsert).toHaveBeenCalledWith(
      {
        groupId: 'group-1',
        raterId: callerId,
        rateeId: 'user-3',
        verdict: 'no',
      },
      ['groupId', 'raterId', 'rateeId'],
    );
    expect(avoidanceInsert.into).toHaveBeenCalledWith(MatchAvoidance);
    expect(avoidanceInsert.values).toHaveBeenCalledWith({
      userId: callerId,
      avoidedUserId: 'user-3',
    });
    expect(avoidanceInsert.orIgnore).toHaveBeenCalled();
    expect(avoidanceRows).toEqual([
      { userId: callerId, avoidedUserId: 'user-3' },
    ]);

    const response = await service.put(
      'group-1',
      callerId,
      { verdicts: { cris: 'maybe' } },
      insideWindow,
    );

    expect(avoidances.delete).toHaveBeenCalledWith({
      userId: callerId,
      avoidedUserId: 'user-3',
    });
    expect(avoidanceRows).toEqual([]);
    expect(response.members.find((member) => member.slug === 'cris')).toEqual(
      expect.objectContaining({ verdict: 'maybe' }),
    );
  });

  it('creates a connection on a mutual yes and tells both, each with the other as the actor', async () => {
    seedVerdict('user-1', callerId, 'yes');

    await service.put(
      'group-1',
      callerId,
      { verdicts: { bea: 'yes' } },
      insideWindow,
    );

    expect(manager.findOne).toHaveBeenCalledWith(Connection, {
      where: { userLow: 'user-1', userHigh: 'user-2' },
    });
    expect(connections.createConnectionInTransaction).toHaveBeenCalledWith(
      manager,
      callerId,
      'user-1',
    );
    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create).toHaveBeenCalledWith(
      callerId,
      NotificationType.GoTogetherMutual,
      { ...mutualPayload, actorId: 'user-1' },
      'user-1',
    );
    expect(notifications.create).toHaveBeenCalledWith(
      'user-1',
      NotificationType.GoTogetherMutual,
      { ...mutualPayload, actorId: callerId },
      callerId,
    );
  });

  it('accepts a pending connection on a mutual yes and notifies both', async () => {
    seedVerdict('user-3', callerId, 'yes');
    manager.findOne.mockResolvedValue({
      id: 'connection-1',
      status: ConnectionStatus.Pending,
    });

    await service.put(
      'group-1',
      callerId,
      { verdicts: { cris: 'yes' } },
      insideWindow,
    );

    expect(manager.findOne).toHaveBeenCalledWith(Connection, {
      where: { userLow: 'user-2', userHigh: 'user-3' },
    });
    expect(manager.update).toHaveBeenCalledWith(
      Connection,
      { id: 'connection-1', status: ConnectionStatus.Pending },
      { status: ConnectionStatus.Accepted, respondedAt: expect.any(Date) },
    );
    expect(connections.createConnectionInTransaction).not.toHaveBeenCalled();
    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create).toHaveBeenCalledWith(
      'user-3',
      NotificationType.GoTogetherMutual,
      { ...mutualPayload, actorId: callerId },
      callerId,
    );
  });

  it.each([
    ConnectionStatus.Accepted,
    ConnectionStatus.Declined,
    ConnectionStatus.Blocked,
  ])(
    'leaves an existing %s connection alone on a mutual yes',
    async (status) => {
      seedVerdict('user-1', callerId, 'yes');
      manager.findOne.mockResolvedValue({ id: 'connection-1', status });

      await expect(
        service.put(
          'group-1',
          callerId,
          { verdicts: { bea: 'yes' } },
          insideWindow,
        ),
      ).resolves.toEqual(expect.objectContaining({ groupId: 'group-1' }));

      expect(manager.findOne).toHaveBeenCalled();
      expectNothingConnected();
    },
  );

  it('connects nobody on a mutual yes when either member blocked the other', async () => {
    seedVerdict('user-1', callerId, 'yes');
    blockFilter.isBlockedEitherWay.mockResolvedValue(true);

    await expect(
      service.put(
        'group-1',
        callerId,
        { verdicts: { bea: 'yes' } },
        insideWindow,
      ),
    ).resolves.toEqual(expect.objectContaining({ groupId: 'group-1' }));

    expect(blockFilter.isBlockedEitherWay).toHaveBeenCalledWith(
      callerId,
      'user-1',
    );
    expect(manager.findOne).not.toHaveBeenCalled();
    expectNothingConnected();
  });

  it('notifies nobody and does not throw when a concurrent request already inserted the connection', async () => {
    seedVerdict('user-1', callerId, 'yes');
    connections.createConnectionInTransaction.mockRejectedValue(
      new QueryFailedError(
        'INSERT INTO connections',
        [],
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      ),
    );

    await expect(
      service.put(
        'group-1',
        callerId,
        { verdicts: { bea: 'yes' } },
        insideWindow,
      ),
    ).resolves.toEqual(expect.objectContaining({ groupId: 'group-1' }));

    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('creates nothing on a one-sided yes', async () => {
    seedVerdict('user-1', callerId, 'maybe');

    await service.put(
      'group-1',
      callerId,
      { verdicts: { bea: 'yes', cris: 'yes' } },
      insideWindow,
    );

    expect(feedbackRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ raterId: callerId, rateeId: 'user-1' }),
        expect.objectContaining({ raterId: callerId, rateeId: 'user-3' }),
      ]),
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expectNothingConnected();
  });

  it('upserts clicked and goAgain on match_group_feedback, keeping the other field', async () => {
    const first = await service.put(
      'group-1',
      callerId,
      { clicked: 'somewhat' },
      insideWindow,
    );

    expect(groupFeedback.upsert).toHaveBeenCalledWith(
      {
        groupId: 'group-1',
        raterId: callerId,
        clicked: 'somewhat',
        goAgain: false,
      },
      ['groupId', 'raterId'],
    );
    expect(first).toMatchObject({ clicked: 'somewhat', goAgain: false });

    const second = await service.put(
      'group-1',
      callerId,
      { goAgain: true },
      insideWindow,
    );

    expect(groupFeedback.upsert).toHaveBeenLastCalledWith(
      {
        groupId: 'group-1',
        raterId: callerId,
        clicked: 'somewhat',
        goAgain: true,
      },
      ['groupId', 'raterId'],
    );
    expect(groupFeedbackRows).toHaveLength(1);
    expect(second).toMatchObject({ clicked: 'somewhat', goAgain: true });
  });

  it('leaves match_group_feedback untouched when neither field is sent', async () => {
    await service.put(
      'group-1',
      callerId,
      { verdicts: { bea: 'maybe' } },
      insideWindow,
    );

    expect(groupFeedback.upsert).not.toHaveBeenCalled();
  });
});
