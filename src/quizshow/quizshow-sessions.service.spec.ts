import { NotFoundException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { FEATURE_NOT_AVAILABLE_MESSAGE } from '../common/feature.decorator';
import { EventStatus } from '../events/entities/event.entity';
import { QuizshowPlayerRecord } from './entities/quizshow-player.entity';
import { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import { QuizshowResultRecord } from './entities/quizshow-result.entity';
import { QuizshowSessionRecord } from './entities/quizshow-session.entity';
import { QuizshowTeamRecord } from './entities/quizshow-team.entity';
import type { QuizshowPlayScope } from './quizshow-access.service';
import type { QuizshowScopeSource } from './quizshow-engine-types';
import { quizshowCodeOf, quizshowError } from './quizshow-errors';
import { isQuizshowPlayable } from './quizshow-play-rules';
import {
  LOBBY_OPEN_COUNT_SQL,
  LOBBY_OPEN_INSERT_SQL,
  LOBBY_OPEN_PRUNE_SQL,
  normaliseJoinCode,
  QuizshowSessionsService,
} from './quizshow-sessions.service';
import type { QuizshowJoinHost } from './quizshow.contract';
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
    ...overrides,
  };
  const claimStatements: unknown[][] = [];
  const query = jest.fn((sql: string, parameters: unknown[] = []) => {
    // The lobby opens ledger: each recorded open joins the rolling hour count.
    if (sql === LOBBY_OPEN_INSERT_SQL) {
      state.recentOpenCount += 1;
      return Promise.resolve([]);
    }
    if (sql.includes('"claimed"')) {
      claimStatements.push(parameters);
      return Promise.resolve(
        state.isPushClaimable ? [{ id: parameters[0] }] : [],
      );
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
      (entity: unknown, options: { where: { id: { _value: string[] } } }) => {
        const ids = options.where.id._value;
        const rows =
          entity === QuizshowPlayerRecord ? state.players : state.teams;
        return Promise.resolve(
          rows.filter((row) => ids.includes(row.id as string)),
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
    transaction: jest.fn((callback: (entityManager: unknown) => unknown) =>
      Promise.resolve(callback(manager)),
    ),
  };
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

const user = (userId: string) => ({ userId, restricted: false }) as never;
const joinInput = (code: string): QuizshowJoinDto => ({ code });

describe('QuizshowSessionsService', () => {
  beforeEach(() => {
    mockIsQuizshowPlayable.mockReset();
    mockIsQuizshowPlayable.mockReturnValue(true);
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
    expect(row.questionLog).toEqual([]);
    expect(row.startedByUserId).toBe(ORGANISER_ID);
    expect(row.attachedOrganiserUserIds).toEqual([]);
    expect(row.lastHostCommandAt).toBe(row.startedAt);
    expect(row.quizSnapshot.rounds.length).toBeGreaterThan(0);
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
        questionStats: { questionsPlayed: 3, answersGiven: 5, questions: [] },
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
    ).toEqual({ questionsPlayed: 3, answersGiven: 5, questions: [] });
    const playing = resultsFixture({
      isOrganiser: true,
      isCohostPlaying: true,
    });
    expect(
      await codeOfRejection(playing.service.getResults(SLUG, ORGANISER_ID)),
    ).toBe('quizshow_cohost_is_playing');
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
});
