import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Connection } from '../connections/entities/connection.entity';
import { Profile } from '../users/entities/profile.entity';
import { ProfileNowHistory } from './entities/profile-now-history.entity';
import { NOW_WINDOW_DAYS, NowInsightsService } from './now-insights.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const OWNER = 'owner-1';
// Pinned "now" for every test in this file. The service computes its window
// starts from `Date.now()` at call time; a test that instead reads
// `Date.now()` itself (before or after that call) to build the expected value
// is comparing two separate reads of the clock, which can straddle a
// millisecond and, over a 90 or 180 day multiplier, turn into a
// fraction-of-a-day gap large enough to flip a boundary assertion. Freezing
// time removes the second read entirely: the test computes the expected
// `since` from the SAME constant the service's `Date.now()` resolves to.
const NOW = new Date('2026-09-01T12:00:00.000Z').getTime();

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
});

afterEach(() => {
  jest.useRealTimers();
});

type SqlCall = [string, Record<string, unknown> | undefined];

/**
 * A chainable query-builder stub, in the spirit of the `qbStub` in
 * `profiles.service.spec.ts` and the SQL-capturing spy in
 * `member-directory.query.spec.ts`: it records every `select`/`where`
 * fragment and parameter it was given, and resolves its terminal call to
 * canned rows.
 *
 * No sibling spec in this directory spins up a real Postgres datasource for
 * a query-builder scan (`profiles.service.spec.ts`, `last-active.service.spec.ts`,
 * `discoverable-identities.service.spec.ts`, `activity-visibility.service.spec.ts`
 * and `board-lifecycle.spec.ts` all mock the repository). Following that
 * pattern here means the grouping, the date-window filtering, and the median
 * itself are Postgres's job and are not exercised by these tests: what they
 * verify is the service's own logic (summing across returned groups, the
 * null-reason/null-lastHelloAt handling, the MIN_ANSWERED floor, the bucket
 * thresholds) against canned rows shaped like what that SQL would produce,
 * plus the literal SQL text and parameters the service hands to the
 * builder.
 */
function connectionsQbStub(
  rawMany: unknown[] = [],
  rawOne: unknown = undefined,
) {
  const selects: [string, string][] = [];
  const wheres: SqlCall[] = [];
  const parameters: Record<string, unknown> = {};
  let groupedBy: string | undefined;
  const qb: Record<string, jest.Mock> = {};
  qb.select = jest.fn((sql: string, alias: string) => {
    selects.push([sql, alias]);
    return qb;
  });
  qb.addSelect = jest.fn((sql: string, alias: string) => {
    selects.push([sql, alias]);
    return qb;
  });
  qb.where = jest.fn((sql: string, params?: Record<string, unknown>) => {
    wheres.push([sql, params]);
    if (params) Object.assign(parameters, params);
    return qb;
  });
  qb.andWhere = jest.fn((sql: string, params?: Record<string, unknown>) => {
    wheres.push([sql, params]);
    if (params) Object.assign(parameters, params);
    return qb;
  });
  qb.setParameter = jest.fn((name: string, value: unknown) => {
    parameters[name] = value;
    return qb;
  });
  qb.groupBy = jest.fn((col: string) => {
    groupedBy = col;
    return qb;
  });
  qb.getRawMany = jest.fn().mockResolvedValue(rawMany);
  qb.getRawOne = jest.fn().mockResolvedValue(rawOne);
  return {
    qb,
    selects,
    wheres,
    parameters,
    groupedBy: () => groupedBy,
  };
}

async function buildService(): Promise<{
  service: NowInsightsService;
  connections: { createQueryBuilder: jest.Mock };
  nowHistory: { find: jest.Mock };
  profiles: { findOne: jest.Mock };
}> {
  const connections = { createQueryBuilder: jest.fn() };
  const nowHistory = { find: jest.fn() };
  const profiles = { findOne: jest.fn() };
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      NowInsightsService,
      { provide: getRepositoryToken(Connection), useValue: connections },
      { provide: getRepositoryToken(ProfileNowHistory), useValue: nowHistory },
      { provide: getRepositoryToken(Profile), useValue: profiles },
    ],
  }).compile();
  return {
    service: module.get(NowInsightsService),
    connections,
    nowHistory,
    profiles,
  };
}

describe('NowInsightsService.getForOwner', () => {
  it('always reports the stated 90 day window', async () => {
    const { service, connections, nowHistory, profiles } = await buildService();
    connections.createQueryBuilder.mockReturnValue(connectionsQbStub([]).qb);
    profiles.findOne.mockResolvedValue(null);
    nowHistory.find.mockResolvedValue([]);

    const insights = await service.getForOwner(OWNER);
    expect(insights.windowDays).toBe(90);
    expect(insights.windowDays).toBe(NOW_WINDOW_DAYS);
  });

  it('sums hellos and replies across every reason group the query returns', async () => {
    const { service, connections, nowHistory, profiles } = await buildService();
    connections.createQueryBuilder.mockReturnValue(
      connectionsQbStub([
        {
          reason: 'open:coffee',
          windowCount: '2',
          windowReplies: '1',
          lastHelloAt: new Date('2026-09-01T00:00:00.000Z'),
        },
        {
          reason: 'open:tea',
          windowCount: '1',
          windowReplies: '1',
          lastHelloAt: new Date('2026-09-02T00:00:00.000Z'),
        },
      ]).qb,
    );
    profiles.findOne.mockResolvedValue(null);
    nowHistory.find.mockResolvedValue([]);

    const insights = await service.getForOwner(OWNER);
    expect(insights.hellos).toBe(3);
    expect(insights.replies).toBe(2);
  });

  it('derives a reply from responded_at being set, with no status clause in the SQL', async () => {
    // A declined request still has `responded_at` set: the addressee acted
    // on it. The service's aggregate expression counts replies on that
    // column alone, so this test locks the literal SQL text that keeps a
    // decline in the reply count. Whether Postgres evaluates the clause
    // correctly against a real declined row is a claim only a live
    // datasource could confirm, and this repo's profiles specs mock the
    // repository throughout (see the stub's doc comment above).
    const { service, connections, nowHistory, profiles } = await buildService();
    const stub = connectionsQbStub([
      {
        reason: 'open:coffee',
        windowCount: '1',
        windowReplies: '1',
        lastHelloAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    ]);
    connections.createQueryBuilder.mockReturnValue(stub.qb);
    profiles.findOne.mockResolvedValue(null);
    nowHistory.find.mockResolvedValue([]);

    const insights = await service.getForOwner(OWNER);
    const sql = [
      ...stub.selects.map(([text]) => text),
      ...stub.wheres.map(([text]) => text),
    ].join('\n');
    expect(sql).toContain('c.responded_at IS NOT NULL');
    expect(sql).toEqual(expect.not.stringMatching(/c\.status/));
    expect(insights.replies).toBe(1);
  });

  it('groups per chip by the raw request reason', async () => {
    const { service, connections, nowHistory, profiles } = await buildService();
    connections.createQueryBuilder.mockReturnValue(
      connectionsQbStub([
        {
          reason: 'open:collaborating',
          windowCount: '2',
          windowReplies: '0',
          lastHelloAt: new Date('2026-08-01T00:00:00.000Z'),
        },
        {
          reason: 'custom:a riso afternoon',
          windowCount: '1',
          windowReplies: '1',
          lastHelloAt: new Date('2026-08-15T00:00:00.000Z'),
        },
      ]).qb,
    );
    profiles.findOne.mockResolvedValue(null);
    nowHistory.find.mockResolvedValue([]);

    const insights = await service.getForOwner(OWNER);
    expect(insights.perChip).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'open:collaborating', count: 2 }),
        expect.objectContaining({
          reason: 'custom:a riso afternoon',
          count: 1,
        }),
      ]),
    );
  });

  it('folds a reasonless hello into the funnel while keeping it off every chip', async () => {
    const { service, connections, nowHistory, profiles } = await buildService();
    connections.createQueryBuilder.mockReturnValue(
      connectionsQbStub([
        {
          reason: null,
          windowCount: '1',
          windowReplies: '0',
          lastHelloAt: new Date(),
        },
      ]).qb,
    );
    profiles.findOne.mockResolvedValue(null);
    nowHistory.find.mockResolvedValue([]);

    const insights = await service.getForOwner(OWNER);
    expect(insights.hellos).toBe(1);
    expect(insights.perChip).toHaveLength(0);
  });

  it('reports lastHelloAt for a chip with zero hellos inside the window', async () => {
    const { service, connections, nowHistory, profiles } = await buildService();
    const oldHello = new Date(Date.now() - 200 * DAY_MS);
    connections.createQueryBuilder.mockReturnValue(
      connectionsQbStub([
        {
          reason: 'open:mentoring',
          windowCount: '0',
          windowReplies: '0',
          lastHelloAt: oldHello,
        },
      ]).qb,
    );
    profiles.findOne.mockResolvedValue(null);
    nowHistory.find.mockResolvedValue([]);

    const insights = await service.getForOwner(OWNER);
    const chip = insights.perChip.find((c) => c.reason === 'open:mentoring');
    expect(chip).toMatchObject({ count: 0 });
    expect(chip?.lastHelloAt).not.toBeNull();
    expect(chip?.lastHelloAt).toBe(oldHello.toISOString());
  });

  it('maps a null lastHelloAt to null', async () => {
    const { service, connections, nowHistory, profiles } = await buildService();
    connections.createQueryBuilder.mockReturnValue(
      connectionsQbStub([
        {
          reason: 'open:coffee',
          windowCount: '0',
          windowReplies: '0',
          lastHelloAt: null,
        },
      ]).qb,
    );
    profiles.findOne.mockResolvedValue(null);
    nowHistory.find.mockResolvedValue([]);

    const insights = await service.getForOwner(OWNER);
    expect(insights.perChip[0]!.lastHelloAt).toBeNull();
  });

  it('reads nowUpdatedAt through a narrow select and maps it to an ISO string or null', async () => {
    const { service, connections, nowHistory, profiles } = await buildService();
    connections.createQueryBuilder.mockReturnValue(connectionsQbStub([]).qb);
    nowHistory.find.mockResolvedValue([]);

    profiles.findOne.mockResolvedValue({
      userId: OWNER,
      nowUpdatedAt: new Date('2026-08-20T10:00:00.000Z'),
    });
    const withStatus = await service.getForOwner(OWNER);
    expect(withStatus.nowUpdatedAt).toBe('2026-08-20T10:00:00.000Z');

    profiles.findOne.mockResolvedValue({
      userId: OWNER,
      nowUpdatedAt: null,
    });
    const withoutStatus = await service.getForOwner(OWNER);
    expect(withoutStatus.nowUpdatedAt).toBeNull();

    expect(profiles.findOne).toHaveBeenCalledWith({
      where: { userId: OWNER },
      select: { userId: true, nowUpdatedAt: true },
    });
  });

  it('returns the five newest history rows the repository already sorted, newest first', async () => {
    // Sorting and limiting are the DB's job (`order`/`take` below); with the
    // repository mocked, this asserts the service asks for the right order
    // and cap and maps whatever comes back without re-sorting it.
    const { service, connections, nowHistory, profiles } = await buildService();
    connections.createQueryBuilder.mockReturnValue(connectionsQbStub([]).qb);
    profiles.findOne.mockResolvedValue(null);
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      userId: OWNER,
      text: `status ${i}`,
      startedAt: new Date(Date.UTC(2026, 0, 10 - i)),
      endedAt: new Date(Date.UTC(2026, 0, 20 - i)),
      createdAt: new Date(),
    }));
    nowHistory.find.mockResolvedValue(rows);

    const insights = await service.getForOwner(OWNER);
    expect(insights.history).toHaveLength(5);
    expect(new Date(insights.history[0]!.endedAt).getTime()).toBeGreaterThan(
      new Date(insights.history[4]!.endedAt).getTime(),
    );
    expect(nowHistory.find).toHaveBeenCalledWith({
      where: { userId: OWNER },
      order: { endedAt: 'DESC' },
      take: 5,
    });
  });

  it('scopes the grouped scan to the addressee and a 90 day since parameter', async () => {
    const { service, connections, nowHistory, profiles } = await buildService();
    const stub = connectionsQbStub([]);
    connections.createQueryBuilder.mockReturnValue(stub.qb);
    profiles.findOne.mockResolvedValue(null);
    nowHistory.find.mockResolvedValue([]);

    await service.getForOwner(OWNER);

    const whereSql = stub.wheres.map(([text]) => text).join('\n');
    expect(whereSql).toContain('c.addressee_id = :userId');
    expect(stub.parameters.userId).toBe(OWNER);
    expect(stub.groupedBy()).toBe('c.request_reason');
    const since = stub.parameters.since as Date;
    expect(since).toBeInstanceOf(Date);
    // Time is frozen at NOW (file-level `jest.useFakeTimers` above), so the
    // service's own `Date.now()` resolves to the exact same instant this
    // assertion computes from, an exact value rather than a range that a
    // second, later clock read could fall outside of.
    expect(since.getTime()).toBe(NOW - NOW_WINDOW_DAYS * DAY_MS);
  });

  it('excludes a system:autoConnect row from hellos, replies, and perChip via a request_reason filter', async () => {
    // The invite auto-connect (`ConnectionsService.createConnectionInTransaction`)
    // writes an already-Accepted row with `requestReason: 'system:autoConnect'`.
    // Filtering that out is Postgres's job (the WHERE below), so with the
    // repository mocked (this file's whole approach, see the stub's doc
    // comment) the only thing assertable here is that the service actually
    // asks for that filter, on the `system:` PREFIX rather than the exact
    // string, so any future system-written row is excluded too.
    const { service, connections, nowHistory, profiles } = await buildService();
    const stub = connectionsQbStub([
      {
        reason: 'open:coffee',
        windowCount: '1',
        windowReplies: '1',
        lastHelloAt: new Date('2026-09-01T00:00:00.000Z'),
      },
    ]);
    connections.createQueryBuilder.mockReturnValue(stub.qb);
    profiles.findOne.mockResolvedValue(null);
    nowHistory.find.mockResolvedValue([]);

    const insights = await service.getForOwner(OWNER);

    const whereSql = stub.wheres.map(([text]) => text).join('\n');
    expect(whereSql).toContain(
      "(c.request_reason IS NULL OR c.request_reason NOT LIKE 'system:%')",
    );
    // Given only the legitimate row above (what Postgres returns once that
    // filter runs for real), a system:autoConnect row contributes nothing to
    // any of these.
    expect(insights.hellos).toBe(1);
    expect(insights.replies).toBe(1);
    expect(insights.perChip).toEqual([
      expect.objectContaining({ reason: 'open:coffee', count: 1 }),
    ]);
  });
});

describe('NowInsightsService.getRespondsWithin', () => {
  it('returns null under three answered requests', async () => {
    const { service, connections } = await buildService();
    connections.createQueryBuilder.mockReturnValue(
      connectionsQbStub([], { medianSeconds: '7200', answered: '2' }).qb,
    );
    expect(await service.getRespondsWithin(OWNER)).toBeNull();
  });

  it('returns null when the aggregate finds no answered row at all', async () => {
    const { service, connections } = await buildService();
    connections.createQueryBuilder.mockReturnValue(
      connectionsQbStub([], undefined).qb,
    );
    expect(await service.getRespondsWithin(OWNER)).toBeNull();
  });

  it('returns null when the median comes back as an unusable number', async () => {
    // `Number(null)` is 0 (a finite, if wrong, hour count), so this guard
    // only bites a genuinely non-numeric value; a real PERCENTILE_CONT NULL
    // always pairs with `answered: '0'`, which the floor above already
    // catches. This targets the `Number.isFinite` guard on its own.
    const { service, connections } = await buildService();
    connections.createQueryBuilder.mockReturnValue(
      connectionsQbStub([], { medianSeconds: 'NaN', answered: '5' }).qb,
    );
    expect(await service.getRespondsWithin(OWNER)).toBeNull();
  });

  it('buckets a median under 24 hours as day', async () => {
    const { service, connections } = await buildService();
    connections.createQueryBuilder.mockReturnValue(
      connectionsQbStub([], {
        medianSeconds: String(2 * 3600),
        answered: '3',
      }).qb,
    );
    expect(await service.getRespondsWithin(OWNER)).toBe('day');
  });

  it('buckets a median of three days as fewDays', async () => {
    const { service, connections } = await buildService();
    connections.createQueryBuilder.mockReturnValue(
      connectionsQbStub([], {
        medianSeconds: String(3 * 24 * 3600),
        answered: '4',
      }).qb,
    );
    expect(await service.getRespondsWithin(OWNER)).toBe('fewDays');
  });

  it('buckets a median of ten days as week', async () => {
    const { service, connections } = await buildService();
    connections.createQueryBuilder.mockReturnValue(
      connectionsQbStub([], {
        medianSeconds: String(10 * 24 * 3600),
        answered: '6',
      }).qb,
    );
    expect(await service.getRespondsWithin(OWNER)).toBe('week');
  });

  it('holds the day/fewDays/week edges at exactly 24 hours and 7 days', async () => {
    const { service, connections } = await buildService();
    connections.createQueryBuilder.mockReturnValue(
      connectionsQbStub([], {
        medianSeconds: String(24 * 3600),
        answered: '3',
      }).qb,
    );
    expect(await service.getRespondsWithin(OWNER)).toBe('day');

    connections.createQueryBuilder.mockReturnValue(
      connectionsQbStub([], {
        medianSeconds: String(24 * 3600 + 1),
        answered: '3',
      }).qb,
    );
    expect(await service.getRespondsWithin(OWNER)).toBe('fewDays');

    connections.createQueryBuilder.mockReturnValue(
      connectionsQbStub([], {
        medianSeconds: String(24 * 7 * 3600),
        answered: '3',
      }).qb,
    );
    expect(await service.getRespondsWithin(OWNER)).toBe('week');
  });

  it('excludes a system:autoConnect row from the response-time sample via a request_reason filter', async () => {
    // Same rationale as the getForOwner test above: an auto-connect row is
    // already Accepted with respondedAt set near-instantly, so left in the
    // median sample it can pull a genuinely slow responder's figure down to
    // "usually replies within a day" once MIN_ANSWERED_FOR_MEDIAN is met.
    // Filtering is Postgres's job; this locks that the service asks for it.
    const { service, connections } = await buildService();
    const stub = connectionsQbStub([], {
      medianSeconds: '7200',
      answered: '3',
    });
    connections.createQueryBuilder.mockReturnValue(stub.qb);

    await service.getRespondsWithin(OWNER);

    const whereSql = stub.wheres.map(([text]) => text);
    expect(whereSql).toEqual(
      expect.arrayContaining([
        "(c.request_reason IS NULL OR c.request_reason NOT LIKE 'system:%')",
      ]),
    );
  });

  it('requires an answered row and scopes the median to a 180 day window', async () => {
    // Mirrors the service's own private `RESPONSE_WINDOW_DAYS`, which isn't
    // exported (unlike `NOW_WINDOW_DAYS`). Kept in sync with the service by
    // the exact-equality assertion below: a drift between the two would fail
    // this test rather than pass silently.
    const RESPONSE_WINDOW_DAYS = 180;
    const { service, connections } = await buildService();
    const stub = connectionsQbStub([], {
      medianSeconds: '7200',
      answered: '3',
    });
    connections.createQueryBuilder.mockReturnValue(stub.qb);

    await service.getRespondsWithin(OWNER);

    const whereSql = stub.wheres.map(([text]) => text);
    expect(whereSql).toEqual(
      expect.arrayContaining([
        'c.addressee_id = :userId',
        'c.responded_at IS NOT NULL',
        'c.created_at >= :since',
      ]),
    );
    const since = stub.parameters.since as Date;
    // Time is frozen at NOW (file-level `jest.useFakeTimers` above): same
    // reasoning as the 90 day assertion above, an exact value instead of a
    // range two separate clock reads could disagree on.
    expect(since.getTime()).toBe(NOW - RESPONSE_WINDOW_DAYS * DAY_MS);
  });
});
