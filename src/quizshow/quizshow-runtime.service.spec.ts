import { Logger } from '@nestjs/common';
import type { Namespace, Socket } from 'socket.io';
import type {
  QuizshowAnswerPayload,
  QuizshowHostVoteOptions,
  QuizshowLobby,
  QuizshowHostLobby,
  QuizshowMyReveal,
  QuizshowMyScores,
  QuizshowPhaseChangeFrame,
  QuizshowRoundKind,
  QuizshowSessionEnd,
  QuizshowVoteOptions,
} from './quizshow.contract';
import {
  hostAddTime,
  hostEnd,
  hostNext,
  hostPause,
  hostRemovePlayer,
  hostReveal,
  hostStart,
  timerElapsed,
} from './quizshow-engine-phases';
import { joinLobby, submitAnswer, submitVote } from './quizshow-engine-players';
import { createLobbyState, succeed } from './quizshow-engine-state';
import type {
  QuizshowLiveQuestionPlay,
  QuizshowLiveState,
  QuizshowPersistOperation,
} from './quizshow-engine-types';
import {
  quizshowPlayerRoomName,
  quizshowRoomName,
  type QuizshowRoleRoom,
} from './quizshow-frames';
import type { QuizshowPersistenceService } from './quizshow-persistence.service';
import { QuizshowRuntimeService } from './quizshow-runtime.service';
import type {
  QuizshowRandom,
  QuizshowSessionSnapshot,
  QuizshowSnapshotQuestion,
  QuizshowSnapshotRound,
} from './quizshow-snapshot';

const START = Date.UTC(2026, 9, 19, 20, 0, 0);
const TWO_HOURS_MS = 7_200_000;
const SESSION_ID = 'session-1';
const UNLOADED_SESSION_ID = 'session-2';
const EVENT_ID = 'event-1';
const HOST_USER_ID = 'host-user';
const READ_PHASE_MS = 4000;
const OPEN_PHASE_WITH_GRACE_MS = 20_500;
const ADDED_SECONDS = 10;
const ROLE_ROOMS: readonly QuizshowRoleRoom[] = ['screen', 'players', 'hosts'];
const OPEN_STATUSES = new Set(['lobby', 'running', 'paused']);

type NamespaceRecord =
  | { kind: 'emit'; room: string; event: string; payload: unknown }
  | { kind: 'leave'; room: string; rooms: string[] };

interface FakePersistence {
  loadLiveState: jest.Mock<
    Promise<QuizshowLiveState | null>,
    [string, QuizshowRandom]
  >;
  enqueueBatch: jest.Mock<
    void,
    [QuizshowLiveState, readonly QuizshowPersistOperation[]]
  >;
  flush: jest.Mock<Promise<void>, [string]>;
  flushAll: jest.Mock<Promise<void>, []>;
  recoverRunningSessionsAfterRestart: jest.Mock<Promise<number>, [Date]>;
  findIdleOpenSessionIds: jest.Mock<Promise<string[]>, [Date]>;
  isOpenSessionIdle: jest.Mock<Promise<boolean>, [string, Date]>;
  markAbandoned: jest.Mock<Promise<void>, [string, Date]>;
  findOpenSessionIdsForEvents: jest.Mock<Promise<string[]>, [string[]]>;
}

interface Harness {
  runtime: QuizshowRuntimeService;
  persistence: FakePersistence;
  records: NamespaceRecord[];
  state: QuizshowLiveState;
  random: QuizshowRandom;
}

function deterministicRandom(): QuizshowRandom {
  let counter = 0;
  return {
    uuid: () => {
      counter += 1;
      return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
    },
    integerBelow: () => 0,
  };
}

function trueFalseQuestion(questionId: string): QuizshowSnapshotQuestion {
  return {
    id: questionId,
    type: 'true_false',
    prompt: { en: 'Is it true?', pt: 'É verdade?' },
    mediaRef: null,
    mediaUrl: null,
    timeLimitSeconds: null,
    points: 1000,
    options: [],
    answer: { isTrue: true },
    acceptedAnswers: [],
    shownOptions: null,
  };
}

function promptQuestion(questionId: string): QuizshowSnapshotQuestion {
  return {
    id: questionId,
    type: 'prompt',
    prompt: { en: 'Write a caption', pt: 'Escreve uma legenda' },
    mediaRef: null,
    mediaUrl: null,
    timeLimitSeconds: null,
    points: 1000,
    options: [],
    answer: null,
    acceptedAnswers: [],
    shownOptions: null,
  };
}

function snapshotRound(
  roundId: string,
  kind: QuizshowRoundKind,
  questions: QuizshowSnapshotQuestion[],
): QuizshowSnapshotRound {
  return {
    id: roundId,
    kind,
    title: { en: 'Round', pt: 'Ronda' },
    contentLabel: 'none',
    settings: {
      timeLimitSeconds: 20,
      isSpeedBonusOn: true,
      isJokerAllowed: true,
      writeSeconds: 60,
      voteSeconds: 30,
    },
    questions,
  };
}

function quizRound(roundId: string, questionIds: string[]) {
  return snapshotRound(roundId, 'quiz', questionIds.map(trueFalseQuestion));
}

function captionRound(roundId: string) {
  return snapshotRound(roundId, 'caption_this', [
    promptQuestion(`${roundId}-question`),
  ]);
}

function lobbyState(
  rounds: QuizshowSnapshotRound[],
  sessionId: string = SESSION_ID,
): QuizshowLiveState {
  const snapshot: QuizshowSessionSnapshot = {
    title: 'Pride night quiz',
    languages: 'both',
    screenLanguage: 'en',
    rounds,
  };
  return createLobbyState({
    sessionId,
    eventId: EVENT_ID,
    eventSlug: 'pride-night',
    eventTitle: 'Pride night',
    hostUserId: HOST_USER_ID,
    openedByUserId: HOST_USER_ID,
    joinCode: 'ABC234',
    playMode: 'solo',
    maxTeamSize: null,
    isReviewOn: false,
    snapshot,
    attachedOrganiserUserIds: new Set<string>(),
    nextEvent: null,
    startedAt: START,
  });
}

function fakePersistence(
  states: ReadonlyMap<string, QuizshowLiveState>,
): FakePersistence {
  return {
    loadLiveState: jest.fn<
      Promise<QuizshowLiveState | null>,
      [string, QuizshowRandom]
    >((sessionId) => {
      const state = states.get(sessionId);
      return Promise.resolve(
        state !== undefined && OPEN_STATUSES.has(state.status) ? state : null,
      );
    }),
    enqueueBatch: jest.fn<
      void,
      [QuizshowLiveState, readonly QuizshowPersistOperation[]]
    >(),
    flush: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
    flushAll: jest.fn<Promise<void>, []>(() => Promise.resolve()),
    recoverRunningSessionsAfterRestart: jest.fn<Promise<number>, [Date]>(() =>
      Promise.resolve(0),
    ),
    findIdleOpenSessionIds: jest.fn<Promise<string[]>, [Date]>(() =>
      Promise.resolve([]),
    ),
    isOpenSessionIdle: jest.fn<Promise<boolean>, [string, Date]>(() =>
      Promise.resolve(false),
    ),
    markAbandoned: jest.fn<Promise<void>, [string, Date]>(() =>
      Promise.resolve(),
    ),
    findOpenSessionIdsForEvents: jest.fn<Promise<string[]>, [string[]]>(() =>
      Promise.resolve([]),
    ),
  };
}

function fakeNamespace(records: NamespaceRecord[]): Namespace {
  const namespace = {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        records.push({ kind: 'emit', room, event, payload });
        return true;
      },
    }),
    in: (room: string) => ({
      socketsLeave: (rooms: string | string[]) => {
        records.push({
          kind: 'leave',
          room,
          rooms: Array.isArray(rooms) ? rooms : [rooms],
        });
      },
    }),
  };
  return namespace as unknown as Namespace;
}

function createHarness(rounds: QuizshowSnapshotRound[]): Harness {
  const state = lobbyState(rounds);
  const persistence = fakePersistence(new Map([[SESSION_ID, state]]));
  const random = deterministicRandom();
  const runtime = new QuizshowRuntimeService(
    persistence as unknown as QuizshowPersistenceService,
    random,
  );
  const records: NamespaceRecord[] = [];
  runtime.bindNamespace(fakeNamespace(records));
  return { runtime, persistence, records, state, random };
}

function roleRoom(role: QuizshowRoleRoom): string {
  return quizshowRoomName(SESSION_ID, role);
}

function playerRoom(playerId: string): string {
  return quizshowPlayerRoomName(SESSION_ID, playerId);
}

function emitsOf(
  records: readonly NamespaceRecord[],
  event: string,
  room?: string,
): Array<Extract<NamespaceRecord, { kind: 'emit' }>> {
  return records.filter(
    (record): record is Extract<NamespaceRecord, { kind: 'emit' }> =>
      record.kind === 'emit' &&
      record.event === event &&
      (room === undefined || record.room === room),
  );
}

function onlyPayload<Payload>(
  records: readonly NamespaceRecord[],
  event: string,
  room: string,
): Payload {
  const emits = emitsOf(records, event, room);
  expect(emits).toHaveLength(1);
  const firstEmit = emits[0];
  if (firstEmit === undefined) throw new Error(`No ${event} to ${room}`);
  return firstEmit.payload as Payload;
}

function indexOfEmit(
  records: readonly NamespaceRecord[],
  event: string,
  room: string,
): number {
  return records.findIndex(
    (record) =>
      record.kind === 'emit' && record.event === event && record.room === room,
  );
}

function currentPlay(state: QuizshowLiveState): QuizshowLiveQuestionPlay {
  const play = state.current;
  if (play === null) throw new Error('No question in play');
  return play;
}

function clearRecords(harness: Harness): void {
  harness.records.length = 0;
}

async function joinPlayer(
  harness: Harness,
  userId: string,
  screenName: string,
  avatarUrl: string | null = null,
): Promise<string> {
  const outcome = await harness.runtime.execute(SESSION_ID, (state, now) =>
    joinLobby(
      state,
      {
        userId,
        isCohostPlayer: false,
        avatarUrl,
        screenName,
        isAvatarShown: avatarUrl !== null,
        hasExtraTime: false,
        team: null,
      },
      now,
      harness.random,
    ),
  );
  if (outcome === null || !outcome.ok) throw new Error('Join refused');
  return outcome.success.me.playerId;
}

async function startGame(harness: Harness): Promise<void> {
  await harness.runtime.execute(SESSION_ID, (state, now) =>
    hostStart(state, state.cursor.phaseId, now),
  );
}

async function nextPhase(harness: Harness): Promise<void> {
  const outcome = await harness.runtime.execute(SESSION_ID, (state, now) =>
    hostNext(state, state.cursor.phaseId, now, harness.random),
  );
  if (outcome === null || !outcome.ok || outcome.success.isNoop) {
    throw new Error('host:next did not move');
  }
}

/** Start, `host:next` into `read`, then let the read timer open the question. */
async function openFirstQuestion(harness: Harness): Promise<void> {
  await startGame(harness);
  await nextPhase(harness);
  await jest.advanceTimersByTimeAsync(READ_PHASE_MS);
  expect(harness.state.cursor.phase).toBe('open');
}

function answerTrue(harness: Harness, playerId: string) {
  return submit(harness, playerId, { type: 'true_false', isTrue: true });
}

function submit(
  harness: Harness,
  playerId: string,
  payload: QuizshowAnswerPayload,
) {
  return harness.runtime.execute(
    SESSION_ID,
    (state, now) =>
      submitAnswer(
        state,
        playerId,
        {
          phaseId: state.cursor.phaseId,
          questionId: currentPlay(state).questionId,
          payload,
        },
        now,
        harness.random,
      ),
    { isSubmission: true },
  );
}

function voteFor(harness: Harness, voterId: string, authorId: string) {
  return harness.runtime.execute(
    SESSION_ID,
    (state, now) => {
      const play = currentPlay(state);
      const option = (play.voteOptions ?? []).find(
        (voteOption) => voteOption.authorPlayerId === authorId,
      );
      if (option === undefined) throw new Error('No option for that author');
      return submitVote(
        state,
        voterId,
        {
          phaseId: state.cursor.phaseId,
          questionId: play.questionId,
          optionId: option.optionId,
        },
        now,
      );
    },
    { isSubmission: true },
  );
}

describe('QuizshowRuntimeService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: START });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("emits phase change before the phase's data frames", async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    const alexId = await joinPlayer(harness, 'user-alex', 'Alex');
    const beaId = await joinPlayer(harness, 'user-bea', 'Bea');
    await openFirstQuestion(harness);
    await answerTrue(harness, alexId);
    clearRecords(harness);

    await answerTrue(harness, beaId);

    expect(harness.state.cursor.phase).toBe('reveal');
    for (const role of ROLE_ROOMS) {
      const phaseIndex = indexOfEmit(
        harness.records,
        'phase:change',
        roleRoom(role),
      );
      const revealIndex = indexOfEmit(
        harness.records,
        'reveal',
        roleRoom(role),
      );
      expect(phaseIndex).toBeGreaterThanOrEqual(0);
      expect(revealIndex).toBeGreaterThan(phaseIndex);
    }
    const lastPhaseIndex = indexOfEmit(
      harness.records,
      'phase:change',
      roleRoom('hosts'),
    );
    for (const playerId of [alexId, beaId]) {
      expect(
        indexOfEmit(harness.records, 'reveal:mine', playerRoom(playerId)),
      ).toBeGreaterThan(lastPhaseIndex);
    }

    clearRecords(harness);
    await nextPhase(harness);

    expect(harness.state.cursor.phase).toBe('scores');
    const scoresPhaseIndex = indexOfEmit(
      harness.records,
      'phase:change',
      roleRoom('hosts'),
    );
    expect(indexOfEmit(harness.records, 'scores', roleRoom('screen'))).toBe(
      scoresPhaseIndex + 1,
    );
    expect(
      indexOfEmit(harness.records, 'scores:mine', playerRoom(alexId)),
    ).toBeGreaterThan(scoresPhaseIndex);
  });

  it('sends the host view to hosts and the public view elsewhere', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    const avatarUrl = 'https://cdn.example.test/avatars/alex.png';
    const alexId = await joinPlayer(harness, 'user-alex', 'Alex', avatarUrl);
    await jest.advanceTimersByTimeAsync(500);

    expect(
      onlyPayload<QuizshowLobby>(
        harness.records,
        'lobby:update',
        roleRoom('screen'),
      ).players[0]?.avatarUrl,
    ).toBe(avatarUrl);
    expect(
      onlyPayload<QuizshowLobby>(
        harness.records,
        'lobby:update',
        roleRoom('players'),
      ).players[0]?.avatarUrl,
    ).toBeNull();
    expect(
      onlyPayload<QuizshowHostLobby>(
        harness.records,
        'lobby:update',
        roleRoom('hosts'),
      ).players[0],
    ).toMatchObject({ playerId: alexId, avatarUrl, isConnected: false });

    await startGame(harness);
    clearRecords(harness);
    await nextPhase(harness);

    expect(harness.state.cursor.phase).toBe('read');
    const hostFrame = onlyPayload<QuizshowPhaseChangeFrame>(
      harness.records,
      'phase:change',
      roleRoom('hosts'),
    );
    expect(hostFrame.question).toHaveProperty('answerKey', {
      type: 'true_false',
      isTrue: true,
    });
    for (const role of ['screen', 'players'] as const) {
      const publicFrame = onlyPayload<QuizshowPhaseChangeFrame>(
        harness.records,
        'phase:change',
        roleRoom(role),
      );
      expect(publicFrame.question).not.toBeNull();
      expect(publicFrame.question).not.toHaveProperty('answerKey');
      expect(publicFrame.cursor.phaseId).toBe(hostFrame.cursor.phaseId);
    }
    expect(
      emitsOf(harness.records, 'phase:change', playerRoom(alexId)),
    ).toHaveLength(0);
  });

  it('throttles lobby updates to one per 500 ms and answer counts to one per 250 ms', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    const alexId = await joinPlayer(harness, 'user-alex', 'Alex');
    const beaId = await joinPlayer(harness, 'user-bea', 'Bea');
    await joinPlayer(harness, 'user-cris', 'Cris');

    await jest.advanceTimersByTimeAsync(499);
    expect(emitsOf(harness.records, 'lobby:update')).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    const firstUpdates = emitsOf(harness.records, 'lobby:update');
    expect(firstUpdates.map((record) => record.room)).toEqual(
      ROLE_ROOMS.map(roleRoom),
    );
    expect(
      onlyPayload<QuizshowLobby>(
        harness.records,
        'lobby:update',
        roleRoom('screen'),
      ).playerCount,
    ).toBe(3);

    clearRecords(harness);
    await joinPlayer(harness, 'user-dani', 'Dani');
    await jest.advanceTimersByTimeAsync(500);
    expect(
      onlyPayload<QuizshowLobby>(
        harness.records,
        'lobby:update',
        roleRoom('players'),
      ).playerCount,
    ).toBe(4);

    await openFirstQuestion(harness);
    clearRecords(harness);
    await answerTrue(harness, alexId);
    await answerTrue(harness, beaId);

    await jest.advanceTimersByTimeAsync(249);
    expect(emitsOf(harness.records, 'answer:count')).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    const counts = emitsOf(harness.records, 'answer:count');
    expect(counts.map((record) => record.room)).toEqual([
      roleRoom('screen'),
      roleRoom('hosts'),
    ]);
    expect(counts[0]?.payload).toEqual({
      phaseId: harness.state.cursor.phaseId,
      count: 2,
      total: 4,
    });
  });

  it('personalises vote options, reveal and scores per player room', async () => {
    const harness = createHarness([
      captionRound('round-1'),
      quizRound('round-2', ['question-2']),
    ]);
    const alexId = await joinPlayer(harness, 'user-alex', 'Alex');
    const beaId = await joinPlayer(harness, 'user-bea', 'Bea');
    const crisId = await joinPlayer(harness, 'user-cris', 'Cris');
    const playerIds = [alexId, beaId, crisId];
    await startGame(harness);
    await nextPhase(harness);
    expect(harness.state.cursor.phase).toBe('write');

    await submit(harness, alexId, { type: 'prompt', text: 'Sunny parade' });
    await submit(harness, beaId, { type: 'prompt', text: 'Glitter storm' });
    clearRecords(harness);
    await submit(harness, crisId, { type: 'prompt', text: 'Disco pigeon' });

    expect(harness.state.cursor.phase).toBe('vote');
    const voteOptions = currentPlay(harness.state).voteOptions ?? [];
    expect(
      onlyPayload<QuizshowVoteOptions>(
        harness.records,
        'vote:options',
        roleRoom('screen'),
      ).ownOptionId,
    ).toBeNull();
    const hostOptions = onlyPayload<QuizshowHostVoteOptions>(
      harness.records,
      'vote:options',
      roleRoom('hosts'),
    );
    expect(hostOptions.options).toHaveLength(3);
    expect(hostOptions.options[0]).toHaveProperty('answerId');
    for (const playerId of playerIds) {
      const ownOption = voteOptions.find(
        (option) => option.authorPlayerId === playerId,
      );
      expect(
        onlyPayload<QuizshowVoteOptions>(
          harness.records,
          'vote:options',
          playerRoom(playerId),
        ).ownOptionId,
      ).toBe(ownOption?.optionId);
    }
    expect(
      emitsOf(harness.records, 'vote:options', roleRoom('players')),
    ).toHaveLength(0);

    await voteFor(harness, alexId, beaId);
    await voteFor(harness, beaId, alexId);
    clearRecords(harness);
    await voteFor(harness, crisId, alexId);

    expect(harness.state.cursor.phase).toBe('reveal');
    const reveals = playerIds.map((playerId) =>
      onlyPayload<QuizshowMyReveal>(
        harness.records,
        'reveal:mine',
        playerRoom(playerId),
      ),
    );
    reveals.forEach((reveal, index) => {
      const playerId = playerIds[index] ?? '';
      expect(reveal.score).toBe(harness.state.players.get(playerId)?.score);
    });
    const [alexReveal, beaReveal, crisReveal] = reveals;
    expect(alexReveal?.pointsAwarded).toBeGreaterThan(
      beaReveal?.pointsAwarded ?? 0,
    );
    expect(beaReveal?.pointsAwarded).toBeGreaterThan(0);
    expect(crisReveal?.pointsAwarded).toBe(0);

    clearRecords(harness);
    await nextPhase(harness);

    expect(harness.state.cursor.phase).toBe('leaderboard');
    for (const role of ROLE_ROOMS) {
      expect(emitsOf(harness.records, 'scores', roleRoom(role))).toHaveLength(
        1,
      );
    }
    const myScores = playerIds.map((playerId) =>
      onlyPayload<QuizshowMyScores>(
        harness.records,
        'scores:mine',
        playerRoom(playerId),
      ),
    );
    myScores.forEach((scores, index) => {
      const playerId = playerIds[index] ?? '';
      expect(scores.ownScore).toBe(harness.state.players.get(playerId)?.score);
    });
    expect(myScores.map((scores) => scores.rank)).toEqual([1, 2, 3]);
  });

  it('fires the timer for the current phase and ignores a stale one', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    await joinPlayer(harness, 'user-alex', 'Alex');
    await startGame(harness);
    await nextPhase(harness);
    expect(harness.state.cursor.phase).toBe('read');

    await jest.advanceTimersByTimeAsync(READ_PHASE_MS - 1);
    expect(harness.state.cursor.phase).toBe('read');
    await jest.advanceTimersByTimeAsync(1);
    expect(harness.state.cursor.phase).toBe('open');
    const openPhaseId = harness.state.cursor.phaseId;

    await harness.runtime.execute(SESSION_ID, (state, now) =>
      hostReveal(state, openPhaseId, now, harness.random),
    );
    expect(harness.state.cursor.phase).toBe('reveal');
    const revealPhaseId = harness.state.cursor.phaseId;
    clearRecords(harness);
    // The open phase's timer is still pending after the host reveal.
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(OPEN_PHASE_WITH_GRACE_MS);
    expect(jest.getTimerCount()).toBe(0);
    expect(harness.state.cursor.phaseId).toBe(revealPhaseId);
    expect(emitsOf(harness.records, 'phase:change')).toHaveLength(0);

    const staleOutcome = await harness.runtime.execute(
      SESSION_ID,
      (state, now) =>
        succeed<Record<string, never>>(
          {},
          timerElapsed(state, openPhaseId, now, harness.random),
        ),
    );
    expect(staleOutcome?.effects).toEqual([]);
    expect(harness.state.cursor.phaseId).toBe(revealPhaseId);
  });

  it('clears the phase timer on pause', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    await joinPlayer(harness, 'user-alex', 'Alex');
    await openFirstQuestion(harness);
    const openPhaseId = harness.state.cursor.phaseId;
    expect(jest.getTimerCount()).toBe(1);
    clearRecords(harness);

    await harness.runtime.execute(SESSION_ID, (state, now) =>
      hostPause(state, openPhaseId, now),
    );

    expect(harness.state.status).toBe('paused');
    expect(jest.getTimerCount()).toBe(0);
    expect(
      onlyPayload<QuizshowPhaseChangeFrame>(
        harness.records,
        'phase:change',
        roleRoom('hosts'),
      ).cursor,
    ).toMatchObject({ phaseId: openPhaseId, status: 'paused' });
    await jest.advanceTimersByTimeAsync(OPEN_PHASE_WITH_GRACE_MS * 2);
    expect(harness.state.cursor.phase).toBe('open');
    expect(harness.state.cursor.phaseId).toBe(openPhaseId);
  });

  it('re-arms the phase timer when the host adds time', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    await joinPlayer(harness, 'user-alex', 'Alex');
    await openFirstQuestion(harness);
    const openPhaseId = harness.state.cursor.phaseId;
    const deadline = harness.state.cursor.deadline;
    if (deadline === null) throw new Error('The open phase has no deadline');

    const outcome = await harness.runtime.execute(SESSION_ID, (state, now) =>
      hostAddTime(
        state,
        {
          phaseId: openPhaseId,
          seconds: ADDED_SECONDS,
          expectedDeadline: deadline,
        },
        now,
      ),
    );

    expect(outcome).toMatchObject({ ok: true, success: { isNoop: false } });
    expect(harness.state.cursor.deadline).toBe(deadline + ADDED_SECONDS * 1000);
    expect(jest.getTimerCount()).toBe(1);
    // The fire time the phase had before the added time passes with no close.
    await jest.advanceTimersByTimeAsync(OPEN_PHASE_WITH_GRACE_MS);
    expect(harness.state.cursor.phase).toBe('open');
    await jest.advanceTimersByTimeAsync(ADDED_SECONDS * 1000 - 1);
    expect(harness.state.cursor.phase).toBe('open');
    await jest.advanceTimersByTimeAsync(1);
    expect(harness.state.cursor.phase).toBe('reveal');
  });

  it('closes open when the last eligible player answers through execute', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    const alexId = await joinPlayer(harness, 'user-alex', 'Alex');
    const beaId = await joinPlayer(harness, 'user-bea', 'Bea');
    await openFirstQuestion(harness);

    const firstOutcome = await answerTrue(harness, alexId);
    expect(harness.state.cursor.phase).toBe('open');
    expect(firstOutcome?.effects).not.toContainEqual({ kind: 'revealed' });
    expect(
      onlyPayload<{ questionId: string }>(
        harness.records,
        'answer:ack',
        playerRoom(alexId),
      ).questionId,
    ).toBe('question-1');

    clearRecords(harness);
    const lastOutcome = await answerTrue(harness, beaId);

    expect(lastOutcome?.ok).toBe(true);
    expect(lastOutcome?.effects).toContainEqual({ kind: 'revealed' });
    expect(harness.state.cursor.phase).toBe('reveal');
    expect(
      onlyPayload<QuizshowPhaseChangeFrame>(
        harness.records,
        'phase:change',
        roleRoom('screen'),
      ).cursor.phase,
    ).toBe('reveal');
  });

  it("removes a player's sockets from every room after telling them", async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    const alexId = await joinPlayer(harness, 'user-alex', 'Alex');
    clearRecords(harness);

    await harness.runtime.execute(SESSION_ID, (state, now) =>
      hostRemovePlayer(state, alexId, HOST_USER_ID, now, harness.random),
    );

    const removedIndex = indexOfEmit(
      harness.records,
      'player:removed',
      playerRoom(alexId),
    );
    const leaveIndex = harness.records.findIndex(
      (record) => record.kind === 'leave',
    );
    expect(removedIndex).toBeGreaterThanOrEqual(0);
    expect(leaveIndex).toBeGreaterThan(removedIndex);
    expect(harness.records[removedIndex]).toMatchObject({
      payload: { sessionId: SESSION_ID },
    });
    expect(harness.records[leaveIndex]).toEqual({
      kind: 'leave',
      room: playerRoom(alexId),
      rooms: [...ROLE_ROOMS.map(roleRoom), playerRoom(alexId)],
    });
  });

  it('ends a session, tells every room and drops it', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    await joinPlayer(harness, 'user-alex', 'Alex');
    await startGame(harness);
    await nextPhase(harness);
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    clearRecords(harness);

    const outcome = await harness.runtime.execute(SESSION_ID, (state, now) =>
      hostEnd(state, state.cursor.phaseId, now),
    );

    expect(outcome?.ok).toBe(true);
    for (const role of ROLE_ROOMS) {
      expect(
        onlyPayload<QuizshowSessionEnd>(
          harness.records,
          'session:end',
          roleRoom(role),
        ),
      ).toMatchObject({
        sessionId: SESSION_ID,
        status: 'abandoned',
        podium: [],
        hasResults: false,
      });
    }
    const operationTypes = harness.persistence.enqueueBatch.mock.calls.flatMap(
      ([, operations]) => operations.map((operation) => operation.type),
    );
    expect(operationTypes).toContain('abandon');
    expect(operationTypes[operationTypes.length - 1]).toBe('checkpoint');
    expect(harness.persistence.flush).toHaveBeenCalledWith(SESSION_ID);
    expect(jest.getTimerCount()).toBe(0);

    const afterEnd = await harness.runtime.execute(SESSION_ID, (state, now) =>
      hostNext(state, state.cursor.phaseId, now, harness.random),
    );
    expect(afterEnd).toBeNull();
    expect(harness.persistence.loadLiveState).toHaveBeenCalledTimes(2);
  });

  it('loads a session once for two concurrent attaches', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);

    const [firstState, secondState] = await Promise.all([
      harness.runtime.getOrLoad(SESSION_ID),
      harness.runtime.getOrLoad(SESSION_ID),
    ]);
    const laterState = await harness.runtime.getOrLoad(SESSION_ID);

    expect(firstState).toBe(harness.state);
    expect(secondState).toBe(firstState);
    expect(laterState).toBe(firstState);
    expect(harness.persistence.loadLiveState).toHaveBeenCalledTimes(1);
    expect(harness.persistence.loadLiveState).toHaveBeenCalledWith(
      SESSION_ID,
      harness.random,
    );

    const alexId = await joinPlayer(harness, 'user-alex', 'Alex');
    const alex = harness.state.players.get(alexId);
    expect(alex?.connectedSocketCount).toBe(0);
    harness.runtime.noteSocketAttached(SESSION_ID, alexId);
    harness.runtime.noteSocketAttached(SESSION_ID, alexId);
    harness.runtime.noteSocketAttached(SESSION_ID, null);
    expect(alex?.connectedSocketCount).toBe(2);
    await jest.advanceTimersByTimeAsync(500);
    expect(
      onlyPayload<QuizshowHostLobby>(
        harness.records,
        'lobby:update',
        roleRoom('hosts'),
      ).players[0]?.isConnected,
    ).toBe(true);
    harness.runtime.noteSocketDetached(SESSION_ID, alexId);
    harness.runtime.noteSocketDetached(SESSION_ID, alexId);
    harness.runtime.noteSocketDetached(SESSION_ID, alexId);
    expect(alex?.connectedSocketCount).toBe(0);

    const socketEmit = jest.fn();
    const socket = { emit: socketEmit } as unknown as Socket;
    harness.runtime.emitSessionState(socket, harness.state, {
      role: 'screen',
    });
    expect(socketEmit).toHaveBeenCalledWith(
      'session:state',
      expect.objectContaining({ role: 'screen', sessionId: SESSION_ID }),
    );
  });

  it('pauses running sessions on boot', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    harness.persistence.recoverRunningSessionsAfterRestart.mockResolvedValueOnce(
      3,
    );

    await harness.runtime.onApplicationBootstrap();

    expect(
      harness.persistence.recoverRunningSessionsAfterRestart,
    ).toHaveBeenCalledWith(new Date(START));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('3'));

    harness.persistence.recoverRunningSessionsAfterRestart.mockRejectedValueOnce(
      Object.assign(new Error('connection refused'), { code: '08006' }),
    );
    await expect(
      harness.runtime.onApplicationBootstrap(),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('08006'));
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('connection refused'),
    );
  });

  it('abandons idle sessions whether loaded or not', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    await harness.runtime.getOrLoad(SESSION_ID);
    harness.persistence.isOpenSessionIdle.mockImplementation((sessionId) =>
      Promise.resolve(sessionId === UNLOADED_SESSION_ID),
    );

    expect(await harness.runtime.abandonIfIdle(SESSION_ID, START + 1000)).toBe(
      false,
    );
    expect(harness.state.status).toBe('lobby');

    const idleAt = START + TWO_HOURS_MS;
    expect(await harness.runtime.abandonIfIdle(SESSION_ID, idleAt)).toBe(true);
    expect(harness.state.status).toBe('abandoned');
    expect(
      onlyPayload<QuizshowSessionEnd>(
        harness.records,
        'session:end',
        roleRoom('screen'),
      ).status,
    ).toBe('abandoned');
    expect(harness.persistence.markAbandoned).not.toHaveBeenCalled();

    expect(
      await harness.runtime.abandonIfIdle(UNLOADED_SESSION_ID, idleAt),
    ).toBe(true);
    expect(harness.persistence.markAbandoned).toHaveBeenCalledWith(
      UNLOADED_SESSION_ID,
      new Date(idleAt),
    );
    expect(await harness.runtime.abandonIfIdle('session-3', idleAt)).toBe(
      false,
    );
    expect(harness.persistence.markAbandoned).toHaveBeenCalledTimes(1);

    const sweepHarness = createHarness([quizRound('round-1', ['question-1'])]);
    await sweepHarness.runtime.getOrLoad(SESSION_ID);
    sweepHarness.persistence.findIdleOpenSessionIds.mockResolvedValue([
      SESSION_ID,
      UNLOADED_SESSION_ID,
    ]);

    expect(await sweepHarness.runtime.sweepIdleSessions(idleAt)).toBe(2);
    expect(sweepHarness.state.status).toBe('abandoned');
    expect(sweepHarness.persistence.markAbandoned).toHaveBeenCalledTimes(1);
    expect(sweepHarness.persistence.markAbandoned).toHaveBeenCalledWith(
      UNLOADED_SESSION_ID,
      new Date(idleAt),
    );
  });

  it('the idle check reads only the joined session', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    harness.persistence.isOpenSessionIdle.mockResolvedValue(true);
    const idleAt = START + TWO_HOURS_MS;

    expect(
      await harness.runtime.abandonIfIdle(UNLOADED_SESSION_ID, idleAt),
    ).toBe(true);

    expect(harness.persistence.isOpenSessionIdle).toHaveBeenCalledTimes(1);
    expect(harness.persistence.isOpenSessionIdle).toHaveBeenCalledWith(
      UNLOADED_SESSION_ID,
      new Date(idleAt),
    );
    expect(harness.persistence.findIdleOpenSessionIds).not.toHaveBeenCalled();
    expect(harness.persistence.markAbandoned).toHaveBeenCalledWith(
      UNLOADED_SESSION_ID,
      new Date(idleAt),
    );

    harness.persistence.isOpenSessionIdle.mockResolvedValue(false);
    expect(await harness.runtime.abandonIfIdle('session-3', idleAt)).toBe(
      false,
    );
    expect(harness.persistence.markAbandoned).toHaveBeenCalledTimes(1);
  });

  it('queues every write of one command as one batch', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    const alexId = await joinPlayer(harness, 'user-alex', 'Alex');
    await openFirstQuestion(harness);
    const batchCountBefore = harness.persistence.enqueueBatch.mock.calls.length;

    const outcome = await answerTrue(harness, alexId);

    expect(outcome?.effects).toContainEqual({ kind: 'revealed' });
    const batches =
      harness.persistence.enqueueBatch.mock.calls.slice(batchCountBefore);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.[0]).toBe(harness.state);
    const operations: readonly QuizshowPersistOperation[] =
      batches[0]?.[1] ?? [];
    const operationTypes = operations.map((operation) => operation.type);
    expect(operationTypes).toEqual(
      expect.arrayContaining(['insert_answer', 'save_scoring', 'checkpoint']),
    );
    const persistEffectCount = (outcome?.effects ?? []).filter(
      (effect) => effect.kind === 'persist',
    ).length;
    expect(operationTypes).toHaveLength(persistEffectCount);
  });

  it('shutdown waits for queued writes', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    let releaseWrites: () => void = () => undefined;
    harness.persistence.flushAll.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseWrites = resolve;
      }),
    );
    let isShutdownDone = false;

    const shutdown = harness.runtime
      .beforeApplicationShutdown('SIGTERM')
      .then(() => {
        isShutdownDone = true;
      });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(harness.persistence.flushAll).toHaveBeenCalledTimes(1);
    expect(isShutdownDone).toBe(false);

    releaseWrites();
    await shutdown;
    expect(isShutdownDone).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('shutdown stops waiting for a stuck write after the drain timeout', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    harness.persistence.flushAll.mockReturnValue(
      new Promise<void>(() => undefined),
    );
    let isShutdownDone = false;

    const shutdown = harness.runtime
      .beforeApplicationShutdown('SIGTERM')
      .then(() => {
        isShutdownDone = true;
      });
    await jest.advanceTimersByTimeAsync(4_999);
    expect(isShutdownDone).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await shutdown;

    expect(isShutdownDone).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      'Pulse Live shutdown proceeding with writes still queued after 5000ms',
    );
  });

  it('abandons the open sessions of cancelled events', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    await joinPlayer(harness, 'user-alex', 'Alex');
    await startGame(harness);
    harness.persistence.findOpenSessionIdsForEvents.mockResolvedValue([
      SESSION_ID,
      UNLOADED_SESSION_ID,
    ]);
    clearRecords(harness);
    const cancelledAt = START + 5000;

    await harness.runtime.abandonSessionsOfEvents([EVENT_ID], cancelledAt);

    expect(
      harness.persistence.findOpenSessionIdsForEvents,
    ).toHaveBeenCalledWith([EVENT_ID]);
    expect(harness.state.status).toBe('abandoned');
    for (const role of ROLE_ROOMS) {
      expect(
        onlyPayload<QuizshowSessionEnd>(
          harness.records,
          'session:end',
          roleRoom(role),
        ).status,
      ).toBe('abandoned');
    }
    expect(harness.persistence.markAbandoned).toHaveBeenCalledTimes(1);
    expect(harness.persistence.markAbandoned).toHaveBeenCalledWith(
      UNLOADED_SESSION_ID,
      new Date(cancelledAt),
    );
  });
});
