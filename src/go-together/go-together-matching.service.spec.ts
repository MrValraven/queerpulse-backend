import { FindOperator, In } from 'typeorm';
import { EventStatus } from '../events/entities/event.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { EventMatchConfig } from './entities/event-match-config.entity';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import { EventMatchGroup } from './entities/event-match-group.entity';
import { MatchFeedback } from './entities/match-feedback.entity';
import { MemberBlocker } from './go-together-eligibility.service';
import { isGoTogetherLaunched } from './go-together-launch.guard';
import {
  ACTIVE_MATCH_CONDITION,
  ACTIVE_MATCH_JOIN,
  GoTogetherMatchingService,
  MATCHING_LOCK_KEY,
  RETENTION_LOCK_KEY,
} from './go-together-matching.service';
import { ComponentScores, pairKey } from './go-together-scoring';

jest.mock('./go-together-launch.guard', () => ({
  isGoTogetherLaunched: jest.fn(() => true),
}));

const mockIsGoTogetherLaunched = isGoTogetherLaunched as jest.MockedFunction<
  typeof isGoTogetherLaunched
>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date('2026-10-01T12:00:00.000Z');

function hoursFromNow(hours: number): Date {
  return new Date(NOW.getTime() + hours * HOUR_MS);
}

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function asTime(value: unknown): number {
  return value instanceof Date ? value.getTime() : Number(value);
}

/** Enough of TypeORM's where semantics for these fixtures. */
function matchesWhere(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (!(expected instanceof FindOperator)) return row[key] === expected;
    const actual = row[key];
    switch (expected.type) {
      case 'in':
        return (expected.value as unknown[]).includes(actual);
      case 'isNull':
        return actual === null || actual === undefined;
      case 'not':
        if (expected.child?.type === 'isNull') {
          return actual !== null && actual !== undefined;
        }
        throw new Error('Unsupported Not() operand');
      case 'moreThan':
        return asTime(actual) > asTime(expected.value);
      case 'lessThanOrEqual':
        return (
          actual !== null &&
          actual !== undefined &&
          asTime(actual) <= asTime(expected.value)
        );
      default:
        throw new Error(`Unsupported operator ${expected.type}`);
    }
  });
}

interface BuilderCall {
  kind: 'update' | 'delete' | 'select';
  values: Row;
  clauses: string[];
  params: Row;
}

interface FakeQueryBuilder {
  update(): FakeQueryBuilder;
  delete(): FakeQueryBuilder;
  from(): FakeQueryBuilder;
  innerJoin(): FakeQueryBuilder;
  select(): FakeQueryBuilder;
  addSelect(): FakeQueryBuilder;
  set(values: Row): FakeQueryBuilder;
  where(clause: string, params?: Row): FakeQueryBuilder;
  andWhere(clause: string, params?: Row): FakeQueryBuilder;
  returning(): FakeQueryBuilder;
  execute(): Promise<unknown>;
  getRawMany(): Promise<unknown[]>;
}

/** A query builder that records the statement and hands it to `onExecute`,
 *  or to `onRawMany` for a read. */
function fakeQueryBuilder(
  calls: BuilderCall[],
  onExecute: (call: BuilderCall) => unknown,
  onRawMany: (call: BuilderCall) => unknown[],
): FakeQueryBuilder {
  const call: BuilderCall = {
    kind: 'update',
    values: {},
    clauses: [],
    params: {},
  };
  calls.push(call);
  const addClause = (clause: string, params: Row = {}): FakeQueryBuilder => {
    call.clauses.push(clause);
    Object.assign(call.params, params);
    return builder;
  };
  const builder: FakeQueryBuilder = {
    update: () => builder,
    delete: () => {
      call.kind = 'delete';
      return builder;
    },
    from: () => builder,
    innerJoin: () => builder,
    select: () => builder,
    addSelect: () => builder,
    set: (values: Row) => {
      call.values = values;
      return builder;
    },
    where: addClause,
    andWhere: addClause,
    returning: () => builder,
    execute: () => Promise.resolve(onExecute(call)),
    getRawMany: () => {
      call.kind = 'select';
      return Promise.resolve().then(() => onRawMany(call));
    },
  };
  return builder;
}

/** A repository over an in-memory table; updates write through. */
function inMemoryRepository<Entity extends object>(
  rows: Entity[],
  onExecute: (call: BuilderCall) => unknown = () => ({ raw: [], affected: 0 }),
  onRawMany: (call: BuilderCall) => unknown[] = () => [],
) {
  const read = (where: Where): Entity[] =>
    rows.filter((row) => matchesWhere(row as unknown as Row, where));
  const builderCalls: BuilderCall[] = [];
  return {
    rows,
    builderCalls,
    find: jest.fn((options: { where: Where }) =>
      Promise.resolve(read(options.where).map((row) => ({ ...row }))),
    ),
    count: jest.fn((options: { where: Where }) =>
      Promise.resolve(read(options.where).length),
    ),
    update: jest.fn((criteria: string | Where, patch: Partial<Entity>) => {
      const matched =
        typeof criteria === 'string'
          ? rows.filter((row) => (row as unknown as Row).id === criteria)
          : read(criteria);
      matched.forEach((row) => Object.assign(row, patch));
      return Promise.resolve({ affected: matched.length });
    }),
    create: jest.fn((input: Partial<Entity>) => ({ ...input })),
    save: jest.fn((input: Partial<Entity> | Partial<Entity>[]) => {
      const saved = Array.isArray(input) ? input : [input];
      rows.push(...(saved as Entity[]));
      return Promise.resolve(input);
    }),
    createQueryBuilder: jest.fn(() =>
      fakeQueryBuilder(builderCalls, onExecute, onRawMany),
    ),
  };
}

function config(
  eventId: string,
  overrides: Partial<EventMatchConfig> = {},
): EventMatchConfig {
  return {
    eventId,
    enabled: true,
    cutoffAt: hoursFromNow(-1),
    hostQuestions: [],
    meetingPointNote: null,
    matchedAt: null,
    lateGroupAt: null,
    feedbackPromptedAt: null,
    runCount: 0,
    createdAt: hoursFromNow(-200),
    updatedAt: hoursFromNow(-200),
    ...overrides,
  };
}

interface EventRow {
  id: string;
  slug: string;
  title: string;
  status: EventStatus;
  startAt: Date;
  endAt: Date | null;
}

function event(id: string, overrides: Partial<EventRow> = {}): EventRow {
  return {
    id,
    slug: `${id}-slug`,
    title: `Gathering ${id}`,
    status: EventStatus.Published,
    startAt: hoursFromNow(48),
    endAt: null,
    ...overrides,
  };
}

function entry(
  id: string,
  eventId: string,
  userId: string,
  overrides: Partial<EventMatchEntry> = {},
): EventMatchEntry {
  return {
    id,
    eventId,
    userId,
    pairPartnerId: null,
    pairStatus: 'none',
    hostAnswers: {},
    lens: 'queerPoc',
    lensConsentedAt: hoursFromNow(-100),
    status: 'waiting',
    groupId: null,
    mergeOfferGroupId: null,
    checkedInAt: null,
    leftEventAt: null,
    unmatchedNotifiedAt: null,
    createdAt: hoursFromNow(-100),
    updatedAt: hoursFromNow(-100),
    ...overrides,
  };
}

function group(
  id: string,
  eventId: string,
  overrides: Partial<EventMatchGroup> = {},
): EventMatchGroup {
  return {
    id,
    eventId,
    conversationId: `conversation-${id}`,
    band: 'strong',
    reasons: [],
    scoringVersion: 1,
    solverSeedLabel: `${eventId}:1`,
    pairComponents: null,
    formedAt: hoursFromNow(-72),
    dissolvedAt: null,
    trainingWrittenAt: null,
    ...overrides,
  };
}

function verdict(
  groupId: string,
  raterId: string,
  rateeId: string,
  answer: MatchFeedback['verdict'],
): MatchFeedback {
  return {
    id: `${raterId}-${rateeId}`,
    groupId,
    raterId,
    rateeId,
    verdict: answer,
    createdAt: hoursFromNow(-24),
    updatedAt: hoursFromNow(-24),
  };
}

function components(seed: number): ComponentScores {
  return {
    values: seed,
    interests: seed,
    energyIntent: seed,
    humour: seed,
    music: seed,
    ageArea: seed,
    hostBonus: 0,
  };
}

type ClaimColumn = 'matchedAt' | 'lateGroupAt' | 'feedbackPromptedAt';

interface Scenario {
  isLockFree?: boolean;
  configs?: EventMatchConfig[];
  events?: EventRow[];
  entries?: EventMatchEntry[];
  groups?: EventMatchGroup[];
  feedback?: MatchFeedback[];
  blocks?: { blockerId: string; blockedId: string }[];
  deletedCounts?: {
    groups: number;
    entries: number;
    configs: number;
    profiles: number;
  };
}

function build(scenario: Scenario = {}) {
  const isLockFree = scenario.isLockFree ?? true;
  const deletedCounts = scenario.deletedCounts ?? {
    groups: 0,
    entries: 0,
    configs: 0,
    profiles: 0,
  };
  const lockRunner = {
    connect: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn((sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) {
        return Promise.resolve([{ locked: isLockFree }]);
      }
      if (sql.includes('pg_advisory_unlock')) {
        return Promise.resolve([{ pg_advisory_unlock: true }]);
      }
      return Promise.reject(new Error(`Unmodelled query: ${sql}`));
    }),
  };
  const dataSource = { createQueryRunner: jest.fn(() => lockRunner) };

  const configRows = scenario.configs ?? [];
  const eventRows = scenario.events ?? [];
  const groupRows = scenario.groups ?? [];
  // The conditional claim UPDATE: only rows whose claim column is still null
  // (and that match the pass's conditions) are stamped and returned. The
  // cutoff claim uses the cutoff clamped to 7 days to 6 hours before the
  // event's current start, as the service's EXISTS clause does.
  // The active-match read: every config joined to its event, kept while the
  // event's end (or start, with no end) is after `activeSince`, or while its
  // prompt went out and one of its groups still holds per-pair scores.
  const readActiveMatches = (call: BuilderCall): Row[] =>
    configRows.flatMap((row) => {
      const eventRow = eventRows.find(
        (candidate) => candidate.id === row.eventId,
      );
      if (!eventRow) return [];
      const lastMomentMs = (eventRow.endAt ?? eventRow.startAt).getTime();
      const isRecent = lastMomentMs > asTime(call.params.activeSince);
      const hasOpenFeedback =
        row.feedbackPromptedAt !== null &&
        groupRows.some(
          (groupRow) =>
            groupRow.eventId === row.eventId &&
            groupRow.trainingWrittenAt === null &&
            groupRow.pairComponents !== null,
        );
      if (!isRecent && !hasOpenFeedback) return [];
      return [
        {
          event_id: row.eventId,
          enabled: row.enabled,
          matched_at: row.matchedAt,
          late_group_at: row.lateGroupAt,
          feedback_prompted_at: row.feedbackPromptedAt,
          slug: eventRow.slug,
          title: eventRow.title,
          status: eventRow.status,
          start_at: eventRow.startAt,
          end_at: eventRow.endAt,
        },
      ];
    });
  const configs = inMemoryRepository(
    configRows,
    (call) => {
      if (call.kind === 'delete') {
        return { raw: [], affected: deletedCounts.configs };
      }
      const column = Object.keys(call.values)[0] as ClaimColumn;
      const stampedAt = call.values[column] as Date;
      const claimed = configRows.filter((row) => {
        if (row[column] !== null) return false;
        if (column === 'matchedAt') {
          const eventRow = eventRows.find(
            (candidate) => candidate.id === row.eventId,
          );
          if (!row.enabled || !eventRow) return false;
          const startMs = eventRow.startAt.getTime();
          const effectiveCutoffMs = Math.min(
            Math.max(row.cutoffAt.getTime(), startMs - 7 * DAY_MS),
            startMs - 6 * HOUR_MS,
          );
          return effectiveCutoffMs <= asTime(call.params.now);
        }
        return (
          row.matchedAt !== null &&
          (call.params.eventIds as string[]).includes(row.eventId)
        );
      });
      claimed.forEach((row) => Object.assign(row, { [column]: stampedAt }));
      return { raw: claimed.map((row) => ({ event_id: row.eventId })) };
    },
    readActiveMatches,
  );
  const events = inMemoryRepository(eventRows);
  const entries = inMemoryRepository(scenario.entries ?? [], () => ({
    raw: [],
    affected: deletedCounts.entries,
  }));
  const groups = inMemoryRepository(groupRows, (call) => {
    if (call.kind === 'delete') {
      return { raw: [], affected: deletedCounts.groups };
    }
    const claimed = groupRows.filter(
      (row) => row.id === call.params.groupId && row.trainingWrittenAt === null,
    );
    claimed.forEach((row) => Object.assign(row, call.values));
    return { raw: claimed.map((row) => ({ id: row.id })) };
  });
  const feedback = inMemoryRepository(scenario.feedback ?? []);
  const trainingRows = inMemoryRepository<Row>([]);
  const profiles = inMemoryRepository<Row>([], () => ({
    raw: [],
    affected: deletedCounts.profiles,
  }));
  const blocks = inMemoryRepository(scenario.blocks ?? []);
  const eligibility = {
    memberBlockers: jest
      .fn()
      .mockResolvedValue(new Map<string, MemberBlocker>()),
  };
  const formation = {
    formForEvent: jest
      .fn()
      .mockResolvedValue({ groupsFormed: 1, unmatched: 0 }),
    placeLateJoiners: jest.fn().mockResolvedValue(0),
    formLateGroup: jest
      .fn()
      .mockResolvedValue({ groupsFormed: 0, unmatched: 0 }),
    removeMember: jest.fn().mockResolvedValue(undefined),
    dissolveEventGroups: jest.fn().mockResolvedValue(undefined),
    moveAfterBlock: jest.fn().mockResolvedValue(true),
  };
  const notifications = {
    createForRecipients: jest.fn().mockResolvedValue([]),
  };

  const service = new GoTogetherMatchingService(
    dataSource as never,
    events as never,
    configs as never,
    entries as never,
    groups as never,
    feedback as never,
    trainingRows as never,
    profiles as never,
    blocks as never,
    eligibility as never,
    formation as never,
    notifications as never,
  );
  const logger = (
    service as unknown as {
      logger: { log: jest.Mock; error: jest.Mock; debug: jest.Mock };
    }
  ).logger;
  const loggerLog = jest
    .spyOn(logger, 'log')
    .mockImplementation(() => undefined);
  const loggerError = jest
    .spyOn(logger, 'error')
    .mockImplementation(() => undefined);
  jest.spyOn(logger, 'debug').mockImplementation(() => undefined);

  return {
    service,
    dataSource,
    lockRunner,
    configs,
    events,
    entries,
    groups,
    feedback,
    trainingRows,
    profiles,
    blocks,
    eligibility,
    formation,
    notifications,
    loggerLog,
    loggerError,
  };
}

function unlockCalls(lockRunner: ReturnType<typeof build>['lockRunner']) {
  return lockRunner.query.mock.calls.filter(([sql]) =>
    sql.includes('pg_advisory_unlock'),
  );
}

function configOf(
  harness: ReturnType<typeof build>,
  eventId: string,
): EventMatchConfig {
  const row = harness.configs.rows.find(
    (candidate) => candidate.eventId === eventId,
  );
  if (!row) throw new Error(`No config for ${eventId}`);
  return row;
}

function entryOf(
  harness: ReturnType<typeof build>,
  entryId: string,
): EventMatchEntry {
  const row = harness.entries.rows.find(
    (candidate) => candidate.id === entryId,
  );
  if (!row) throw new Error(`No entry ${entryId}`);
  return row;
}

/** The active-match reads the harness served, one per tick that ran. */
function activeMatchReads(harness: ReturnType<typeof build>): BuilderCall[] {
  return harness.configs.builderCalls.filter((call) => call.kind === 'select');
}

describe('GoTogetherMatchingService', () => {
  afterEach(() => {
    jest.useRealTimers();
    mockIsGoTogetherLaunched.mockReturnValue(true);
  });

  describe('advisory lock', () => {
    it('uses two lock keys no other advisory lock uses, above the 32-bit hashtext range', () => {
      expect(MATCHING_LOCK_KEY).not.toBe(RETENTION_LOCK_KEY);
      for (const lockKey of [MATCHING_LOCK_KEY, RETENTION_LOCK_KEY]) {
        expect(lockKey).not.toBe(481205733107400);
        expect(lockKey).not.toBe(793640001);
        expect(lockKey).not.toBe(793_640_002_000);
        expect(lockKey).toBeGreaterThan(2 ** 31 - 1);
        expect(Number.isSafeInteger(lockKey)).toBe(true);
      }
    });

    it('skips every pass when another replica holds the lock, and still releases the runner', async () => {
      const harness = build({ isLockFree: false });
      const runPasses = jest.spyOn(harness.service, 'runPasses');

      await harness.service.tick();

      expect(harness.lockRunner.query).toHaveBeenCalledWith(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [MATCHING_LOCK_KEY],
      );
      expect(runPasses).not.toHaveBeenCalled();
      expect(harness.configs.find).not.toHaveBeenCalled();
      expect(harness.configs.createQueryBuilder).not.toHaveBeenCalled();
      expect(unlockCalls(harness.lockRunner)).toHaveLength(0);
      expect(harness.lockRunner.release).toHaveBeenCalledTimes(1);
    });

    it('unlocks and releases the runner even when the passes throw', async () => {
      const harness = build();
      jest
        .spyOn(harness.service, 'runPasses')
        .mockRejectedValue(new Error('database went away'));

      await expect(harness.service.tick()).resolves.toBeUndefined();

      expect(unlockCalls(harness.lockRunner)).toEqual([
        ['SELECT pg_advisory_unlock($1)', [MATCHING_LOCK_KEY]],
      ]);
      expect(harness.lockRunner.release).toHaveBeenCalledTimes(1);
      expect(harness.loggerError).toHaveBeenCalledWith(
        expect.stringContaining('database went away'),
      );
    });
  });

  describe('launch key', () => {
    it('runs only the reconcile safety pass while Go together is held dark', async () => {
      mockIsGoTogetherLaunched.mockReturnValue(false);
      const harness = build({
        configs: [
          config('event-grouped', { matchedAt: hoursFromNow(-2) }),
          config('event-due'),
          config('event-past', {
            matchedAt: hoursFromNow(-80),
            feedbackPromptedAt: new Date(NOW.getTime() - 8 * DAY_MS),
          }),
        ],
        events: [
          event('event-grouped', { startAt: hoursFromNow(5) }),
          event('event-due'),
          event('event-past', { startAt: hoursFromNow(-230) }),
        ],
        entries: [
          entry('entry-banned', 'event-grouped', 'user-banned', {
            status: 'grouped',
            groupId: 'group-1',
          }),
        ],
        groups: [
          group('group-past', 'event-past', {
            pairComponents: { [pairKey('user-a', 'user-b')]: components(1) },
          }),
        ],
      });
      harness.eligibility.memberBlockers.mockResolvedValue(
        new Map<string, MemberBlocker>([['user-banned', 'bannedFromEvent']]),
      );

      await harness.service.tick();

      // A member banned from the gathering still leaves their group.
      expect(harness.formation.removeMember).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-banned' }),
      );
      // Nothing forms, fills, prompts or writes training rows.
      expect(harness.formation.formForEvent).not.toHaveBeenCalled();
      expect(harness.formation.placeLateJoiners).not.toHaveBeenCalled();
      expect(harness.formation.formLateGroup).not.toHaveBeenCalled();
      expect(harness.notifications.createForRecipients).not.toHaveBeenCalled();
      expect(harness.trainingRows.save).not.toHaveBeenCalled();
      expect(configOf(harness, 'event-due').matchedAt).toBeNull();
      expect(
        harness.configs.builderCalls.filter((call) => call.kind === 'update'),
      ).toEqual([]);
    });

    it('runs the passes once the key is back on', async () => {
      const harness = build({
        configs: [config('event-a')],
        events: [event('event-a')],
      });

      await harness.service.tick();

      expect(harness.formation.formForEvent).toHaveBeenCalledWith('event-a');
    });

    it('keeps the retention sweep running while Go together is held dark', async () => {
      mockIsGoTogetherLaunched.mockReturnValue(false);
      jest.useFakeTimers({ now: NOW });
      const harness = build();

      await harness.service.retentionSweep();

      expect(harness.lockRunner.query).toHaveBeenCalledWith(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [RETENTION_LOCK_KEY],
      );
      expect(harness.groups.builderCalls[0]?.kind).toBe('delete');
      expect(harness.entries.builderCalls[0]?.kind).toBe('delete');
      expect(harness.configs.builderCalls[0]?.kind).toBe('delete');
    });
  });

  describe('active matches', () => {
    // TypeORM rewrites `alias.property` only when a space, comma or bracket
    // follows it; a path ending a line reaches Postgres raw. The fragments are
    // written in quoted snake_case so there is nothing to rewrite.
    it.each([
      ['condition', ACTIVE_MATCH_CONDITION],
      ['join', ACTIVE_MATCH_JOIN],
    ])('writes the active-match %s in quoted snake_case', (_name, fragment) => {
      expect(fragment).not.toMatch(/\b(config|event)\.\w+\s*\n/);
      expect(fragment).not.toMatch(/(^|[^"])\b(config|event)\.[a-zA-Z]/);
      expect(fragment).not.toMatch(/"[a-z_]*[A-Z]/);
    });

    it('names each column of the condition with its quoted alias', () => {
      expect(ACTIVE_MATCH_CONDITION).toContain(
        'COALESCE("event"."end_at", "event"."start_at") > :activeSince',
      );
      expect(ACTIVE_MATCH_CONDITION).toContain(
        '"config"."feedback_prompted_at" IS NOT NULL',
      );
      expect(ACTIVE_MATCH_CONDITION).toContain(
        '"open_group"."event_id" = "config"."event_id"',
      );
      expect(ACTIVE_MATCH_JOIN).toBe('"event"."id" = "config"."event_id"');
    });

    it('loads the configs once per tick, only for gatherings that ended under 14 days ago', async () => {
      const harness = build({
        configs: [
          config('event-upcoming', { matchedAt: hoursFromNow(-2) }),
          config('event-closing', {
            matchedAt: hoursFromNow(-400),
            feedbackPromptedAt: new Date(NOW.getTime() - 8 * DAY_MS),
          }),
          config('event-long-over', {
            matchedAt: hoursFromNow(-900),
            feedbackPromptedAt: new Date(NOW.getTime() - 8 * DAY_MS),
          }),
        ],
        events: [
          event('event-upcoming', { startAt: hoursFromNow(30) }),
          event('event-closing', {
            startAt: new Date(NOW.getTime() - 10 * DAY_MS),
            endAt: new Date(NOW.getTime() - 10 * DAY_MS + 3 * HOUR_MS),
          }),
          event('event-long-over', {
            startAt: new Date(NOW.getTime() - 20 * DAY_MS),
            endAt: new Date(NOW.getTime() - 20 * DAY_MS + 3 * HOUR_MS),
          }),
        ],
      });

      await harness.service.runPasses(NOW);

      const reads = activeMatchReads(harness);
      expect(reads).toHaveLength(1);
      expect(reads[0]?.params.activeSince).toEqual(
        new Date(NOW.getTime() - 14 * DAY_MS),
      );
      expect(reads[0]?.clauses).toHaveLength(1);
      expect(reads[0]?.clauses[0]).toContain(
        'COALESCE("event"."end_at", "event"."start_at") > :activeSince',
      );
      expect(reads[0]?.clauses[0]).toContain(
        '"open_group"."training_written_at" IS NULL',
      );
      // No pass re-reads configs or scans every open group on its own.
      expect(harness.configs.find).not.toHaveBeenCalled();
      const groupReads = harness.groups.find.mock.calls.map(
        ([options]) => options.where,
      );
      expect(groupReads).toHaveLength(1);
      expect(groupReads[0]?.eventId).toEqual(In(['event-closing']));
    });

    it('closes the feedback window when it falls due, however long ago the gathering was', async () => {
      // Held dark for a while: the prompt went out 8 days ago, on relaunch,
      // for a gathering 20 days over, which is outside the 14-day window.
      const harness = build({
        configs: [
          config('event-late', {
            matchedAt: hoursFromNow(-600),
            feedbackPromptedAt: new Date(NOW.getTime() - 8 * DAY_MS),
          }),
        ],
        events: [
          event('event-late', {
            startAt: new Date(NOW.getTime() - 20 * DAY_MS),
            endAt: new Date(NOW.getTime() - 20 * DAY_MS + 3 * HOUR_MS),
          }),
        ],
        groups: [
          group('group-late', 'event-late', {
            pairComponents: {
              [pairKey('user-ana', 'user-bea')]: components(0.8),
            },
          }),
        ],
        feedback: [
          verdict('group-late', 'user-ana', 'user-bea', 'yes'),
          verdict('group-late', 'user-bea', 'user-ana', 'yes'),
        ],
      });

      await harness.service.runPasses(NOW);

      const lateGroup = harness.groups.rows.find(
        (row) => row.id === 'group-late',
      );
      expect(lateGroup?.trainingWrittenAt).toEqual(NOW);
      expect(lateGroup?.pairComponents).toBeNull();
      expect(harness.trainingRows.rows).toHaveLength(1);
    });

    it('logs once and ends the tick when the shared read fails', async () => {
      const harness = build({
        configs: [config('event-a')],
        events: [event('event-a')],
      });
      harness.configs.createQueryBuilder.mockImplementationOnce(() => {
        const failing = fakeQueryBuilder(
          [],
          () => ({ raw: [] }),
          () => {
            throw new Error('read timed out');
          },
        );
        return failing;
      });

      await harness.service.runPasses(NOW);

      expect(harness.loggerError).toHaveBeenCalledTimes(1);
      expect(harness.loggerError).toHaveBeenCalledWith(
        expect.stringContaining('read timed out'),
      );
      expect(harness.formation.formForEvent).not.toHaveBeenCalled();
      expect(configOf(harness, 'event-a').matchedAt).toBeNull();
    });

    it('keeps running the other passes when one pass fails', async () => {
      const harness = build({
        configs: [
          config('event-due'),
          config('event-past', { matchedAt: hoursFromNow(-80) }),
        ],
        events: [
          event('event-due'),
          event('event-past', {
            startAt: hoursFromNow(-48),
            endAt: hoursFromNow(-44),
          }),
        ],
        entries: [
          entry('entry-ana', 'event-past', 'user-ana', {
            status: 'grouped',
            groupId: 'group-1',
          }),
        ],
        groups: [group('group-1', 'event-past')],
      });
      // The second builder is the cutoff claim: it fails outright.
      const createBuilder = harness.configs.createQueryBuilder;
      const realBuilder = createBuilder.getMockImplementation();
      let builderCount = 0;
      createBuilder.mockImplementation(() => {
        builderCount += 1;
        if (builderCount === 2) {
          return fakeQueryBuilder(
            [],
            () => {
              throw new Error('claim deadlocked');
            },
            () => [],
          );
        }
        return realBuilder!();
      });

      await harness.service.runPasses(NOW);

      expect(harness.loggerError).toHaveBeenCalledWith(
        expect.stringContaining('cutoff pass failed'),
      );
      expect(harness.formation.formForEvent).not.toHaveBeenCalled();
      // The feedback prompt pass still ran after the failed cutoff.
      expect(harness.notifications.createForRecipients).toHaveBeenCalledTimes(
        1,
      );
      expect(configOf(harness, 'event-past').feedbackPromptedAt).toEqual(NOW);
    });

    it('shows a claim the cutoff pass kept to the later passes of the same tick', async () => {
      // Moved to 5.5 hours out after its cutoff was saved: formation and the
      // late group both fall due in one tick.
      const harness = build({
        configs: [config('event-soon', { cutoffAt: hoursFromNow(20) })],
        events: [event('event-soon', { startAt: hoursFromNow(5.5) })],
      });

      await harness.service.runPasses(NOW);

      expect(harness.formation.formForEvent).toHaveBeenCalledWith('event-soon');
      expect(harness.formation.formLateGroup).toHaveBeenCalledWith(
        'event-soon',
      );
      expect(activeMatchReads(harness)).toHaveLength(1);
    });
  });

  describe('cutoff pass', () => {
    it('forms each claimed event once, and a second run whose claim returns nothing forms none', async () => {
      const harness = build({
        configs: [
          config('event-a'),
          config('event-b'),
          config('event-later', { cutoffAt: hoursFromNow(5) }),
        ],
        events: [event('event-a'), event('event-b'), event('event-later')],
      });

      await harness.service.runPasses(NOW);

      expect(harness.formation.formForEvent.mock.calls).toEqual([
        ['event-a'],
        ['event-b'],
      ]);
      expect(configOf(harness, 'event-a').matchedAt).toEqual(NOW);
      expect(configOf(harness, 'event-later').matchedAt).toBeNull();
      const cutoffClaim = harness.configs.builderCalls.find(
        (call) => 'matchedAt' in call.values,
      );
      expect(cutoffClaim?.clauses.slice(0, 2)).toEqual([
        'enabled = true',
        'matched_at IS NULL',
      ]);
      const effectiveCutoffClause = cutoffClaim?.clauses[2] ?? '';
      expect(effectiveCutoffClause).toContain(
        `GREATEST("event_match_configs"."cutoff_at", "scheduled_event"."start_at" - interval '7 days')`,
      );
      expect(effectiveCutoffClause).toContain(
        `"scheduled_event"."start_at" - interval '6 hours'`,
      );
      expect(effectiveCutoffClause).toContain(') <= :now');

      await harness.service.runPasses(new Date(NOW.getTime() + 5 * 60 * 1000));

      expect(harness.formation.formForEvent).toHaveBeenCalledTimes(2);
    });

    it('does not claim early when the gathering moved later after its cutoff was saved', async () => {
      // Saved for a start 2 days out; the start then moved 30 days out, so
      // the effective cutoff is 7 days before the new start.
      const harness = build({
        configs: [config('event-moved', { cutoffAt: hoursFromNow(-1) })],
        events: [event('event-moved', { startAt: hoursFromNow(30 * 24) })],
      });

      await harness.service.runPasses(NOW);

      expect(harness.formation.formForEvent).not.toHaveBeenCalled();
      expect(configOf(harness, 'event-moved').matchedAt).toBeNull();
    });

    it('claims at 6 hours before the start when the gathering moved earlier than its cutoff', async () => {
      // The saved cutoff is after the new start; the effective cutoff is
      // 6 hours before the new start, which has just passed.
      const harness = build({
        configs: [config('event-moved', { cutoffAt: hoursFromNow(20) })],
        events: [event('event-moved', { startAt: hoursFromNow(5.5) })],
      });

      await harness.service.runPasses(NOW);

      expect(harness.formation.formForEvent).toHaveBeenCalledWith(
        'event-moved',
      );
      expect(configOf(harness, 'event-moved').matchedAt).toEqual(NOW);
    });

    it('hands the claim back for an upcoming draft gathering so a republish still forms groups', async () => {
      const harness = build({
        configs: [config('event-draft')],
        events: [event('event-draft', { status: EventStatus.Draft })],
      });

      await harness.service.runPasses(NOW);

      expect(harness.formation.formForEvent).not.toHaveBeenCalled();
      expect(configOf(harness, 'event-draft').matchedAt).toBeNull();

      harness.events.rows[0]!.status = EventStatus.Published;
      await harness.service.runPasses(new Date(NOW.getTime() + 5 * 60 * 1000));

      expect(harness.formation.formForEvent).toHaveBeenCalledWith(
        'event-draft',
      );
    });

    it('keeps the claim of a cancelled gathering without forming', async () => {
      const harness = build({
        configs: [config('event-cancelled')],
        events: [event('event-cancelled', { status: EventStatus.Cancelled })],
      });

      await harness.service.runPasses(NOW);

      expect(harness.formation.formForEvent).not.toHaveBeenCalled();
      expect(configOf(harness, 'event-cancelled').matchedAt).toEqual(NOW);
    });

    it('releases the claim of a failed formation and still forms the next event', async () => {
      const harness = build({
        configs: [config('event-a'), config('event-b')],
        events: [event('event-a'), event('event-b')],
      });
      harness.formation.formForEvent.mockImplementation((eventId: string) =>
        eventId === 'event-a'
          ? Promise.reject(new Error('solver exploded'))
          : Promise.resolve({ groupsFormed: 2, unmatched: 1 }),
      );

      await harness.service.runPasses(NOW);

      expect(harness.formation.formForEvent.mock.calls).toEqual([
        ['event-a'],
        ['event-b'],
      ]);
      expect(configOf(harness, 'event-a').matchedAt).toBeNull();
      expect(configOf(harness, 'event-b').matchedAt).toEqual(NOW);
      expect(harness.loggerError).toHaveBeenCalledWith(
        expect.stringContaining('solver exploded'),
      );
    });
  });

  describe('reconcile pass', () => {
    const matchedConfig = () =>
      config('event-a', { matchedAt: hoursFromNow(-2) });

    it('removes a grouped member who is no longer going and withdraws a blocked waiting member without any chat call', async () => {
      const harness = build({
        configs: [matchedConfig()],
        events: [event('event-a')],
        entries: [
          entry('entry-grouped', 'event-a', 'user-grouped', {
            status: 'grouped',
            groupId: 'group-1',
          }),
          entry('entry-staying', 'event-a', 'user-staying', {
            status: 'grouped',
            groupId: 'group-1',
          }),
          entry('entry-waiting', 'event-a', 'user-waiting', {
            pairStatus: 'accepted',
            pairPartnerId: 'user-partner',
          }),
          entry('entry-partner', 'event-a', 'user-partner', {
            pairStatus: 'accepted',
            pairPartnerId: 'user-waiting',
          }),
          entry('entry-gone', 'event-a', 'user-gone', { status: 'withdrawn' }),
        ],
      });
      harness.eligibility.memberBlockers.mockResolvedValue(
        new Map<string, MemberBlocker>([
          ['user-grouped', 'notGoing'],
          ['user-waiting', 'notVerified'],
        ]),
      );

      await harness.service.runPasses(NOW);

      expect(harness.eligibility.memberBlockers).toHaveBeenCalledWith(
        'event-a',
        ['user-grouped', 'user-staying', 'user-waiting', 'user-partner'],
        NOW,
      );
      expect(harness.formation.removeMember).toHaveBeenCalledTimes(1);
      expect(harness.formation.removeMember).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'entry-grouped',
          userId: 'user-grouped',
        }),
      );
      expect(entryOf(harness, 'entry-waiting')).toMatchObject({
        status: 'withdrawn',
        pairStatus: 'none',
        pairPartnerId: null,
        lens: null,
        lensConsentedAt: null,
      });
      // The accepted partner goes back to waiting alone.
      expect(entryOf(harness, 'entry-partner')).toMatchObject({
        status: 'waiting',
        pairStatus: 'none',
        pairPartnerId: null,
      });
      expect(entryOf(harness, 'entry-staying').status).toBe('grouped');
      expect(harness.formation.dissolveEventGroups).not.toHaveBeenCalled();
    });

    it('moves the blocker out of a group that seated a blocked pair together, and leaves other groups alone', async () => {
      const harness = build({
        configs: [matchedConfig()],
        events: [event('event-a')],
        entries: [
          entry('entry-blocker', 'event-a', 'user-blocker', {
            status: 'grouped',
            groupId: 'group-1',
          }),
          entry('entry-blocked', 'event-a', 'user-blocked', {
            status: 'grouped',
            groupId: 'group-1',
          }),
          entry('entry-apart', 'event-a', 'user-apart', {
            status: 'grouped',
            groupId: 'group-2',
          }),
          entry('entry-waiting', 'event-a', 'user-waiting'),
        ],
        blocks: [
          { blockerId: 'user-blocker', blockedId: 'user-blocked' },
          // Already in different groups: nothing to do.
          { blockerId: 'user-apart', blockedId: 'user-blocked' },
          // Not seated: the pool's hard filter handles it.
          { blockerId: 'user-waiting', blockedId: 'user-blocker' },
        ],
      });
      const warn = jest
        .spyOn(
          (
            harness.service as unknown as {
              logger: { warn: (text: string) => void };
            }
          ).logger,
          'warn',
        )
        .mockImplementation(() => undefined);

      await harness.service.runPasses(NOW);

      expect(harness.formation.moveAfterBlock).toHaveBeenCalledTimes(1);
      expect(harness.formation.moveAfterBlock).toHaveBeenCalledWith(
        'event-a',
        'user-blocker',
        'user-blocked',
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('group-1'));
      expect(harness.formation.removeMember).not.toHaveBeenCalled();
    });

    it('does not log a separation when moveAfterBlock made no move', async () => {
      const harness = build({
        configs: [matchedConfig()],
        events: [event('event-a')],
        entries: [
          entry('entry-blocker', 'event-a', 'user-blocker', {
            status: 'grouped',
            groupId: 'group-1',
          }),
          entry('entry-blocked', 'event-a', 'user-blocked', {
            status: 'grouped',
            groupId: 'group-1',
          }),
        ],
        blocks: [{ blockerId: 'user-blocker', blockedId: 'user-blocked' }],
      });
      harness.formation.moveAfterBlock.mockResolvedValue(false);
      const warn = jest
        .spyOn(
          (
            harness.service as unknown as {
              logger: { warn: (text: string) => void };
            }
          ).logger,
          'warn',
        )
        .mockImplementation(() => undefined);

      await harness.service.runPasses(NOW);

      expect(harness.formation.moveAfterBlock).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not look for blocked pairs among members it just removed', async () => {
      const harness = build({
        configs: [matchedConfig()],
        events: [event('event-a')],
        entries: [
          entry('entry-blocker', 'event-a', 'user-blocker', {
            status: 'grouped',
            groupId: 'group-1',
          }),
          entry('entry-blocked', 'event-a', 'user-blocked', {
            status: 'grouped',
            groupId: 'group-1',
          }),
        ],
        blocks: [{ blockerId: 'user-blocker', blockedId: 'user-blocked' }],
      });
      harness.eligibility.memberBlockers.mockResolvedValue(
        new Map<string, MemberBlocker>([['user-blocker', 'notGoing']]),
      );

      await harness.service.runPasses(NOW);

      expect(harness.formation.removeMember).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-blocker' }),
      );
      expect(harness.blocks.find).not.toHaveBeenCalled();
      expect(harness.formation.moveAfterBlock).not.toHaveBeenCalled();
    });

    it('clears a pending invite whose invited friend became ineligible, and checks that friend too', async () => {
      const harness = build({
        configs: [matchedConfig()],
        events: [event('event-a')],
        entries: [
          entry('entry-inviter', 'event-a', 'user-inviter', {
            pairStatus: 'pending',
            pairPartnerId: 'user-friend',
          }),
        ],
      });
      harness.eligibility.memberBlockers.mockResolvedValue(
        new Map<string, MemberBlocker>([['user-friend', 'bannedFromEvent']]),
      );

      await harness.service.runPasses(NOW);

      expect(harness.eligibility.memberBlockers).toHaveBeenCalledWith(
        'event-a',
        ['user-inviter', 'user-friend'],
        NOW,
      );
      expect(entryOf(harness, 'entry-inviter')).toMatchObject({
        status: 'waiting',
        pairStatus: 'none',
        pairPartnerId: null,
      });
      expect(harness.formation.removeMember).not.toHaveBeenCalled();
    });

    it('dissolves the groups of a cancelled gathering and does nothing else for it', async () => {
      const harness = build({
        configs: [matchedConfig()],
        events: [event('event-a', { status: EventStatus.Cancelled })],
        entries: [
          entry('entry-grouped', 'event-a', 'user-grouped', {
            status: 'grouped',
            groupId: 'group-1',
          }),
          entry('entry-waiting', 'event-a', 'user-waiting'),
        ],
        groups: [group('group-1', 'event-a')],
      });

      await harness.service.runPasses(NOW);

      expect(harness.formation.dissolveEventGroups).toHaveBeenCalledTimes(1);
      expect(harness.formation.dissolveEventGroups).toHaveBeenCalledWith(
        'event-a',
      );
      expect(harness.eligibility.memberBlockers).not.toHaveBeenCalled();
      expect(harness.formation.removeMember).not.toHaveBeenCalled();
      expect(harness.formation.formForEvent).not.toHaveBeenCalled();
      expect(harness.formation.placeLateJoiners).not.toHaveBeenCalled();
      expect(harness.formation.formLateGroup).not.toHaveBeenCalled();
    });

    it('leaves an already dissolved cancelled gathering alone', async () => {
      const harness = build({
        configs: [matchedConfig()],
        events: [event('event-a', { status: EventStatus.Cancelled })],
        entries: [
          entry('entry-gone', 'event-a', 'user-gone', { status: 'withdrawn' }),
        ],
        groups: [
          group('group-1', 'event-a', { dissolvedAt: hoursFromNow(-1) }),
        ],
      });

      await harness.service.runPasses(NOW);

      expect(harness.formation.dissolveEventGroups).not.toHaveBeenCalled();
    });
  });

  describe('late joiner pass', () => {
    it('runs only for matched events more than 6 hours before the start that hold a pending entry', async () => {
      const harness = build({
        configs: [
          config('event-far', { matchedAt: hoursFromNow(-2) }),
          config('event-near', { matchedAt: hoursFromNow(-2) }),
          config('event-unmatched', { cutoffAt: hoursFromNow(10) }),
          config('event-settled', { matchedAt: hoursFromNow(-2) }),
        ],
        events: [
          event('event-far', { startAt: hoursFromNow(7) }),
          event('event-near', { startAt: hoursFromNow(5) }),
          event('event-unmatched', { startAt: hoursFromNow(30) }),
          event('event-settled', { startAt: hoursFromNow(30) }),
        ],
        entries: [
          entry('entry-far', 'event-far', 'user-far', { status: 'unmatched' }),
          entry('entry-near', 'event-near', 'user-near'),
          entry('entry-unmatched', 'event-unmatched', 'user-unmatched'),
          entry('entry-settled', 'event-settled', 'user-settled', {
            status: 'grouped',
            groupId: 'group-settled',
          }),
        ],
      });

      await harness.service.runPasses(NOW);

      // event-near is inside the 6 hours, so only the late-group pass (which
      // follows the late-joiner pass) places its joiners, then forms a group.
      expect(harness.formation.placeLateJoiners.mock.calls).toEqual([
        ['event-far'],
        ['event-near'],
      ]);
      expect(harness.formation.formLateGroup.mock.calls).toEqual([
        ['event-near'],
      ]);
    });
  });

  describe('late group pass', () => {
    it('claims late_group_at once and places late joiners before forming the late group', async () => {
      const harness = build({
        configs: [config('event-near', { matchedAt: hoursFromNow(-30) })],
        events: [event('event-near', { startAt: hoursFromNow(5) })],
      });

      await harness.service.runPasses(NOW);
      await harness.service.runPasses(new Date(NOW.getTime() + 5 * 60 * 1000));

      expect(harness.formation.placeLateJoiners).toHaveBeenCalledTimes(1);
      expect(harness.formation.formLateGroup).toHaveBeenCalledTimes(1);
      expect(harness.formation.placeLateJoiners).toHaveBeenCalledWith(
        'event-near',
      );
      expect(
        harness.formation.placeLateJoiners.mock.invocationCallOrder[0],
      ).toBeLessThan(
        harness.formation.formLateGroup.mock.invocationCallOrder[0]!,
      );
      expect(configOf(harness, 'event-near').lateGroupAt).toEqual(NOW);
      const lateGroupClaim = harness.configs.builderCalls.find(
        (call) => 'lateGroupAt' in call.values,
      );
      expect(lateGroupClaim?.clauses).toEqual([
        'event_id IN (:...eventIds)',
        'matched_at IS NOT NULL',
        'late_group_at IS NULL',
      ]);
      expect(lateGroupClaim?.params.eventIds).toEqual(['event-near']);
    });

    it('hands the late-group claim back while the gathering is an upcoming draft', async () => {
      const harness = build({
        configs: [config('event-near', { matchedAt: hoursFromNow(-30) })],
        events: [
          event('event-near', {
            status: EventStatus.Draft,
            startAt: hoursFromNow(5),
          }),
        ],
      });

      await harness.service.runPasses(NOW);

      expect(harness.formation.placeLateJoiners).not.toHaveBeenCalled();
      expect(harness.formation.formLateGroup).not.toHaveBeenCalled();
      expect(configOf(harness, 'event-near').lateGroupAt).toBeNull();
    });
  });

  describe('feedback prompt pass', () => {
    it('sends GoTogetherMeetAgain once per group with its groupId and nulls every lens of the event', async () => {
      const harness = build({
        configs: [
          config('event-past', { matchedAt: hoursFromNow(-80) }),
          config('event-recent', { matchedAt: hoursFromNow(-80) }),
        ],
        events: [
          event('event-past', {
            startAt: hoursFromNow(-48),
            endAt: hoursFromNow(-44),
          }),
          event('event-recent', {
            startAt: hoursFromNow(-3),
            endAt: hoursFromNow(-1),
          }),
        ],
        entries: [
          entry('entry-ana', 'event-past', 'user-ana', {
            status: 'grouped',
            groupId: 'group-1',
          }),
          entry('entry-bea', 'event-past', 'user-bea', {
            status: 'grouped',
            groupId: 'group-1',
          }),
          entry('entry-cai', 'event-past', 'user-cai', {
            status: 'grouped',
            groupId: 'group-2',
          }),
          entry('entry-dan', 'event-past', 'user-dan', {
            status: 'grouped',
            groupId: 'group-2',
          }),
          entry('entry-eli', 'event-past', 'user-eli', {
            status: 'withdrawn',
          }),
          entry('entry-recent', 'event-recent', 'user-recent', {
            status: 'grouped',
            groupId: 'group-3',
          }),
        ],
        groups: [
          group('group-1', 'event-past'),
          group('group-2', 'event-past'),
          group('group-3', 'event-recent'),
        ],
      });

      await harness.service.runPasses(NOW);
      await harness.service.runPasses(new Date(NOW.getTime() + 5 * 60 * 1000));

      expect(harness.notifications.createForRecipients.mock.calls).toEqual([
        [
          ['user-ana', 'user-bea'],
          NotificationType.GoTogetherMeetAgain,
          {
            eventId: 'event-past',
            eventSlug: 'event-past-slug',
            eventTitle: 'Gathering event-past',
            groupId: 'group-1',
          },
        ],
        [
          ['user-cai', 'user-dan'],
          NotificationType.GoTogetherMeetAgain,
          {
            eventId: 'event-past',
            eventSlug: 'event-past-slug',
            eventTitle: 'Gathering event-past',
            groupId: 'group-2',
          },
        ],
      ]);
      for (const entryId of [
        'entry-ana',
        'entry-bea',
        'entry-cai',
        'entry-dan',
        'entry-eli',
      ]) {
        expect(entryOf(harness, entryId)).toMatchObject({
          lens: null,
          lensConsentedAt: null,
        });
      }
      expect(entryOf(harness, 'entry-recent').lens).toBe('queerPoc');
      expect(configOf(harness, 'event-past').feedbackPromptedAt).toEqual(NOW);
      expect(configOf(harness, 'event-recent').feedbackPromptedAt).toBeNull();
    });
  });

  describe('feedback close pass', () => {
    it('writes one training row per pair where both answered, then nulls the scores and stamps the group', async () => {
      const componentsAnaBea = components(0.9);
      const componentsAnaCai = components(0.6);
      const componentsBeaCai = components(0.3);
      const harness = build({
        configs: [
          config('event-old', {
            matchedAt: hoursFromNow(-400),
            feedbackPromptedAt: new Date(NOW.getTime() - 8 * DAY_MS),
          }),
          config('event-fresh', {
            matchedAt: hoursFromNow(-100),
            feedbackPromptedAt: new Date(NOW.getTime() - 2 * DAY_MS),
          }),
        ],
        events: [
          event('event-old', { startAt: hoursFromNow(-230) }),
          event('event-fresh', { startAt: hoursFromNow(-80) }),
        ],
        groups: [
          group('group-old', 'event-old', {
            scoringVersion: 3,
            pairComponents: {
              [pairKey('user-ana', 'user-bea')]: componentsAnaBea,
              [pairKey('user-ana', 'user-cai')]: componentsAnaCai,
              [pairKey('user-bea', 'user-cai')]: componentsBeaCai,
            },
          }),
          group('group-fresh', 'event-fresh', {
            pairComponents: {
              [pairKey('user-dan', 'user-eli')]: components(0.5),
            },
          }),
        ],
        feedback: [
          verdict('group-old', 'user-ana', 'user-bea', 'yes'),
          verdict('group-old', 'user-bea', 'user-ana', 'yes'),
          verdict('group-old', 'user-ana', 'user-cai', 'yes'),
          verdict('group-old', 'user-cai', 'user-ana', 'no'),
          // Only one direction for bea and cai: no training row.
          verdict('group-old', 'user-bea', 'user-cai', 'maybe'),
        ],
      });

      await harness.service.runPasses(NOW);
      await harness.service.runPasses(new Date(NOW.getTime() + 5 * 60 * 1000));

      expect(harness.trainingRows.save).toHaveBeenCalledTimes(1);
      expect(harness.trainingRows.rows).toEqual([
        { scoringVersion: 3, components: componentsAnaBea, mutualYes: true },
        { scoringVersion: 3, components: componentsAnaCai, mutualYes: false },
      ]);
      const oldGroup = harness.groups.rows.find(
        (row) => row.id === 'group-old',
      );
      expect(oldGroup?.pairComponents).toBeNull();
      expect(oldGroup?.trainingWrittenAt).toEqual(NOW);
      const freshGroup = harness.groups.rows.find(
        (row) => row.id === 'group-fresh',
      );
      expect(freshGroup?.pairComponents).not.toBeNull();
      expect(freshGroup?.trainingWrittenAt).toBeNull();
    });
  });

  describe('retention sweep', () => {
    it('deletes groups, entries and configs of gatherings over 90 days old and questionnaires idle for 12 months, under its own lock', async () => {
      jest.useFakeTimers({ now: NOW });
      const harness = build({
        deletedCounts: { groups: 2, entries: 9, configs: 3, profiles: 4 },
      });

      await harness.service.retentionSweep();

      expect(harness.lockRunner.query).toHaveBeenCalledWith(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [RETENTION_LOCK_KEY],
      );
      const eventsBefore = new Date(NOW.getTime() - 90 * DAY_MS);
      const [groupDelete] = harness.groups.builderCalls;
      expect(groupDelete).toMatchObject({
        kind: 'delete',
        params: { eventsBefore },
      });
      expect(groupDelete?.clauses[0]).toContain('"start_at" < :eventsBefore');
      const [entryDelete] = harness.entries.builderCalls;
      expect(entryDelete).toMatchObject({
        kind: 'delete',
        params: { eventsBefore },
      });
      expect(entryDelete?.clauses[0]).toContain('"start_at" < :eventsBefore');
      // The host's config goes on the same schedule, after the rows that
      // belong to its gathering.
      const [configDelete] = harness.configs.builderCalls;
      expect(configDelete).toMatchObject({
        kind: 'delete',
        params: { eventsBefore },
      });
      expect(configDelete?.clauses[0]).toContain('"start_at" < :eventsBefore');
      const [groupBuilderOrder] =
        harness.groups.createQueryBuilder.mock.invocationCallOrder;
      const [entryBuilderOrder] =
        harness.entries.createQueryBuilder.mock.invocationCallOrder;
      const [configBuilderOrder] =
        harness.configs.createQueryBuilder.mock.invocationCallOrder;
      expect(groupBuilderOrder).toBeLessThan(entryBuilderOrder!);
      expect(entryBuilderOrder).toBeLessThan(configBuilderOrder!);
      // Every lens goes once its gathering ended, matched or not.
      const lensClear = harness.entries.builderCalls[1];
      expect(lensClear).toMatchObject({
        kind: 'update',
        values: { lens: null, lensConsentedAt: null },
        params: { now: NOW },
      });
      expect(lensClear?.clauses[0]).toContain(
        'COALESCE("end_at", "start_at") < :now',
      );
      expect(lensClear?.clauses[1]).toContain('"lens" IS NOT NULL');
      const [profileDelete] = harness.profiles.builderCalls;
      expect(profileDelete).toMatchObject({
        kind: 'delete',
        params: { idleBefore: new Date(NOW.getTime() - 365 * DAY_MS) },
      });
      expect(profileDelete?.clauses[0]).toContain('"last_used_at"');
      expect(harness.loggerLog).toHaveBeenCalledWith(
        expect.stringMatching(/2 group.*9 entr.*3 config.*4 questionnaire/),
      );
      expect(unlockCalls(harness.lockRunner)).toEqual([
        ['SELECT pg_advisory_unlock($1)', [RETENTION_LOCK_KEY]],
      ]);
      expect(harness.lockRunner.release).toHaveBeenCalledTimes(1);
    });
  });
});
