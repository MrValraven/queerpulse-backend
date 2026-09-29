import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, MoreThan } from 'typeorm';
import { Connection } from '../connections/entities/connection.entity';
import { Block } from '../social/entities/block.entity';
import { EventMatchConfig } from './entities/event-match-config.entity';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import { EventMatchGroup } from './entities/event-match-group.entity';
import { FriendMatchProfile } from './entities/friend-match-profile.entity';
import { MatchAvoidance } from './entities/match-avoidance.entity';
import {
  MatchFeedback,
  MeetAgainVerdict,
} from './entities/match-feedback.entity';
import { MatchGroupFeedback } from './entities/match-group-feedback.entity';
import {
  FriendMatchAnswers,
  HostQuestion,
} from './go-together-questionnaire.catalog';
import {
  groupUnitLists,
  personIndexesOf,
  planPlacements,
  unitIndexesWhere,
} from './go-together-formation.helpers';
import {
  GoTogetherPoolService,
  INTEREST_FREQUENCY_SQL,
  INTEREST_IDF_TTL_MS,
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

/** Frequency rows as the aggregate returns them, for the given profiles. */
function interestFrequencyRows(profiles: FriendMatchProfile[]) {
  const documentFrequency = new Map<string, number>();
  for (const row of profiles) {
    for (const tagId of new Set(row.answers.interests)) {
      documentFrequency.set(tagId, (documentFrequency.get(tagId) ?? 0) + 1);
    }
  }
  return [...documentFrequency].map(([tagId, frequency]) => ({
    tag_id: tagId,
    document_frequency: frequency,
    profile_total: profiles.length,
  }));
}

interface PoolFixtures {
  profiles: FriendMatchProfile[];
  /** Every questionnaire on the platform; defaults to the pool's own. */
  platformProfiles?: FriendMatchProfile[];
  configs?: Pick<EventMatchConfig, 'eventId' | 'hostQuestions'>[];
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
  let profilesRepository: {
    find: jest.Mock;
    query: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let configsRepository: { find: jest.Mock };

  async function build(fixtures: PoolFixtures): Promise<GoTogetherPoolService> {
    // `createQueryBuilder` is here only to prove the pool never calls it: a
    // read of every questionnaire's interests would go through it.
    profilesRepository = {
      find: jest.fn().mockResolvedValue(fixtures.profiles),
      query: jest
        .fn()
        .mockResolvedValue(
          interestFrequencyRows(fixtures.platformProfiles ?? fixtures.profiles),
        ),
      createQueryBuilder: jest.fn(),
    };
    configsRepository = {
      find: jest.fn().mockResolvedValue(fixtures.configs ?? []),
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
          useValue: profilesRepository,
        },
        {
          provide: getRepositoryToken(EventMatchConfig),
          useValue: configsRepository,
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

  it('keeps a listed pending entry without a questionnaire answerless, so its accepted pair stays one unit', async () => {
    const service = await build({
      profiles: [profile('mover'), profile('c')],
      blocks: [{ blockerId: 'user-partner', blockedId: 'user-c' }],
    });
    const { pool, skippedEntryIds } = await service.buildPool(
      [
        entry('mover', {
          status: 'unmatched',
          pairStatus: 'accepted',
          pairPartnerId: 'user-partner',
        }),
        entry('partner', {
          status: 'unmatched',
          pairStatus: 'accepted',
          pairPartnerId: 'user-mover',
        }),
        entry('c'),
        entry('gone'),
      ],
      {
        includeAnchors: false,
        keepAnswerlessEntryIds: new Set(['entry-partner']),
      },
    );
    const mover = indexOf(pool, 'mover');
    const partner = indexOf(pool, 'partner');
    expect(skippedEntryIds).toEqual(['entry-gone']);
    expect(pool.members[partner]!.candidate).toBeNull();
    expect(pool.graph.score(mover, partner)).toBe(NEUTRAL_SCORE);
    expect(pool.graph.feasible(partner, indexOf(pool, 'c'))).toBe(false);
    expect(pool.units).toContainEqual({
      id: 'entry-mover',
      members: [mover, partner],
    });
  });

  describe('scoped reads', () => {
    it('reads questionnaires only for the pool members and takes the platform-wide IDF from the aggregate counts', async () => {
      const service = await build({
        profiles: [
          profile('a', { interests: ['boardGames', 'hiking'] }),
          profile('b', { interests: ['boardGames'] }),
        ],
      });
      // Platform: 99 questionnaires, boardGames in 49, hiking in 4.
      profilesRepository.query.mockResolvedValue([
        { tag_id: 'boardGames', document_frequency: 49, profile_total: 99 },
        { tag_id: 'hiking', document_frequency: 4, profile_total: 99 },
      ]);

      const { pool } = await service.buildPool([entry('a'), entry('b')], {
        includeAnchors: false,
      });

      expect(profilesRepository.find).toHaveBeenCalledTimes(1);
      expect(profilesRepository.find).toHaveBeenCalledWith({
        where: { userId: In(['user-a', 'user-b']) },
      });
      expect(profilesRepository.createQueryBuilder).not.toHaveBeenCalled();
      expect(profilesRepository.query).toHaveBeenCalledWith(
        INTEREST_FREQUENCY_SQL,
      );
      const idfOf = (tagId: string) => pool.context.interestIdf.get(tagId);
      expect(idfOf('boardGames')).toBeCloseTo(Math.log(100 / 50) + 1);
      expect(idfOf('hiking')).toBeCloseTo(Math.log(100 / 5) + 1);
      expect(idfOf('queerHistory')).toBeUndefined();
    });

    it('aggregates counts in SQL with snake_case aliases and loads no interest list', () => {
      expect(INTEREST_FREQUENCY_SQL).toContain('GROUP BY "interest"."tag_id"');
      expect(INTEREST_FREQUENCY_SQL).toContain('COUNT(DISTINCT');
      for (const alias of INTEREST_FREQUENCY_SQL.matchAll(/AS "([^"]+)"/g)) {
        expect(alias[1]).toMatch(/^[a-z_]+$/);
      }
    });

    it('runs the aggregate once per tick window, shared by every pool build in it', async () => {
      const service = await build({ profiles: [profile('a'), profile('b')] });
      const clock = jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
      const entries = [entry('a'), entry('b')];

      await service.buildPool(entries, { includeAnchors: false });
      await service.buildPool(entries, { includeAnchors: false });
      clock.mockReturnValue(NOW.getTime() + INTEREST_IDF_TTL_MS - 1);
      await service.buildPool(entries, { includeAnchors: false });
      expect(profilesRepository.query).toHaveBeenCalledTimes(1);

      clock.mockReturnValue(NOW.getTime() + INTEREST_IDF_TTL_MS);
      await service.buildPool(entries, { includeAnchors: false });
      expect(profilesRepository.query).toHaveBeenCalledTimes(2);
      clock.mockRestore();
    });

    it('asks again on the next build after a failed aggregate', async () => {
      const service = await build({ profiles: [profile('a'), profile('b')] });
      const entries = [entry('a'), entry('b')];
      profilesRepository.query.mockRejectedValueOnce(new Error('timeout'));

      await expect(
        service.buildPool(entries, { includeAnchors: false }),
      ).rejects.toThrow('timeout');
      await service.buildPool(entries, { includeAnchors: false });

      expect(profilesRepository.query).toHaveBeenCalledTimes(2);
    });

    it("reads the host questions of the pool's gathering only", async () => {
      const service = await build({ profiles: [profile('a'), profile('b')] });

      await service.buildPool([entry('a'), entry('b')], {
        includeAnchors: false,
      });

      expect(configsRepository.find).toHaveBeenCalledWith({
        where: { eventId: In(['event-1']) },
        select: { eventId: true, hostQuestions: true },
      });
    });
  });

  describe('host answers', () => {
    const currentQuestion: HostQuestion = {
      id: 'q-plan',
      prompt: 'Before or after?',
      options: [
        { id: 'before', label: 'Before' },
        { id: 'after', label: 'After' },
      ],
    };

    it('scores only answers to the questions the host asks now', async () => {
      const service = await build({
        profiles: [profile('a'), profile('b')],
        configs: [{ eventId: 'event-1', hostQuestions: [currentQuestion] }],
      });

      const { pool } = await service.buildPool(
        [
          entry('a', {
            hostAnswers: { 'q-plan': 'before', 'q-removed': 'yes' },
          }),
          entry('b', {
            hostAnswers: { 'q-plan': 'gone-option', 'q-removed': 'yes' },
          }),
        ],
        { includeAnchors: false },
      );

      expect(
        pool.members.map((member) => member.candidate?.hostAnswers),
      ).toEqual([{ 'q-plan': 'before' }, {}]);
      // The removed question both answered alike earns no host bonus.
      expect(
        pool.componentsFor(indexOf(pool, 'a'), indexOf(pool, 'b')).hostBonus,
      ).toBe(0);
    });

    it('drops every host answer when the gathering has no config', async () => {
      const service = await build({ profiles: [profile('a')] });

      const { pool } = await service.buildPool(
        [entry('a', { hostAnswers: { 'q-plan': 'before' } })],
        { includeAnchors: false },
      );

      expect(pool.members[0]?.candidate?.hostAnswers).toEqual({});
    });
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
