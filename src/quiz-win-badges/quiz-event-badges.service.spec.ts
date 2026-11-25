import { DataSource, Repository } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { MemberLookup } from '../common/member-ref';
import { ModAuditService } from '../moderation/mod-audit.service';
import { Profile } from '../users/entities/profile.entity';
import {
  ELIGIBLE_WINNER_USER_IDS_SQL,
  QuizBadgeAwardingService,
  QuizBadgeNewWin,
} from './quiz-badge-awarding.service';
import {
  DELETE_EVENT_SLOT_SQL,
  INSERT_EVENT_SLOT_SQL,
  LOAD_QUIZ_BADGE_EVENT_SQL,
  QuizEventBadgesService,
  READ_EVENT_SLOTS_SQL,
  READ_EVENT_WINNER_SQL,
  READ_LIVE_GAME_WINNERS_SQL,
  READ_NUMBERED_GAME_SESSION_SQL,
  READ_NUMBERED_SESSIONS_SQL,
  READ_SESSION_WINNERS_SQL,
  READ_SESSION_WINS_SQL,
  READ_SETUP_DEFINITIONS_FOR_SHARE_SQL,
  READ_SETUP_DEFINITIONS_SQL,
  READ_WINNER_REVOKED_AT_SQL,
  SEARCH_QUIZ_EVENTS_SQL,
} from './quiz-event-badges.service';
import { QUIZ_EVENT_BADGES_LOCK_SQL } from './quiz-win-badges.constants';

const EVENT_ID = '0b9f3c1e-5a4d-4c6b-9e2f-1a2b3c4d5e01';
const OTHER_EVENT_ID = '0b9f3c1e-5a4d-4c6b-9e2f-1a2b3c4d5e02';
const DEF_1 = '7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e01';
const DEF_2 = '7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e02';
const DEF_3 = '7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e03';
const DEF_4 = '7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e04';
const WINNER_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c01';
const FINISHED_AT = new Date('2026-11-24T21:30:00.000Z');
const REVOKED_AT = new Date('2026-11-25T10:00:00.000Z');

interface DefinitionFixture {
  id: string;
  badge_key: string;
  name_en: string;
  name_pt: string | null;
  icon_key: string;
  tint: string;
  rarity: string;
  archived_at: Date | null;
}

interface SlotFixture extends DefinitionFixture {
  slot_id: string;
  game_number: number;
}

interface LiveWinnerFixture {
  id: string;
  session_id: string | null;
  user_id: string;
  finished_at: Date;
  game_number: number;
  revoked_at: Date | null;
}

interface EventWinnerFixture {
  id: string;
  user_id: string;
  event_id: string;
  revoked_at: Date | null;
}

interface FakeDatabase {
  event: Record<string, unknown> | null;
  definitions: DefinitionFixture[];
  slots: SlotFixture[];
  gameSessions: { id: string; game_number: number; rounds: unknown }[];
  liveWinners: LiveWinnerFixture[];
  eligibleUserIds: string[];
  numberedSessions: Record<string, unknown>[];
  sessionWinners: Record<string, unknown>[];
  sessionWins: Record<string, unknown>[];
  eventWinners: EventWinnerFixture[];
  searchRows: Record<string, unknown>[];
  /** What the share-locked re-read sees; null reads the same definitions. */
  definitionsAtLock: DefinitionFixture[] | null;
}

function definitionRow(
  id: string,
  nameEn: string,
  archivedAt: Date | null = null,
): DefinitionFixture {
  return {
    id,
    badge_key: `quiz:${id}`,
    name_en: nameEn,
    name_pt: null,
    icon_key: 'trophy',
    tint: 'jade',
    rarity: 'rare',
    archived_at: archivedAt,
  };
}

function newWin(winId: string): QuizBadgeNewWin {
  return {
    winId,
    userId: 'user-1',
    badgeKey: `quiz:${DEF_1}`,
    badgeNameEn: 'Quiz Night Champion',
    badgeNamePt: null,
    eventName: 'Pride Quiz Night',
  };
}

function liveWinner(
  id: string,
  userId: string,
  revokedAt: Date | null = null,
): LiveWinnerFixture {
  return {
    id,
    session_id: 'session-1',
    user_id: userId,
    finished_at: FINISHED_AT,
    game_number: 1,
    revoked_at: revokedAt,
  };
}

describe('QuizEventBadgesService', () => {
  let database: FakeDatabase;
  let insertedSlotCount: number;
  let dataSource: { query: jest.Mock; transaction: jest.Mock };
  let manager: { query: jest.Mock };
  let profiles: { find: jest.Mock };
  let awarding: {
    awardWin: jest.Mock;
    revokeGameWin: jest.Mock;
    notifyNewWins: jest.Mock;
  };
  let modAudit: { writeAuditLog: jest.Mock };
  let service: QuizEventBadgesService;

  /** Answers every raw query from the fake database, by SQL text. */
  function answer(sql: string, params: unknown[] = []): unknown {
    switch (sql) {
      case QUIZ_EVENT_BADGES_LOCK_SQL:
        return [{ pg_advisory_xact_lock: '' }];
      case SEARCH_QUIZ_EVENTS_SQL:
        return database.searchRows;
      case LOAD_QUIZ_BADGE_EVENT_SQL:
        return database.event === null ? [] : [database.event];
      case READ_SETUP_DEFINITIONS_FOR_SHARE_SQL: {
        const requestedIds = params[0] as string[];
        return (database.definitionsAtLock ?? database.definitions).filter(
          (definition) => requestedIds.includes(definition.id),
        );
      }
      case READ_SETUP_DEFINITIONS_SQL: {
        const requestedIds = params[0] as string[];
        return database.definitions.filter((definition) =>
          requestedIds.includes(definition.id),
        );
      }
      case READ_EVENT_SLOTS_SQL:
        return [...database.slots].sort(
          (first, second) => first.game_number - second.game_number,
        );
      case DELETE_EVENT_SLOT_SQL:
        database.slots = database.slots.filter(
          (slot) => slot.slot_id !== params[0],
        );
        return [[], 1];
      case INSERT_EVENT_SLOT_SQL: {
        const definition = database.definitions.find(
          (candidate) => candidate.id === params[2],
        ) as DefinitionFixture;
        insertedSlotCount += 1;
        database.slots.push({
          ...definition,
          slot_id: `slot-new-${insertedSlotCount}`,
          game_number: params[1] as number,
        });
        return [];
      }
      case READ_NUMBERED_GAME_SESSION_SQL:
        return database.gameSessions
          .filter((session) => session.game_number === params[1])
          .map((session) => ({ id: session.id, rounds: session.rounds }));
      case READ_LIVE_GAME_WINNERS_SQL:
        return database.liveWinners
          .filter(
            (winner) =>
              winner.game_number === params[1] && winner.revoked_at === null,
          )
          .map((winner) => ({
            id: winner.id,
            session_id: winner.session_id,
            user_id: winner.user_id,
            finished_at: winner.finished_at,
          }));
      case ELIGIBLE_WINNER_USER_IDS_SQL: {
        const candidateIds = params[0] as string[];
        return database.eligibleUserIds
          .filter((userId) => candidateIds.includes(userId))
          .map((userId) => ({ id: userId }));
      }
      case READ_NUMBERED_SESSIONS_SQL:
        return database.numberedSessions;
      case READ_SESSION_WINNERS_SQL:
        return database.sessionWinners;
      case READ_SESSION_WINS_SQL:
        return database.sessionWins;
      case READ_EVENT_WINNER_SQL:
        return database.eventWinners
          .filter(
            (winner) =>
              winner.id === params[0] && winner.event_id === params[1],
          )
          .map((winner) => ({
            id: winner.id,
            user_id: winner.user_id,
            revoked_at: winner.revoked_at,
          }));
      case READ_WINNER_REVOKED_AT_SQL:
        return [{ revoked_at: REVOKED_AT }];
      default:
        throw new Error(`Unexpected query: ${sql}`);
    }
  }

  function auditCallsFor(action: string): unknown[][] {
    const calls = modAudit.writeAuditLog.mock.calls as unknown[][];
    return calls.filter((call) => call[2] === action);
  }

  function queriesOf(mock: jest.Mock, sql: string): unknown[][] {
    const calls = mock.mock.calls as unknown[][];
    return calls.filter((call) => call[0] === sql);
  }

  beforeEach(() => {
    insertedSlotCount = 0;
    database = {
      event: {
        id: EVENT_ID,
        slug: 'pride-quiz-night',
        title: 'Pride Quiz Night',
        start_at: new Date('2026-11-24T20:00:00.000Z'),
        status: 'published',
        visibility: 'public',
        is_adults_only: false,
        has_quiz: true,
      },
      definitions: [
        definitionRow(DEF_1, 'Quiz Night Champion'),
        definitionRow(DEF_2, 'Trivia Royalty'),
        definitionRow(DEF_3, 'Sharp Mind'),
        definitionRow(DEF_4, 'Last Round Hero'),
      ],
      slots: [],
      gameSessions: [],
      liveWinners: [],
      eligibleUserIds: [],
      numberedSessions: [],
      sessionWinners: [],
      sessionWins: [],
      eventWinners: [],
      searchRows: [],
      definitionsAtLock: null,
    };
    dataSource = {
      query: jest.fn((sql: string, params?: unknown[]) =>
        Promise.resolve(answer(sql, params)),
      ),
      transaction: jest.fn(
        (work: (transactionManager: unknown) => Promise<unknown>) =>
          work(manager),
      ),
    };
    manager = {
      query: jest.fn((sql: string, params?: unknown[]) =>
        Promise.resolve(answer(sql, params)),
      ),
    };
    profiles = { find: jest.fn().mockResolvedValue([]) };
    awarding = {
      awardWin: jest.fn().mockResolvedValue(null),
      revokeGameWin: jest.fn().mockResolvedValue(null),
      notifyNewWins: jest.fn().mockResolvedValue(undefined),
    };
    modAudit = { writeAuditLog: jest.fn().mockResolvedValue('audit-1') };
    service = new QuizEventBadgesService(
      dataSource as unknown as DataSource,
      profiles as unknown as Repository<Profile>,
      awarding as unknown as QuizBadgeAwardingService,
      modAudit as unknown as ModAuditService,
    );
  });

  /** Game 1 finished in session-1 with an adults round in its snapshot. */
  function finishGameOne(): void {
    database.gameSessions = [
      {
        id: 'session-1',
        game_number: 1,
        rounds: [{ contentLabel: 'general' }, { contentLabel: 'adults' }],
      },
    ];
  }

  describe('saveSetup checks', () => {
    it.each([
      [null, 'quiz_badge_setup_invalid'],
      [{ games: {} }, 'quiz_badge_setup_invalid'],
      [
        { games: [{ gameNumber: 1.5, badgeDefinitionIds: [] }] },
        'quiz_badge_game_number_invalid',
      ],
      [
        { games: [{ gameNumber: 6, badgeDefinitionIds: [] }] },
        'quiz_badge_game_limit_reached',
      ],
      [
        { games: [{ gameNumber: 1, badgeDefinitionIds: [DEF_1, DEF_1] }] },
        'quiz_badge_slot_duplicate',
      ],
      [
        {
          games: [
            { gameNumber: 1, badgeDefinitionIds: [DEF_1, DEF_2] },
            { gameNumber: 1, badgeDefinitionIds: [DEF_3, DEF_4] },
          ],
        },
        'quiz_badge_slot_limit_reached',
      ],
    ])('refuses %p with %s', async (body, code) => {
      await expect(
        service.saveSetup('admin-1', EVENT_ID, body as never),
      ).rejects.toMatchObject({ response: { code } });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('answers a game number refusal with the game number and the limit', async () => {
      await expect(
        service.saveSetup('admin-1', EVENT_ID, {
          games: [{ gameNumber: 0, badgeDefinitionIds: [] }],
        }),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_game_number_invalid', gameNumber: 0 },
      });
      await expect(
        service.saveSetup('admin-1', EVENT_ID, {
          games: [{ gameNumber: 6, badgeDefinitionIds: [] }],
        }),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_game_limit_reached', limit: 5 },
      });
    });

    it('refuses an id list that holds something other than text', async () => {
      await expect(
        service.saveSetup('admin-1', EVENT_ID, {
          games: [{ gameNumber: 1, badgeDefinitionIds: [DEF_1, 7] }],
        }),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_setup_invalid' },
      });
    });

    it('refuses a malformed or unknown definition id with that id', async () => {
      await expect(
        service.saveSetup('admin-1', EVENT_ID, {
          games: [{ gameNumber: 1, badgeDefinitionIds: ['not-a-uuid'] }],
        }),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_not_found', definitionId: 'not-a-uuid' },
      });
      database.definitions = database.definitions.filter(
        (definition) => definition.id !== DEF_3,
      );
      await expect(
        service.saveSetup('admin-1', EVENT_ID, {
          games: [{ gameNumber: 1, badgeDefinitionIds: [DEF_1, DEF_3] }],
        }),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_not_found', definitionId: DEF_3 },
      });
    });

    it('refuses an archived badge on a game that does not hold it and keeps it where it is', async () => {
      database.definitions[1] = definitionRow(
        DEF_2,
        'Trivia Royalty',
        new Date('2026-11-20T00:00:00.000Z'),
      );
      database.slots = [
        { ...database.definitions[1], slot_id: 'slot-2', game_number: 2 },
      ];

      await expect(
        service.saveSetup('admin-1', EVENT_ID, {
          games: [
            { gameNumber: 1, badgeDefinitionIds: [DEF_2] },
            { gameNumber: 2, badgeDefinitionIds: [DEF_2] },
          ],
        }),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_archived', definitionId: DEF_2 },
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();

      await service.saveSetup('admin-1', EVENT_ID, {
        games: [{ gameNumber: 2, badgeDefinitionIds: [DEF_2] }],
      });
      expect(queriesOf(manager.query, INSERT_EVENT_SLOT_SQL)).toHaveLength(0);
      expect(queriesOf(manager.query, DELETE_EVENT_SLOT_SQL)).toHaveLength(0);
      expect(database.slots.map((slot) => slot.slot_id)).toEqual(['slot-2']);
    });

    it('answers no quiz before any slot write', async () => {
      (database.event as Record<string, unknown>).has_quiz = false;

      await expect(
        service.saveSetup('admin-1', EVENT_ID, {
          games: [{ gameNumber: 1, badgeDefinitionIds: [DEF_1] }],
        }),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_event_has_no_quiz' },
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(manager.query).not.toHaveBeenCalled();
    });

    it('answers event not found for a malformed or unknown event id', async () => {
      await expect(
        service.saveSetup('admin-1', 'not-a-uuid', { games: [] }),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_event_not_found' },
      });
      database.event = null;
      await expect(
        service.saveSetup('admin-1', EVENT_ID, { games: [] }),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_event_not_found' },
      });
    });
  });

  describe('saveSetup writes', () => {
    it('takes the event lock before reading the current slots', async () => {
      await service.saveSetup('admin-1', EVENT_ID, {
        games: [{ gameNumber: 1, badgeDefinitionIds: [DEF_1] }],
      });
      expect(manager.query.mock.calls[0]).toEqual([
        QUIZ_EVENT_BADGES_LOCK_SQL,
        [EVENT_ID],
      ]);
      expect(manager.query.mock.calls[1]).toEqual([
        READ_SETUP_DEFINITIONS_FOR_SHARE_SQL,
        [[DEF_1]],
      ]);
      expect(manager.query.mock.calls[2]).toEqual([
        READ_EVENT_SLOTS_SQL,
        [EVENT_ID],
      ]);
    });

    it('answers not found for a definition deleted between the first read and the lock', async () => {
      database.definitionsAtLock = database.definitions.filter(
        (definition) => definition.id !== DEF_2,
      );

      await expect(
        service.saveSetup('admin-1', EVENT_ID, {
          games: [{ gameNumber: 1, badgeDefinitionIds: [DEF_1, DEF_2] }],
        }),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_not_found', definitionId: DEF_2 },
      });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(queriesOf(manager.query, INSERT_EVENT_SLOT_SQL)).toHaveLength(0);
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
    });

    it('answers archived for a definition archived between the first read and the lock', async () => {
      database.definitionsAtLock = [
        definitionRow(DEF_1, 'Quiz Night Champion', REVOKED_AT),
      ];

      await expect(
        service.saveSetup('admin-1', EVENT_ID, {
          games: [{ gameNumber: 1, badgeDefinitionIds: [DEF_1] }],
        }),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_archived', definitionId: DEF_1 },
      });
      expect(queriesOf(manager.query, INSERT_EVENT_SLOT_SQL)).toHaveLength(0);
    });

    it('reads an uppercase definition id as the same badge', async () => {
      await expect(
        service.saveSetup('admin-1', EVENT_ID, {
          games: [
            { gameNumber: 1, badgeDefinitionIds: [DEF_1, DEF_1.toUpperCase()] },
          ],
        }),
      ).rejects.toMatchObject({
        response: {
          code: 'quiz_badge_slot_duplicate',
          gameNumber: 1,
          definitionId: DEF_1,
        },
      });

      await service.saveSetup('admin-1', EVENT_ID, {
        games: [{ gameNumber: 1, badgeDefinitionIds: [DEF_2.toUpperCase()] }],
      });
      expect(queriesOf(manager.query, INSERT_EVENT_SLOT_SQL)).toEqual([
        [INSERT_EVENT_SLOT_SQL, [EVENT_ID, 1, DEF_2, 'admin-1']],
      ]);
    });

    it('writes one attach and one detach audit row per changed slot', async () => {
      database.slots = [
        { ...database.definitions[1]!, slot_id: 'slot-2', game_number: 1 },
      ];

      await service.saveSetup('admin-1', EVENT_ID, {
        games: [{ gameNumber: 1, badgeDefinitionIds: [DEF_1] }],
      });

      expect(queriesOf(manager.query, DELETE_EVENT_SLOT_SQL)).toEqual([
        [DELETE_EVENT_SLOT_SQL, ['slot-2']],
      ]);
      expect(queriesOf(manager.query, INSERT_EVENT_SLOT_SQL)).toEqual([
        [INSERT_EVENT_SLOT_SQL, [EVENT_ID, 1, DEF_1, 'admin-1']],
      ]);
      expect(auditCallsFor('quiz_badge_attached')).toEqual([
        [
          null,
          'admin-1',
          'quiz_badge_attached',
          undefined,
          `Quiz Night Champion (${DEF_1}), game 1, event ${EVENT_ID}`,
          undefined,
          manager,
          null,
        ],
      ]);
      expect(auditCallsFor('quiz_badge_detached')).toEqual([
        [
          null,
          'admin-1',
          'quiz_badge_detached',
          undefined,
          `Trivia Royalty (${DEF_2}), game 1, event ${EVENT_ID}`,
          undefined,
          manager,
          null,
        ],
      ]);
    });

    it('awards an added badge to the finished game live winners and audits each win', async () => {
      finishGameOne();
      database.liveWinners = [
        liveWinner('winner-1', 'user-1'),
        liveWinner('winner-2', 'user-2'),
      ];
      database.eligibleUserIds = ['user-1', 'user-2'];
      awarding.awardWin
        .mockResolvedValueOnce(newWin('win-1'))
        .mockResolvedValueOnce(null);

      const response = await service.saveSetup('admin-1', EVENT_ID, {
        games: [{ gameNumber: 1, badgeDefinitionIds: [DEF_1] }],
      });

      expect(awarding.awardWin).toHaveBeenCalledTimes(2);
      expect(awarding.awardWin).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          userId: 'user-1',
          sessionId: 'session-1',
          gameNumber: 1,
          wonAt: FINISHED_AT,
          eventWasAdultsOnly: true,
        }),
      );
      expect(awarding.awardWin).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          definition: {
            id: DEF_1,
            badgeKey: `quiz:${DEF_1}`,
            nameEn: 'Quiz Night Champion',
            namePt: null,
          },
          eventId: EVENT_ID,
          eventName: 'Pride Quiz Night',
          eventWasPublic: true,
        }),
      );
      expect(response.awardedWinCount).toBe(1);
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        'admin-1',
        'quiz_badge_awarded_after_game',
        undefined,
        `Quiz Night Champion (${DEF_1}), game 1, event ${EVENT_ID}`,
        undefined,
        manager,
        'user-1',
      );
      expect(auditCallsFor('quiz_badge_awarded_after_game')).toHaveLength(1);
      expect(awarding.notifyNewWins).toHaveBeenCalledWith([newWin('win-1')]);
    });

    it('snapshots an after-the-game win as public only for a public and published event', async () => {
      for (const [visibility, status, isExpectedPublic] of [
        ['public', 'published', true],
        ['public', 'draft', false],
        ['public', 'cancelled', false],
        ['members', 'published', false],
      ] as const) {
        awarding.awardWin.mockClear();
        database.slots = [];
        database.event = {
          ...(database.event as Record<string, unknown>),
          visibility,
          status,
        };
        finishGameOne();
        database.liveWinners = [liveWinner('winner-1', 'user-1')];
        database.eligibleUserIds = ['user-1'];

        await service.saveSetup('admin-1', EVENT_ID, {
          games: [{ gameNumber: 1, badgeDefinitionIds: [DEF_1] }],
        });

        expect(awarding.awardWin).toHaveBeenCalledTimes(1);
        expect(awarding.awardWin).toHaveBeenCalledWith(
          manager,
          expect.objectContaining({ eventWasPublic: isExpectedPublic }),
        );
      }
    });

    it('awards across every added game in badge key order and then member id order', async () => {
      database.gameSessions = [
        { id: 'session-1', game_number: 1, rounds: [] },
        { id: 'session-2', game_number: 2, rounds: [] },
      ];
      database.liveWinners = [
        liveWinner('winner-2', 'user-2'),
        liveWinner('winner-1', 'user-1'),
        {
          ...liveWinner('winner-3', 'user-3'),
          session_id: 'session-2',
          game_number: 2,
        },
      ];
      database.eligibleUserIds = ['user-1', 'user-2', 'user-3'];

      await service.saveSetup('admin-1', EVENT_ID, {
        games: [
          { gameNumber: 1, badgeDefinitionIds: [DEF_2] },
          { gameNumber: 2, badgeDefinitionIds: [DEF_1] },
        ],
      });

      const awardCalls = awarding.awardWin.mock.calls as [
        unknown,
        {
          definition: { id: string };
          userId: string;
          sessionId: string;
          gameNumber: number;
        },
      ][];
      expect(
        awardCalls.map(
          ([, input]) =>
            `${input.definition.id}/${input.userId}/${input.sessionId}/${input.gameNumber}`,
        ),
      ).toEqual([
        `${DEF_1}/user-3/session-2/2`,
        `${DEF_2}/user-1/session-1/1`,
        `${DEF_2}/user-2/session-1/1`,
      ]);
    });

    it('sends the notifications after the transaction resolves', async () => {
      finishGameOne();
      database.liveWinners = [liveWinner('winner-1', 'user-1')];
      database.eligibleUserIds = ['user-1'];
      awarding.awardWin.mockResolvedValueOnce(newWin('win-1'));
      let isTransactionOpen = false;
      dataSource.transaction.mockImplementation(
        async (work: (transactionManager: unknown) => Promise<unknown>) => {
          isTransactionOpen = true;
          const result = await work(manager);
          isTransactionOpen = false;
          return result;
        },
      );
      let isSentInsideTransaction: boolean | null = null;
      awarding.notifyNewWins.mockImplementation(() => {
        isSentInsideTransaction = isTransactionOpen;
        return Promise.resolve();
      });

      await service.saveSetup('admin-1', EVENT_ID, {
        games: [{ gameNumber: 1, badgeDefinitionIds: [DEF_1] }],
      });

      expect(isSentInsideTransaction).toBe(false);
    });

    it('skips a revoked winner when a badge is attached later', async () => {
      finishGameOne();
      database.liveWinners = [
        liveWinner('winner-1', 'user-1'),
        liveWinner('winner-3', 'user-3', REVOKED_AT),
      ];
      database.eligibleUserIds = ['user-1', 'user-3'];

      await service.saveSetup('admin-1', EVENT_ID, {
        games: [{ gameNumber: 1, badgeDefinitionIds: [DEF_1] }],
      });

      const winnerReads = queriesOf(manager.query, READ_LIVE_GAME_WINNERS_SQL);
      expect(winnerReads).toHaveLength(1);
      expect(winnerReads[0]?.[0]).toContain('"revoked_at" IS NULL');
      expect(winnerReads[0]?.[1]).toEqual([EVENT_ID, 1]);
      expect(awarding.awardWin).toHaveBeenCalledTimes(1);
      expect(awarding.awardWin).not.toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ userId: 'user-3' }),
      );
    });

    it('skips a suspended winner when awarding after the game', async () => {
      finishGameOne();
      database.liveWinners = [
        liveWinner('winner-1', 'user-1'),
        liveWinner('winner-2', 'user-2'),
      ];
      database.eligibleUserIds = ['user-1'];

      await service.saveSetup('admin-1', EVENT_ID, {
        games: [{ gameNumber: 1, badgeDefinitionIds: [DEF_1] }],
      });

      expect(queriesOf(manager.query, ELIGIBLE_WINNER_USER_IDS_SQL)).toEqual([
        [ELIGIBLE_WINNER_USER_IDS_SQL, [['user-1', 'user-2']]],
      ]);
      expect(awarding.awardWin).toHaveBeenCalledTimes(1);
      expect(awarding.awardWin).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    it('awards nothing for an added badge of a game with no numbered session', async () => {
      database.liveWinners = [liveWinner('winner-1', 'user-1')];
      database.eligibleUserIds = ['user-1'];

      const response = await service.saveSetup('admin-1', EVENT_ID, {
        games: [{ gameNumber: 1, badgeDefinitionIds: [DEF_1] }],
      });

      expect(awarding.awardWin).not.toHaveBeenCalled();
      expect(queriesOf(manager.query, READ_LIVE_GAME_WINNERS_SQL)).toHaveLength(
        0,
      );
      expect(response.awardedWinCount).toBe(0);
      expect(awarding.notifyNewWins).not.toHaveBeenCalled();
    });

    it('awards each added badge once when the same setup is saved twice', async () => {
      finishGameOne();
      database.liveWinners = [liveWinner('winner-1', 'user-1')];
      database.eligibleUserIds = ['user-1'];
      awarding.awardWin.mockResolvedValueOnce(newWin('win-1'));
      const body = { games: [{ gameNumber: 1, badgeDefinitionIds: [DEF_1] }] };

      const firstResponse = await service.saveSetup('admin-1', EVENT_ID, body);
      const secondResponse = await service.saveSetup('admin-1', EVENT_ID, body);

      expect(firstResponse.awardedWinCount).toBe(1);
      expect(secondResponse.awardedWinCount).toBe(0);
      expect(awarding.awardWin).toHaveBeenCalledTimes(1);
      expect(queriesOf(manager.query, INSERT_EVENT_SLOT_SQL)).toHaveLength(1);
      expect(auditCallsFor('quiz_badge_attached')).toHaveLength(1);
      expect(awarding.notifyNewWins).toHaveBeenCalledTimes(1);
    });

    it('answers the setup read after the save', async () => {
      const response = await service.saveSetup('admin-1', EVENT_ID, {
        games: [{ gameNumber: 3, badgeDefinitionIds: [DEF_1, DEF_2] }],
      });

      expect(
        response.setup.games[2]!.badges.map((badge) => badge.definitionId),
      ).toEqual([DEF_1, DEF_2]);
      expect(response.setup.games[0]!.badges).toEqual([]);
    });
  });

  describe('getSetup', () => {
    it('lists all five games, every numbered finished game and a game with no winner', async () => {
      database.slots = [
        { ...database.definitions[0]!, slot_id: 'slot-1', game_number: 1 },
      ];
      database.numberedSessions = [
        {
          id: 'session-1',
          event_game_number: 1,
          ended_at: FINISHED_AT,
          play_mode: 'teams',
        },
        {
          id: 'session-6',
          event_game_number: 6,
          ended_at: new Date('2026-11-24T23:00:00.000Z'),
          play_mode: 'solo',
        },
      ];
      database.sessionWinners = [
        {
          id: 'winner-1',
          session_id: 'session-1',
          user_id: 'user-1',
          screen_name: 'Glitter',
          team_name: 'Quizzy Rascals',
          revoked_at: null,
          revoke_reason: null,
          revoked_by_id: null,
        },
      ];
      database.sessionWins = [
        {
          ...database.definitions[0]!,
          win_id: 'win-1',
          session_id: 'session-1',
          user_id: 'user-1',
          won_at: FINISHED_AT,
        },
      ];

      const setup = await service.getSetup(EVENT_ID);

      expect(setup.games).toHaveLength(5);
      expect(setup.games.map((game) => game.gameNumber)).toEqual([
        1, 2, 3, 4, 5,
      ]);
      expect(setup.games[0]!.isFinished).toBe(true);
      expect(setup.games[1]!.isFinished).toBe(false);
      expect(setup.games[0]!.badges.map((badge) => badge.badgeKey)).toEqual([
        `quiz:${DEF_1}`,
      ]);
      expect(setup.nextGameNumber).toBe(7);
      expect(setup.limits).toEqual({ gameSlotsMax: 5, badgesPerGameMax: 3 });
      expect(setup.event).toEqual({
        id: EVENT_ID,
        slug: 'pride-quiz-night',
        title: 'Pride Quiz Night',
        startAt: '2026-11-24T20:00:00.000Z',
        status: 'published',
        isAdultsOnly: false,
        isPublic: true,
      });
      expect(setup.finishedGames.map((game) => game.gameNumber)).toEqual([
        1, 6,
      ]);
      expect(setup.finishedGames[0]).toMatchObject({
        sessionId: 'session-1',
        finishedAt: FINISHED_AT.toISOString(),
        playMode: 'teams',
      });
      expect(setup.finishedGames[1]!.winners).toEqual([]);
      expect(setup.finishedGames[0]!.winners).toEqual([
        {
          winnerId: 'winner-1',
          screenName: 'Glitter',
          teamName: 'Quizzy Rascals',
          member: null,
          wins: [
            {
              winId: 'win-1',
              badge: expect.objectContaining({
                definitionId: DEF_1,
                isArchived: false,
              }) as unknown,
              wonAt: FINISHED_AT.toISOString(),
            },
          ],
          isRevoked: false,
          revokedAt: null,
          revokeReason: null,
          revokedBy: null,
        },
      ]);
      expect(profiles.find).toHaveBeenCalledTimes(1);
      expect(profiles.find).toHaveBeenCalledWith(
        MemberLookup.findOptionsFor(['user-1']),
      );
    });

    it('offers game 1 to an event with no numbered game', async () => {
      const setup = await service.getSetup(EVENT_ID);

      expect(setup.nextGameNumber).toBe(1);
      expect(setup.finishedGames).toEqual([]);
      expect(setup.games.every((game) => !game.isFinished)).toBe(true);
    });

    it('answers no quiz for an event without a quiz', async () => {
      (database.event as Record<string, unknown>).has_quiz = false;

      await expect(service.getSetup(EVENT_ID)).rejects.toMatchObject({
        response: { code: 'quiz_badge_event_has_no_quiz' },
      });
    });
  });

  describe('searchEvents', () => {
    it('cuts and escapes the search term', async () => {
      await service.searchEvents(`  50%_off ${'x'.repeat(200)}`, 'abc');
      const [, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
      expect(params[0]).toBe(
        escapeLikeTerm(`50%_off ${'x'.repeat(200)}`.slice(0, 100)),
      );
      expect(params[1]).toBe(0);
    });

    it('maps the rows and reads the total from the window count', async () => {
      database.searchRows = [
        {
          id: EVENT_ID,
          slug: 'pride-quiz-night',
          title: 'Pride Quiz Night',
          start_at: new Date('2026-11-24T20:00:00.000Z'),
          status: 'published',
          is_adults_only: true,
          configured_game_count: 2,
          finished_game_count: '1',
          total: '41',
        },
      ];

      const result = await service.searchEvents(undefined, '3');

      const [, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual(['', 40]);
      expect(result).toEqual({
        items: [
          {
            eventId: EVENT_ID,
            slug: 'pride-quiz-night',
            title: 'Pride Quiz Night',
            startAt: '2026-11-24T20:00:00.000Z',
            status: 'published',
            isAdultsOnly: true,
            configuredGameCount: 2,
            finishedGameCount: 1,
          },
        ],
        total: 41,
        page: 3,
        pageSize: 20,
      });
    });

    it('caps the page at the maximum page', async () => {
      const result = await service.searchEvents('', '999999');

      expect(result.page).toBe(10_000);
      const [, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
      expect(params[1]).toBe((10_000 - 1) * 20);
    });
  });

  describe('revokeWinner', () => {
    beforeEach(() => {
      database.eventWinners = [
        {
          id: WINNER_ID,
          user_id: 'user-1',
          event_id: EVENT_ID,
          revoked_at: null,
        },
      ];
    });

    it('answers winner not found for a winner of another event', async () => {
      database.eventWinners[0]!.event_id = OTHER_EVENT_ID;

      await expect(
        service.revokeWinner('admin-1', EVENT_ID, WINNER_ID, {
          reason: 'Wrong team entered',
        }),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_winner_not_found' },
      });
      expect(queriesOf(dataSource.query, READ_EVENT_WINNER_SQL)).toEqual([
        [READ_EVENT_WINNER_SQL, [WINNER_ID, EVENT_ID]],
      ]);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('answers winner not found for a malformed winner id', async () => {
      await expect(
        service.revokeWinner('admin-1', EVENT_ID, 'not-a-uuid', {
          reason: 'Wrong team entered',
        }),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_winner_not_found' },
      });
    });

    it('answers event not found before the winner and skips the quiz check', async () => {
      database.event = null;
      await expect(
        service.revokeWinner('admin-1', EVENT_ID, WINNER_ID, {
          reason: 'Wrong team entered',
        }),
      ).rejects.toMatchObject({
        response: { code: 'quiz_badge_event_not_found' },
      });

      database.event = {
        id: EVENT_ID,
        slug: 'pride-quiz-night',
        title: 'Pride Quiz Night',
        start_at: new Date('2026-11-24T20:00:00.000Z'),
        status: 'published',
        visibility: 'public',
        is_adults_only: false,
        has_quiz: false,
      };
      awarding.revokeGameWin.mockResolvedValueOnce({
        userId: 'user-1',
        eventId: EVENT_ID,
        revokedBadgeKeys: [],
        removedAwardKeys: [],
      });
      await expect(
        service.revokeWinner('admin-1', EVENT_ID, WINNER_ID, {
          reason: 'Wrong team entered',
        }),
      ).resolves.toEqual({
        winnerId: WINNER_ID,
        revokedBadgeKeys: [],
        removedAwardKeys: [],
      });
    });

    it('checks the reason after the winner is found live', async () => {
      database.eventWinners[0]!.revoked_at = REVOKED_AT;

      await expect(
        service.revokeWinner('admin-1', EVENT_ID, WINNER_ID, { reason: '' }),
      ).rejects.toMatchObject({
        response: {
          code: 'quiz_badge_winner_already_revoked',
          revokedAt: REVOKED_AT.toISOString(),
        },
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it.each([
      [{}, 'quiz_badge_revoke_reason_required'],
      [{ reason: 42 }, 'quiz_badge_revoke_reason_required'],
      [{ reason: '   ' }, 'quiz_badge_revoke_reason_required'],
      [{ reason: 'x'.repeat(301) }, 'quiz_badge_revoke_reason_too_long'],
    ])('refuses the reason %p with %s', async (body, code) => {
      await expect(
        service.revokeWinner('admin-1', EVENT_ID, WINNER_ID, body),
      ).rejects.toMatchObject({ response: { code } });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('answers the longest reason with its limit', async () => {
      await expect(
        service.revokeWinner('admin-1', EVENT_ID, WINNER_ID, {
          reason: 'x'.repeat(301),
        }),
      ).rejects.toMatchObject({ response: { maxLength: 300 } });
    });

    it('answers already revoked when the guarded update matches nothing', async () => {
      awarding.revokeGameWin.mockResolvedValue(null);
      await expect(
        service.revokeWinner('admin-1', EVENT_ID, WINNER_ID, {
          reason: 'Wrong team entered',
        }),
      ).rejects.toMatchObject({
        response: {
          code: 'quiz_badge_winner_already_revoked',
          revokedAt: REVOKED_AT.toISOString(),
        },
      });
      expect(queriesOf(manager.query, READ_WINNER_REVOKED_AT_SQL)).toEqual([
        [READ_WINNER_REVOKED_AT_SQL, [WINNER_ID]],
      ]);
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
    });

    it('revokes the whole game, audits with the reason and sends nothing', async () => {
      awarding.revokeGameWin.mockResolvedValueOnce({
        userId: 'user-1',
        eventId: EVENT_ID,
        revokedBadgeKeys: [`quiz:${DEF_1}`, `quiz:${DEF_2}`],
        removedAwardKeys: [`quiz:${DEF_1}`],
      });

      const response = await service.revokeWinner(
        'admin-1',
        EVENT_ID,
        WINNER_ID,
        { reason: '  Wrong team entered  ' },
      );

      expect(response).toEqual({
        winnerId: WINNER_ID,
        revokedBadgeKeys: [`quiz:${DEF_1}`, `quiz:${DEF_2}`],
        removedAwardKeys: [`quiz:${DEF_1}`],
      });
      expect(manager.query.mock.calls[0]).toEqual([
        QUIZ_EVENT_BADGES_LOCK_SQL,
        [EVENT_ID],
      ]);
      expect(awarding.revokeGameWin).toHaveBeenCalledWith(manager, {
        winnerId: WINNER_ID,
        actorId: 'admin-1',
        reason: 'Wrong team entered',
      });
      expect(modAudit.writeAuditLog).toHaveBeenCalledTimes(1);
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        'admin-1',
        'quiz_game_win_revoked',
        undefined,
        `${WINNER_ID}: Wrong team entered`,
        undefined,
        manager,
        'user-1',
      );
      expect(awarding.notifyNewWins).not.toHaveBeenCalled();
    });
  });
});
