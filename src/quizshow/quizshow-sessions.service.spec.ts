import { NotFoundException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { FEATURE_NOT_AVAILABLE_MESSAGE } from '../common/feature.decorator';
import { EventStatus } from '../events/entities/event.entity';
import { NEXT_GAME_WIN_BADGES_SQL } from '../quiz-win-badges/quiz-win-badges-event-reads';
import {
  RESULTS_SESSION_GAME_SQL,
  RESULTS_WIN_ROWS_SQL,
} from '../quiz-win-badges/quiz-win-badges-results-reads';
import { QuizshowPlayerRecord } from './entities/quizshow-player.entity';
import { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import { QuizshowResultRecord } from './entities/quizshow-result.entity';
import { QuizshowSessionRecord } from './entities/quizshow-session.entity';
import { QuizshowTeamRecord } from './entities/quizshow-team.entity';
import type { QuizshowPlayScope } from './quizshow-access.service';
import type { QuizshowHostOutcome } from './quizshow-engine-phases';
import { hostRefreshQuiz } from './quizshow-engine-session-tools';
import type {
  QuizshowLiveState,
  QuizshowScopeSource,
} from './quizshow-engine-types';
import { quizshowCodeOf, quizshowError } from './quizshow-errors';
import { isQuizshowPlayable } from './quizshow-play-rules';
import {
  LOBBY_OPEN_COUNT_SQL,
  LOBBY_OPEN_INSERT_SQL,
  LOBBY_OPEN_PRUNE_SQL,
  normaliseJoinCode,
  QUIZ_LAST_OPEN_SETTINGS_SQL,
  QuizshowSessionsService,
} from './quizshow-sessions.service';
import { emptyWheelProgress } from './quizshow-wheel';
import {
  QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
  type QuizshowJoinHost,
} from './quizshow.contract';
import type { QuizshowOpenGameSessionDto } from './dto/quizshow-game.dto';
import type { QuizshowJoinDto } from './dto/quizshow-join.dto';
import type { QuizshowOpenSessionDto } from './dto/quizshow-open-session.dto';

jest.mock('./quizshow-play-rules', () => ({
  ...jest.requireActual<Record<string, unknown>>('./quizshow-play-rules'),
  isQuizshowPlayable: jest.fn(() => true),
}));

const mockIsQuizshowPlayable = isQuizshowPlayable as jest.MockedFunction<
  typeof isQuizshowPlayable
>;

// The refresh command is the engine's own (B19, specced there); here it only answers.
jest.mock('./quizshow-engine-session-tools', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    './quizshow-engine-session-tools',
  ),
  hostRefreshQuiz: jest.fn(),
}));

const mockHostRefreshQuiz = hostRefreshQuiz as jest.MockedFunction<
  typeof hostRefreshQuiz
>;

const ORGANISER_ID = 'organiser-1';
const VIEWER_ID = 'viewer-1';
const OWNER_ID = 'owner-1';
const EVENT_ID = 'event-1';
const GAME_ID = '7b0c8a1e-2f4d-4c6a-9e3b-5d1f0a2c4e6b';
const SLUG = 'quiz-night';
const SESSION_ID = 'session-1';
const HOUR_MS = 3_600_000;

interface OwnedGame {
  id: string;
  ownerUserId: string;
  isAdultsOnly: boolean;
}

function ownedGame(overrides: Partial<OwnedGame> = {}): OwnedGame {
  return {
    id: GAME_ID,
    ownerUserId: OWNER_ID,
    isAdultsOnly: false,
    ...overrides,
  };
}

const OWNER_CARD: QuizshowJoinHost = {
  name: 'Rui Costa',
  avatarUrl: null,
  memberSlug: 'rui-costa',
};

interface FakeState {
  event: Record<string, unknown>;
  quiz: unknown;
  openSession: { id: string; join_code: string } | null;
  keptSessions: Array<{ id: string; has_results: boolean }>;
  latestSession: Partial<QuizshowSessionRecord> | null;
  resultSession: Record<string, unknown> | null;
  result: Partial<QuizshowResultRecord> | null;
  players: Array<Partial<QuizshowPlayerRecord>>;
  teams: Array<Partial<QuizshowTeamRecord>>;
  hasGoingRsvp: boolean;
  isOrganiser: boolean;
  isBarred: boolean;
  isCohostPlaying: boolean;
  isPushClaimable: boolean;
  insertFailures: Error[];
  existingPlayer: Partial<QuizshowPlayerRecord> | null;
  isIdleAbandoned: boolean;
  /** Lobbies the caller opened within the rolling hour. */
  recentOpenCount: number;
  /** The quiz row `findOne(QuizshowQuizRecord)` answers. */
  quizRecord: Record<string, unknown> | null;
  /** The caller's own game; null answers game not found. */
  game: OwnedGame | null;
  joinHost: QuizshowJoinHost | null;
  isAdultsEvent: boolean;
  /** What `runtime.getOrLoad` answers; null when the session is not live. */
  liveState: Partial<QuizshowLiveState> | null;
  /** Thrown by the guest push claim, as a database fault would be. */
  claimError: Error | null;
  /** The event and game number row `RESULTS_SESSION_GAME_SQL` answers; null answers no row. */
  winBadgeSessionRow: {
    event_id: string | null;
    event_game_number: number | null;
  } | null;
  /** The live win rows `RESULTS_WIN_ROWS_SQL` answers. */
  winBadgeRows: unknown[];
  /** The chip rows `NEXT_GAME_WIN_BADGES_SQL` answers. */
  nextGameBadgeRows: unknown[];
}

function completeQuiz(): unknown {
  return structuredClone({
    title: 'Pride and queer history',
    languages: 'both',
    screenLanguage: 'en',
    updatedAt: '2026-10-19T10:00:00.000Z',
    rounds: [
      {
        kind: 'quiz',
        title: { en: 'Where it started', pt: 'Onde tudo começou' },
        contentLabel: 'none',
        settings: {
          timeLimitSeconds: 20,
          isSpeedBonusOn: true,
          isJokerAllowed: true,
          writeSeconds: 60,
          voteSeconds: 30,
          ...QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
        },
        questions: [
          {
            type: 'multiple_choice',
            prompt: {
              en: 'Which year was the first Pride march?',
              pt: 'Em que ano foi a primeira marcha do orgulho?',
            },
            options: [
              { id: 'a', text: { en: '1959', pt: '1959' } },
              { id: 'b', text: { en: '1970', pt: '1970' } },
              { id: 'c', text: { en: '1985', pt: '1985' } },
              { id: 'd', text: { en: '1999', pt: '1999' } },
            ],
            answer: { correctIndex: 1 },
            acceptedAnswers: [],
            mediaRef: null,
            timeLimitSeconds: null,
            points: 1000,
          },
        ],
      },
    ],
  });
}

function uniqueViolation(constraint: string): QueryFailedError {
  const error = new QueryFailedError('insert', [], new Error('duplicate'));
  (error as unknown as { driverError: object }).driverError = {
    code: '23505',
    constraint,
  };
  return error;
}

function build(overrides: Partial<FakeState> = {}) {
  const state: FakeState = {
    event: {
      id: EVENT_ID,
      slug: SLUG,
      title: 'Quiz night',
      hostId: ORGANISER_ID,
      status: EventStatus.Published,
    },
    quiz: completeQuiz(),
    openSession: null,
    keptSessions: [],
    latestSession: null,
    resultSession: null,
    result: null,
    players: [],
    teams: [],
    hasGoingRsvp: false,
    isOrganiser: true,
    isBarred: false,
    isCohostPlaying: false,
    isPushClaimable: true,
    insertFailures: [],
    existingPlayer: null,
    isIdleAbandoned: false,
    recentOpenCount: 0,
    quizRecord: { id: 'quiz-1' },
    game: null,
    joinHost: OWNER_CARD,
    isAdultsEvent: false,
    liveState: null,
    claimError: null,
    winBadgeSessionRow: null,
    winBadgeRows: [],
    nextGameBadgeRows: [],
    ...overrides,
  };
  // Sessions whose `guest_push_sent_at` the fake claim stamped.
  const stampedSessionIds = new Set<string>();
  const claimStatements: unknown[][] = [];
  const query = jest.fn((sql: string, parameters: unknown[] = []) => {
    // The lobby opens ledger: each recorded open joins the rolling hour count.
    if (sql === LOBBY_OPEN_INSERT_SQL) {
      state.recentOpenCount += 1;
      return Promise.resolve([]);
    }
    if (sql === RESULTS_SESSION_GAME_SQL) {
      return Promise.resolve(
        state.winBadgeSessionRow ? [state.winBadgeSessionRow] : [],
      );
    }
    if (sql === RESULTS_WIN_ROWS_SQL) {
      return Promise.resolve(state.winBadgeRows);
    }
    if (sql === NEXT_GAME_WIN_BADGES_SQL) {
      return Promise.resolve(state.nextGameBadgeRows);
    }
    if (sql.includes('"claimed"')) {
      claimStatements.push(parameters);
      if (state.claimError !== null) return Promise.reject(state.claimError);
      // Mirrors the claim's `guest_push_sent_at IS NULL` guard.
      const sessionId = parameters[0] as string;
      if (!state.isPushClaimable || stampedSessionIds.has(sessionId)) {
        return Promise.resolve([]);
      }
      stampedSessionIds.add(sessionId);
      return Promise.resolve([{ id: sessionId }]);
    }
    if (sql.includes('"guest_push_sent_at" AS "guest_push_sent_at"')) {
      const sessionId = parameters[0] as string;
      return Promise.resolve([
        {
          guest_push_sent_at: stampedSessionIds.has(sessionId)
            ? new Date()
            : null,
        },
      ]);
    }
    if (sql.includes('"has_rsvp"')) {
      return Promise.resolve([{ has_rsvp: state.hasGoingRsvp }]);
    }
    if (sql.includes('"open_count"')) {
      return Promise.resolve([{ open_count: state.recentOpenCount }]);
    }
    if (sql.includes('"has_results"')) {
      return Promise.resolve(state.keptSessions);
    }
    if (sql.includes('"join_code" AS "join_code"')) {
      return Promise.resolve(state.openSession ? [state.openSession] : []);
    }
    if (sql.includes('INNER JOIN "quizshow_results"')) {
      return Promise.resolve(state.resultSession ? [state.resultSession] : []);
    }
    return Promise.resolve([]);
  });
  const insert = jest.fn((_entity: unknown, row: object) => {
    const failure = state.insertFailures.shift();
    if (failure) return Promise.reject(failure);
    return Promise.resolve({ identifiers: [{ id: SESSION_ID }], raw: row });
  });
  const manager = {
    query,
    insert,
    findOne: jest.fn((entity: unknown) => {
      if (entity === QuizshowQuizRecord) {
        return Promise.resolve(state.quizRecord);
      }
      if (entity === QuizshowSessionRecord) {
        return Promise.resolve(state.latestSession);
      }
      if (entity === QuizshowResultRecord) return Promise.resolve(state.result);
      if (entity === QuizshowPlayerRecord) {
        return Promise.resolve(state.existingPlayer);
      }
      return Promise.resolve(state.event);
    }),
    find: jest.fn(
      (
        entity: unknown,
        options: {
          where: {
            id?: { _value: string[] };
            sessionId?: string;
            removedAt?: unknown;
            leftAt?: unknown;
          };
        },
      ) => {
        const rows: Array<
          Partial<QuizshowPlayerRecord> | Partial<QuizshowTeamRecord>
        > = entity === QuizshowPlayerRecord ? state.players : state.teams;
        const { id: idFilter, sessionId } = options.where;
        if (idFilter === undefined) {
          // An IsNull() filter on removedAt or leftAt keeps rows without one.
          const isNullFilterKept = (
            row: Partial<QuizshowPlayerRecord> | Partial<QuizshowTeamRecord>,
            key: 'removedAt' | 'leftAt',
          ): boolean =>
            !(key in options.where) ||
            !(row as Partial<QuizshowPlayerRecord>)[key];
          return Promise.resolve(
            rows.filter(
              (row) =>
                row.sessionId === sessionId &&
                isNullFilterKept(row, 'removedAt') &&
                isNullFilterKept(row, 'leftAt'),
            ),
          );
        }
        return Promise.resolve(
          rows.filter((row) => idFilter._value.includes(row.id as string)),
        );
      },
    ),
    count: jest.fn((entity: unknown) =>
      Promise.resolve(
        entity === QuizshowPlayerRecord
          ? state.players.filter((player) => !player.removedAt).length
          : state.teams.length,
      ),
    ),
  };
  const dataSource = {
    manager,
    query,
    // A distinct object sharing the fakes, so `mock.contexts` shows which
    // calls ran on the transaction's manager.
    transaction: jest.fn((callback: (entityManager: unknown) => unknown) =>
      Promise.resolve(callback(transactionManager)),
    ),
  };
  const transactionManager = { ...manager };
  const access = {
    loadViewableEvent: jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve({ event: state.event, isOrganizer: state.isOrganiser }),
      ),
    assertOrganiser: jest
      .fn()
      .mockImplementation(() =>
        state.isOrganiser
          ? Promise.resolve()
          : Promise.reject(new Error('quizshow_not_organiser')),
      ),
    assertNotCohostPlaying: jest
      .fn()
      .mockImplementation(() =>
        state.isCohostPlaying
          ? Promise.reject(new Error('quizshow_cohost_is_playing'))
          : Promise.resolve(),
      ),
    isBarredFromEvent: jest
      .fn()
      .mockImplementation(() => Promise.resolve(state.isBarred)),
    isAdultsEvent: jest.fn().mockImplementation(() => state.isAdultsEvent),
    // Mirrors QuizshowAccessService.loadPlayScope over the fake rows.
    loadPlayScope: jest
      .fn()
      .mockImplementation(
        (source: QuizshowScopeSource): Promise<QuizshowPlayScope | null> => {
          if (source.kind === 'game') {
            if (source.gameId === null || source.hostUserId === null) {
              return Promise.resolve(null);
            }
            return Promise.resolve({
              kind: 'game',
              gameId: source.gameId,
              ownerUserId: source.hostUserId,
            });
          }
          return Promise.resolve(
            source.eventId === null
              ? null
              : ({ kind: 'event', event: state.event } as never),
          );
        },
      ),
    // Mirrors the owner rule of QuizshowAccessService.assertMayPlay for games.
    assertMayPlay: jest
      .fn()
      .mockImplementation(
        (input: { scope: QuizshowPlayScope; userId: string }) => {
          if (
            input.scope.kind === 'game' &&
            input.scope.ownerUserId === input.userId
          ) {
            return Promise.reject(quizshowError('quizshow_organiser_running'));
          }
          return Promise.resolve({
            existingPlayer: state.existingPlayer,
            isCohost: false,
          });
        },
      ),
    loadOwnedGame: jest
      .fn()
      .mockImplementation((gameId: string, userId: string) =>
        state.game !== null &&
        state.game.id === gameId &&
        state.game.ownerUserId === userId
          ? Promise.resolve(state.game)
          : Promise.reject(quizshowError('quizshow_game_not_found')),
      ),
    loadJoinHost: jest
      .fn()
      .mockImplementation(() => Promise.resolve(state.joinHost)),
  };
  const quizService = {
    loadQuiz: jest.fn().mockImplementation(() => Promise.resolve(state.quiz)),
    loadQuizById: jest
      .fn()
      .mockImplementation(() => Promise.resolve(state.quiz)),
  };
  const guestPush = {
    sendLobbyOpened: jest.fn().mockResolvedValue(undefined),
  };
  const persistence = {
    deleteKeptResults: jest.fn().mockResolvedValue(undefined),
  };
  const runtime = {
    abandonIfIdle: jest
      .fn()
      .mockImplementation(() => Promise.resolve(state.isIdleAbandoned)),
    getOrLoad: jest
      .fn()
      .mockImplementation(() => Promise.resolve(state.liveState)),
    // Runs the command on the fake live state, as the runtime does at `Date.now()`.
    execute: jest
      .fn()
      .mockImplementation(
        (
          _sessionId: string,
          command: (liveState: QuizshowLiveState, now: number) => unknown,
        ) =>
          Promise.resolve(
            state.liveState === null
              ? null
              : command(state.liveState as QuizshowLiveState, Date.now()),
          ),
      ),
    emitRematch: jest.fn(),
  };
  const service = new QuizshowSessionsService(
    dataSource as never,
    access as never,
    quizService as never,
    guestPush as never,
    persistence as never,
    runtime as never,
  );
  return {
    service,
    state,
    manager,
    dataSource,
    transactionManager,
    access,
    quizService,
    guestPush,
    persistence,
    runtime,
    claimStatements,
    query,
  };
}

function queryCallsMatching(
  query: jest.Mock,
  fragment: string,
): Array<{ sql: string; parameters: unknown[]; order: number }> {
  return query.mock.calls
    .map((call, index) => ({
      sql: call[0] as string,
      parameters: (call[1] ?? []) as unknown[],
      order: query.mock.invocationCallOrder[index] ?? -1,
    }))
    .filter((call) => call.sql.includes(fragment));
}

function gameOpenInput(
  overrides: Partial<QuizshowOpenSessionDto> = {},
): QuizshowOpenGameSessionDto {
  return openInput(overrides);
}

async function bodyOfRejection(
  promise: Promise<unknown>,
): Promise<Record<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    return (error as { getResponse(): Record<string, unknown> }).getResponse();
  }
  return {};
}

function openInput(
  overrides: Partial<QuizshowOpenSessionDto> = {},
): QuizshowOpenSessionDto {
  return {
    playMode: 'solo',
    maxTeamSize: null,
    isReviewOn: true,
    notifyGuests: false,
    shouldReplaceResults: false,
    isPractice: false,
    rematchOfSessionId: null,
    ...overrides,
  };
}

async function codeOfRejection(
  promise: Promise<unknown>,
): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return quizshowCodeOf(error) ?? (error as Error).message;
  }
}

/** A live win row as `RESULTS_WIN_ROWS_SQL` returns it, with badge definition `def-1`. */
function winRow(input: {
  winnerId: string;
  screenName: string;
  teamName: string | null;
  isMine: boolean;
}) {
  return {
    is_mine: input.isMine,
    winner_id: input.winnerId,
    screen_name: input.screenName,
    team_name: input.teamName,
    definition_id: 'def-1',
    badge_key: 'quiz:def-1',
    name_en: 'Quiz Night Champion',
    name_pt: null,
    icon_key: 'star',
    tint: 'jade',
    rarity: 'rare',
    archived_at: null,
  };
}

const user = (userId: string) => ({ userId, restricted: false }) as never;
const joinInput = (code: string): QuizshowJoinDto => ({ code });

describe('QuizshowSessionsService', () => {
  beforeEach(() => {
    mockIsQuizshowPlayable.mockReset();
    mockIsQuizshowPlayable.mockReturnValue(true);
    mockHostRefreshQuiz.mockReset();
  });

  it('opens a lobby with a fresh join code and the frozen quiz', async () => {
    const { service, manager } = build();
    const opened = await service.openSession(SLUG, ORGANISER_ID, openInput());
    expect(opened.sessionId).toBe(SESSION_ID);
    expect(opened.joinCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(opened.isGuestPushSent).toBe(false);
    const row = manager.insert.mock.calls[0]?.[1] as Record<string, any>;
    expect(row.status).toBe('lobby');
    expect(row.cursor.phase).toBe('lobby');
    expect(row.cursor.phaseCounter).toBe(0);
    expect(row.cursor.roundCount).toBe(1);
    expect(row.cursor.wheelProgress).toEqual(emptyWheelProgress());
    expect(row.questionLog).toEqual([]);
    expect(row.startedByUserId).toBe(ORGANISER_ID);
    expect(row.attachedOrganiserUserIds).toEqual([]);
    expect(row.lastHostCommandAt).toBe(row.startedAt);
    expect(row.quizSnapshot.rounds.length).toBeGreaterThan(0);
  });

  it('stores a lobby cursor whose round count skips the wheels', async () => {
    const { service, manager, state } = build();
    const baseQuiz = completeQuiz() as { rounds: Record<string, any>[] };
    const quizRound = baseQuiz.rounds[0] as Record<string, any>;
    const wheelRound = {
      kind: 'wheel',
      title: { en: 'Spin', pt: 'Gira' },
      contentLabel: 'none',
      settings: {
        ...quizRound.settings,
        wheelBonus: 250,
        wheelPick: 'round',
        sliceCount: null,
      },
      questions: [],
    };
    state.quiz = {
      ...baseQuiz,
      rounds: [
        structuredClone(quizRound),
        wheelRound,
        structuredClone(quizRound),
        structuredClone(quizRound),
      ],
    };
    await service.openSession(SLUG, ORGANISER_ID, openInput());
    const row = manager.insert.mock.calls[0]?.[1] as Record<string, any>;
    expect(row.cursor.roundCount).toBe(3);
    expect(row.cursor.wheelProgress).toEqual(emptyWheelProgress());
    expect(row.quizSnapshot.rounds[1].settings).toEqual(
      expect.objectContaining({
        timeLimitSeconds: 20,
        isSpeedBonusOn: true,
        isJokerAllowed: true,
        writeSeconds: 60,
        voteSeconds: 30,
        wheelBonus: 250,
        wheelPick: 'round',
        sliceCount: null,
      }),
    );
    expect(Object.keys(row.quizSnapshot.rounds[1].settings)).toHaveLength(8);
  });

  it('retries a join code that collides with an open session', async () => {
    const { service, manager } = build({
      insertFailures: [
        uniqueViolation('UQ_quizshow_sessions_open_join_code'),
        uniqueViolation('UQ_quizshow_sessions_open_join_code'),
      ],
    });
    const opened = await service.openSession(SLUG, ORGANISER_ID, openInput());
    expect(manager.insert).toHaveBeenCalledTimes(3);
    expect(opened.sessionId).toBe(SESSION_ID);
  });

  it('refuses an incomplete quiz with its problems', async () => {
    const { service, state } = build();
    state.quiz = { ...(state.quiz as object), rounds: [] };
    let body: Record<string, unknown> = {};
    try {
      await service.openSession(SLUG, ORGANISER_ID, openInput());
    } catch (error) {
      body = (
        error as { getResponse(): Record<string, unknown> }
      ).getResponse();
    }
    expect(body.code).toBe('quizshow_quiz_incomplete');
    expect(body.problems).toEqual([
      {
        code: 'no_rounds',
        roundIndex: null,
        questionIndex: null,
        language: null,
      },
    ]);
  });

  it('refuses a second open session with its id and code', async () => {
    const { service } = build({
      openSession: { id: 'open-1', join_code: 'ABC234' },
    });
    let body: Record<string, unknown> = {};
    try {
      await service.openSession(SLUG, ORGANISER_ID, openInput());
    } catch (error) {
      body = (
        error as { getResponse(): Record<string, unknown> }
      ).getResponse();
    }
    expect(body.code).toBe('quizshow_session_already_open');
    expect(body.sessionId).toBe('open-1');
    expect(body.joinCode).toBe('ABC234');
  });

  it('asks before replacing kept results and deletes them once confirmed', async () => {
    const { service, persistence } = build({
      keptSessions: [{ id: 'old-1', has_results: true }],
    });
    expect(
      await codeOfRejection(
        service.openSession(SLUG, ORGANISER_ID, openInput()),
      ),
    ).toBe('quizshow_results_exist');
    expect(persistence.deleteKeptResults).not.toHaveBeenCalled();
    await service.openSession(
      SLUG,
      ORGANISER_ID,
      openInput({ shouldReplaceResults: true }),
    );
    expect(persistence.deleteKeptResults).toHaveBeenCalledWith(
      expect.anything(),
      'old-1',
    );
  });

  it('pushes guests once per event every two hours', async () => {
    const first = build();
    const sent = await first.service.openSession(
      SLUG,
      ORGANISER_ID,
      openInput({ notifyGuests: true }),
    );
    expect(sent.isGuestPushSent).toBe(true);
    expect(first.guestPush.sendLobbyOpened).toHaveBeenCalledTimes(1);
    const claim = first.claimStatements[0] as [string, Date, string, Date];
    expect(claim[0]).toBe(SESSION_ID);
    expect(claim[1].getTime() - claim[3].getTime()).toBe(2 * HOUR_MS);

    const cooling = build({ isPushClaimable: false });
    const skipped = await cooling.service.openSession(
      SLUG,
      ORGANISER_ID,
      openInput({ notifyGuests: true }),
    );
    expect(skipped.isGuestPushSent).toBe(false);
    expect(cooling.guestPush.sendLobbyOpened).not.toHaveBeenCalled();

    const silent = build();
    await silent.service.openSession(SLUG, ORGANISER_ID, openInput());
    expect(silent.claimStatements).toHaveLength(0);
  });

  it('takes a join code in any case with spaces and hyphens', () => {
    expect(normaliseJoinCode('abc-234')).toBe('ABC234');
    expect(normaliseJoinCode(' ab c2 34 ')).toBe('ABC234');
    expect(normaliseJoinCode('ABC23')).toBeNull();
    expect(normaliseJoinCode('ABCDE0')).toBeNull();
    expect(normaliseJoinCode('')).toBeNull();
  });

  it('answers finished for a code that ended within twelve hours and not found after', async () => {
    const recent = build({
      latestSession: {
        id: SESSION_ID,
        eventId: EVENT_ID,
        status: 'finished',
        endedAt: new Date(Date.now() - 11 * HOUR_MS),
      },
    });
    expect(
      await codeOfRejection(
        recent.service.join(user(VIEWER_ID), joinInput('ABC234')),
      ),
    ).toBe('quizshow_session_finished');
    const old = build({
      latestSession: {
        id: SESSION_ID,
        eventId: EVENT_ID,
        status: 'abandoned',
        endedAt: new Date(Date.now() - 13 * HOUR_MS),
      },
    });
    expect(
      await codeOfRejection(
        old.service.join(user(VIEWER_ID), joinInput('ABC234')),
      ),
    ).toBe('quizshow_join_code_not_found');
    const malformed = build();
    expect(
      await codeOfRejection(
        malformed.service.join(user(VIEWER_ID), joinInput('nope')),
      ),
    ).toBe('quizshow_join_code_not_found');
    const none = build();
    expect(
      await codeOfRejection(
        none.service.join(user(VIEWER_ID), joinInput('ABC234')),
      ),
    ).toBe('quizshow_join_code_not_found');
  });

  it('abandons an idle lobby on join', async () => {
    const { service, runtime, access } = build({
      isIdleAbandoned: true,
      latestSession: {
        id: SESSION_ID,
        eventId: EVENT_ID,
        status: 'lobby',
        endedAt: null,
      },
    });
    expect(
      await codeOfRejection(service.join(user(VIEWER_ID), joinInput('ABC234'))),
    ).toBe('quizshow_session_finished');
    expect(runtime.abandonIfIdle).toHaveBeenCalledWith(
      SESSION_ID,
      expect.any(Number),
    );
    expect(access.assertMayPlay).not.toHaveBeenCalled();
  });

  it('marks a rejoin', async () => {
    const latestSession = {
      id: SESSION_ID,
      eventId: EVENT_ID,
      status: 'running' as const,
      endedAt: null,
      quizSnapshot: { title: 'Quiz night questions', rounds: [] },
    };
    const fresh = build({ latestSession });
    const first = await fresh.service.join(
      user(VIEWER_ID),
      joinInput('abc 234'),
    );
    expect(first).toEqual({
      sessionId: SESSION_ID,
      kind: 'event',
      eventSlug: SLUG,
      eventTitle: 'Quiz night',
      quizTitle: 'Quiz night questions',
      isAdultsOnly: false,
      host: null,
      status: 'running',
      isRejoin: false,
    });
    expect(fresh.access.assertMayPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        shouldCheckCapacity: true,
        isRestricted: false,
      }),
    );
    const returning = build({
      latestSession,
      existingPlayer: { id: 'player-1' },
    });
    const second = await returning.service.join(
      user(VIEWER_ID),
      joinInput('ABC234'),
    );
    expect(second.isRejoin).toBe(true);
  });

  function resultsFixture(overrides: Partial<FakeState> = {}) {
    return build({
      isOrganiser: false,
      resultSession: {
        id: SESSION_ID,
        play_mode: 'solo',
        started_at: new Date('2026-10-19T19:00:00.000Z'),
        ended_at: new Date('2026-10-19T20:00:00.000Z'),
      },
      result: {
        sessionId: SESSION_ID,
        podium: [
          { place: 2, kind: 'player', entrantId: 'player-2', score: 700 },
          { place: 1, kind: 'player', entrantId: 'player-1', score: 900 },
          { place: 3, kind: 'player', entrantId: 'player-gone', score: 100 },
        ],
        placings: { 'player-1': 1, 'player-2': 2, 'player-3': 4 },
        questionStats: {
          questionsPlayed: 3,
          answersGiven: 5,
          questions: [],
          standings: [],
        },
      },
      players: [
        {
          id: 'player-1',
          screenName: 'Zed',
          score: 900,
          userId: 'u-1',
          removedAt: null,
        },
        {
          id: 'player-2',
          screenName: 'Ana',
          score: 700,
          userId: 'u-2',
          removedAt: null,
        },
        {
          id: 'player-3',
          screenName: 'Bo',
          score: 50,
          userId: VIEWER_ID,
          removedAt: null,
        },
      ],
      hasGoingRsvp: true,
      ...overrides,
    });
  }

  it("builds the results card with no user id and with the viewer's own placing", async () => {
    const { service } = resultsFixture({
      existingPlayer: { id: 'player-3', score: 50, teamId: null },
    });
    const card = await service.getResults(SLUG, VIEWER_ID);
    expect(card.podium.map((entry) => entry.name)).toEqual(['Zed', 'Ana']);
    expect(card.podium.every((entry) => !entry.isMine)).toBe(true);
    expect(card.me).toEqual({
      place: 4,
      score: 50,
      teamName: null,
      teamColorKey: null,
    });
    expect(card.playerCount).toBe(3);
    expect(card.teamCount).toBeNull();
    expect(card.startedAt).toBe('2026-10-19T19:00:00.000Z');
    expect(JSON.stringify(card)).not.toContain('u-1');
    expect(JSON.stringify(card)).not.toContain(VIEWER_ID);
  });

  it('leaves an erased player out of the podium', async () => {
    const { service } = resultsFixture();
    const card = await service.getResults(SLUG, VIEWER_ID);
    expect(card.podium).toHaveLength(2);
    expect(card.podium.map((entry) => entry.place)).toEqual([1, 2]);
  });

  it('gives the recap to organisers only', async () => {
    const guest = resultsFixture();
    expect((await guest.service.getResults(SLUG, VIEWER_ID)).recap).toBeNull();
    const organiser = resultsFixture({ isOrganiser: true });
    expect(
      (await organiser.service.getResults(SLUG, ORGANISER_ID)).recap,
    ).toEqual({
      questionsPlayed: 3,
      answersGiven: 5,
      questions: [],
      // A recap stored before live v2 reads with empty standings (contract 6.24).
      standings: [],
    });
    const playing = resultsFixture({
      isOrganiser: true,
      isCohostPlaying: true,
    });
    expect(
      await codeOfRejection(playing.service.getResults(SLUG, ORGANISER_ID)),
    ).toBe('quizshow_cohost_is_playing');
  });

  it('builds the recap standings from the kept rows and ignores the standings a recap stored', async () => {
    const solo = resultsFixture({
      isOrganiser: true,
      result: {
        sessionId: SESSION_ID,
        podium: [],
        placings: {},
        questionStats: {
          questionsPlayed: 3,
          answersGiven: 5,
          questions: [],
          standings: [
            {
              rank: 1,
              kind: 'player',
              name: 'Erased Name',
              colorKey: null,
              score: 999,
            },
          ],
        },
      },
      players: [
        { id: 'p-b', sessionId: SESSION_ID, screenName: 'Bo', score: 700 },
        { id: 'p-a', sessionId: SESSION_ID, screenName: 'Ana', score: 700 },
        { id: 'p-z', sessionId: SESSION_ID, screenName: 'Zed', score: 900 },
        {
          id: 'p-gone',
          sessionId: SESSION_ID,
          screenName: 'Removed',
          score: 800,
          removedAt: new Date('2026-10-19T19:30:00.000Z'),
        },
        {
          id: 'p-left',
          sessionId: SESSION_ID,
          screenName: 'Left',
          score: 800,
          leftAt: new Date('2026-10-19T19:30:00.000Z'),
        },
        { id: 'p-other', sessionId: 'other-session', screenName: 'Elsewhere' },
      ],
    });
    const soloCard = await solo.service.getResults(SLUG, ORGANISER_ID);
    expect(soloCard.recap?.standings).toEqual([
      { rank: 1, kind: 'player', name: 'Zed', colorKey: null, score: 900 },
      { rank: 2, kind: 'player', name: 'Ana', colorKey: null, score: 700 },
      { rank: 2, kind: 'player', name: 'Bo', colorKey: null, score: 700 },
    ]);
    expect(JSON.stringify(soloCard)).not.toContain('Erased Name');
    expect(JSON.stringify(soloCard)).not.toContain('p-z');

    const teams = resultsFixture({
      isOrganiser: true,
      resultSession: {
        id: SESSION_ID,
        play_mode: 'teams',
        started_at: new Date('2026-10-19T19:00:00.000Z'),
        ended_at: new Date('2026-10-19T20:00:00.000Z'),
      },
      result: {
        sessionId: SESSION_ID,
        podium: [],
        placings: {},
        questionStats: {
          questionsPlayed: 1,
          answersGiven: 2,
          questions: [],
          standings: [],
        },
      },
      players: [],
      teams: [
        {
          id: 't-1',
          sessionId: SESSION_ID,
          name: 'Glitter',
          colorKey: 'circle',
          score: 300,
        },
        {
          id: 't-2',
          sessionId: SESSION_ID,
          name: 'Sequins',
          colorKey: 'star',
          score: 500,
        },
      ],
    });
    const teamsCard = await teams.service.getResults(SLUG, ORGANISER_ID);
    expect(teamsCard.recap?.standings).toEqual([
      { rank: 1, kind: 'team', name: 'Sequins', colorKey: 'star', score: 500 },
      {
        rank: 2,
        kind: 'team',
        name: 'Glitter',
        colorKey: 'circle',
        score: 300,
      },
    ]);
  });

  it('adds the winners badges to the results card by name only', async () => {
    const { service } = resultsFixture({
      winBadgeSessionRow: { event_id: EVENT_ID, event_game_number: 1 },
      winBadgeRows: [
        winRow({
          winnerId: 'winner-1',
          screenName: 'Zed',
          teamName: null,
          isMine: false,
        }),
      ],
    });
    const card = await service.getResults(SLUG, VIEWER_ID);
    expect(card.winBadges).toEqual({
      gameNumber: 1,
      winners: [
        {
          kind: 'player',
          name: 'Zed',
          badges: [expect.objectContaining({ definitionId: 'def-1' })],
        },
      ],
      myBadges: [],
    });
    expect(JSON.stringify(card)).not.toContain(VIEWER_ID);
  });

  it('leaves winBadges null on a card with no numbered game', async () => {
    const { service, query } = resultsFixture();
    const card = await service.getResults(SLUG, VIEWER_ID);
    expect(card.winBadges).toBeNull();
    expect(queryCallsMatching(query, '"winner"."revoked_at" IS NULL')).toEqual(
      [],
    );
  });

  it('serves the next game badges to a viewer who can see the event', async () => {
    const { service, access, query } = build({
      nextGameBadgeRows: [
        {
          game_number: 1,
          definition_id: 'def-1',
          badge_key: 'quiz:def-1',
          name_en: 'Quiz Night Champion',
          name_pt: null,
          icon_key: 'star',
          tint: 'jade',
          rarity: 'rare',
          archived_at: null,
        },
      ],
    });
    const response = await service.getWinBadgesPreview(SLUG, VIEWER_ID);
    expect(response).toEqual({
      preview: {
        gameNumber: 1,
        badges: [expect.objectContaining({ definitionId: 'def-1' })],
      },
    });
    expect(access.loadViewableEvent).toHaveBeenCalledWith(SLUG, VIEWER_ID);
    expect(query).toHaveBeenCalledWith(NEXT_GAME_WIN_BADGES_SQL, [EVENT_ID]);
  });

  it('answers a null preview when the next game gives no badge', async () => {
    const { service } = build();
    expect(await service.getWinBadgesPreview(SLUG, VIEWER_ID)).toEqual({
      preview: null,
    });
  });

  it('keeps the event refusal for a viewer who cannot see the event', async () => {
    const { service, access, query } = build();
    access.loadViewableEvent.mockRejectedValueOnce(
      quizshowError('quizshow_event_not_found'),
    );
    expect(
      await codeOfRejection(service.getWinBadgesPreview(SLUG, VIEWER_ID)),
    ).toBe('quizshow_event_not_found');
    expect(queryCallsMatching(query, '"next_game"')).toEqual([]);
  });

  it('hides results from a member who neither organised, went nor played', async () => {
    const stranger = resultsFixture({ hasGoingRsvp: false });
    expect(
      await codeOfRejection(stranger.service.getResults(SLUG, VIEWER_ID)),
    ).toBe('quizshow_results_not_found');
    const barred = resultsFixture({ isBarred: true });
    expect(
      await codeOfRejection(barred.service.getResults(SLUG, VIEWER_ID)),
    ).toBe('quizshow_results_not_found');
    const none = resultsFixture({ resultSession: null });
    expect(
      await codeOfRejection(none.service.getResults(SLUG, VIEWER_ID)),
    ).toBe('quizshow_results_not_found');
  });

  it('deletes results with every player, team, answer and vote', async () => {
    const { service, persistence, dataSource } = build({
      keptSessions: [
        { id: 'old-1', has_results: true },
        { id: 'old-2', has_results: false },
      ],
    });
    await service.deleteResults(SLUG, ORGANISER_ID);
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(persistence.deleteKeptResults).toHaveBeenCalledTimes(1);
    expect(persistence.deleteKeptResults).toHaveBeenCalledWith(
      expect.anything(),
      'old-1',
    );
    const empty = build();
    expect(
      await codeOfRejection(empty.service.deleteResults(SLUG, ORGANISER_ID)),
    ).toBe('quizshow_results_not_found');
    const outsider = build({ isOrganiser: false });
    expect(
      await codeOfRejection(outsider.service.deleteResults(SLUG, VIEWER_ID)),
    ).toBe('quizshow_not_organiser');
  });

  it('deleting results ignores abandoned sessions', async () => {
    const { service, persistence, dataSource } = build({
      keptSessions: [
        { id: 'abandoned-1', has_results: false },
        { id: 'abandoned-2', has_results: false },
      ],
    });
    expect(
      await codeOfRejection(service.deleteResults(SLUG, ORGANISER_ID)),
    ).toBe('quizshow_results_not_found');
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(persistence.deleteKeptResults).not.toHaveBeenCalled();
  });

  it('opens a lobby without asking and keeps abandoned sessions for retention', async () => {
    const { service, persistence } = build({
      keptSessions: [{ id: 'abandoned-1', has_results: false }],
    });
    await service.openSession(SLUG, ORGANISER_ID, openInput());
    expect(persistence.deleteKeptResults).not.toHaveBeenCalled();
  });

  it('replaces only the sessions with a results card', async () => {
    const { service, persistence } = build({
      keptSessions: [
        { id: 'old-1', has_results: true },
        { id: 'abandoned-1', has_results: false },
      ],
    });
    await service.openSession(
      SLUG,
      ORGANISER_ID,
      openInput({ shouldReplaceResults: true }),
    );
    expect(persistence.deleteKeptResults).toHaveBeenCalledTimes(1);
    expect(persistence.deleteKeptResults).toHaveBeenCalledWith(
      expect.anything(),
      'old-1',
    );
  });

  it('opens a game lobby with no event, no guest push and the game as quiz', async () => {
    const { service, manager, guestPush, quizService, claimStatements, query } =
      build({ game: ownedGame() });
    const opened = await service.openGameSession(
      GAME_ID,
      OWNER_ID,
      gameOpenInput(),
    );
    expect(opened).toEqual({
      sessionId: SESSION_ID,
      joinCode: expect.stringMatching(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/),
      isGuestPushSent: false,
    });
    expect(quizService.loadQuizById).toHaveBeenCalledWith(GAME_ID);
    const row = manager.insert.mock.calls[0]?.[1] as Record<string, any>;
    expect(row.eventId).toBeNull();
    expect(row.quizId).toBe(GAME_ID);
    expect(row.startedByUserId).toBe(OWNER_ID);
    expect(row.status).toBe('lobby');
    expect(row.quizSnapshot.rounds.length).toBeGreaterThan(0);
    expect(guestPush.sendLobbyOpened).not.toHaveBeenCalled();
    expect(claimStatements).toHaveLength(0);
    const openLookups = queryCallsMatching(query, '"join_code" AS "join_code"');
    expect(openLookups).toHaveLength(1);
    expect(openLookups[0]?.sql).toContain('"session"."quiz_id" = $1');
    expect(openLookups[0]?.parameters).toEqual([GAME_ID]);
  });

  it('refuses a game lobby with an adults round while the 18+ switch is off', async () => {
    const adultsQuiz = (): unknown => {
      const quiz = completeQuiz() as {
        rounds: Array<{ contentLabel: string }>;
      };
      const firstRound = quiz.rounds[0];
      if (!firstRound) throw new Error('A round is needed');
      firstRound.contentLabel = 'adults';
      return quiz;
    };
    const switchedOff = build({ game: ownedGame(), quiz: adultsQuiz() });
    expect(
      await codeOfRejection(
        switchedOff.service.openGameSession(GAME_ID, OWNER_ID, gameOpenInput()),
      ),
    ).toBe('quizshow_game_adults_rounds_need_switch');
    expect(switchedOff.manager.insert).not.toHaveBeenCalled();
    const switchedOn = build({
      game: ownedGame({ isAdultsOnly: true }),
      quiz: adultsQuiz(),
    });
    await switchedOn.service.openGameSession(
      GAME_ID,
      OWNER_ID,
      gameOpenInput(),
    );
    expect(switchedOn.manager.insert).toHaveBeenCalledTimes(1);
  });

  it('refuses the eleventh lobby in an hour across events and games', async () => {
    const underLimit = build({ recentOpenCount: 9 });
    await underLimit.service.openSession(SLUG, ORGANISER_ID, openInput());
    const countCalls = queryCallsMatching(underLimit.query, '"open_count"');
    expect(countCalls).toHaveLength(1);
    const countCall = countCalls[0]!;
    expect(countCall.sql).toBe(LOBBY_OPEN_COUNT_SQL);
    expect(countCall.sql).toContain('FROM "quizshow_lobby_opens"');
    expect(countCall.sql).toContain(
      '"lobby_open"."user_id" = $1 AND "lobby_open"."opened_at" > $2',
    );
    expect(countCall.sql).not.toContain('quizshow_sessions');
    expect(countCall.sql).not.toContain('event_id');
    expect(countCall.sql).not.toContain('quiz_id');
    expect(countCall.parameters[0]).toBe(ORGANISER_ID);
    const row = underLimit.manager.insert.mock.calls[0]?.[1] as {
      startedAt: Date;
    };
    expect(
      row.startedAt.getTime() - (countCall.parameters[1] as Date).getTime(),
    ).toBe(HOUR_MS);
    const ledgerInserts = queryCallsMatching(
      underLimit.query,
      'INSERT INTO "quizshow_lobby_opens"',
    );
    expect(ledgerInserts).toHaveLength(1);
    expect(ledgerInserts[0]?.parameters).toEqual([ORGANISER_ID, row.startedAt]);
    const ledgerPrunes = queryCallsMatching(
      underLimit.query,
      'DELETE FROM "quizshow_lobby_opens"',
    );
    expect(ledgerPrunes).toHaveLength(1);
    expect(ledgerPrunes[0]?.sql).toBe(LOBBY_OPEN_PRUNE_SQL);
    expect(ledgerPrunes[0]?.parameters[0]).toBe(ORGANISER_ID);
    expect(ledgerPrunes[0]?.parameters[1]).toEqual(countCall.parameters[1]);
    expect(ledgerInserts[0]!.order).toBeGreaterThan(
      underLimit.manager.insert.mock.invocationCallOrder[0]!,
    );
    expect(ledgerPrunes[0]!.order).toBeGreaterThan(ledgerInserts[0]!.order);

    const eventAtLimit = build({ recentOpenCount: 10 });
    expect(
      await codeOfRejection(
        eventAtLimit.service.openSession(SLUG, ORGANISER_ID, openInput()),
      ),
    ).toBe('quizshow_lobby_rate_limited');
    expect(eventAtLimit.manager.insert).not.toHaveBeenCalled();
    expect(
      queryCallsMatching(eventAtLimit.query, '"quizshow_lobby_opens" ('),
    ).toHaveLength(0);

    const gameAtLimit = build({ recentOpenCount: 10, game: ownedGame() });
    expect(
      await codeOfRejection(
        gameAtLimit.service.openGameSession(GAME_ID, OWNER_ID, gameOpenInput()),
      ),
    ).toBe('quizshow_lobby_rate_limited');
    expect(gameAtLimit.manager.insert).not.toHaveBeenCalled();
    const gameCountCall = queryCallsMatching(
      gameAtLimit.query,
      '"open_count"',
    )[0];
    expect(gameCountCall?.parameters[0]).toBe(OWNER_ID);
  });

  it('keeps counting lobby opens after the game is deleted', async () => {
    const fake = build({ recentOpenCount: 9, game: ownedGame() });
    await fake.service.openGameSession(GAME_ID, OWNER_ID, gameOpenInput());
    expect(fake.state.recentOpenCount).toBe(10);

    // The owner deletes the game, its sessions go with it, and they make a new game.
    const newGameId = '8c1d9b2f-3a5e-4d7b-8f4c-6e2a1b3d5f7c';
    fake.state.game = ownedGame({ id: newGameId });
    fake.state.keptSessions = [];

    expect(
      await codeOfRejection(
        fake.service.openGameSession(newGameId, OWNER_ID, gameOpenInput()),
      ),
    ).toBe('quizshow_lobby_rate_limited');
    expect(fake.manager.insert).toHaveBeenCalledTimes(1);
    const countCalls = queryCallsMatching(fake.query, '"open_count"');
    expect(countCalls).toHaveLength(2);
    for (const countCall of countCalls) {
      expect(countCall.sql).toBe(LOBBY_OPEN_COUNT_SQL);
      expect(countCall.sql).not.toContain('quizshow_sessions');
      expect(countCall.parameters[0]).toBe(OWNER_ID);
    }
  });

  it('refuses a rate-limited open before deleting kept results', async () => {
    const kept = [{ id: 'old-1', has_results: true }];
    const eventOpen = build({ recentOpenCount: 10, keptSessions: kept });
    expect(
      await codeOfRejection(
        eventOpen.service.openSession(
          SLUG,
          ORGANISER_ID,
          openInput({ shouldReplaceResults: true }),
        ),
      ),
    ).toBe('quizshow_lobby_rate_limited');
    expect(eventOpen.persistence.deleteKeptResults).not.toHaveBeenCalled();

    const gameOpen = build({
      recentOpenCount: 10,
      keptSessions: kept,
      game: ownedGame(),
    });
    expect(
      await codeOfRejection(
        gameOpen.service.openGameSession(
          GAME_ID,
          OWNER_ID,
          gameOpenInput({ shouldReplaceResults: true }),
        ),
      ),
    ).toBe('quizshow_lobby_rate_limited');
    expect(gameOpen.persistence.deleteKeptResults).not.toHaveBeenCalled();
  });

  it('takes the per-member lobby lock first in the open transaction', async () => {
    const { service, query, dataSource, persistence, manager } = build({
      keptSessions: [{ id: 'old-1', has_results: true }],
    });
    await service.openSession(
      SLUG,
      ORGANISER_ID,
      openInput({ shouldReplaceResults: true }),
    );
    const transactionOrder =
      dataSource.transaction.mock.invocationCallOrder[0]!;
    const queriesInTransaction = queryCallsMatching(query, '').filter(
      (call) => call.order > transactionOrder,
    );
    const lockCall = queriesInTransaction[0];
    expect(lockCall?.sql).toBe('SELECT pg_advisory_xact_lock(hashtext($1))');
    expect(lockCall?.parameters).toEqual([
      'quizshow_lobby_open:' + ORGANISER_ID,
    ]);
    const countOrder = queryCallsMatching(query, '"open_count"')[0]!.order;
    const deleteOrder =
      persistence.deleteKeptResults.mock.invocationCallOrder[0]!;
    const insertOrder = manager.insert.mock.invocationCallOrder[0]!;
    expect(lockCall!.order).toBeLessThan(countOrder);
    expect(countOrder).toBeLessThan(deleteOrder);
    expect(deleteOrder).toBeLessThan(insertOrder);
  });

  it('maps the per-quiz open index to session already open', async () => {
    const gameOpen = build({ game: ownedGame() });
    gameOpen.manager.insert.mockImplementationOnce(() => {
      gameOpen.state.openSession = { id: 'open-2', join_code: 'XYZ234' };
      return Promise.reject(uniqueViolation('UQ_quizshow_sessions_open_quiz'));
    });
    const gameBody = await bodyOfRejection(
      gameOpen.service.openGameSession(GAME_ID, OWNER_ID, gameOpenInput()),
    );
    expect(gameBody.code).toBe('quizshow_session_already_open');
    expect(gameBody.sessionId).toBe('open-2');
    expect(gameBody.joinCode).toBe('XYZ234');
    const gameLookups = queryCallsMatching(
      gameOpen.query,
      '"join_code" AS "join_code"',
    );
    expect(gameLookups.at(-1)?.sql).toContain('"session"."quiz_id" = $1');
    expect(gameLookups.at(-1)?.parameters).toEqual([GAME_ID]);

    const eventOpen = build();
    eventOpen.manager.insert.mockImplementationOnce(() => {
      eventOpen.state.openSession = { id: 'open-3', join_code: 'KLM234' };
      return Promise.reject(uniqueViolation('UQ_quizshow_sessions_open_quiz'));
    });
    const eventBody = await bodyOfRejection(
      eventOpen.service.openSession(SLUG, ORGANISER_ID, openInput()),
    );
    expect(eventBody.code).toBe('quizshow_session_already_open');
    expect(eventBody.sessionId).toBe('open-3');
    expect(eventBody.joinCode).toBe('KLM234');
    const eventLookups = queryCallsMatching(
      eventOpen.query,
      '"join_code" AS "join_code"',
    );
    expect(eventLookups.at(-1)?.parameters).toEqual(['quiz-1']);
  });

  it('asks before replacing kept game results and deletes them once confirmed', async () => {
    const { service, persistence, query } = build({
      game: ownedGame(),
      keptSessions: [{ id: 'old-1', has_results: true }],
    });
    expect(
      await codeOfRejection(
        service.openGameSession(GAME_ID, OWNER_ID, gameOpenInput()),
      ),
    ).toBe('quizshow_results_exist');
    expect(persistence.deleteKeptResults).not.toHaveBeenCalled();
    await service.openGameSession(
      GAME_ID,
      OWNER_ID,
      gameOpenInput({ shouldReplaceResults: true }),
    );
    expect(persistence.deleteKeptResults).toHaveBeenCalledWith(
      expect.anything(),
      'old-1',
    );
    const keptLookup = queryCallsMatching(query, '"has_results"')[0];
    expect(keptLookup?.sql).toContain('"session"."quiz_id" = $1');
    expect(keptLookup?.parameters).toEqual([GAME_ID]);
  });

  function gameSession(
    overrides: Partial<QuizshowSessionRecord> = {},
  ): Partial<QuizshowSessionRecord> {
    return {
      id: SESSION_ID,
      eventId: null,
      quizId: GAME_ID,
      status: 'lobby',
      endedAt: null,
      startedByUserId: OWNER_ID,
      attachedOrganiserUserIds: [],
      quizSnapshot: {
        title: 'Friday trivia',
        rounds: [{ contentLabel: 'none' }],
      },
      ...overrides,
    };
  }

  function gameQuizRecord(isAdultsOnly = false): Record<string, unknown> {
    return { id: GAME_ID, ownerUserId: OWNER_ID, isAdultsOnly };
  }

  it('joins a game with kind game, the game title, the host card and null event fields', async () => {
    const { service, access } = build({
      latestSession: gameSession(),
      quizRecord: gameQuizRecord(),
    });
    const joined = await service.join(user(VIEWER_ID), joinInput('ABC234'));
    expect(joined).toEqual({
      sessionId: SESSION_ID,
      kind: 'game',
      eventSlug: null,
      eventTitle: null,
      quizTitle: 'Friday trivia',
      isAdultsOnly: false,
      host: OWNER_CARD,
      status: 'lobby',
      isRejoin: false,
    });
    expect(access.loadPlayScope).toHaveBeenCalledWith({
      kind: 'game',
      eventId: null,
      gameId: GAME_ID,
      hostUserId: OWNER_ID,
    });
    expect(access.assertMayPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: 'game', gameId: GAME_ID, ownerUserId: OWNER_ID },
        userId: VIEWER_ID,
        shouldCheckCapacity: true,
      }),
    );
    expect(access.loadJoinHost).toHaveBeenCalledWith(OWNER_ID);

    const ownerGone = build({
      latestSession: gameSession(),
      quizRecord: gameQuizRecord(),
      joinHost: null,
    });
    expect(
      await codeOfRejection(
        ownerGone.service.join(user(VIEWER_ID), joinInput('ABC234')),
      ),
    ).toBe('quizshow_join_code_not_found');
  });

  it('returns isAdultsOnly for an 18+ event and for a game with an adults round', async () => {
    const eventSession = {
      id: SESSION_ID,
      eventId: EVENT_ID,
      status: 'lobby' as const,
      endedAt: null,
      quizSnapshot: { title: 'Quiz', rounds: [{ contentLabel: 'none' }] },
    };
    const adultsEvent = build({
      latestSession: eventSession,
      isAdultsEvent: true,
    });
    expect(
      (await adultsEvent.service.join(user(VIEWER_ID), joinInput('ABC234')))
        .isAdultsOnly,
    ).toBe(true);
    const plainEvent = build({ latestSession: eventSession });
    expect(
      (await plainEvent.service.join(user(VIEWER_ID), joinInput('ABC234')))
        .isAdultsOnly,
    ).toBe(false);

    const adultsRoundGame = build({
      latestSession: gameSession({
        quizSnapshot: {
          title: 'Late trivia',
          rounds: [{ contentLabel: 'none' }, { contentLabel: 'adults' }],
        },
      }),
      quizRecord: gameQuizRecord(false),
    });
    expect(
      (await adultsRoundGame.service.join(user(VIEWER_ID), joinInput('ABC234')))
        .isAdultsOnly,
    ).toBe(true);
    const switchedOnGame = build({
      latestSession: gameSession(),
      quizRecord: gameQuizRecord(true),
    });
    expect(
      (await switchedOnGame.service.join(user(VIEWER_ID), joinInput('ABC234')))
        .isAdultsOnly,
    ).toBe(true);
  });

  it('refuses the owner joining their own game with organiser running', async () => {
    const { service, access } = build({
      latestSession: gameSession(),
      quizRecord: gameQuizRecord(),
    });
    expect(
      await codeOfRejection(service.join(user(OWNER_ID), joinInput('ABC234'))),
    ).toBe('quizshow_organiser_running');
    expect(access.assertMayPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: 'game', gameId: GAME_ID, ownerUserId: OWNER_ID },
        userId: OWNER_ID,
      }),
    );
    expect(access.loadJoinHost).not.toHaveBeenCalled();
  });

  it('refuses join while Pulse Live is neither launched nor in early access', async () => {
    mockIsQuizshowPlayable.mockReturnValue(false);
    const { service, manager, access } = build({
      latestSession: gameSession(),
      quizRecord: gameQuizRecord(),
    });
    let refusal: unknown = null;
    try {
      await service.join(user(VIEWER_ID), joinInput('ABC234'));
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(NotFoundException);
    expect((refusal as NotFoundException).getStatus()).toBe(404);
    expect((refusal as NotFoundException).message).toBe(
      FEATURE_NOT_AVAILABLE_MESSAGE,
    );
    expect(manager.findOne).not.toHaveBeenCalled();
    expect(access.assertMayPlay).not.toHaveBeenCalled();

    mockIsQuizshowPlayable.mockReturnValue(true);
    const joined = await service.join(user(VIEWER_ID), joinInput('ABC234'));
    expect(joined.kind).toBe('game');
  });

  it('gives the owner the game results with the recap', async () => {
    const { service, access, query } = resultsFixture({ game: ownedGame() });
    const card = await service.getGameResults(GAME_ID, OWNER_ID);
    expect(access.loadOwnedGame).toHaveBeenCalledWith(GAME_ID, OWNER_ID);
    expect(card.recap).toEqual({
      questionsPlayed: 3,
      answersGiven: 5,
      questions: [],
      standings: [],
    });
    expect(card.podium.map((entry) => entry.name)).toEqual(['Zed', 'Ana']);
    expect(card.me).toBeNull();
    expect(card.playerCount).toBe(3);
    expect(JSON.stringify(card)).not.toContain(OWNER_ID);
    const sessionLookup = queryCallsMatching(
      query,
      'INNER JOIN "quizshow_results"',
    )[0];
    expect(sessionLookup?.sql).toContain('"session"."quiz_id" = $1');
    expect(sessionLookup?.parameters).toEqual([GAME_ID]);

    const none = resultsFixture({ game: ownedGame(), resultSession: null });
    expect(
      await codeOfRejection(none.service.getGameResults(GAME_ID, OWNER_ID)),
    ).toBe('quizshow_results_not_found');
  });

  it("answers game not found for another member's game results", async () => {
    const { service, query, persistence, manager } = resultsFixture({
      game: ownedGame(),
      keptSessions: [{ id: 'old-1', has_results: true }],
    });
    expect(
      await codeOfRejection(service.getGameResults(GAME_ID, VIEWER_ID)),
    ).toBe('quizshow_game_not_found');
    expect(
      await codeOfRejection(service.deleteGameResults(GAME_ID, VIEWER_ID)),
    ).toBe('quizshow_game_not_found');
    expect(
      await codeOfRejection(
        service.openGameSession(GAME_ID, VIEWER_ID, gameOpenInput()),
      ),
    ).toBe('quizshow_game_not_found');
    expect(query).not.toHaveBeenCalled();
    expect(persistence.deleteKeptResults).not.toHaveBeenCalled();
    expect(manager.insert).not.toHaveBeenCalled();
  });

  it("deletes the kept results of the owner's game", async () => {
    const { service, persistence, dataSource, query } = build({
      game: ownedGame(),
      keptSessions: [
        { id: 'old-1', has_results: true },
        { id: 'abandoned-1', has_results: false },
      ],
    });
    await service.deleteGameResults(GAME_ID, OWNER_ID);
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(persistence.deleteKeptResults).toHaveBeenCalledTimes(1);
    expect(persistence.deleteKeptResults).toHaveBeenCalledWith(
      expect.anything(),
      'old-1',
    );
    expect(queryCallsMatching(query, '"has_results"')[0]?.parameters).toEqual([
      GAME_ID,
    ]);
    const empty = build({ game: ownedGame() });
    expect(
      await codeOfRejection(empty.service.deleteGameResults(GAME_ID, OWNER_ID)),
    ).toBe('quizshow_results_not_found');
  });

  describe('practice lobbies (contract 6.9)', () => {
    it('opens a practice lobby on a draft event and keeps no results card', async () => {
      const draftEvent = {
        id: EVENT_ID,
        slug: SLUG,
        title: 'Quiz night',
        hostId: ORGANISER_ID,
        status: EventStatus.Draft,
      };
      const practice = build({ event: draftEvent });
      await practice.service.openSession(
        SLUG,
        ORGANISER_ID,
        openInput({ isPractice: true }),
      );
      const row = practice.manager.insert.mock.calls[0]?.[1] as Record<
        string,
        unknown
      >;
      expect(row.isPractice).toBe(true);
      expect(row.resultsKept).toBe(false);

      const real = build({ event: draftEvent });
      expect(
        await codeOfRejection(
          real.service.openSession(SLUG, ORGANISER_ID, openInput()),
        ),
      ).toBe('quizshow_event_not_playable');
    });

    it('refuses a practice lobby on a cancelled event', async () => {
      const { service, manager } = build({
        event: {
          id: EVENT_ID,
          slug: SLUG,
          title: 'Quiz night',
          hostId: ORGANISER_ID,
          status: EventStatus.Cancelled,
        },
      });
      expect(
        await codeOfRejection(
          service.openSession(
            SLUG,
            ORGANISER_ID,
            openInput({ isPractice: true }),
          ),
        ),
      ).toBe('quizshow_event_not_playable');
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('leaves kept results untouched and sends no guest push', async () => {
      const { service, persistence, query, guestPush, claimStatements } = build(
        { keptSessions: [{ id: 'old-1', has_results: true }] },
      );
      const opened = await service.openSession(
        SLUG,
        ORGANISER_ID,
        openInput({ isPractice: true, notifyGuests: true }),
      );
      expect(opened.isGuestPushSent).toBe(false);
      expect(persistence.deleteKeptResults).not.toHaveBeenCalled();
      expect(queryCallsMatching(query, '"has_results"')).toHaveLength(0);
      expect(claimStatements).toHaveLength(0);
      expect(guestPush.sendLobbyOpened).not.toHaveBeenCalled();
    });

    it('opens a practice game lobby without touching kept results', async () => {
      const { service, persistence, manager } = build({
        game: ownedGame(),
        keptSessions: [{ id: 'old-1', has_results: true }],
      });
      await service.openGameSession(
        GAME_ID,
        OWNER_ID,
        gameOpenInput({ isPractice: true }),
      );
      expect(persistence.deleteKeptResults).not.toHaveBeenCalled();
      const row = manager.insert.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(row.isPractice).toBe(true);
      expect(row.resultsKept).toBe(false);
    });

    it('counts a practice open toward the hourly lobby limit', async () => {
      const { service, query } = build({ recentOpenCount: 10 });
      expect(
        await codeOfRejection(
          service.openSession(
            SLUG,
            ORGANISER_ID,
            openInput({ isPractice: true }),
          ),
        ),
      ).toBe('quizshow_lobby_rate_limited');
      expect(queryCallsMatching(query, '"open_count"')).toHaveLength(1);
    });
  });

  describe('remembered open settings (item 52)', () => {
    it('writes the open settings on the quiz inside the open transaction', async () => {
      const { service, query, dataSource, manager, transactionManager } =
        build();
      await service.openSession(
        SLUG,
        ORGANISER_ID,
        openInput({ playMode: 'teams', maxTeamSize: 4, isReviewOn: false }),
      );
      const writes = queryCallsMatching(query, '"last_open_settings"');
      expect(writes).toHaveLength(1);
      expect(writes[0]?.sql).toBe(QUIZ_LAST_OPEN_SETTINGS_SQL);
      expect(writes[0]?.parameters[0]).toBe('quiz-1');
      expect(JSON.parse(writes[0]?.parameters[1] as string)).toEqual({
        playMode: 'teams',
        maxTeamSize: 4,
        isReviewOn: false,
      });
      expect(writes[0]!.order).toBeGreaterThan(
        dataSource.transaction.mock.invocationCallOrder[0]!,
      );
      expect(writes[0]!.order).toBeGreaterThan(
        manager.insert.mock.invocationCallOrder[0]!,
      );
      const writeCallIndex = query.mock.calls.findIndex(
        (call) => call[0] === QUIZ_LAST_OPEN_SETTINGS_SQL,
      );
      expect(query.mock.contexts[writeCallIndex]).toBe(transactionManager);
    });

    it('writes them for a practice game lobby too, with no team size in solo play', async () => {
      const { service, query } = build({ game: ownedGame() });
      await service.openGameSession(
        GAME_ID,
        OWNER_ID,
        gameOpenInput({ isPractice: true }),
      );
      const writes = queryCallsMatching(query, '"last_open_settings"');
      expect(writes[0]?.parameters[0]).toBe(GAME_ID);
      expect(JSON.parse(writes[0]?.parameters[1] as string)).toEqual({
        playMode: 'solo',
        maxTeamSize: null,
        isReviewOn: true,
      });
    });
  });

  describe('rematch (contract 6.17)', () => {
    const OLD_SESSION_ID = '0d6f3c1a-9b2e-4f7a-8c5d-1e2f3a4b5c6d';

    function finishedSession(
      overrides: Partial<QuizshowSessionRecord> = {},
    ): Partial<QuizshowSessionRecord> {
      return {
        id: OLD_SESSION_ID,
        eventId: EVENT_ID,
        quizId: 'quiz-1',
        status: 'finished',
        endedAt: new Date(Date.now() - 5 * 60_000),
        ...overrides,
      };
    }

    it('answers rematch not found for a missing, foreign or unfinished session', async () => {
      const cases: Array<Partial<QuizshowSessionRecord> | null> = [
        null,
        finishedSession({ eventId: 'event-2' }),
        finishedSession({ status: 'abandoned' }),
        finishedSession({ status: 'running', endedAt: null }),
      ];
      for (const latestSession of cases) {
        const { service, manager, runtime } = build({ latestSession });
        expect(
          await codeOfRejection(
            service.openSession(
              SLUG,
              ORGANISER_ID,
              openInput({ rematchOfSessionId: OLD_SESSION_ID }),
            ),
          ),
        ).toBe('quizshow_rematch_not_found');
        expect(manager.insert).not.toHaveBeenCalled();
        expect(runtime.emitRematch).not.toHaveBeenCalled();
      }
      const eventSessionForGame = build({
        game: ownedGame(),
        latestSession: finishedSession({ quizId: GAME_ID }),
      });
      expect(
        await codeOfRejection(
          eventSessionForGame.service.openGameSession(
            GAME_ID,
            OWNER_ID,
            gameOpenInput({ rematchOfSessionId: OLD_SESSION_ID }),
          ),
        ),
      ).toBe('quizshow_rematch_not_found');
    });

    it('answers rematch expired once the window has passed', async () => {
      const { service, manager } = build({
        latestSession: finishedSession({
          endedAt: new Date(Date.now() - 31 * 60_000),
        }),
      });
      expect(
        await codeOfRejection(
          service.openSession(
            SLUG,
            ORGANISER_ID,
            openInput({ rematchOfSessionId: OLD_SESSION_ID }),
          ),
        ),
      ).toBe('quizshow_rematch_expired');
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('still asks before replacing kept results on a rematch', async () => {
      const { service } = build({
        latestSession: finishedSession(),
        keptSessions: [{ id: OLD_SESSION_ID, has_results: true }],
      });
      expect(
        await codeOfRejection(
          service.openSession(
            SLUG,
            ORGANISER_ID,
            openInput({ rematchOfSessionId: OLD_SESSION_ID }),
          ),
        ),
      ).toBe('quizshow_results_exist');
    });

    it('creates the old teams empty in a teams rematch, then tells the old session', async () => {
      const { service, manager, runtime, dataSource, transactionManager } =
        build({
          latestSession: finishedSession(),
          teams: [
            {
              id: 'team-1',
              sessionId: OLD_SESSION_ID,
              name: 'Disco Dykes',
              colorKey: 'circle',
              score: 4200,
            },
            {
              id: 'team-2',
              sessionId: OLD_SESSION_ID,
              name: 'Glitter Gays',
              colorKey: 'triangle',
              score: 3100,
            },
            {
              id: 'team-3',
              sessionId: 'other-session',
              name: 'Elsewhere',
              colorKey: 'square',
            },
          ],
        });
      const opened = await service.openSession(
        SLUG,
        ORGANISER_ID,
        openInput({
          playMode: 'teams',
          maxTeamSize: 4,
          rematchOfSessionId: OLD_SESSION_ID,
        }),
      );
      expect(manager.insert).toHaveBeenCalledTimes(2);
      const [teamEntity, teamRows] = manager.insert.mock.calls[1] as [
        unknown,
        Array<Record<string, unknown>>,
      ];
      expect(teamEntity).toBe(QuizshowTeamRecord);
      expect(manager.insert.mock.contexts[0]).toBe(transactionManager);
      expect(manager.insert.mock.contexts[1]).toBe(transactionManager);
      expect(teamRows).toEqual([
        {
          sessionId: SESSION_ID,
          name: 'Disco Dykes',
          colorKey: 'circle',
          score: 0,
          isHostMade: true,
          createdAt: expect.any(Date) as Date,
        },
        {
          sessionId: SESSION_ID,
          name: 'Glitter Gays',
          colorKey: 'triangle',
          score: 0,
          isHostMade: true,
          createdAt: expect.any(Date) as Date,
        },
      ]);
      expect(runtime.emitRematch).toHaveBeenCalledTimes(1);
      expect(runtime.emitRematch).toHaveBeenCalledWith(OLD_SESSION_ID, {
        fromSessionId: OLD_SESSION_ID,
        sessionId: SESSION_ID,
        joinCode: opened.joinCode,
        playMode: 'teams',
      });
      expect(runtime.emitRematch.mock.invocationCallOrder[0]!).toBeGreaterThan(
        manager.insert.mock.invocationCallOrder[1]!,
      );
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('stamps the rematch teams with creation times that rise in the old order', async () => {
      const { service, manager } = build({
        latestSession: finishedSession(),
        teams: ['circle', 'triangle', 'square'].map((colorKey, teamIndex) => ({
          id: `team-${teamIndex}`,
          sessionId: OLD_SESSION_ID,
          name: `Team ${teamIndex}`,
          colorKey: colorKey as QuizshowTeamRecord['colorKey'],
        })),
      });
      await service.openSession(
        SLUG,
        ORGANISER_ID,
        openInput({
          playMode: 'teams',
          maxTeamSize: 4,
          rematchOfSessionId: OLD_SESSION_ID,
        }),
      );
      const [, teamRows] = manager.insert.mock.calls[1] as [
        unknown,
        Array<{ name: string; createdAt: Date }>,
      ];
      expect(teamRows.map((row) => row.name)).toEqual([
        'Team 0',
        'Team 1',
        'Team 2',
      ]);
      const createdTimes = teamRows.map((row) => row.createdAt.getTime());
      expect(createdTimes[1]! - createdTimes[0]!).toBe(1);
      expect(createdTimes[2]! - createdTimes[1]!).toBe(1);
    });

    it('creates no teams in a solo rematch', async () => {
      const { service, manager, runtime } = build({
        latestSession: finishedSession(),
        teams: [
          {
            id: 'team-1',
            sessionId: OLD_SESSION_ID,
            name: 'Disco Dykes',
            colorKey: 'circle',
          },
        ],
      });
      await service.openSession(
        SLUG,
        ORGANISER_ID,
        openInput({ rematchOfSessionId: OLD_SESSION_ID }),
      );
      expect(manager.insert).toHaveBeenCalledTimes(1);
      expect(runtime.emitRematch).toHaveBeenCalledTimes(1);
    });

    it('tells nobody when a fresh lobby opens', async () => {
      const { service, runtime } = build();
      await service.openSession(SLUG, ORGANISER_ID, openInput());
      expect(runtime.emitRematch).not.toHaveBeenCalled();
    });
  });

  describe('join lock on REST (contract 6.15)', () => {
    const lobbySession = {
      id: SESSION_ID,
      eventId: EVENT_ID,
      status: 'lobby' as const,
      endedAt: null,
      isJoinLocked: false,
      quizSnapshot: { title: 'Quiz night questions', rounds: [] },
    };

    it('refuses a new player while the live state is locked', async () => {
      const { service, runtime } = build({
        latestSession: lobbySession,
        liveState: { isJoinLocked: true },
      });
      expect(
        await codeOfRejection(
          service.join(user(VIEWER_ID), joinInput('ABC234')),
        ),
      ).toBe('quizshow_joining_locked');
      expect(runtime.getOrLoad).toHaveBeenCalledWith(SESSION_ID);
    });

    it('reads the column when the runtime does not hold the session', async () => {
      const { service } = build({
        latestSession: { ...lobbySession, isJoinLocked: true },
        liveState: null,
      });
      expect(
        await codeOfRejection(
          service.join(user(VIEWER_ID), joinInput('ABC234')),
        ),
      ).toBe('quizshow_joining_locked');
    });

    it('lets an existing row back in while locked', async () => {
      const { service, runtime } = build({
        latestSession: lobbySession,
        liveState: { isJoinLocked: true },
        existingPlayer: { id: 'player-1' },
      });
      const joined = await service.join(user(VIEWER_ID), joinInput('ABC234'));
      expect(joined.isRejoin).toBe(true);
      expect(runtime.getOrLoad).not.toHaveBeenCalled();
    });

    it('locks a game session for a new player too', async () => {
      const { service } = build({
        latestSession: {
          ...lobbySession,
          eventId: null,
          quizId: GAME_ID,
        },
        quizRecord: { id: GAME_ID, ownerUserId: OWNER_ID, isAdultsOnly: false },
        liveState: { isJoinLocked: true },
      });
      expect(
        await codeOfRejection(
          service.join(user(VIEWER_ID), joinInput('ABC234')),
        ),
      ).toBe('quizshow_joining_locked');
    });
  });

  describe('join preview (contract 5.1)', () => {
    it('answers the quiz title and the status and nothing else', async () => {
      const { service } = build({
        latestSession: {
          id: SESSION_ID,
          eventId: EVENT_ID,
          status: 'running',
          endedAt: null,
          quizSnapshot: { title: 'Quiz night questions', rounds: [] },
        },
      });
      const preview = await service.joinPreview('abc-234');
      expect(preview).toEqual({
        quizTitle: 'Quiz night questions',
        status: 'running',
      });
      expect(Object.keys(preview)).toHaveLength(2);
    });

    it('refuses the codes the join refuses', async () => {
      const finished = build({
        latestSession: {
          id: SESSION_ID,
          eventId: EVENT_ID,
          status: 'finished',
          endedAt: new Date(Date.now() - HOUR_MS),
        },
      });
      expect(
        await codeOfRejection(finished.service.joinPreview('ABC234')),
      ).toBe('quizshow_session_finished');
      const forgotten = build({
        latestSession: {
          id: SESSION_ID,
          eventId: EVENT_ID,
          status: 'finished',
          endedAt: new Date(Date.now() - 13 * HOUR_MS),
        },
      });
      expect(
        await codeOfRejection(forgotten.service.joinPreview('ABC234')),
      ).toBe('quizshow_join_code_not_found');
      const unknown = build();
      expect(await codeOfRejection(unknown.service.joinPreview('ABC234'))).toBe(
        'quizshow_join_code_not_found',
      );
      expect(await codeOfRejection(unknown.service.joinPreview('nope'))).toBe(
        'quizshow_join_code_not_found',
      );
      const idle = build({
        isIdleAbandoned: true,
        latestSession: {
          id: SESSION_ID,
          eventId: EVENT_ID,
          status: 'lobby',
          endedAt: null,
        },
      });
      expect(await codeOfRejection(idle.service.joinPreview('ABC234'))).toBe(
        'quizshow_session_finished',
      );
    });

    it('answers the feature 404 while Pulse Live is closed', async () => {
      mockIsQuizshowPlayable.mockReturnValue(false);
      const { service, manager } = build();
      const rejection = service.joinPreview('ABC234');
      await expect(rejection).rejects.toBeInstanceOf(NotFoundException);
      await expect(rejection).rejects.toThrow(FEATURE_NOT_AVAILABLE_MESSAGE);
      expect(manager.findOne).not.toHaveBeenCalled();
    });
  });

  describe('lobby refresh (contract 6.10)', () => {
    const eventTarget = { kind: 'event', slug: SLUG } as const;
    const openLobby = { id: SESSION_ID, join_code: 'ABC234' };
    const lobbyState: Partial<QuizshowLiveState> = { status: 'lobby' };

    function refreshed(isNoop: boolean): QuizshowHostOutcome {
      return { ok: true, success: { isNoop }, effects: [] };
    }

    it('answers session not found with a 404 when no lobby is open', async () => {
      const closed = build({ openSession: null });
      const error = await closed.service
        .refreshLobby(eventTarget, ORGANISER_ID)
        .catch((caught: unknown) => caught);
      expect(quizshowCodeOf(error)).toBe('quizshow_session_not_found');
      expect((error as { getStatus(): number }).getStatus()).toBe(404);

      const unloaded = build({ openSession: openLobby, liveState: null });
      expect(
        await codeOfRejection(
          unloaded.service.refreshLobby(eventTarget, ORGANISER_ID),
        ),
      ).toBe('quizshow_session_not_found');
    });

    it('answers not in lobby once the game has started', async () => {
      const { service, quizService } = build({
        openSession: openLobby,
        liveState: { status: 'running' },
      });
      expect(
        await codeOfRejection(service.refreshLobby(eventTarget, ORGANISER_ID)),
      ).toBe('quizshow_not_in_lobby');
      expect(quizService.loadQuiz).not.toHaveBeenCalled();
    });

    it('answers quiz gone, incomplete and adults mismatch from the saved quiz', async () => {
      const gone = build({
        openSession: openLobby,
        liveState: lobbyState,
        quiz: null,
      });
      expect(
        await codeOfRejection(
          gone.service.refreshLobby(eventTarget, ORGANISER_ID),
        ),
      ).toBe('quizshow_refresh_quiz_gone');

      const incomplete = build({
        openSession: openLobby,
        liveState: lobbyState,
      });
      incomplete.state.quiz = {
        ...(incomplete.state.quiz as object),
        rounds: [],
      };
      const body = await bodyOfRejection(
        incomplete.service.refreshLobby(eventTarget, ORGANISER_ID),
      );
      expect(body.code).toBe('quizshow_refresh_quiz_incomplete');
      expect(body.problems).toEqual([
        {
          code: 'no_rounds',
          roundIndex: null,
          questionIndex: null,
          language: null,
        },
      ]);

      const adults = build({ openSession: openLobby, liveState: lobbyState });
      const adultsQuiz = adults.state.quiz as {
        rounds: Array<{ contentLabel: string }>;
      };
      adultsQuiz.rounds[0]!.contentLabel = 'adults';
      expect(
        await codeOfRejection(
          adults.service.refreshLobby(eventTarget, ORGANISER_ID),
        ),
      ).toBe('quizshow_refresh_adults_mismatch');
      expect(mockHostRefreshQuiz).not.toHaveBeenCalled();
    });

    it('runs the engine refresh with a fresh snapshot and answers its no-op flag', async () => {
      const { service, runtime } = build({
        openSession: openLobby,
        liveState: lobbyState,
        isAdultsEvent: true,
      });
      mockHostRefreshQuiz.mockReturnValue(refreshed(false));
      await expect(
        service.refreshLobby(eventTarget, ORGANISER_ID),
      ).resolves.toEqual({ isNoop: false });
      expect(runtime.execute).toHaveBeenCalledWith(
        SESSION_ID,
        expect.any(Function),
      );
      const [, snapshot, isScopeAdultsOnly, now] =
        mockHostRefreshQuiz.mock.calls[0]!;
      expect(snapshot.title).toBe('Pride and queer history');
      expect(snapshot.sourceUpdatedAt).toBe('2026-10-19T10:00:00.000Z');
      expect(isScopeAdultsOnly).toBe(true);
      expect(typeof now).toBe('number');

      mockHostRefreshQuiz.mockReturnValue(refreshed(true));
      await expect(
        service.refreshLobby(eventTarget, ORGANISER_ID),
      ).resolves.toEqual({ isNoop: true });
    });

    it('passes the engine refusals through as their own 409', async () => {
      const engineCodes = [
        'quizshow_not_in_lobby',
        'quizshow_refresh_adults_lobby_joined',
      ] as const;
      for (const code of engineCodes) {
        const { service } = build({
          openSession: openLobby,
          liveState: lobbyState,
        });
        mockHostRefreshQuiz.mockReturnValue({
          ok: false,
          failure: { ok: false, code, message: 'Refused by the engine.' },
          effects: [],
        });
        const error = await service
          .refreshLobby(eventTarget, ORGANISER_ID)
          .catch((caught: unknown) => caught);
        expect(quizshowCodeOf(error)).toBe(code);
        expect((error as { getStatus(): number }).getStatus()).toBe(409);
      }
    });

    it("refreshes the owner's game lobby with the game's own quiz and switch", async () => {
      const { service, access, quizService, query } = build({
        game: ownedGame({ isAdultsOnly: false }),
        openSession: openLobby,
        liveState: lobbyState,
      });
      mockHostRefreshQuiz.mockReturnValue(refreshed(false));
      await service.refreshLobby({ kind: 'game', gameId: GAME_ID }, OWNER_ID);
      expect(access.loadOwnedGame).toHaveBeenCalledWith(GAME_ID, OWNER_ID);
      expect(quizService.loadQuizById).toHaveBeenCalledWith(GAME_ID);
      expect(mockHostRefreshQuiz.mock.calls[0]?.[2]).toBe(false);
      const lookup = queryCallsMatching(query, '"join_code" AS "join_code"')[0];
      expect(lookup?.sql).toContain('"session"."quiz_id" = $1');
      expect(lookup?.parameters).toEqual([GAME_ID]);
    });

    it('runs the organiser checks of an open', async () => {
      const { service } = build({
        openSession: openLobby,
        liveState: lobbyState,
        isCohostPlaying: true,
      });
      expect(
        await codeOfRejection(service.refreshLobby(eventTarget, ORGANISER_ID)),
      ).toBe('quizshow_cohost_is_playing');
      const stranger = build({
        openSession: openLobby,
        liveState: lobbyState,
        isOrganiser: false,
      });
      expect(
        await codeOfRejection(
          stranger.service.refreshLobby(eventTarget, VIEWER_ID),
        ),
      ).toBe('quizshow_not_organiser');
    });
  });

  describe('guest push from the remote (contract 6.8)', () => {
    function lobbyLiveState(
      overrides: Partial<QuizshowLiveState> = {},
    ): Partial<QuizshowLiveState> {
      return {
        sessionId: SESSION_ID,
        status: 'lobby',
        kind: 'event',
        eventId: EVENT_ID,
        joinCode: 'ABC234',
        isPractice: false,
        guestPushSentAt: null,
        ...overrides,
      };
    }

    it('answers each live-state refusal before claiming the cooldown', async () => {
      const cases: Array<[Partial<QuizshowLiveState> | null, string]> = [
        [null, 'quizshow_session_ended'],
        [lobbyLiveState({ status: 'running' }), 'quizshow_not_in_lobby'],
        [
          lobbyLiveState({ kind: 'game', eventId: null }),
          'quizshow_guest_push_needs_event',
        ],
        [lobbyLiveState({ isPractice: true }), 'quizshow_guest_push_practice'],
        [
          lobbyLiveState({ guestPushSentAt: Date.now() - 60_000 }),
          'quizshow_guest_push_already_sent',
        ],
      ];
      for (const [liveState, expectedCode] of cases) {
        const { service, claimStatements, guestPush } = build({ liveState });
        await expect(service.notifyGuestsForSession(SESSION_ID)).resolves.toBe(
          expectedCode,
        );
        expect(claimStatements).toHaveLength(0);
        expect(guestPush.sendLobbyOpened).not.toHaveBeenCalled();
      }
    });

    it('answers the cooldown when another session of the event pushed lately', async () => {
      const { service, guestPush, runtime, state } = build({
        liveState: lobbyLiveState(),
        isPushClaimable: false,
      });
      await expect(service.notifyGuestsForSession(SESSION_ID)).resolves.toBe(
        'quizshow_guest_push_cooldown',
      );
      expect(guestPush.sendLobbyOpened).not.toHaveBeenCalled();
      expect(runtime.execute).not.toHaveBeenCalled();
      expect(state.liveState?.guestPushSentAt).toBeNull();
    });

    it('sends one push when two remote calls race', async () => {
      const { service, guestPush, claimStatements } = build({
        liveState: lobbyLiveState(),
      });
      const answers = await Promise.all([
        service.notifyGuestsForSession(SESSION_ID),
        service.notifyGuestsForSession(SESSION_ID),
      ]);
      expect(guestPush.sendLobbyOpened).toHaveBeenCalledTimes(1);
      expect(claimStatements).toHaveLength(2);
      expect([...answers].sort()).toEqual([
        null,
        'quizshow_guest_push_already_sent',
      ]);
    });

    it('refuses a draft or cancelled event before claiming', async () => {
      for (const status of [EventStatus.Draft, EventStatus.Cancelled]) {
        const { service, guestPush, claimStatements } = build({
          liveState: lobbyLiveState(),
          event: {
            id: EVENT_ID,
            slug: SLUG,
            title: 'Quiz night',
            hostId: ORGANISER_ID,
            status,
          },
        });
        await expect(service.notifyGuestsForSession(SESSION_ID)).resolves.toBe(
          'quizshow_event_not_playable',
        );
        expect(claimStatements).toHaveLength(0);
        expect(guestPush.sendLobbyOpened).not.toHaveBeenCalled();
      }
    });

    it('throws a claim fault on the remote path and opens a lobby without a push', async () => {
      const claimError = new Error('connection reset');
      const remote = build({ liveState: lobbyLiveState(), claimError });
      await expect(
        remote.service.notifyGuestsForSession(SESSION_ID),
      ).rejects.toBe(claimError);
      expect(remote.guestPush.sendLobbyOpened).not.toHaveBeenCalled();
      expect(remote.runtime.execute).not.toHaveBeenCalled();

      const open = build({ claimError });
      const opened = await open.service.openSession(
        SLUG,
        ORGANISER_ID,
        openInput({ notifyGuests: true }),
      );
      expect(opened.isGuestPushSent).toBe(false);
      expect(open.guestPush.sendLobbyOpened).not.toHaveBeenCalled();
    });

    it('pushes the guests, stamps the session and mirrors the stamp in the live state', async () => {
      const { service, guestPush, runtime, state, claimStatements } = build({
        liveState: lobbyLiveState(),
      });
      await expect(
        service.notifyGuestsForSession(SESSION_ID),
      ).resolves.toBeNull();
      const claim = claimStatements[0] as [string, Date, string, Date];
      expect(claim[0]).toBe(SESSION_ID);
      expect(claim[2]).toBe(EVENT_ID);
      expect(guestPush.sendLobbyOpened).toHaveBeenCalledWith({
        eventId: EVENT_ID,
        eventTitle: 'Quiz night',
        hostUserId: ORGANISER_ID,
        sessionId: SESSION_ID,
        joinCode: 'ABC234',
        startedAt: claim[1],
      });
      expect(runtime.execute).toHaveBeenCalledWith(
        SESSION_ID,
        expect.any(Function),
      );
      expect(state.liveState?.guestPushSentAt).toBe(claim[1].getTime());
    });
  });
});
