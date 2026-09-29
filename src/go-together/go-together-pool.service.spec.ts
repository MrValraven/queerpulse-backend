import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MoreThan } from 'typeorm';
import { Connection } from '../connections/entities/connection.entity';
import { Block } from '../social/entities/block.entity';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import { EventMatchGroup } from './entities/event-match-group.entity';
import { FriendMatchProfile } from './entities/friend-match-profile.entity';
import { MatchAvoidance } from './entities/match-avoidance.entity';
import {
  MatchFeedback,
  MeetAgainVerdict,
} from './entities/match-feedback.entity';
import { MatchGroupFeedback } from './entities/match-group-feedback.entity';
import { FriendMatchAnswers } from './go-together-questionnaire.catalog';
import {
  groupUnitLists,
  personIndexesOf,
  planPlacements,
  unitIndexesWhere,
} from './go-together-formation.helpers';
import {
  GoTogetherPoolService,
  MatchPool,
  NEUTRAL_SCORE,
} from './go-together-pool.service';
import { MIN_AFFINITY } from './go-together-scoring';

const NOW = new Date('2026-10-01T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function answers(
  overrides: Partial<FriendMatchAnswers> = {},
): FriendMatchAnswers {
  return {
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
    energy: { talker: 3, nightShape: 2, planner: 3 },
    intent: 'closeFriends',
    meetFrequency: 'fewTimesAMonth',
    languages: ['pt', 'en'],
    drinking: 'eitherWay',
    ageBracket: '25-34',
    agePreference: 'any',
    area: 'Arroios',
    ...overrides,
  };
}

function entry(
  name: string,
  overrides: Partial<EventMatchEntry> = {},
): EventMatchEntry {
  return {
    id: `entry-${name}`,
    eventId: 'event-1',
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

function profile(
  name: string,
  overrides: Partial<FriendMatchAnswers> = {},
): FriendMatchProfile {
  return {
    userId: `user-${name}`,
    answers: answers(overrides),
    questionnaireVersion: 1,
    consentedAt: new Date(0),
    lastUsedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

interface PoolFixtures {
  profiles: FriendMatchProfile[];
  blocks?: Pick<Block, 'blockerId' | 'blockedId'>[];
  avoidances?: Pick<MatchAvoidance, 'userId' | 'avoidedUserId'>[];
  connections?: Pick<Connection, 'userLow' | 'userHigh'>[];
  goAgain?: Pick<MatchGroupFeedback, 'groupId' | 'raterId'>[];
  pastGroups?: Pick<EventMatchGroup, 'id' | 'formedAt'>[];
  verdicts?: Pick<
    MatchFeedback,
    'groupId' | 'raterId' | 'rateeId' | 'verdict'
  >[];
}

describe('GoTogetherPoolService', () => {
  let groupsRepository: { find: jest.Mock };
  let groupFeedbackRepository: { find: jest.Mock };

  async function build(fixtures: PoolFixtures): Promise<GoTogetherPoolService> {
    const interestRows = fixtures.profiles.map((row) => ({
      interests: row.answers.interests,
    }));
    const queryBuilder = {
      select: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(interestRows),
    };
    groupsRepository = {
      find: jest.fn().mockResolvedValue(fixtures.pastGroups ?? []),
    };
    groupFeedbackRepository = {
      find: jest.fn().mockResolvedValue(fixtures.goAgain ?? []),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        GoTogetherPoolService,
        {
          provide: getRepositoryToken(FriendMatchProfile),
          useValue: {
            find: jest.fn().mockResolvedValue(fixtures.profiles),
            createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
          },
        },
        {
          provide: getRepositoryToken(Block),
          useValue: {
            find: jest.fn().mockResolvedValue(fixtures.blocks ?? []),
          },
        },
        {
          provide: getRepositoryToken(MatchAvoidance),
          useValue: {
            find: jest.fn().mockResolvedValue(fixtures.avoidances ?? []),
          },
        },
        {
          provide: getRepositoryToken(Connection),
          useValue: {
            find: jest.fn().mockResolvedValue(fixtures.connections ?? []),
          },
        },
        {
          provide: getRepositoryToken(EventMatchGroup),
          useValue: groupsRepository,
        },
        {
          provide: getRepositoryToken(MatchFeedback),
          useValue: {
            find: jest.fn().mockResolvedValue(fixtures.verdicts ?? []),
          },
        },
        {
          provide: getRepositoryToken(MatchGroupFeedback),
          useValue: groupFeedbackRepository,
        },
      ],
    }).compile();
    return moduleRef.get(GoTogetherPoolService);
  }

  function indexOf(pool: MatchPool, name: string): number {
    const index = pool.indexByUserId.get(`user-${name}`);
    if (index === undefined) throw new Error(`user-${name} is not in the pool`);
    return index;
  }

  it.each([
    ['the first member blocked the second', 'a', 'b'],
    ['the second member blocked the first', 'b', 'a'],
  ])(
    'makes a blocked pair infeasible when %s',
    async (_label, blockerName, blockedName) => {
      const service = await build({
        profiles: [profile('a'), profile('b'), profile('c')],
        blocks: [
          {
            blockerId: `user-${blockerName}`,
            blockedId: `user-${blockedName}`,
          },
        ],
      });
      const { pool } = await service.buildPool(
        [entry('a'), entry('b'), entry('c')],
        { includeAnchors: false },
      );
      const first = indexOf(pool, 'a');
      const second = indexOf(pool, 'b');
      expect(pool.graph.feasible(first, second)).toBe(false);
      expect(pool.graph.feasible(second, first)).toBe(false);
      expect(pool.graph.feasible(first, indexOf(pool, 'c'))).toBe(true);
    },
  );

  it('makes a "Not for me" pair infeasible in both directions', async () => {
    const service = await build({
      profiles: [profile('a'), profile('b'), profile('c')],
      avoidances: [{ userId: 'user-b', avoidedUserId: 'user-a' }],
    });
    const { pool } = await service.buildPool(
      [entry('a'), entry('b'), entry('c')],
      { includeAnchors: false },
    );
    const first = indexOf(pool, 'a');
    const second = indexOf(pool, 'b');
    expect(pool.graph.feasible(first, second)).toBe(false);
    expect(pool.graph.feasible(second, first)).toBe(false);
    expect(pool.graph.feasible(second, indexOf(pool, 'c'))).toBe(true);
    expect(pool.context.avoidedPairs.size).toBe(1);
  });

  it('turns an accepted pair into one unit and keeps a pending inviter solo', async () => {
    const service = await build({
      profiles: [profile('a'), profile('b'), profile('c')],
    });
    const { pool } = await service.buildPool(
      [
        entry('a', { pairStatus: 'accepted', pairPartnerId: 'user-b' }),
        entry('b', { pairStatus: 'accepted', pairPartnerId: 'user-a' }),
        entry('c', { pairStatus: 'pending', pairPartnerId: 'user-d' }),
      ],
      { includeAnchors: false },
    );
    expect(pool.units).toEqual([
      { id: 'entry-a', members: [indexOf(pool, 'a'), indexOf(pool, 'b')] },
      { id: 'entry-c', members: [indexOf(pool, 'c')] },
    ]);
  });

  it('skips an entry whose member has no questionnaire', async () => {
    const service = await build({ profiles: [profile('a'), profile('c')] });
    const { pool, skippedEntryIds } = await service.buildPool(
      [entry('a'), entry('b'), entry('c')],
      { includeAnchors: false },
    );
    expect(skippedEntryIds).toEqual(['entry-b']);
    expect(pool.members.map((member) => member.entry.userId)).toEqual([
      'user-a',
      'user-c',
    ]);
    expect(pool.indexByUserId.has('user-b')).toBe(false);
    expect(pool.graph.size).toBe(2);
  });

  describe('regroup anchors', () => {
    const pastGroup = {
      id: 'past-group',
      formedAt: new Date(NOW.getTime() - 10 * DAY_MS),
    };
    const goAgain = ['a', 'b', 'c'].map((name) => ({
      groupId: 'past-group',
      raterId: `user-${name}`,
    }));

    function verdictsAmong(
      names: string[],
      overrides: Record<string, MeetAgainVerdict> = {},
    ): PoolFixtures['verdicts'] {
      return names.flatMap((rater) =>
        names
          .filter((ratee) => ratee !== rater)
          .map((ratee) => ({
            groupId: 'past-group',
            raterId: `user-${rater}`,
            rateeId: `user-${ratee}`,
            verdict: overrides[`${rater}>${ratee}`] ?? ('yes' as const),
          })),
      );
    }

    it('keeps three solos who all want to go together again as one unit', async () => {
      const service = await build({
        profiles: [profile('a'), profile('b'), profile('c'), profile('d')],
        goAgain,
        pastGroups: [pastGroup],
        verdicts: verdictsAmong(['a', 'b', 'c'], { 'b>c': 'maybe' }),
      });
      const { pool } = await service.buildPool(
        [entry('a'), entry('b'), entry('c'), entry('d')],
        { includeAnchors: true, now: NOW },
      );
      expect(pool.units).toEqual([
        {
          id: 'entry-a',
          members: [indexOf(pool, 'a'), indexOf(pool, 'b'), indexOf(pool, 'c')],
        },
        { id: 'entry-d', members: [indexOf(pool, 'd')] },
      ]);
      expect(groupsRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            formedAt: MoreThan(new Date(NOW.getTime() - 90 * DAY_MS)),
          }),
        }),
      );
    });

    it('anchors only the mutual pair when one member rated another No', async () => {
      const service = await build({
        profiles: [profile('a'), profile('b'), profile('c'), profile('d')],
        goAgain,
        pastGroups: [pastGroup],
        verdicts: verdictsAmong(['a', 'b', 'c'], { 'c>a': 'no' }),
      });
      const { pool } = await service.buildPool(
        [entry('a'), entry('b'), entry('c'), entry('d')],
        { includeAnchors: true, now: NOW },
      );
      const anchors = pool.units.filter((unit) => unit.members.length > 1);
      expect(anchors).toHaveLength(1);
      const anchorMembers = anchors[0]!.members;
      expect(anchorMembers).toHaveLength(2);
      const isHoldingBothRaters =
        anchorMembers.includes(indexOf(pool, 'a')) &&
        anchorMembers.includes(indexOf(pool, 'c'));
      expect(isHoldingBothRaters).toBe(false);
      expect(pool.units).toHaveLength(3);
      expect(
        pool.units
          .flatMap((unit) => unit.members)
          .sort((first, second) => first - second),
      ).toEqual([0, 1, 2, 3]);
    });

    it('reads no feedback when anchors are off', async () => {
      const service = await build({
        profiles: [profile('a'), profile('b'), profile('c')],
        goAgain,
        pastGroups: [pastGroup],
        verdicts: verdictsAmong(['a', 'b', 'c']),
      });
      const { pool } = await service.buildPool(
        [entry('a'), entry('b'), entry('c')],
        { includeAnchors: false },
      );
      expect(pool.units.every((unit) => unit.members.length === 1)).toBe(true);
      expect(groupFeedbackRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('placement pools', () => {
    const seatedIn = (groupId: string, name: string): EventMatchEntry =>
      entry(name, { status: 'grouped', groupId });

    function placementsFor(pool: MatchPool, joinerEntryId: string): number {
      return planPlacements(
        pool,
        groupUnitLists(pool, ['group-one']),
        unitIndexesWhere(pool, (poolEntry) => poolEntry.id === joinerEntryId),
        { maxSize: 5, minAffinity: MIN_AFFINITY, shouldReserveSeats: true },
      ).length;
    }

    it('keeps a seated member without a questionnaire, scored neutral, with their blocks', async () => {
      const service = await build({
        profiles: [profile('b'), profile('c')],
        blocks: [{ blockerId: 'user-quiet', blockedId: 'user-c' }],
      });
      const { pool, skippedEntryIds } = await service.buildPool(
        [
          seatedIn('group-one', 'quiet'),
          seatedIn('group-one', 'b'),
          entry('c', { status: 'unmatched' }),
          entry('gone'),
        ],
        { includeAnchors: false },
      );
      const quiet = indexOf(pool, 'quiet');
      const seatedMate = indexOf(pool, 'b');
      const joiner = indexOf(pool, 'c');
      expect(skippedEntryIds).toEqual(['entry-gone']);
      expect(pool.members[quiet]!.candidate).toBeNull();
      expect(pool.graph.feasible(quiet, seatedMate)).toBe(true);
      expect(pool.graph.feasible(quiet, joiner)).toBe(false);
      expect(pool.graph.feasible(joiner, quiet)).toBe(false);
      expect(pool.graph.score(quiet, seatedMate)).toBe(NEUTRAL_SCORE);
      expect(pool.graph.isTalker(quiet)).toBe(false);
      expect(pool.componentsFor(quiet, seatedMate).values).toBe(NEUTRAL_SCORE);
    });

    it('lets a seated member without a questionnaire still block a late joiner', async () => {
      const seated = [
        seatedIn('group-one', 'g1'),
        seatedIn('group-one', 'g2'),
        seatedIn('group-one', 'g3'),
        seatedIn('group-one', 'quiet'),
      ];
      const profiles = [
        profile('g1'),
        profile('g2'),
        profile('g3'),
        profile('late'),
      ];
      const joiner = entry('late', { status: 'unmatched' });

      const openService = await build({ profiles });
      const openPool = (
        await openService.buildPool([...seated, joiner], {
          includeAnchors: false,
        })
      ).pool;
      expect(placementsFor(openPool, joiner.id)).toBe(1);

      const blockingService = await build({
        profiles,
        blocks: [{ blockerId: 'user-quiet', blockedId: 'user-late' }],
      });
      const blockingPool = (
        await blockingService.buildPool([...seated, joiner], {
          includeAnchors: false,
        })
      ).pool;
      expect(placementsFor(blockingPool, joiner.id)).toBe(0);
    });

    it('counts a seated member without a questionnaire, so a group of 5 rejects a sixth', async () => {
      const service = await build({
        profiles: ['f1', 'f2', 'f3', 'f4', 'late'].map((name) => profile(name)),
      });
      const joiner = entry('late', { status: 'unmatched' });
      const { pool } = await service.buildPool(
        [
          ...['f1', 'f2', 'f3', 'f4', 'quiet'].map((name) =>
            seatedIn('group-one', name),
          ),
          joiner,
        ],
        { includeAnchors: false },
      );
      const [groupList] = groupUnitLists(pool, ['group-one']);
      expect(personIndexesOf(pool.units, groupList ?? [])).toHaveLength(5);
      expect(placementsFor(pool, joiner.id)).toBe(0);
    });

    it('keeps an accepted pair split across two groups as two solos', async () => {
      const service = await build({
        profiles: ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => profile(name)),
      });
      const { pool } = await service.buildPool(
        [
          entry('a', {
            status: 'grouped',
            groupId: 'group-one',
            pairStatus: 'accepted',
            pairPartnerId: 'user-b',
          }),
          entry('b', {
            status: 'grouped',
            groupId: 'group-two',
            pairStatus: 'accepted',
            pairPartnerId: 'user-a',
          }),
          seatedIn('group-one', 'c'),
          seatedIn('group-two', 'd'),
          entry('e', {
            status: 'grouped',
            groupId: 'group-one',
            pairStatus: 'accepted',
            pairPartnerId: 'user-f',
          }),
          entry('f', { pairStatus: 'accepted', pairPartnerId: 'user-e' }),
        ],
        { includeAnchors: false },
      );
      expect(pool.units.every((unit) => unit.members.length === 1)).toBe(true);
      const [groupOne, groupTwo] = groupUnitLists(pool, [
        'group-one',
        'group-two',
      ]);
      const groupOneUserIds = personIndexesOf(pool.units, groupOne ?? []).map(
        (person) => pool.members[person]!.entry.userId,
      );
      const groupTwoUserIds = personIndexesOf(pool.units, groupTwo ?? []).map(
        (person) => pool.members[person]!.entry.userId,
      );
      expect(groupOneUserIds.sort()).toEqual(['user-a', 'user-c', 'user-e']);
      expect(groupTwoUserIds.sort()).toEqual(['user-b', 'user-d']);
    });
  });

  it('marks talkers at 4 or 5 and flags accepted connections', async () => {
    const service = await build({
      profiles: [
        profile('a', { energy: { talker: 3, nightShape: 2, planner: 3 } }),
        profile('b', { energy: { talker: 4, nightShape: 2, planner: 3 } }),
        profile('c', { energy: { talker: 5, nightShape: 2, planner: 3 } }),
      ],
      connections: [{ userLow: 'user-a', userHigh: 'user-b' }],
    });
    const { pool } = await service.buildPool(
      [entry('a'), entry('b'), entry('c')],
      { includeAnchors: false },
    );
    const first = indexOf(pool, 'a');
    const second = indexOf(pool, 'b');
    const third = indexOf(pool, 'c');
    expect(pool.graph.isTalker(first)).toBe(false);
    expect(pool.graph.isTalker(second)).toBe(true);
    expect(pool.graph.isTalker(third)).toBe(true);
    expect(pool.graph.connected(first, second)).toBe(true);
    expect(pool.graph.connected(second, first)).toBe(true);
    expect(pool.graph.connected(first, third)).toBe(false);
  });
});
