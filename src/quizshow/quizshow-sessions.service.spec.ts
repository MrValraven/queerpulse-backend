import { QueryFailedError } from 'typeorm';
import { EventStatus } from '../events/entities/event.entity';
import { QuizshowPlayerRecord } from './entities/quizshow-player.entity';
import { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import { QuizshowResultRecord } from './entities/quizshow-result.entity';
import { QuizshowSessionRecord } from './entities/quizshow-session.entity';
import { QuizshowTeamRecord } from './entities/quizshow-team.entity';
import { quizshowCodeOf } from './quizshow-errors';
import {
  normaliseJoinCode,
  QuizshowSessionsService,
} from './quizshow-sessions.service';
import { QUIZSHOW_STARTER_PACKS } from './quizshow-starter-packs';
import type { QuizshowJoinDto } from './dto/quizshow-join.dto';
import type { QuizshowOpenSessionDto } from './dto/quizshow-open-session.dto';

const ORGANISER_ID = 'organiser-1';
const VIEWER_ID = 'viewer-1';
const EVENT_ID = 'event-1';
const SLUG = 'quiz-night';
const SESSION_ID = 'session-1';
const HOUR_MS = 3_600_000;

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
}

function completeQuiz(): unknown {
  const pack = QUIZSHOW_STARTER_PACKS[0];
  if (!pack) throw new Error('A starter pack is needed');
  return structuredClone({
    ...pack.quiz,
    updatedAt: '2026-10-19T10:00:00.000Z',
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
    ...overrides,
  };
  const claimStatements: unknown[][] = [];
  const query = jest.fn((sql: string, parameters: unknown[] = []) => {
    if (sql.includes('"claimed"')) {
      claimStatements.push(parameters);
      return Promise.resolve(
        state.isPushClaimable ? [{ id: parameters[0] }] : [],
      );
    }
    if (sql.includes('"has_rsvp"')) {
      return Promise.resolve([{ has_rsvp: state.hasGoingRsvp }]);
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
      if (entity === QuizshowQuizRecord)
        return Promise.resolve({ id: 'quiz-1' });
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
    isAdultsEvent: jest.fn().mockReturnValue(false),
    assertMayPlay: jest.fn().mockImplementation(() =>
      Promise.resolve({
        existingPlayer: state.existingPlayer,
        isCohost: false,
      }),
    ),
  };
  const quizService = {
    loadQuiz: jest.fn().mockImplementation(() => Promise.resolve(state.quiz)),
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
    guestPush,
    persistence,
    runtime,
    claimStatements,
  };
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
    };
    const fresh = build({ latestSession });
    const first = await fresh.service.join(
      user(VIEWER_ID),
      joinInput('abc 234'),
    );
    expect(first).toEqual({
      sessionId: SESSION_ID,
      eventSlug: SLUG,
      eventTitle: 'Quiz night',
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
});
