import { ConflictException, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator } from 'typeorm';
import { Event } from '../events/entities/event.entity';
import { GroupsService } from '../messaging/groups.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { EventMatchConfig } from './entities/event-match-config.entity';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import { EventMatchGroup } from './entities/event-match-group.entity';
import {
  GoTogetherFormationService,
  MERGE_EXPIRED_CODE,
} from './go-together-formation.service';
import { MatchGraph, MatchUnit } from './go-together-grouping';
import { GoTogetherHouseService } from './go-together-house.service';
import {
  GoTogetherPoolService,
  MatchPool,
  placeOf,
} from './go-together-pool.service';
import { FriendMatchAnswers } from './go-together-questionnaire.catalog';
import {
  ComponentScores,
  SCORING_VERSION,
  pairKey,
} from './go-together-scoring';

const EVENT_ID = 'event-1';
const HOUSE_ID = 'house-1';
const EVENT = {
  id: EVENT_ID,
  slug: 'pride-picnic',
  title: 'Pride picnic',
  startAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
};
const EVENT_PAYLOAD = {
  eventId: EVENT_ID,
  eventSlug: 'pride-picnic',
  eventTitle: 'Pride picnic',
};
const PAIR_SCORE = 0.8;
const COMPONENTS: ComponentScores = {
  values: 0.8,
  interests: 0.8,
  energyIntent: 0.8,
  humour: 0.8,
  music: 0.8,
  ageArea: 0.8,
  hostBonus: 0,
};

const ANSWERS: FriendMatchAnswers = {
  values: {
    community: 4,
    creativity: 4,
    family: 3,
    fun: 5,
    career: 2,
    spirituality: 1,
  },
  humour: { h1: 'a', h2: 'a', h3: 'b', h4: 'a' },
  interests: ['boardGames', 'queerHistory', 'hiking'],
  music: ['pop', 'indie'],
  energy: { talker: 4, nightShape: 2, planner: 3 },
  intent: 'closeFriends',
  meetFrequency: 'fewTimesAMonth',
  languages: ['pt', 'en'],
  drinking: 'eitherWay',
  ageBracket: '25-34',
  agePreference: 'any',
  area: 'Arroios',
};

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/** Enough of TypeORM's where semantics for these fixtures: equality, In and IsNull. */
function matchesWhere(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected instanceof FindOperator) {
      if (expected.type === 'in')
        return (expected.value as unknown[]).includes(row[key]);
      if (expected.type === 'isNull') return row[key] === null;
      throw new Error(`Unsupported operator ${expected.type}`);
    }
    return row[key] === expected;
  });
}

/** A repository over an in-memory table. Reads return copies, the way
 *  TypeORM returns fresh entities, and updates write through to the table. */
function inMemoryRepository<Entity extends { id: string }>(
  rows: Entity[],
  nextId: () => string,
) {
  const read = (where: Where): Entity[] =>
    rows.filter((row) => matchesWhere(row as unknown as Row, where));
  return {
    rows,
    find: jest.fn(async (options: { where: Where }) =>
      read(options.where).map((row) => ({ ...row })),
    ),
    findOne: jest.fn(async (options: { where: Where }) => {
      const row = read(options.where)[0];
      return row ? { ...row } : null;
    }),
    count: jest.fn(
      async (options: { where: Where }) => read(options.where).length,
    ),
    update: jest.fn(
      async (criteria: string | Where, patch: Partial<Entity>) => {
        const matched =
          typeof criteria === 'string'
            ? rows.filter((row) => row.id === criteria)
            : read(criteria);
        matched.forEach((row) => Object.assign(row, patch));
        return { affected: matched.length };
      },
    ),
    create: jest.fn((input: Partial<Entity>) => ({ ...input })),
    save: jest.fn(async (input: Partial<Entity>) => {
      const saved = {
        formedAt: new Date(),
        ...input,
        id: input.id ?? nextId(),
      } as unknown as Entity;
      rows.push(saved);
      return { ...saved };
    }),
  };
}

function entryRow(
  name: string,
  overrides: Partial<EventMatchEntry> = {},
): EventMatchEntry {
  return {
    id: `entry-${name}`,
    eventId: EVENT_ID,
    userId: `user-${name}`,
    pairPartnerId: null,
    pairStatus: 'none',
    hostAnswers: {},
    lens: null,
    lensConsentedAt: null,
    status: 'waiting',
    groupId: null,
    mergeOfferGroupId: null,
    checkedInAt: null,
    leftEventAt: null,
    unmatchedNotifiedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function groupedRows(groupId: string, names: string[]): EventMatchEntry[] {
  return names.map((name) => entryRow(name, { status: 'grouped', groupId }));
}

function groupRow(
  id: string,
  overrides: Partial<EventMatchGroup> = {},
): EventMatchGroup {
  return {
    id,
    eventId: EVENT_ID,
    conversationId: `conversation-${id}`,
    band: 'good',
    reasons: [],
    scoringVersion: SCORING_VERSION,
    solverSeedLabel: `${EVENT_ID}:1`,
    pairComponents: null,
    formedAt: new Date(0),
    dissolvedAt: null,
    trainingWrittenAt: null,
    ...overrides,
  };
}

/**
 * A pool where every pair scores the same and every pair is feasible unless
 * listed. It follows the real rules: a seated member without a questionnaire
 * stays in as an answerless member, a pending one is skipped, and a mutually
 * accepted pair is one unit only while both sit in the same place.
 */
function poolFrom(
  poolEntries: EventMatchEntry[],
  infeasiblePairs: ReadonlySet<string>,
  missingProfiles: ReadonlySet<string>,
): { pool: MatchPool; skippedEntryIds: string[] } {
  const isSkipped = (entry: EventMatchEntry): boolean =>
    missingProfiles.has(entry.userId) && placeOf(entry) === 'pending';
  const members = poolEntries
    .filter((entry) => !isSkipped(entry))
    .map((entry) => ({
      entry,
      candidate: missingProfiles.has(entry.userId)
        ? null
        : {
            userId: entry.userId,
            answers: ANSWERS,
            hostAnswers: entry.hostAnswers,
            lens: entry.lens,
          },
    }));
  const indexByUserId = new Map(
    members.map((member, index) => [member.entry.userId, index]),
  );
  const userIdAt = (person: number): string =>
    members[person]?.entry.userId ?? '';
  const graph: MatchGraph = {
    size: members.length,
    score: () => PAIR_SCORE,
    feasible: (first, second) =>
      !infeasiblePairs.has(pairKey(userIdAt(first), userIdAt(second))),
    isTalker: () => true,
    connected: () => false,
  };
  const units: MatchUnit[] = [];
  const placed = new Set<number>();
  members.forEach((member, index) => {
    if (placed.has(index)) return;
    const partnerIndex =
      member.entry.pairStatus === 'accepted' && member.entry.pairPartnerId
        ? indexByUserId.get(member.entry.pairPartnerId)
        : undefined;
    const partner =
      partnerIndex === undefined ? undefined : members[partnerIndex];
    const isPair =
      partnerIndex !== undefined &&
      !placed.has(partnerIndex) &&
      partner?.entry.pairStatus === 'accepted' &&
      partner.entry.pairPartnerId === member.entry.userId &&
      placeOf(partner.entry) === placeOf(member.entry);
    const unitMembers =
      isPair && partnerIndex !== undefined ? [index, partnerIndex] : [index];
    unitMembers.forEach((person) => placed.add(person));
    units.push({ id: member.entry.id, members: unitMembers });
  });
  return {
    pool: {
      members,
      indexByUserId,
      units,
      graph,
      context: {
        interestIdf: new Map(),
        blockedPairs: new Set(),
        avoidedPairs: new Set(),
        connectedPairs: new Set(),
      },
      componentsFor: () => COMPONENTS,
    },
    skippedEntryIds: poolEntries.filter(isSkipped).map((entry) => entry.id),
  };
}

interface Scenario {
  entries?: EventMatchEntry[];
  groups?: EventMatchGroup[];
  /** Name pairs that may not share a group. */
  infeasible?: [string, string][];
  /** Names with no questionnaire row. */
  missingProfiles?: string[];
  /** Runs once, right after the first pool is built: a member acting while
   *  the solver runs. */
  afterFirstPool?: (rows: EventMatchEntry[]) => void;
  /** Overrides for the gathering read by `loadEvent`, merged onto `EVENT`. */
  event?: Partial<typeof EVENT>;
}

describe('GoTogetherFormationService', () => {
  let service: GoTogetherFormationService;
  let entries: ReturnType<typeof inMemoryRepository<EventMatchEntry>>;
  let groups: ReturnType<typeof inMemoryRepository<EventMatchGroup>>;
  let config: EventMatchConfig;
  let configs: { findOne: jest.Mock; increment: jest.Mock };
  let poolService: { buildPool: jest.Mock };
  let groupsService: {
    createMatchedGroup: jest.Mock;
    addMatchedMembers: jest.Mock;
    dissolveMatchedGroup: jest.Mock;
    leaveGroup: jest.Mock;
  };
  let notifications: { createForRecipients: jest.Mock };
  let loggedErrors: jest.SpyInstance;

  async function build(scenario: Scenario = {}): Promise<void> {
    let groupSequence = 0;
    entries = inMemoryRepository(scenario.entries ?? [], () => 'unused');
    groups = inMemoryRepository(scenario.groups ?? [], () => {
      groupSequence += 1;
      return `new-group-${groupSequence}`;
    });
    config = {
      eventId: EVENT_ID,
      enabled: true,
      cutoffAt: new Date(0),
      hostQuestions: [],
      meetingPointNote: 'By the fountain',
      matchedAt: null,
      lateGroupAt: null,
      feedbackPromptedAt: null,
      runCount: 2,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    configs = {
      findOne: jest.fn(async () => config),
      increment: jest.fn(
        async (_where: unknown, _column: string, by: number) => {
          config.runCount += by;
          return { affected: 1 };
        },
      ),
    };
    const infeasiblePairs = new Set(
      (scenario.infeasible ?? []).map(([first, second]) =>
        pairKey(`user-${first}`, `user-${second}`),
      ),
    );
    const missingProfiles = new Set(
      (scenario.missingProfiles ?? []).map((name) => `user-${name}`),
    );
    poolService = {
      buildPool: jest.fn(async (poolEntries: EventMatchEntry[]) => {
        const built = poolFrom(poolEntries, infeasiblePairs, missingProfiles);
        const afterFirstPool = scenario.afterFirstPool;
        scenario.afterFirstPool = undefined;
        afterFirstPool?.(entries.rows);
        return built;
      }),
    };
    groupsService = {
      createMatchedGroup: jest.fn(async () => ({
        conversationId: 'conversation-new',
      })),
      addMatchedMembers: jest.fn(async () => undefined),
      dissolveMatchedGroup: jest.fn(async () => undefined),
      leaveGroup: jest.fn(async () => ({ ok: true })),
    };
    notifications = { createForRecipients: jest.fn(async () => []) };
    loggedErrors = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        GoTogetherFormationService,
        { provide: getRepositoryToken(EventMatchEntry), useValue: entries },
        { provide: getRepositoryToken(EventMatchGroup), useValue: groups },
        { provide: getRepositoryToken(EventMatchConfig), useValue: configs },
        {
          provide: getRepositoryToken(Event),
          useValue: {
            findOne: jest.fn(async () => ({ ...EVENT, ...scenario.event })),
          },
        },
        { provide: GoTogetherPoolService, useValue: poolService },
        { provide: GroupsService, useValue: groupsService },
        {
          provide: GoTogetherHouseService,
          useValue: { houseUserId: jest.fn(async () => HOUSE_ID) },
        },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = moduleRef.get(GoTogetherFormationService);
  }

  afterEach(() => jest.restoreAllMocks());

  function notificationsOf(type: NotificationType): unknown[][] {
    const calls = notifications.createForRecipients.mock.calls as unknown[][];
    return calls.filter((call) => call[1] === type);
  }

  function row(name: string): EventMatchEntry {
    const found = entries.rows.find((entry) => entry.userId === `user-${name}`);
    if (!found) throw new Error(`No entry for ${name}`);
    return found;
  }

  describe('formForEvent', () => {
    it('ends the pending invite of a member who got a seat, and keeps an accepted pair', async () => {
      await build({
        entries: [
          entryRow('a', {
            pairStatus: 'pending',
            pairPartnerId: 'user-friend',
          }),
          entryRow('b', { pairStatus: 'accepted', pairPartnerId: 'user-c' }),
          entryRow('c', { pairStatus: 'accepted', pairPartnerId: 'user-b' }),
          entryRow('d'),
        ],
      });

      await service.formForEvent(EVENT_ID);

      expect(row('a')).toEqual(
        expect.objectContaining({
          status: 'grouped',
          pairStatus: 'none',
          pairPartnerId: null,
        }),
      );
      expect(row('b')).toEqual(
        expect.objectContaining({
          status: 'grouped',
          pairStatus: 'accepted',
          pairPartnerId: 'user-c',
        }),
      );
    });

    it('persists the group, opens its chat and tells exactly its members', async () => {
      await build({
        entries: ['a', 'b', 'c', 'd'].map((name) => entryRow(name)),
      });

      const result = await service.formForEvent(EVENT_ID);

      expect(result).toEqual({ groupsFormed: 1, unmatched: 0 });
      expect(configs.increment).toHaveBeenCalledWith(
        { eventId: EVENT_ID },
        'runCount',
        1,
      );
      expect(poolService.buildPool).toHaveBeenCalledWith(expect.any(Array), {
        includeAnchors: true,
      });
      expect(groups.save).toHaveBeenCalledTimes(1);
      const [group] = groups.rows;
      expect(group).toEqual(
        expect.objectContaining({
          eventId: EVENT_ID,
          scoringVersion: SCORING_VERSION,
          solverSeedLabel: `${EVENT_ID}:3`,
          band: 'strong',
          conversationId: 'conversation-new',
        }),
      );
      expect(group!.reasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'interests' }),
        ]),
      );
      expect(Object.keys(group!.pairComponents ?? {})).toHaveLength(6);
      for (const name of ['a', 'b', 'c', 'd']) {
        expect(row(name)).toEqual(
          expect.objectContaining({ status: 'grouped', groupId: group!.id }),
        );
      }
      expect(groupsService.createMatchedGroup).toHaveBeenCalledWith({
        ownerUserId: HOUSE_ID,
        memberUserIds: expect.arrayContaining([
          'user-a',
          'user-b',
          'user-c',
          'user-d',
        ]),
        title: 'Pride picnic',
        description: 'By the fountain',
        eventMatchGroupId: group!.id,
      });
      expect(groups.update).toHaveBeenCalledWith(group!.id, {
        conversationId: 'conversation-new',
      });
      const readyCalls = notificationsOf(NotificationType.GoTogetherGroupReady);
      expect(readyCalls).toHaveLength(1);
      expect([...(readyCalls[0]![0] as string[])].sort()).toEqual([
        'user-a',
        'user-b',
        'user-c',
        'user-d',
      ]);
      expect(readyCalls[0]![2]).toEqual({
        ...EVENT_PAYLOAD,
        groupId: group!.id,
        conversationId: 'conversation-new',
      });
      expect(
        notificationsOf(NotificationType.GoTogetherUnmatched),
      ).toHaveLength(0);
    });

    it('tells an unmatched member once, and not again on a second run', async () => {
      await build({
        entries: ['a', 'b', 'c', 'd', 'e'].map((name) => entryRow(name)),
        infeasible: ['a', 'b', 'c', 'd'].map((name) => ['e', name]),
      });

      const firstRun = await service.formForEvent(EVENT_ID);

      expect(firstRun).toEqual({ groupsFormed: 1, unmatched: 1 });
      expect(row('e')).toEqual(
        expect.objectContaining({
          status: 'unmatched',
          groupId: null,
          unmatchedNotifiedAt: expect.any(Date),
        }),
      );
      const unmatchedCalls = notificationsOf(
        NotificationType.GoTogetherUnmatched,
      );
      expect(unmatchedCalls).toEqual([
        [
          ['user-e'],
          NotificationType.GoTogetherUnmatched,
          { ...EVENT_PAYLOAD, isFinal: false },
        ],
      ]);

      row('e').status = 'waiting';
      const secondRun = await service.formForEvent(EVENT_ID);

      expect(secondRun).toEqual({ groupsFormed: 0, unmatched: 1 });
      expect(row('e').status).toBe('unmatched');
      expect(
        notificationsOf(NotificationType.GoTogetherUnmatched),
      ).toHaveLength(1);
    });

    it('keeps the group with no chat when creating the chat fails', async () => {
      await build({
        entries: ['a', 'b', 'c', 'd'].map((name) => entryRow(name)),
      });
      groupsService.createMatchedGroup.mockRejectedValueOnce(
        new Error('chat down'),
      );

      const result = await service.formForEvent(EVENT_ID);

      expect(result.groupsFormed).toBe(1);
      const [group] = groups.rows;
      expect(group!.conversationId).toBeNull();
      expect(groups.update).not.toHaveBeenCalledWith(
        group!.id,
        expect.objectContaining({ conversationId: expect.anything() }),
      );
      expect(loggedErrors).toHaveBeenCalledWith(
        expect.stringContaining(group!.id),
      );
      expect(row('a').status).toBe('grouped');
      expect(
        notificationsOf(NotificationType.GoTogetherGroupReady)[0]![2],
      ).toEqual({ ...EVENT_PAYLOAD, groupId: group!.id, conversationId: null });
    });

    it('notifies no one who withdrew while the solver ran', async () => {
      await build({
        entries: ['a', 'b', 'c', 'd', 'e'].map((name) => entryRow(name)),
        infeasible: ['a', 'b', 'c', 'd'].map((name) => ['e', name]),
        afterFirstPool: (rows) => {
          const withdrawing = rows.find((entry) => entry.userId === 'user-e');
          if (withdrawing) withdrawing.status = 'withdrawn';
        },
      });

      await service.formForEvent(EVENT_ID);

      expect(row('e').status).toBe('withdrawn');
      expect(
        notificationsOf(NotificationType.GoTogetherUnmatched),
      ).toHaveLength(0);
    });

    it('opens no chat and returns members to waiting when withdrawals leave fewer than 3', async () => {
      await build({
        entries: ['a', 'b', 'c', 'd'].map((name) => entryRow(name)),
        afterFirstPool: (rows) => {
          for (const entry of rows) {
            if (entry.userId === 'user-c' || entry.userId === 'user-d')
              entry.status = 'withdrawn';
          }
        },
      });

      const result = await service.formForEvent(EVENT_ID);

      expect(result).toEqual({ groupsFormed: 0, unmatched: 0 });
      expect(groupsService.createMatchedGroup).not.toHaveBeenCalled();
      expect(groups.rows[0]!.dissolvedAt).toBeInstanceOf(Date);
      for (const name of ['a', 'b']) {
        expect(row(name)).toEqual(
          expect.objectContaining({ status: 'waiting', groupId: null }),
        );
      }
      expect(row('c').status).toBe('withdrawn');
      expect(
        notificationsOf(NotificationType.GoTogetherGroupReady),
      ).toHaveLength(0);
    });

    it('summarises and seats only the members still there after a withdrawal', async () => {
      await build({
        entries: ['a', 'b', 'c', 'd', 'e'].map((name) => entryRow(name)),
        afterFirstPool: (rows) => {
          const withdrawing = rows.find((entry) => entry.userId === 'user-e');
          if (withdrawing) withdrawing.status = 'withdrawn';
        },
      });

      const result = await service.formForEvent(EVENT_ID);

      expect(result.groupsFormed).toBe(1);
      const [group] = groups.rows;
      expect(Object.keys(group!.pairComponents ?? {})).toHaveLength(6);
      expect(Object.keys(group!.pairComponents ?? {}).join(',')).not.toContain(
        'user-e',
      );
      const memberUserIds = (
        (groupsService.createMatchedGroup.mock.calls as unknown[][])[0]![0] as {
          memberUserIds: string[];
        }
      ).memberUserIds;
      expect([...memberUserIds].sort()).toEqual([
        'user-a',
        'user-b',
        'user-c',
        'user-d',
      ]);
      const [readyCall] = notificationsOf(
        NotificationType.GoTogetherGroupReady,
      );
      expect(readyCall![0]).not.toContain('user-e');
      expect(row('e').status).toBe('withdrawn');
    });
  });

  describe('placeLateJoiners', () => {
    it('seats a pending member in the group of 4 and never in the group of 5', async () => {
      await build({
        entries: [
          ...groupedRows('group-five', ['f1', 'f2', 'f3', 'f4', 'f5']),
          ...groupedRows('group-four', ['g1', 'g2', 'g3', 'g4']),
          entryRow('late', { status: 'unmatched' }),
        ],
        groups: [groupRow('group-five'), groupRow('group-four')],
      });

      const placedCount = await service.placeLateJoiners(EVENT_ID);

      expect(placedCount).toBe(1);
      expect(groupsService.addMatchedMembers).toHaveBeenCalledTimes(1);
      expect(groupsService.addMatchedMembers).toHaveBeenCalledWith(
        'conversation-group-four',
        HOUSE_ID,
        ['user-late'],
      );
      expect(row('late')).toEqual(
        expect.objectContaining({ status: 'grouped', groupId: 'group-four' }),
      );
      expect(notificationsOf(NotificationType.GoTogetherGroupReady)).toEqual([
        [
          ['user-late'],
          NotificationType.GoTogetherGroupReady,
          {
            ...EVENT_PAYLOAD,
            groupId: 'group-four',
            conversationId: 'conversation-group-four',
          },
        ],
      ]);
    });

    it('places nobody when the only group already has 5', async () => {
      await build({
        entries: [
          ...groupedRows('group-five', ['f1', 'f2', 'f3', 'f4', 'f5']),
          entryRow('late', { status: 'waiting' }),
        ],
        groups: [groupRow('group-five')],
      });

      const placedCount = await service.placeLateJoiners(EVENT_ID);

      expect(placedCount).toBe(0);
      expect(groupsService.addMatchedMembers).not.toHaveBeenCalled();
      expect(row('late')).toEqual(
        expect.objectContaining({ status: 'waiting', groupId: null }),
      );
    });

    it('seats and notifies no one who withdrew while the pass ran', async () => {
      await build({
        entries: [
          ...groupedRows('group-four', ['g1', 'g2', 'g3', 'g4']),
          entryRow('late', { status: 'unmatched' }),
        ],
        groups: [groupRow('group-four')],
        afterFirstPool: (rows) => {
          const withdrawing = rows.find(
            (entry) => entry.userId === 'user-late',
          );
          if (withdrawing) withdrawing.status = 'withdrawn';
        },
      });

      const placedCount = await service.placeLateJoiners(EVENT_ID);

      expect(placedCount).toBe(0);
      expect(groupsService.addMatchedMembers).not.toHaveBeenCalled();
      expect(
        notificationsOf(NotificationType.GoTogetherGroupReady),
      ).toHaveLength(0);
      expect(row('late')).toEqual(
        expect.objectContaining({ status: 'withdrawn', groupId: null }),
      );
    });

    it('never seats a joiner beside a seated member without a questionnaire who blocked them', async () => {
      await build({
        entries: [
          ...groupedRows('group-four', ['g1', 'g2', 'g3', 'quiet']),
          entryRow('late', { status: 'unmatched' }),
        ],
        groups: [groupRow('group-four')],
        missingProfiles: ['quiet'],
        infeasible: [['quiet', 'late']],
      });

      const placedCount = await service.placeLateJoiners(EVENT_ID);

      expect(placedCount).toBe(0);
      expect(groupsService.addMatchedMembers).not.toHaveBeenCalled();
      expect(row('late').status).toBe('unmatched');
    });

    it('counts a seated member without a questionnaire toward the size cap', async () => {
      await build({
        entries: [
          ...groupedRows('group-five', ['f1', 'f2', 'f3', 'f4', 'quiet']),
          entryRow('late', { status: 'unmatched' }),
        ],
        groups: [groupRow('group-five')],
        missingProfiles: ['quiet'],
      });

      const placedCount = await service.placeLateJoiners(EVENT_ID);

      expect(placedCount).toBe(0);
      expect(groupsService.addMatchedMembers).not.toHaveBeenCalled();
    });
  });

  describe('formLateGroup', () => {
    it('forms a group of 3 and sends the final notice to anyone left', async () => {
      const earlierNotice = new Date('2026-09-01T00:00:00Z');
      await build({
        entries: [
          entryRow('a', { status: 'unmatched' }),
          entryRow('b', { status: 'unmatched' }),
          entryRow('c'),
          entryRow('d', {
            status: 'unmatched',
            unmatchedNotifiedAt: earlierNotice,
          }),
        ],
        missingProfiles: ['d'],
      });

      const result = await service.formLateGroup(EVENT_ID);

      expect(result).toEqual({ groupsFormed: 1, unmatched: 1 });
      const memberUserIds = (
        (groupsService.createMatchedGroup.mock.calls as unknown[][])[0]![0] as {
          memberUserIds: string[];
        }
      ).memberUserIds;
      expect([...memberUserIds].sort()).toEqual(['user-a', 'user-b', 'user-c']);
      expect(notificationsOf(NotificationType.GoTogetherUnmatched)).toEqual([
        [
          ['user-d'],
          NotificationType.GoTogetherUnmatched,
          { ...EVENT_PAYLOAD, isFinal: true },
        ],
      ]);
      expect(row('d').unmatchedNotifiedAt!.getTime()).toBeGreaterThan(
        earlierNotice.getTime(),
      );
    });

    it('sends everyone the final notice when fewer than 3 are pending', async () => {
      await build({
        entries: [entryRow('a'), entryRow('b', { status: 'unmatched' })],
      });

      const result = await service.formLateGroup(EVENT_ID);

      expect(result).toEqual({ groupsFormed: 0, unmatched: 2 });
      expect(groupsService.createMatchedGroup).not.toHaveBeenCalled();
      expect(configs.increment).not.toHaveBeenCalled();
      const [call] = notificationsOf(NotificationType.GoTogetherUnmatched);
      expect([...(call![0] as string[])].sort()).toEqual(['user-a', 'user-b']);
      expect(call![2]).toEqual({ ...EVENT_PAYLOAD, isFinal: true });
    });
  });

  describe('removeMember', () => {
    const leavingScenario = (): Scenario => ({
      entries: [
        entryRow('leaver', {
          status: 'grouped',
          groupId: 'group-one',
          pairStatus: 'accepted',
          pairPartnerId: 'user-partner',
          lens: 'queerPoc',
          lensConsentedAt: new Date(0),
        }),
        entryRow('partner', {
          status: 'grouped',
          groupId: 'group-one',
          pairStatus: 'accepted',
          pairPartnerId: 'user-leaver',
          lens: 'queerPoc',
          lensConsentedAt: new Date(0),
        }),
        entryRow('m', { status: 'grouped', groupId: 'group-one' }),
        ...groupedRows('group-two', ['x', 'y', 'z']),
      ],
      groups: [groupRow('group-one'), groupRow('group-two')],
    });

    it('leaves the chat, withdraws, frees the partner and offers the two left a merge', async () => {
      await build(leavingScenario());

      await service.removeMember({ ...row('leaver') });

      expect(groupsService.leaveGroup).toHaveBeenCalledWith(
        'conversation-group-one',
        'user-leaver',
        { isGoTogetherRemoval: true },
      );
      expect(row('leaver')).toEqual(
        expect.objectContaining({
          status: 'withdrawn',
          groupId: null,
          pairStatus: 'none',
          pairPartnerId: null,
          lens: null,
          lensConsentedAt: null,
        }),
      );
      expect(row('partner')).toEqual(
        expect.objectContaining({
          status: 'grouped',
          groupId: 'group-one',
          pairStatus: 'none',
          pairPartnerId: null,
          mergeOfferGroupId: 'group-two',
        }),
      );
      expect(row('m').mergeOfferGroupId).toBe('group-two');
      const leftCalls = notificationsOf(NotificationType.GoTogetherMemberLeft);
      expect(leftCalls.map((call) => call[0])).toEqual([
        ['user-partner'],
        ['user-m'],
      ]);
      for (const call of leftCalls) {
        expect(call[2]).toEqual({
          ...EVENT_PAYLOAD,
          groupId: 'group-one',
          mergeOfferGroupId: 'group-two',
        });
      }
      expect(groupsService.dissolveMatchedGroup).not.toHaveBeenCalled();
    });

    it('lets an offered member accept the merge into the other group', async () => {
      await build(leavingScenario());
      await service.removeMember({ ...row('leaver') });
      const partnerEntry = { ...row('partner') };

      await service.acceptMerge(partnerEntry);

      expect(groupsService.leaveGroup).toHaveBeenCalledWith(
        'conversation-group-one',
        'user-partner',
        { isGoTogetherRemoval: true },
      );
      expect(groupsService.addMatchedMembers).toHaveBeenCalledWith(
        'conversation-group-two',
        HOUSE_ID,
        ['user-partner'],
      );
      expect(row('partner')).toEqual(
        expect.objectContaining({
          groupId: 'group-two',
          mergeOfferGroupId: null,
        }),
      );
      expect(partnerEntry.mergeOfferGroupId).toBe('group-two');
    });

    it('refuses an expired merge with GO_TOGETHER_MERGE_EXPIRED and clears the offer', async () => {
      const scenario = leavingScenario();
      await build(scenario);
      await service.removeMember({ ...row('leaver') });
      entries.rows.push(...groupedRows('group-two', ['v', 'w']));

      const failure: unknown = await service
        .acceptMerge({ ...row('partner') })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ConflictException);
      expect((failure as ConflictException).getResponse()).toEqual(
        expect.objectContaining({ code: MERGE_EXPIRED_CODE }),
      );
      expect(row('partner')).toEqual(
        expect.objectContaining({
          groupId: 'group-one',
          mergeOfferGroupId: null,
        }),
      );
      expect(groupsService.addMatchedMembers).not.toHaveBeenCalled();
    });

    it('dissolves a group its last member leaves', async () => {
      await build({
        entries: groupedRows('group-solo', ['last']),
        groups: [groupRow('group-solo')],
      });

      await service.removeMember({ ...row('last') });

      expect(groupsService.dissolveMatchedGroup).toHaveBeenCalledWith(
        'conversation-group-solo',
        HOUSE_ID,
      );
      expect(groups.rows[0]!.dissolvedAt).toBeInstanceOf(Date);
      expect(
        notificationsOf(NotificationType.GoTogetherMemberLeft),
      ).toHaveLength(0);
    });
  });

  describe('moveAfterBlock', () => {
    const blockScenario = (secondGroupNames: string[]): Scenario => ({
      entries: [
        ...groupedRows('group-one', ['blocker', 'blocked', 'o1', 'o2']),
        ...groupedRows('group-two', secondGroupNames),
      ],
      groups: [groupRow('group-one'), groupRow('group-two')],
      infeasible: [['blocker', 'blocked']],
    });

    function groupMatesOfBlocker(): string[] {
      const groupId = row('blocker').groupId;
      return entries.rows
        .filter(
          (entry) =>
            groupId !== null &&
            entry.groupId === groupId &&
            entry.status === 'grouped',
        )
        .map((entry) => entry.userId);
    }

    it('moves the blocker into another group and never back beside the blocked member', async () => {
      await build(blockScenario(['x', 'y', 'z']));

      const wasSeparated = await service.moveAfterBlock(
        EVENT_ID,
        'user-blocker',
        'user-blocked',
      );

      expect(wasSeparated).toBe(true);
      expect(groupsService.leaveGroup).toHaveBeenCalledWith(
        'conversation-group-one',
        'user-blocker',
        { isGoTogetherRemoval: true },
      );
      expect(groupsService.addMatchedMembers).toHaveBeenCalledWith(
        'conversation-group-two',
        HOUSE_ID,
        ['user-blocker'],
      );
      expect(groupsService.addMatchedMembers).not.toHaveBeenCalledWith(
        'conversation-group-one',
        expect.anything(),
        expect.anything(),
      );
      expect(row('blocker').groupId).toBe('group-two');
      expect(groupMatesOfBlocker()).not.toContain('user-blocked');
      const pooledUserIds = poolService.buildPool.mock.calls.flatMap(
        (call: unknown[]) =>
          (call[0] as EventMatchEntry[]).map((entry) => entry.userId),
      );
      expect(pooledUserIds).not.toContain('user-blocked');
    });

    it('leaves the blocker unmatched when no other group has room', async () => {
      await build(blockScenario(['v', 'w', 'x', 'y', 'z']));

      const wasSeparated = await service.moveAfterBlock(
        EVENT_ID,
        'user-blocker',
        'user-blocked',
      );

      expect(wasSeparated).toBe(true);
      expect(groupsService.addMatchedMembers).not.toHaveBeenCalled();
      expect(row('blocker')).toEqual(
        expect.objectContaining({ status: 'unmatched', groupId: null }),
      );
      expect(row('blocked')).toEqual(
        expect.objectContaining({ status: 'grouped', groupId: 'group-one' }),
      );
    });

    it('returns false and moves nobody when the pair no longer shares a group', async () => {
      await build({
        entries: [
          ...groupedRows('group-one', ['blocker']),
          ...groupedRows('group-two', ['blocked']),
        ],
        groups: [groupRow('group-one'), groupRow('group-two')],
      });

      const wasSeparated = await service.moveAfterBlock(
        EVENT_ID,
        'user-blocker',
        'user-blocked',
      );

      expect(wasSeparated).toBe(false);
      expect(groupsService.leaveGroup).not.toHaveBeenCalled();
      expect(groupsService.addMatchedMembers).not.toHaveBeenCalled();
      expect(row('blocker')).toEqual(
        expect.objectContaining({ status: 'grouped', groupId: 'group-one' }),
      );
    });

    describe('once the gathering has started', () => {
      const startedEvent: Partial<typeof EVENT> = {
        startAt: new Date(Date.now() - 60 * 60 * 1000),
      };

      it('still separates the pair in chat but never reseats the blocker into another group', async () => {
        await build({
          ...blockScenario(['x', 'y', 'z']),
          event: startedEvent,
        });

        const wasSeparated = await service.moveAfterBlock(
          EVENT_ID,
          'user-blocker',
          'user-blocked',
        );

        expect(wasSeparated).toBe(true);
        expect(groupsService.leaveGroup).toHaveBeenCalledWith(
          'conversation-group-one',
          'user-blocker',
          { isGoTogetherRemoval: true },
        );
        expect(groupsService.addMatchedMembers).not.toHaveBeenCalled();
        expect(row('blocker')).toEqual(
          expect.objectContaining({ status: 'unmatched', groupId: null }),
        );
      });

      it('leaves the blocker accepted partner grouped in the same chat, with the pair link cleared', async () => {
        await build({
          entries: [
            entryRow('blocker', {
              status: 'grouped',
              groupId: 'group-one',
              pairStatus: 'accepted',
              pairPartnerId: 'user-partner',
            }),
            entryRow('partner', {
              status: 'grouped',
              groupId: 'group-one',
              pairStatus: 'accepted',
              pairPartnerId: 'user-blocker',
            }),
            ...groupedRows('group-one', ['blocked', 'o1']),
            ...groupedRows('group-two', ['x', 'y', 'z']),
          ],
          groups: [groupRow('group-one'), groupRow('group-two')],
          infeasible: [['blocker', 'blocked']],
          event: startedEvent,
        });

        const wasSeparated = await service.moveAfterBlock(
          EVENT_ID,
          'user-blocker',
          'user-blocked',
        );

        expect(wasSeparated).toBe(true);
        expect(groupsService.addMatchedMembers).not.toHaveBeenCalled();
        expect(groupsService.leaveGroup).toHaveBeenCalledTimes(1);
        expect(groupsService.leaveGroup).toHaveBeenCalledWith(
          'conversation-group-one',
          'user-blocker',
          { isGoTogetherRemoval: true },
        );
        expect(row('blocker')).toEqual(
          expect.objectContaining({
            status: 'unmatched',
            groupId: null,
            pairStatus: 'none',
            pairPartnerId: null,
          }),
        );
        expect(row('partner')).toEqual(
          expect.objectContaining({
            status: 'grouped',
            groupId: 'group-one',
            pairStatus: 'none',
            pairPartnerId: null,
          }),
        );
      });
    });
  });

  describe('dissolveEventGroups', () => {
    it('ends every open chat, stamps dissolvedAt and withdraws every entry', async () => {
      await build({
        entries: [
          ...groupedRows('group-one', ['a', 'b', 'c']),
          ...groupedRows('group-two', ['d', 'e', 'f']),
          entryRow('g', { status: 'unmatched' }),
          entryRow('h'),
        ],
        groups: [
          groupRow('group-one'),
          groupRow('group-two'),
          groupRow('group-old', { dissolvedAt: new Date(0) }),
        ],
      });

      await service.dissolveEventGroups(EVENT_ID);

      expect(groupsService.dissolveMatchedGroup.mock.calls).toEqual([
        ['conversation-group-one', HOUSE_ID],
        ['conversation-group-two', HOUSE_ID],
      ]);
      const [groupOne, groupTwo, groupOld] = groups.rows;
      expect(groupOne!.dissolvedAt).toBeInstanceOf(Date);
      expect(groupTwo!.dissolvedAt).toBeInstanceOf(Date);
      expect(groupOld!.dissolvedAt).toEqual(new Date(0));
      expect(entries.rows.every((entry) => entry.status === 'withdrawn')).toBe(
        true,
      );
    });
  });
});
