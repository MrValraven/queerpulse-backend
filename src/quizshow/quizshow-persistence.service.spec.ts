import { Logger } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { createLobbyState } from './quizshow-engine-state';
import type {
  QuizshowLivePlayer,
  QuizshowLiveState,
  QuizshowLiveTeam,
  QuizshowQuestionLogEntry,
} from './quizshow-engine-types';
import {
  buildQuizshowRecap,
  QUIZSHOW_RESTART_REPLAY_PHASES,
  QuizshowPersistenceService,
} from './quizshow-persistence.service';
import type {
  QuizshowRandom,
  QuizshowSessionSnapshot,
  QuizshowSnapshotRound,
} from './quizshow-snapshot';

const STARTED_AT = 1_000;
const SESSION_ID = 'session-1';

interface RecordedQuery {
  sql: string;
  params: unknown[];
  transactionNumber: number | null;
}

type Responder = (sql: string, params: unknown[]) => unknown;

function buildService(responder: Responder = () => []) {
  const recordedQueries: RecordedQuery[] = [];
  let transactionCount = 0;
  const run = (
    sql: string,
    params: unknown[] | undefined,
    transactionNumber: number | null,
  ): Promise<unknown> => {
    recordedQueries.push({ sql, params: params ?? [], transactionNumber });
    return Promise.resolve().then(() => responder(sql, params ?? []));
  };
  const dataSource = {
    query: jest.fn((sql: string, params?: unknown[]) => run(sql, params, null)),
    transaction: jest.fn(
      async (work: (manager: EntityManager) => Promise<unknown>) => {
        transactionCount += 1;
        const transactionNumber = transactionCount;
        const manager = {
          query: jest.fn((sql: string, params?: unknown[]) =>
            run(sql, params, transactionNumber),
          ),
        };
        return work(manager as unknown as EntityManager);
      },
    ),
  };
  const service = new QuizshowPersistenceService(
    dataSource as unknown as DataSource,
  );
  return { service, dataSource, recordedQueries };
}

function createGate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const ROUND_SETTINGS = {
  timeLimitSeconds: 20,
  isSpeedBonusOn: true,
  isJokerAllowed: true,
  writeSeconds: 60,
  voteSeconds: 30,
};

const QUIZ_ROUND: QuizshowSnapshotRound = {
  id: 'round-quiz',
  kind: 'quiz',
  title: { en: 'Icons', pt: 'Ícones' },
  contentLabel: 'none',
  settings: ROUND_SETTINGS,
  questions: [
    {
      id: 'question-choice',
      type: 'multiple_choice',
      prompt: { en: 'Who sang Believe?', pt: 'Quem cantou Believe?' },
      mediaRef: null,
      mediaUrl: null,
      timeLimitSeconds: null,
      points: 1000,
      options: [
        { id: 'cher', text: { en: 'Cher', pt: 'Cher' } },
        { id: 'kylie', text: { en: 'Kylie', pt: 'Kylie' } },
      ],
      answer: { correctIndex: 0 },
      acceptedAnswers: [],
      shownOptions: [
        { id: 'cher', text: { en: 'Cher', pt: 'Cher' } },
        { id: 'kylie', text: { en: 'Kylie', pt: 'Kylie' } },
      ],
    },
    {
      id: 'question-order',
      type: 'order',
      prompt: { en: 'Order the decades', pt: 'Ordena as décadas' },
      mediaRef: null,
      mediaUrl: null,
      timeLimitSeconds: null,
      points: 1000,
      options: [
        { id: 'sixties', text: { en: '1960s', pt: 'Anos 60' } },
        { id: 'seventies', text: { en: '1970s', pt: 'Anos 70' } },
        { id: 'eighties', text: { en: '1980s', pt: 'Anos 80' } },
      ],
      answer: { orderedIds: ['sixties', 'seventies', 'eighties'] },
      acceptedAnswers: [],
      shownOptions: null,
    },
  ],
};

const LIE_ROUND: QuizshowSnapshotRound = {
  id: 'round-lie',
  kind: 'lie_detector',
  title: { en: 'Lie Detector', pt: 'Detetor de mentiras' },
  contentLabel: 'none',
  settings: ROUND_SETTINGS,
  questions: [
    {
      id: 'question-lie',
      type: 'prompt',
      prompt: {
        en: 'Who is the goddess of pop?',
        pt: 'Quem é a deusa da pop?',
      },
      mediaRef: null,
      mediaUrl: null,
      timeLimitSeconds: null,
      points: 1000,
      options: [],
      answer: { truth: { en: 'Cher', pt: 'A Cher' } },
      acceptedAnswers: [],
      shownOptions: null,
    },
  ],
};

const CAPTION_ROUND: QuizshowSnapshotRound = {
  id: 'round-caption',
  kind: 'caption_this',
  title: { en: 'Caption This', pt: 'Legenda isto' },
  contentLabel: 'none',
  settings: ROUND_SETTINGS,
  questions: [
    {
      id: 'question-caption',
      type: 'prompt',
      prompt: { en: '', pt: '' },
      mediaRef: 'event-covers/caption.png',
      mediaUrl: null,
      timeLimitSeconds: null,
      points: 1000,
      options: [],
      answer: null,
      acceptedAnswers: [],
      shownOptions: null,
    },
  ],
};

const SNAPSHOT: QuizshowSessionSnapshot = {
  title: 'Pride night quiz',
  languages: 'both',
  screenLanguage: 'en',
  rounds: [QUIZ_ROUND, LIE_ROUND, CAPTION_ROUND],
};

function logEntry(
  overrides: Partial<QuizshowQuestionLogEntry> &
    Pick<QuizshowQuestionLogEntry, 'questionId'>,
): QuizshowQuestionLogEntry {
  return {
    roundIndex: 0,
    questionIndex: 0,
    roundKind: 'quiz',
    type: 'multiple_choice',
    openedAt: 10_000,
    revealedAt: 30_000,
    eligibleCount: 2,
    wasSkipped: false,
    ...overrides,
  };
}

function lobbyState(): QuizshowLiveState {
  return createLobbyState({
    sessionId: SESSION_ID,
    eventId: 'event-1',
    eventSlug: 'pride-night',
    eventTitle: 'Pride night',
    hostUserId: 'host-user',
    openedByUserId: 'host-user',
    joinCode: 'ABC234',
    playMode: 'solo',
    maxTeamSize: null,
    isReviewOn: true,
    snapshot: SNAPSHOT,
    attachedOrganiserUserIds: new Set<string>(),
    nextEvent: null,
    startedAt: STARTED_AT,
  });
}

function livePlayer(playerId: string): QuizshowLivePlayer {
  return {
    playerId,
    userId: `${playerId}-user`,
    screenName: 'Ana Banana',
    teamId: null,
    isCohostPlayer: false,
    isAvatarShown: false,
    avatarUrl: null,
    hasExtraTime: false,
    score: 0,
    streak: 0,
    hasUsedJoker: false,
    jokerRoundIndex: null,
    joinedAt: 2_000,
    removedAt: null,
    connectedSocketCount: 1,
  };
}

function liveTeam(teamId: string): QuizshowLiveTeam {
  return {
    teamId,
    name: 'The Divas',
    colorKey: 'heart',
    score: 0,
    hasUsedJoker: false,
    jokerRoundIndex: null,
    createdAt: 1_500,
  };
}

function sessionRow(overrides: Record<string, unknown>) {
  return {
    id: SESSION_ID,
    event_id: 'event-1',
    status: 'running',
    join_code: 'ABC234',
    play_mode: 'solo',
    max_team_size: null,
    is_review_on: true,
    cursor: {
      phase: 'lobby',
      roundIndex: null,
      questionIndex: null,
      roundCount: 2,
      phaseStartedAt: null,
      deadline: null,
      extraTimeDeadline: null,
      pausedRemainingMs: null,
      pausedExtraTimeRemainingMs: null,
      isRestartRecovery: false,
      phaseCounter: 0,
    },
    question_log: [],
    quiz_snapshot: SNAPSHOT,
    started_by_user_id: 'cohost-user',
    last_host_command_at: new Date(40_000),
    paused_at: null,
    attached_organiser_user_ids: ['cohost-user'],
    event_slug: 'pride-night',
    event_title: 'Pride night',
    event_host_id: 'host-user',
    event_series_id: null,
    event_series_index: null,
    ...overrides,
  };
}

function playerRow(overrides: Record<string, unknown>) {
  return {
    user_id: 'some-user',
    is_cohost_player: false,
    team_id: null,
    screen_name: 'Player',
    is_avatar_shown: false,
    has_extra_time: false,
    score: 0,
    streak: 0,
    has_used_joker: false,
    joker_round_index: null,
    removed_at: null,
    joined_at: new Date(5_000),
    profile_avatar_url: null,
    profile_photo_visible: true,
    ...overrides,
  };
}

function answerRow(overrides: Record<string, unknown>) {
  return {
    received_at: new Date(12_000),
    elapsed_ms: null,
    is_correct: null,
    points_awarded: 0,
    vote_option_id: null,
    hidden_at: null,
    ...overrides,
  };
}

/** Answers each load query by the table it reads. */
function loadResponder(rows: {
  session: unknown[];
  players?: unknown[];
  teams?: unknown[];
  nextEvents?: unknown[];
  answers?: unknown[];
  votes?: unknown[];
}): Responder {
  return (sql) => {
    if (sql.includes('FROM "quizshow_sessions" "session"')) return rows.session;
    if (sql.includes('FROM "quizshow_players" "player"')) {
      return rows.players ?? [];
    }
    if (sql.includes('FROM "quizshow_teams" "team"')) return rows.teams ?? [];
    if (sql.includes('FROM "events" "next_event"')) {
      return rows.nextEvents ?? [];
    }
    if (sql.includes('FROM "quizshow_answers" "answer"')) {
      return rows.answers ?? [];
    }
    if (sql.includes('FROM "quizshow_votes" "vote"')) return rows.votes ?? [];
    return [];
  };
}

const RANDOM: QuizshowRandom = {
  uuid: () => 'option-truth',
  integerBelow: () => 1,
};

describe('QuizshowPersistenceService', () => {
  let loggerErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    loggerErrorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('pauses running sessions on boot with restart recovery only in question phases', async () => {
    const { service, recordedQueries } = buildService(() => [
      { id: 'session-1' },
      { id: 'session-2' },
    ]);
    const now = new Date('2026-10-19T21:00:00.000Z');

    const pausedCount = await service.recoverRunningSessionsAfterRestart(now);

    expect(pausedCount).toBe(2);
    expect(recordedQueries).toHaveLength(1);
    const [recovery] = recordedQueries;
    expect(recovery?.params).toEqual([
      now,
      ['read', 'open', 'write', 'review', 'vote'],
    ]);
    expect(QUIZSHOW_RESTART_REPLAY_PHASES).toEqual([
      'read',
      'open',
      'write',
      'review',
      'vote',
    ]);
    const sql = recovery?.sql ?? '';
    expect(sql).toContain('WITH "recovered" AS (');
    expect(sql).toContain(`SET "status" = 'paused'`);
    expect(sql).toContain('"paused_at" = $1');
    expect(sql).toContain(`WHERE "status" = 'running'`);
    expect(sql).toContain('RETURNING "id"');
    expect(sql).toContain(
      `'isRestartRecovery', ("cursor" ->> 'phase') = ANY($2::text[])`,
    );
    for (const clearedField of [
      'deadline',
      'extraTimeDeadline',
      'pausedRemainingMs',
      'pausedExtraTimeRemainingMs',
    ]) {
      expect(sql).toContain(`'${clearedField}', NULL`);
    }
    expect(sql).not.toContain('last_host_command_at');
  });

  it('rebuilds players, teams, scores and the current question from the database', async () => {
    const { service, recordedQueries } = buildService(
      loadResponder({
        session: [
          sessionRow({
            play_mode: 'teams',
            max_team_size: 4,
            cursor: {
              phase: 'scores',
              roundIndex: 0,
              questionIndex: 0,
              roundCount: 2,
              phaseStartedAt: 31_000,
              deadline: null,
              extraTimeDeadline: null,
              pausedRemainingMs: null,
              pausedExtraTimeRemainingMs: null,
              isRestartRecovery: false,
              phaseCounter: 7,
            },
            question_log: [logEntry({ questionId: 'question-choice' })],
            event_series_id: 'series-1',
            event_series_index: 2,
          }),
        ],
        players: [
          playerRow({
            id: 'player-ana',
            user_id: 'ana-user',
            team_id: 'team-red',
            screen_name: 'Ana',
            is_avatar_shown: true,
            score: 1100,
            streak: 1,
            joined_at: new Date(5_000),
            profile_avatar_url: 'https://images.example.com/ana.png',
            profile_photo_visible: true,
          }),
          playerRow({
            id: 'player-bea',
            user_id: 'bea-user',
            team_id: 'team-red',
            screen_name: 'Bea',
            joined_at: new Date(6_000),
            profile_avatar_url: 'https://images.example.com/bea.png',
            profile_photo_visible: false,
          }),
          playerRow({
            id: 'player-caz',
            user_id: 'caz-user',
            team_id: 'team-blue',
            screen_name: 'Caz',
            joined_at: new Date(20_000),
          }),
          playerRow({
            id: 'player-dee',
            user_id: 'dee-user',
            team_id: 'team-blue',
            screen_name: 'Dee',
            joined_at: new Date(4_000),
            removed_at: new Date(8_000),
          }),
        ],
        teams: [
          {
            id: 'team-red',
            name: 'Red',
            color_key: 'heart',
            score: 550,
            has_used_joker: false,
            joker_round_index: null,
            created_at: new Date(3_000),
          },
          {
            id: 'team-blue',
            name: 'Blue',
            color_key: 'moon',
            score: 0,
            has_used_joker: true,
            joker_round_index: 1,
            created_at: new Date(3_500),
          },
        ],
        nextEvents: [
          {
            slug: 'pride-night-4',
            title: 'Pride night',
            start_at: new Date('2026-10-26T20:00:00.000Z'),
          },
        ],
        answers: [
          answerRow({
            id: 'answer-ana',
            player_id: 'player-ana',
            question_id: 'question-choice',
            payload: { type: 'multiple_choice', optionIndex: 0 },
            elapsed_ms: 1_200,
            is_correct: true,
            points_awarded: 1_100,
          }),
          answerRow({
            id: 'answer-bea',
            player_id: 'player-bea',
            question_id: 'question-choice',
            payload: { type: 'multiple_choice', optionIndex: 1 },
            elapsed_ms: 3_000,
            is_correct: false,
            points_awarded: 0,
          }),
        ],
      }),
    );

    const state = await service.loadLiveState(SESSION_ID, RANDOM);

    expect(state).not.toBeNull();
    if (state === null) return;
    expect(state.eventSlug).toBe('pride-night');
    expect(state.eventTitle).toBe('Pride night');
    expect(state.hostUserId).toBe('host-user');
    expect(state.openedByUserId).toBe('cohost-user');
    expect(state.snapshot).toBe(SNAPSHOT);
    expect(state.phaseCounter).toBe(7);
    expect(state.cursor).toEqual({
      phaseId: '7',
      status: 'running',
      phase: 'scores',
      roundIndex: 0,
      questionIndex: 0,
      roundCount: 2,
      phaseStartedAt: 31_000,
      deadline: null,
      extraTimeDeadline: null,
      pausedRemainingMs: null,
      pausedExtraTimeRemainingMs: null,
      isRestartRecovery: false,
    });
    expect(state.lastHostCommandAt).toBe(40_000);
    expect(state.attachedOrganiserUserIds).toEqual(new Set(['cohost-user']));
    expect(state.isScreenMuted).toBe(false);

    expect([...state.players.keys()]).toEqual([
      'player-ana',
      'player-bea',
      'player-caz',
      'player-dee',
    ]);
    expect(state.players.get('player-ana')).toEqual(
      expect.objectContaining({
        teamId: 'team-red',
        isAvatarShown: true,
        avatarUrl: 'https://images.example.com/ana.png',
        score: 1100,
        streak: 1,
        joinedAt: 5_000,
        removedAt: null,
        connectedSocketCount: 0,
      }),
    );
    expect(state.players.get('player-bea')?.avatarUrl).toBeNull();
    expect(state.players.get('player-dee')?.removedAt).toBe(8_000);
    expect(state.teams.get('team-blue')).toEqual({
      teamId: 'team-blue',
      name: 'Blue',
      colorKey: 'moon',
      score: 0,
      hasUsedJoker: true,
      jokerRoundIndex: 1,
      createdAt: 3_500,
    });

    expect(state.scoresAtLastFrame).toEqual(
      new Map([
        ['team-red', 550],
        ['team-blue', 0],
      ]),
    );
    expect(state.lastScoresFrame?.scope).toBe('question');
    expect(state.hasScoredQuestion).toBe(true);
    expect(state.nextEvent).toEqual({
      slug: 'pride-night-4',
      title: 'Pride night',
      startAt: '2026-10-26T20:00:00.000Z',
    });
    const nextEventQuery = recordedQueries.find((query) =>
      query.sql.includes('FROM "events" "next_event"'),
    );
    expect(nextEventQuery?.sql).toContain(
      `"next_event"."status" = 'published'`,
    );
    expect(nextEventQuery?.sql).toContain(
      'ORDER BY "next_event"."series_index" ASC',
    );
    expect(nextEventQuery?.params).toEqual(['series-1', 2]);

    const current = state.current;
    expect(current).not.toBeNull();
    if (current === null) return;
    expect(current.questionId).toBe('question-choice');
    expect(current.openedAt).toBe(10_000);
    expect(current.isScored).toBe(true);
    expect(current.eligiblePlayerIds).toEqual(
      new Set(['player-ana', 'player-bea']),
    );
    expect(current.pointsByPlayer).toEqual(
      new Map([
        ['player-ana', 1100],
        ['player-bea', 0],
      ]),
    );
    expect(current.teamPoints.get('team-red')).toBe(550);
    expect(current.answers.get('player-ana')?.streakBonus).toBe(100);
    expect(current.answers.get('player-bea')?.streakBonus).toBe(0);
    expect(current.answers.get('player-ana')).toEqual(
      expect.objectContaining({
        answerId: 'answer-ana',
        phaseId: '5',
        receivedAt: 12_000,
        elapsedMs: 1_200,
        isCorrect: true,
        pointsAwarded: 1_100,
      }),
    );
    expect(current.voteOptions).toBeNull();

    const emptyLoad = buildService(loadResponder({ session: [] }));
    await expect(
      emptyLoad.service.loadLiveState(SESSION_ID, RANDOM),
    ).resolves.toBeNull();
    expect(emptyLoad.recordedQueries[0]?.sql).toContain(
      `"session"."status" IN ('lobby', 'running', 'paused')`,
    );
  });

  it('mints a truth option for Lie Detector votes on reload', async () => {
    const { service } = buildService(
      loadResponder({
        session: [
          sessionRow({
            cursor: {
              phase: 'reveal',
              roundIndex: 1,
              questionIndex: 0,
              roundCount: 2,
              phaseStartedAt: 50_000,
              deadline: null,
              extraTimeDeadline: null,
              pausedRemainingMs: null,
              pausedExtraTimeRemainingMs: null,
              isRestartRecovery: false,
              phaseCounter: 12,
            },
            question_log: [
              logEntry({
                questionId: 'question-lie',
                roundIndex: 1,
                questionIndex: 0,
                roundKind: 'lie_detector',
                type: 'prompt',
                eligibleCount: 3,
              }),
            ],
          }),
        ],
        players: [
          playerRow({ id: 'player-ana', joined_at: new Date(5_000) }),
          playerRow({ id: 'player-bea', joined_at: new Date(5_100) }),
          playerRow({
            id: 'player-caz',
            joined_at: new Date(5_200),
            has_used_joker: true,
            joker_round_index: 1,
          }),
        ],
        answers: [
          answerRow({
            id: 'answer-ana',
            player_id: 'player-ana',
            question_id: 'question-lie',
            payload: { type: 'prompt', text: 'Madonna' },
            points_awarded: 0,
            vote_option_id: 'option-ana',
          }),
          answerRow({
            id: 'answer-bea',
            player_id: 'player-bea',
            question_id: 'question-lie',
            payload: { type: 'prompt', text: 'Kylie' },
            points_awarded: 500,
            vote_option_id: 'option-bea',
          }),
        ],
        votes: [
          {
            voter_player_id: 'player-caz',
            question_id: 'question-lie',
            answer_id: null,
            created_at: new Date(45_000),
          },
          {
            voter_player_id: 'player-ana',
            question_id: 'question-lie',
            answer_id: 'answer-bea',
            created_at: new Date(45_100),
          },
          {
            voter_player_id: 'player-bea',
            question_id: 'question-lie',
            answer_id: null,
            created_at: new Date(45_200),
          },
        ],
      }),
    );

    const state = await service.loadLiveState(SESSION_ID, RANDOM);
    const current = state?.current ?? null;

    expect(current).not.toBeNull();
    if (current === null) return;
    expect(current.voteOptions).toEqual([
      {
        optionId: 'option-ana',
        answerId: 'answer-ana',
        authorPlayerId: 'player-ana',
        text: 'Madonna',
        isTruth: false,
      },
      {
        optionId: 'option-truth',
        answerId: null,
        authorPlayerId: null,
        text: 'Cher',
        isTruth: true,
      },
      {
        optionId: 'option-bea',
        answerId: 'answer-bea',
        authorPlayerId: 'player-bea',
        text: 'Kylie',
        isTruth: false,
      },
    ]);
    expect(current.votes.get('player-caz')).toEqual({
      voterPlayerId: 'player-caz',
      questionId: 'question-lie',
      optionId: 'option-truth',
      answerId: null,
      createdAt: 45_000,
    });
    expect(current.votes.get('player-bea')?.optionId).toBe('option-truth');
    expect(current.votes.get('player-ana')?.optionId).toBe('option-bea');
    expect(current.eligiblePlayerIds).toEqual(
      new Set(['player-ana', 'player-bea', 'player-caz']),
    );
    // Ana fooled nobody; Bea fooled Ana (500) and found the truth (1000);
    // Caz found the truth under her joker (2 x 1000).
    expect(current.pointsByPlayer).toEqual(
      new Map([
        ['player-ana', 0],
        ['player-bea', 1500],
        ['player-caz', 2000],
      ]),
    );
    expect(current.favouriteOptionId).toBeNull();
    // write (9), review (10), vote (11), reveal (12).
    expect(current.answers.get('player-ana')?.phaseId).toBe('9');
  });

  it('applies writes of one session in order and keeps going after a failure', async () => {
    const gate = createGate();
    const { service, recordedQueries } = buildService((sql) => {
      if (sql.includes('INSERT INTO "quizshow_players"')) {
        return gate.promise.then(() => []);
      }
      if (sql.includes('INSERT INTO "quizshow_teams"')) {
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }
      return [];
    });
    const state = lobbyState();

    service.enqueue(state, {
      type: 'insert_player',
      player: livePlayer('player-ana'),
    });
    service.enqueue(state, { type: 'insert_team', team: liveTeam('team-1') });
    service.enqueue(state, { type: 'checkpoint' });
    await settle();

    expect(recordedQueries).toHaveLength(1);
    expect(recordedQueries[0]?.sql).toContain('INSERT INTO "quizshow_players"');

    gate.release();
    await service.flush(SESSION_ID);

    expect(
      recordedQueries.map((query) => query.sql.split('(')[0]?.trim()),
    ).toEqual([
      'INSERT INTO "quizshow_players"',
      'INSERT INTO "quizshow_teams"',
      expect.stringContaining('UPDATE "quizshow_sessions"'),
    ]);
    expect(loggerErrorSpy).toHaveBeenCalledTimes(1);
    expect(loggerErrorSpy).toHaveBeenCalledWith(
      'Pulse Live write insert_team failed for session session-1 (23505)',
    );
  });

  it('logs a failed write with its type and code and without the error text', async () => {
    const leakingMessage =
      'Key (session_id, lower(name))=(session-1, the divas) already exists, screen name Ana Banana';
    const { service } = buildService((sql) => {
      if (sql.includes('INSERT INTO "quizshow_players"')) {
        throw Object.assign(new Error(leakingMessage), {
          driverError: { code: '23505', detail: leakingMessage },
        });
      }
      if (sql.includes('INSERT INTO "quizshow_answers"')) {
        throw new TypeError(leakingMessage);
      }
      return [];
    });
    const state = lobbyState();

    service.enqueue(state, {
      type: 'insert_player',
      player: livePlayer('player-ana'),
    });
    service.enqueue(state, {
      type: 'insert_answer',
      answer: {
        answerId: 'answer-1',
        playerId: 'player-ana',
        questionId: 'question-lie',
        phaseId: '3',
        payload: { type: 'prompt', text: 'Ana Banana' },
        receivedAt: 12_000,
        elapsedMs: null,
        isCorrect: null,
        correctPositions: null,
        pointsAwarded: 0,
        streakBonus: 0,
        voteOptionId: null,
        hiddenAt: null,
      },
    });
    await service.flush(SESSION_ID);

    expect(loggerErrorSpy.mock.calls).toEqual([
      ['Pulse Live write insert_player failed for session session-1 (23505)'],
      [
        'Pulse Live write insert_answer failed for session session-1 (TypeError)',
      ],
    ]);
    const loggedText = JSON.stringify(loggerErrorSpy.mock.calls);
    expect(loggedText).not.toContain('Ana Banana');
    expect(loggedText).not.toContain('the divas');
  });

  it('captures the cursor at enqueue time for a checkpoint', async () => {
    const gate = createGate();
    const { service, recordedQueries } = buildService((sql) => {
      if (sql.includes('INSERT INTO "quizshow_players"')) {
        return gate.promise.then(() => []);
      }
      return [];
    });
    const state = lobbyState();

    service.enqueue(state, {
      type: 'insert_player',
      player: livePlayer('player-ana'),
    });
    service.enqueue(state, { type: 'checkpoint' });
    state.status = 'paused';
    state.cursor = { ...state.cursor, phase: 'round_intro', roundIndex: 0 };
    state.phaseCounter = 4;
    state.pausedAt = 90_000;
    state.lastHostCommandAt = 90_000;
    state.questionLog.push(logEntry({ questionId: 'question-choice' }));
    gate.release();
    await service.flush(SESSION_ID);

    const checkpoint = recordedQueries.find((query) =>
      query.sql.includes('UPDATE "quizshow_sessions"'),
    );
    expect(checkpoint?.sql).toContain(
      `AND "status" IN ('lobby', 'running', 'paused')`,
    );
    const [
      sessionId,
      status,
      cursorJson,
      questionLogJson,
      pausedAt,
      lastHostCommandAt,
    ] = checkpoint?.params ?? [];
    expect(sessionId).toBe(SESSION_ID);
    expect(status).toBe('lobby');
    expect(JSON.parse(String(cursorJson))).toEqual({
      phase: 'lobby',
      roundIndex: null,
      questionIndex: null,
      roundCount: 3,
      phaseStartedAt: null,
      deadline: null,
      extraTimeDeadline: null,
      pausedRemainingMs: null,
      pausedExtraTimeRemainingMs: null,
      isRestartRecovery: false,
      phaseCounter: 0,
    });
    expect(JSON.parse(String(questionLogJson))).toEqual([]);
    expect(pausedAt).toBeNull();
    expect(lastHostCommandAt).toEqual(new Date(STARTED_AT));
  });

  it('writes the results and the recap in one transaction', async () => {
    const endedAt = 120_000;
    jest.spyOn(Date, 'now').mockReturnValue(999_999);
    const { service, recordedQueries, dataSource } = buildService((sql) => {
      if (sql.includes('WITH "finished" AS (')) return [{ id: SESSION_ID }];
      if (sql.includes('GROUP BY "answer"."question_id"')) {
        return [
          {
            question_id: 'question-choice',
            answer_count: 3,
            correct_count: 2,
            average_elapsed_ms: 1500.4,
          },
          {
            question_id: 'question-order',
            answer_count: 1,
            correct_count: 0,
            average_elapsed_ms: 900,
          },
          {
            question_id: 'question-lie',
            answer_count: 3,
            correct_count: 0,
            average_elapsed_ms: null,
          },
        ];
      }
      return [];
    });
    const state = lobbyState();
    state.status = 'finished';
    state.phaseCounter = 20;
    state.cursor = {
      ...state.cursor,
      phaseId: '20',
      status: 'finished',
      phase: 'ended',
      phaseStartedAt: endedAt,
    };
    state.questionLog.push(
      logEntry({ questionId: 'question-choice', eligibleCount: 4 }),
      logEntry({
        questionId: 'question-order',
        questionIndex: 1,
        type: 'order',
        eligibleCount: 3,
        revealedAt: null,
        wasSkipped: true,
      }),
      logEntry({
        questionId: 'question-lie',
        roundIndex: 1,
        roundKind: 'lie_detector',
        type: 'prompt',
        eligibleCount: 3,
      }),
    );
    const podium = [
      {
        place: 1 as const,
        kind: 'player' as const,
        entrantId: 'player-ana',
        score: 2_100,
      },
    ];

    service.enqueue(state, {
      type: 'finish',
      podium,
      placings: { 'player-ana': 1, 'player-bea': 2 },
    });
    await service.flush(SESSION_ID);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(recordedQueries).toHaveLength(3);
    expect(
      recordedQueries.every((query) => query.transactionNumber === 1),
    ).toBe(true);
    const [finishUpdate, aggregate, resultsInsert] = recordedQueries;
    expect(finishUpdate?.sql).toContain(`SET "status" = 'finished'`);
    expect(finishUpdate?.params[0]).toBe(SESSION_ID);
    expect(finishUpdate?.params[1]).toEqual(new Date(endedAt));
    expect(JSON.parse(String(finishUpdate?.params[2]))).toEqual(
      expect.objectContaining({ phase: 'ended', phaseCounter: 20 }),
    );
    expect(JSON.parse(String(finishUpdate?.params[3]))).toHaveLength(3);
    expect(aggregate?.sql).toContain('FROM "quizshow_answers" "answer"');
    expect(resultsInsert?.sql).toContain('INSERT INTO "quizshow_results"');
    expect(resultsInsert?.params[0]).toBe(SESSION_ID);
    expect(JSON.parse(String(resultsInsert?.params[1]))).toEqual(podium);
    expect(JSON.parse(String(resultsInsert?.params[2]))).toEqual({
      'player-ana': 1,
      'player-bea': 2,
    });
    expect(JSON.parse(String(resultsInsert?.params[3]))).toEqual({
      questionsPlayed: 2,
      answersGiven: 7,
      questions: [
        {
          roundIndex: 0,
          questionIndex: 0,
          roundKind: 'quiz',
          type: 'multiple_choice',
          prompt: { en: 'Who sang Believe?', pt: 'Quem cantou Believe?' },
          answerCount: 3,
          percentCorrect: Math.round((100 * 2) / 4),
          averageAnswerMs: 1500,
          wasSkipped: false,
        },
        {
          roundIndex: 0,
          questionIndex: 1,
          roundKind: 'quiz',
          type: 'order',
          prompt: { en: 'Order the decades', pt: 'Ordena as décadas' },
          answerCount: 1,
          percentCorrect: null,
          averageAnswerMs: null,
          wasSkipped: true,
        },
        {
          roundIndex: 1,
          questionIndex: 0,
          roundKind: 'lie_detector',
          type: 'prompt',
          prompt: {
            en: 'Who is the goddess of pop?',
            pt: 'Quem é a deusa da pop?',
          },
          answerCount: 3,
          percentCorrect: null,
          averageAnswerMs: null,
          wasSkipped: false,
        },
      ],
    });
  });

  it('deletes kept results and every row that names a player', async () => {
    const { service } = buildService();
    const managerQueries: RecordedQuery[] = [];
    const manager = {
      query: jest.fn((sql: string, params: unknown[]) => {
        managerQueries.push({ sql, params, transactionNumber: null });
        return Promise.resolve([]);
      }),
    };

    await service.deleteKeptResults(
      manager as unknown as EntityManager,
      SESSION_ID,
    );

    expect(managerQueries.map((query) => query.sql)).toEqual([
      'DELETE FROM "quizshow_votes" WHERE "session_id" = $1',
      'DELETE FROM "quizshow_answers" WHERE "session_id" = $1',
      'DELETE FROM "quizshow_players" WHERE "session_id" = $1',
      'DELETE FROM "quizshow_teams" WHERE "session_id" = $1',
      'DELETE FROM "quizshow_results" WHERE "session_id" = $1',
      'UPDATE "quizshow_sessions" SET "results_kept" = false WHERE "id" = $1',
    ]);
    for (const query of managerQueries) {
      expect(query.params).toEqual([SESSION_ID]);
    }
  });

  it('rebuilds the host favourite of a Caption This question from the stored points', async () => {
    const { service } = buildService(
      loadResponder({
        session: [
          sessionRow({
            cursor: {
              phase: 'reveal',
              roundIndex: 2,
              questionIndex: 0,
              roundCount: 3,
              phaseStartedAt: 60_000,
              deadline: null,
              extraTimeDeadline: null,
              pausedRemainingMs: null,
              pausedExtraTimeRemainingMs: null,
              isRestartRecovery: false,
              phaseCounter: 15,
            },
            question_log: [
              logEntry({
                questionId: 'question-caption',
                roundIndex: 2,
                questionIndex: 0,
                roundKind: 'caption_this',
                type: 'prompt',
                eligibleCount: 3,
              }),
            ],
          }),
        ],
        players: [
          playerRow({ id: 'player-ana', joined_at: new Date(5_000) }),
          playerRow({
            id: 'player-bea',
            joined_at: new Date(5_100),
            has_used_joker: true,
            joker_round_index: 2,
          }),
          playerRow({ id: 'player-caz', joined_at: new Date(5_200) }),
        ],
        answers: [
          answerRow({
            id: 'answer-ana',
            player_id: 'player-ana',
            question_id: 'question-caption',
            payload: { type: 'prompt', text: 'Serving looks' },
            points_awarded: 500,
            vote_option_id: 'option-ana',
          }),
          answerRow({
            id: 'answer-bea',
            player_id: 'player-bea',
            question_id: 'question-caption',
            payload: { type: 'prompt', text: 'Mother has arrived' },
            points_awarded: 1500,
            vote_option_id: 'option-bea',
          }),
        ],
        votes: [
          {
            voter_player_id: 'player-caz',
            question_id: 'question-caption',
            answer_id: 'answer-ana',
            created_at: new Date(55_000),
          },
          {
            voter_player_id: 'player-bea',
            question_id: 'question-caption',
            answer_id: 'answer-ana',
            created_at: new Date(55_100),
          },
          {
            voter_player_id: 'player-ana',
            question_id: 'question-caption',
            answer_id: 'answer-bea',
            created_at: new Date(55_200),
          },
        ],
      }),
    );

    const state = await service.loadLiveState(SESSION_ID, RANDOM);
    const current = state?.current ?? null;

    expect(current).not.toBeNull();
    if (current === null) return;
    // Bea: (250 for one vote + 500 favourite) x 2 under her joker = 1500.
    // Ana: 250 for each of two votes = 500, no favourite.
    expect(current.favouriteOptionId).toBe('option-bea');
    expect(current.pointsByPlayer).toEqual(
      new Map([
        ['player-ana', 500],
        ['player-bea', 1500],
        ['player-caz', 0],
      ]),
    );
    expect(current.voteOptions?.some((option) => option.isTruth)).toBe(false);
  });

  it('marks a session paused in a question phase for a replay on reload', async () => {
    const pausedCursor = {
      phase: 'open',
      roundIndex: 0,
      questionIndex: 0,
      roundCount: 3,
      phaseStartedAt: 20_000,
      deadline: null,
      extraTimeDeadline: null,
      pausedRemainingMs: 9_000,
      pausedExtraTimeRemainingMs: null,
      isRestartRecovery: false,
      phaseCounter: 4,
    };
    const pausedInOpen = buildService(
      loadResponder({
        session: [
          sessionRow({
            status: 'paused',
            paused_at: new Date(25_000),
            cursor: pausedCursor,
          }),
        ],
      }),
    );
    const pausedInLeaderboard = buildService(
      loadResponder({
        session: [
          sessionRow({
            status: 'paused',
            paused_at: new Date(25_000),
            cursor: {
              ...pausedCursor,
              phase: 'leaderboard',
              questionIndex: null,
              pausedRemainingMs: null,
            },
          }),
        ],
      }),
    );

    const openState = await pausedInOpen.service.loadLiveState(
      SESSION_ID,
      RANDOM,
    );
    const leaderboardState = await pausedInLeaderboard.service.loadLiveState(
      SESSION_ID,
      RANDOM,
    );

    expect(openState?.cursor.isRestartRecovery).toBe(true);
    expect(openState?.cursor.status).toBe('paused');
    expect(openState?.pausedAt).toBe(25_000);
    expect(openState?.current).toBeNull();
    expect(leaderboardState?.cursor.isRestartRecovery).toBe(false);
  });

  it('skips the closing checkpoint so the abandon write sets ended_at', async () => {
    const { service, recordedQueries } = buildService();
    const state = lobbyState();
    state.status = 'abandoned';
    state.phaseCounter = 1;
    state.cursor = {
      ...state.cursor,
      phaseId: '1',
      status: 'abandoned',
      phase: 'ended',
      phaseStartedAt: 70_000,
    };
    jest.spyOn(Date, 'now').mockReturnValue(999_999);

    service.enqueue(state, { type: 'checkpoint' });
    service.enqueue(state, { type: 'abandon' });
    await service.flush(SESSION_ID);

    expect(recordedQueries).toHaveLength(1);
    const [abandonWrite] = recordedQueries;
    expect(abandonWrite?.sql).toContain(`SET "status" = 'abandoned'`);
    expect(abandonWrite?.sql).toContain('"paused_at" = NULL');
    expect(abandonWrite?.sql).toContain('"question_log" = $4::jsonb');
    expect(abandonWrite?.params[0]).toBe(SESSION_ID);
    expect(abandonWrite?.params[1]).toEqual(new Date(70_000));
    expect(JSON.parse(String(abandonWrite?.params[2]))).toEqual(
      expect.objectContaining({ phase: 'ended', phaseCounter: 1 }),
    );
    expect(JSON.parse(String(abandonWrite?.params[3]))).toEqual([]);
  });

  it('writes no results row when the session is no longer open', async () => {
    const { service, recordedQueries } = buildService(() => []);
    const state = lobbyState();
    state.status = 'finished';
    state.cursor = {
      ...state.cursor,
      status: 'finished',
      phase: 'ended',
      phaseStartedAt: 80_000,
    };

    service.enqueue(state, {
      type: 'finish',
      podium: [],
      placings: {},
    });
    await service.flush(SESSION_ID);

    expect(recordedQueries).toHaveLength(1);
    expect(recordedQueries[0]?.sql).toContain('WITH "finished" AS (');
    expect(
      recordedQueries.some((query) =>
        query.sql.includes('INSERT INTO "quizshow_results"'),
      ),
    ).toBe(false);
  });

  it('abandons an unloaded session at the ended phase', async () => {
    const { service, recordedQueries } = buildService();
    const now = new Date('2026-10-19T23:00:00.000Z');

    await service.markAbandoned(SESSION_ID, now);

    expect(recordedQueries).toHaveLength(1);
    const [abandonWrite] = recordedQueries;
    expect(abandonWrite?.params).toEqual([SESSION_ID, now, now.getTime()]);
    expect(abandonWrite?.sql).toContain(`SET "status" = 'abandoned'`);
    expect(abandonWrite?.sql).toContain('"ended_at" = $2');
    expect(abandonWrite?.sql).toContain(`'phase', 'ended'`);
    expect(abandonWrite?.sql).toContain(
      `AND "status" IN ('lobby', 'running', 'paused')`,
    );
  });

  it('finds open sessions idle for two hours by their last host command', async () => {
    const { service, recordedQueries } = buildService(() => [
      { id: 'session-idle' },
    ]);
    const now = new Date('2026-10-19T23:00:00.000Z');

    const sessionIds = await service.findIdleOpenSessionIds(now);

    expect(sessionIds).toEqual(['session-idle']);
    expect(recordedQueries[0]?.params).toEqual([
      new Date(now.getTime() - 7_200_000),
    ]);
    expect(recordedQueries[0]?.sql).toContain(
      '"session"."last_host_command_at" <= $1',
    );
    expect(recordedQueries[0]?.sql).toContain(
      `"session"."status" IN ('lobby', 'running', 'paused')`,
    );
  });

  it('finds no open sessions for an empty event list without a query', async () => {
    const { service, dataSource } = buildService();

    await expect(service.findOpenSessionIdsForEvents([])).resolves.toEqual([]);
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('rebuilds team points with a member removed before reveal', async () => {
    const { service } = buildService(
      loadResponder({
        session: [
          sessionRow({
            play_mode: 'teams',
            cursor: {
              phase: 'reveal',
              roundIndex: 0,
              questionIndex: 0,
              roundCount: 3,
              phaseStartedAt: 30_000,
              deadline: null,
              extraTimeDeadline: null,
              pausedRemainingMs: null,
              pausedExtraTimeRemainingMs: null,
              isRestartRecovery: false,
              phaseCounter: 6,
            },
            question_log: [
              logEntry({
                questionId: 'question-choice',
                openedAt: 10_000,
                revealedAt: 30_000,
              }),
            ],
          }),
        ],
        players: [
          playerRow({
            id: 'player-x',
            team_id: 'team-red',
            score: 1100,
            streak: 1,
            joined_at: new Date(5_000),
          }),
          playerRow({
            id: 'player-y',
            team_id: 'team-red',
            joined_at: new Date(5_000),
            removed_at: new Date(20_000),
          }),
        ],
        teams: [
          {
            id: 'team-red',
            name: 'Red',
            color_key: 'heart',
            score: 550,
            has_used_joker: false,
            joker_round_index: null,
            created_at: new Date(3_000),
          },
        ],
        answers: [
          answerRow({
            id: 'answer-x',
            player_id: 'player-x',
            question_id: 'question-choice',
            payload: { type: 'multiple_choice', optionIndex: 0 },
            elapsed_ms: 1_200,
            is_correct: true,
            points_awarded: 1_100,
          }),
        ],
      }),
    );

    const state = await service.loadLiveState(SESSION_ID, RANDOM);
    const current = state?.current ?? null;

    expect(current).not.toBeNull();
    if (current === null) return;
    // Engine: X and Y opened the question; Y was removed before the reveal,
    // so only X scores, and Y stays in the team divisor at 0: 1100 / 2.
    expect(current.eligiblePlayerIds).toEqual(
      new Set(['player-x', 'player-y']),
    );
    expect(current.pointsByPlayer).toEqual(new Map([['player-x', 1100]]));
    expect(current.teamPoints).toEqual(new Map([['team-red', 550]]));
  });

  it("infers the favourite when a removed voter's vote is dropped", async () => {
    const { service } = buildService(
      loadResponder({
        session: [
          sessionRow({
            cursor: {
              phase: 'reveal',
              roundIndex: 2,
              questionIndex: 0,
              roundCount: 3,
              phaseStartedAt: 58_000,
              deadline: null,
              extraTimeDeadline: null,
              pausedRemainingMs: null,
              pausedExtraTimeRemainingMs: null,
              isRestartRecovery: false,
              phaseCounter: 15,
            },
            question_log: [
              logEntry({
                questionId: 'question-caption',
                roundIndex: 2,
                questionIndex: 0,
                roundKind: 'caption_this',
                type: 'prompt',
                eligibleCount: 3,
                revealedAt: 58_000,
              }),
            ],
          }),
        ],
        players: [
          playerRow({ id: 'player-ana', joined_at: new Date(5_000) }),
          playerRow({ id: 'player-bea', joined_at: new Date(5_100) }),
          playerRow({
            id: 'player-caz',
            joined_at: new Date(5_200),
            removed_at: new Date(57_000),
          }),
        ],
        answers: [
          answerRow({
            id: 'answer-ana',
            player_id: 'player-ana',
            question_id: 'question-caption',
            payload: { type: 'prompt', text: 'Serving looks' },
            points_awarded: 750,
            vote_option_id: 'option-ana',
          }),
          answerRow({
            id: 'answer-bea',
            player_id: 'player-bea',
            question_id: 'question-caption',
            payload: { type: 'prompt', text: 'Mother has arrived' },
            points_awarded: 250,
            vote_option_id: 'option-bea',
          }),
        ],
        votes: [
          {
            voter_player_id: 'player-caz',
            question_id: 'question-caption',
            answer_id: 'answer-ana',
            created_at: new Date(55_000),
          },
          {
            voter_player_id: 'player-bea',
            question_id: 'question-caption',
            answer_id: 'answer-ana',
            created_at: new Date(55_100),
          },
          {
            voter_player_id: 'player-ana',
            question_id: 'question-caption',
            answer_id: 'answer-bea',
            created_at: new Date(55_200),
          },
        ],
      }),
    );

    const state = await service.loadLiveState(SESSION_ID, RANDOM);
    const current = state?.current ?? null;

    expect(current).not.toBeNull();
    if (current === null) return;
    // Engine: Caz was removed before the reveal, so only Bea's vote counts
    // for Ana: 250 plus the 500 favourite gives the stored 750. Counting
    // Caz's vote too would leave 250 above the vote points and no match.
    expect(current.favouriteOptionId).toBe('option-ana');
    expect(current.pointsByPlayer).toEqual(
      new Map([
        ['player-ana', 750],
        ['player-bea', 250],
      ]),
    );
    expect(current.votes.get('player-caz')?.optionId).toBe('option-ana');
  });

  it('a running row loaded in a question phase comes back paused for recovery', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(77_000);
    const runningCursor = {
      phase: 'open',
      roundIndex: 0,
      questionIndex: 0,
      roundCount: 3,
      phaseStartedAt: 20_000,
      deadline: 40_000,
      extraTimeDeadline: 50_000,
      pausedRemainingMs: null,
      pausedExtraTimeRemainingMs: null,
      isRestartRecovery: false,
      phaseCounter: 4,
    };
    const runningInOpen = buildService(
      loadResponder({
        session: [sessionRow({ status: 'running', cursor: runningCursor })],
      }),
    );
    const runningInLeaderboard = buildService(
      loadResponder({
        session: [
          sessionRow({
            status: 'running',
            cursor: {
              ...runningCursor,
              phase: 'leaderboard',
              questionIndex: null,
              deadline: null,
              extraTimeDeadline: null,
            },
          }),
        ],
      }),
    );

    const openState = await runningInOpen.service.loadLiveState(
      SESSION_ID,
      RANDOM,
    );
    const leaderboardState = await runningInLeaderboard.service.loadLiveState(
      SESSION_ID,
      RANDOM,
    );

    expect(openState?.status).toBe('paused');
    expect(openState?.cursor).toEqual(
      expect.objectContaining({
        status: 'paused',
        phase: 'open',
        phaseId: '4',
        deadline: null,
        extraTimeDeadline: null,
        pausedRemainingMs: null,
        pausedExtraTimeRemainingMs: null,
        isRestartRecovery: true,
      }),
    );
    expect(openState?.pausedAt).toBe(77_000);
    expect(openState?.current).toBeNull();

    await runningInOpen.service.flush(SESSION_ID);
    const checkpoint = runningInOpen.recordedQueries.find((query) =>
      query.sql.includes('UPDATE "quizshow_sessions"'),
    );
    expect(checkpoint).toBeDefined();
    const [sessionId, status, cursorJson, , pausedAt] =
      checkpoint?.params ?? [];
    expect(sessionId).toBe(SESSION_ID);
    expect(status).toBe('paused');
    expect(JSON.parse(String(cursorJson))).toEqual(
      expect.objectContaining({
        phase: 'open',
        deadline: null,
        extraTimeDeadline: null,
        isRestartRecovery: true,
        phaseCounter: 4,
      }),
    );
    expect(pausedAt).toEqual(new Date(77_000));

    expect(leaderboardState?.status).toBe('running');
    expect(leaderboardState?.cursor.isRestartRecovery).toBe(false);
    expect(leaderboardState?.pausedAt).toBeNull();
    await runningInLeaderboard.service.flush(SESSION_ID);
    expect(
      runningInLeaderboard.recordedQueries.some((query) =>
        query.sql.includes('UPDATE "quizshow_sessions"'),
      ),
    ).toBe(false);
  });

  it("one command's writes commit together or not at all", async () => {
    const { service, dataSource, recordedQueries } = buildService((sql) => {
      if (sql.includes('UPDATE "quizshow_sessions"')) {
        throw Object.assign(new Error('could not serialize access'), {
          code: '40001',
        });
      }
      return [];
    });
    const state = lobbyState();
    state.status = 'running';

    service.enqueueBatch(state, [
      {
        type: 'save_scoring',
        questionId: 'question-choice',
        answers: [
          { answerId: 'answer-ana', isCorrect: true, pointsAwarded: 1_100 },
        ],
        players: [{ playerId: 'player-ana', score: 1_100, streak: 1 }],
        teams: [],
      },
      {
        type: 'set_answer_hidden',
        answerId: 'answer-ana',
        hiddenAt: 30_000,
        hiddenByUserId: 'host-user',
      },
      { type: 'checkpoint' },
    ]);
    await service.flush(SESSION_ID);

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(dataSource.query).not.toHaveBeenCalled();
    expect(
      recordedQueries.map((query) => query.sql.split('SET')[0]?.trim()),
    ).toEqual([
      'UPDATE "quizshow_answers" "answer"',
      'UPDATE "quizshow_players" "player"',
      'UPDATE "quizshow_answers"',
      'UPDATE "quizshow_sessions"',
    ]);
    expect(
      recordedQueries.every((query) => query.transactionNumber === 1),
    ).toBe(true);
    // The failure leaves the transaction callback, so Postgres rolls the
    // scoring and the hide back with the checkpoint.
    const transactionResult = dataSource.transaction.mock.results[0]
      ?.value as Promise<unknown>;
    await expect(transactionResult).rejects.toMatchObject({ code: '40001' });
    expect(loggerErrorSpy.mock.calls).toEqual([
      [
        'Pulse Live write save_scoring+set_answer_hidden+checkpoint failed for session session-1 (40001)',
      ],
    ]);

    service.enqueueBatch(state, [
      { type: 'insert_team', team: liveTeam('team-1') },
    ]);
    await service.flush(SESSION_ID);
    expect(dataSource.query).toHaveBeenCalledTimes(1);
    expect(recordedQueries[recordedQueries.length - 1]).toEqual(
      expect.objectContaining({ transactionNumber: null }),
    );
  });

  it('shutdown flush waits for every session queue', async () => {
    const gate = createGate();
    const { service, recordedQueries } = buildService((sql) => {
      if (sql.includes('INSERT INTO "quizshow_players"')) {
        return gate.promise.then(() => []);
      }
      return [];
    });
    const firstState = lobbyState();
    const secondState = lobbyState();
    secondState.sessionId = 'session-2';
    let isFlushed = false;

    service.enqueue(firstState, {
      type: 'insert_player',
      player: livePlayer('player-ana'),
    });
    service.enqueue(secondState, { type: 'checkpoint' });
    const flushing = service.flushAll().then(() => {
      isFlushed = true;
    });
    await settle();
    expect(isFlushed).toBe(false);

    gate.release();
    await flushing;
    expect(isFlushed).toBe(true);
    expect(recordedQueries).toHaveLength(2);
  });

  it('the recap skips a question that never reached reveal', () => {
    const recap = buildQuizshowRecap(
      [
        {
          entry: logEntry({ questionId: 'question-choice', eligibleCount: 2 }),
          prompt: { en: 'Who sang Believe?', pt: 'Quem cantou Believe?' },
        },
        {
          entry: logEntry({
            questionId: 'question-order',
            questionIndex: 1,
            type: 'order',
            eligibleCount: 2,
            revealedAt: null,
            wasSkipped: false,
          }),
          prompt: { en: 'Order the decades', pt: 'Ordena as décadas' },
        },
      ],
      [
        {
          question_id: 'question-choice',
          answer_count: 2,
          correct_count: 1,
          average_elapsed_ms: 1_000,
        },
        {
          question_id: 'question-order',
          answer_count: 1,
          correct_count: 0,
          average_elapsed_ms: 800,
        },
      ],
    );

    expect(recap.questionsPlayed).toBe(1);
    expect(recap.answersGiven).toBe(3);
    expect(recap.questions[0]).toEqual(
      expect.objectContaining({
        percentCorrect: 50,
        averageAnswerMs: 1_000,
        wasSkipped: false,
      }),
    );
    expect(recap.questions[1]).toEqual(
      expect.objectContaining({
        answerCount: 1,
        percentCorrect: null,
        averageAnswerMs: null,
        wasSkipped: true,
      }),
    );
  });

  it('a reload in reveal keeps the count-up base', async () => {
    const revealCursor = {
      phase: 'reveal',
      roundIndex: 0,
      questionIndex: 0,
      roundCount: 3,
      phaseStartedAt: 30_000,
      deadline: null,
      extraTimeDeadline: null,
      pausedRemainingMs: null,
      pausedExtraTimeRemainingMs: null,
      isRestartRecovery: false,
      phaseCounter: 6,
    };
    const choiceAnswer = answerRow({
      id: 'answer-ana',
      player_id: 'player-ana',
      question_id: 'question-choice',
      payload: { type: 'multiple_choice', optionIndex: 0 },
      elapsed_ms: 1_200,
      is_correct: true,
      points_awarded: 1_100,
    });
    const soloLoad = buildService(
      loadResponder({
        session: [
          sessionRow({
            cursor: revealCursor,
            question_log: [logEntry({ questionId: 'question-choice' })],
          }),
        ],
        players: [
          playerRow({ id: 'player-ana', score: 2_100, streak: 1 }),
          playerRow({ id: 'player-bea', score: 500 }),
        ],
        answers: [choiceAnswer],
      }),
    );
    const teamsLoad = buildService(
      loadResponder({
        session: [
          sessionRow({
            play_mode: 'teams',
            cursor: revealCursor,
            question_log: [logEntry({ questionId: 'question-choice' })],
          }),
        ],
        players: [
          playerRow({
            id: 'player-ana',
            team_id: 'team-red',
            score: 2_100,
            streak: 1,
          }),
          playerRow({ id: 'player-bea', team_id: 'team-red', score: 500 }),
        ],
        teams: [
          {
            id: 'team-red',
            name: 'Red',
            color_key: 'heart',
            score: 1_550,
            has_used_joker: false,
            joker_round_index: null,
            created_at: new Date(3_000),
          },
        ],
        answers: [choiceAnswer],
      }),
    );

    const soloState = await soloLoad.service.loadLiveState(SESSION_ID, RANDOM);
    const teamsState = await teamsLoad.service.loadLiveState(
      SESSION_ID,
      RANDOM,
    );

    expect(soloState?.current?.pointsByPlayer.get('player-ana')).toBe(1_100);
    expect(soloState?.scoresAtLastFrame).toEqual(
      new Map([
        ['player-ana', 1_000],
        ['player-bea', 500],
      ]),
    );
    expect(soloState?.players.get('player-ana')?.score).toBe(2_100);
    // Ana's 1100 over a team of two is 550 for the team.
    expect(teamsState?.current?.teamPoints.get('team-red')).toBe(550);
    expect(teamsState?.scoresAtLastFrame).toEqual(
      new Map([['team-red', 1_000]]),
    );
    expect(teamsState?.teams.get('team-red')?.score).toBe(1_550);
  });

  it('a reload in scores keeps the count-up base', async () => {
    const scoresCursor = {
      phase: 'scores',
      roundIndex: 0,
      questionIndex: 0,
      roundCount: 3,
      phaseStartedAt: 31_000,
      deadline: null,
      extraTimeDeadline: null,
      pausedRemainingMs: null,
      pausedExtraTimeRemainingMs: null,
      isRestartRecovery: false,
      phaseCounter: 7,
    };
    const choiceAnswer = answerRow({
      id: 'answer-ana',
      player_id: 'player-ana',
      question_id: 'question-choice',
      payload: { type: 'multiple_choice', optionIndex: 0 },
      elapsed_ms: 1_200,
      is_correct: true,
      points_awarded: 1_100,
    });
    const soloLoad = buildService(
      loadResponder({
        session: [
          sessionRow({
            cursor: scoresCursor,
            question_log: [logEntry({ questionId: 'question-choice' })],
          }),
        ],
        players: [
          playerRow({ id: 'player-ana', score: 2_100, streak: 1 }),
          playerRow({ id: 'player-bea', score: 500 }),
        ],
        answers: [choiceAnswer],
      }),
    );
    const teamsLoad = buildService(
      loadResponder({
        session: [
          sessionRow({
            play_mode: 'teams',
            cursor: scoresCursor,
            question_log: [logEntry({ questionId: 'question-choice' })],
          }),
        ],
        players: [
          playerRow({
            id: 'player-ana',
            team_id: 'team-red',
            score: 2_100,
            streak: 1,
          }),
          playerRow({ id: 'player-bea', team_id: 'team-red', score: 500 }),
        ],
        teams: [
          {
            id: 'team-red',
            name: 'Red',
            color_key: 'heart',
            score: 1_550,
            has_used_joker: false,
            joker_round_index: null,
            created_at: new Date(3_000),
          },
        ],
        answers: [choiceAnswer],
      }),
    );

    const soloState = await soloLoad.service.loadLiveState(SESSION_ID, RANDOM);
    const teamsState = await teamsLoad.service.loadLiveState(
      SESSION_ID,
      RANDOM,
    );

    // The scores frame on show re-sends counting up from the totals before
    // the question; the next frame starts from the totals it shows.
    expect(soloState?.lastScoresFrame).toEqual({
      phaseId: '7',
      scope: 'question',
      previousByEntrant: new Map([
        ['player-ana', 1_000],
        ['player-bea', 500],
      ]),
    });
    expect(soloState?.scoresAtLastFrame).toEqual(
      new Map([
        ['player-ana', 2_100],
        ['player-bea', 500],
      ]),
    );
    expect(teamsState?.current?.teamPoints.get('team-red')).toBe(550);
    expect(teamsState?.lastScoresFrame?.previousByEntrant).toEqual(
      new Map([['team-red', 1_000]]),
    );
    expect(teamsState?.scoresAtLastFrame).toEqual(
      new Map([['team-red', 1_550]]),
    );
  });

  it('a Lie Detector reload keeps the truth with no fakes', async () => {
    const { service } = buildService(
      loadResponder({
        session: [
          sessionRow({
            cursor: {
              phase: 'reveal',
              roundIndex: 1,
              questionIndex: 0,
              roundCount: 3,
              phaseStartedAt: 50_000,
              deadline: null,
              extraTimeDeadline: null,
              pausedRemainingMs: null,
              pausedExtraTimeRemainingMs: null,
              isRestartRecovery: false,
              phaseCounter: 10,
            },
            question_log: [
              logEntry({
                questionId: 'question-lie',
                roundIndex: 1,
                questionIndex: 0,
                roundKind: 'lie_detector',
                type: 'prompt',
                eligibleCount: 1,
              }),
            ],
          }),
        ],
        players: [playerRow({ id: 'player-ana' })],
        answers: [],
        votes: [],
      }),
    );

    const state = await service.loadLiveState(SESSION_ID, RANDOM);

    expect(state?.current?.voteOptions).toEqual([
      {
        optionId: 'option-truth',
        answerId: null,
        authorPlayerId: null,
        text: 'Cher',
        isTruth: true,
      },
    ]);
    expect(state?.current?.votes.size).toBe(0);
    expect(state?.current?.pointsByPlayer).toEqual(
      new Map([['player-ana', 0]]),
    );
  });

  it('the idle check of one session queries that session id only', async () => {
    const idleService = buildService(() => [{ id: SESSION_ID }]);
    const activeService = buildService(() => []);
    const now = new Date('2026-10-19T23:00:00.000Z');

    await expect(
      idleService.service.isOpenSessionIdle(SESSION_ID, now),
    ).resolves.toBe(true);
    await expect(
      activeService.service.isOpenSessionIdle(SESSION_ID, now),
    ).resolves.toBe(false);

    expect(idleService.recordedQueries).toHaveLength(1);
    const [idleQuery] = idleService.recordedQueries;
    expect(idleQuery?.params).toEqual([
      SESSION_ID,
      new Date(now.getTime() - 7_200_000),
    ]);
    expect(idleQuery?.sql).toContain('"session"."id" = $1');
    expect(idleQuery?.sql).toContain('"session"."last_host_command_at" <= $2');
    expect(idleQuery?.sql).toContain(
      `"session"."status" IN ('lobby', 'running', 'paused')`,
    );
    expect(idleQuery?.sql).not.toContain('ORDER BY');
  });
});
