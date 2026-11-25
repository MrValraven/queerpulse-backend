import { Logger } from '@nestjs/common';
import type { Namespace, Socket } from 'socket.io';
import {
  QUIZSHOW_LIMITS,
  QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
  type QuizshowAnswerPayload,
  type QuizshowHostVoteOptions,
  type QuizshowLobby,
  type QuizshowHostLobby,
  type QuizshowMyReveal,
  type QuizshowMyScores,
  type QuizshowPairedDevice,
  type QuizshowPhaseChangeFrame,
  type QuizshowPlayerLobby,
  type QuizshowPlayerState,
  type QuizshowPodiumEntry,
  type QuizshowPodiumFrame,
  type QuizshowReactionsFrame,
  type QuizshowRematch,
  type QuizshowRoundKind,
  type QuizshowSessionEnd,
  type QuizshowSessionState,
  type QuizshowVoteOptions,
} from './quizshow.contract';
import {
  hostAddTime,
  hostEnd,
  hostNext,
  hostPause,
  hostRemovePlayer,
  hostReveal,
  hostSpin,
  hostStart,
  timerElapsed,
} from './quizshow-engine-phases';
import { joinLobby, submitAnswer, submitVote } from './quizshow-engine-players';
import { createLobbyState, succeed } from './quizshow-engine-state';
import type {
  QuizshowEngineEffect,
  QuizshowLivePlayer,
  QuizshowLiveQuestionPlay,
  QuizshowLiveState,
  QuizshowPersistOperation,
} from './quizshow-engine-types';
import {
  buildSessionState,
  quizshowPlayerRoomName,
  quizshowRoomName,
  type QuizshowRoleRoom,
} from './quizshow-frames';
import type { QuizshowPersistenceService } from './quizshow-persistence.service';
import {
  QUIZSHOW_LOBBY_THROTTLE_MS,
  QuizshowRuntimeService,
} from './quizshow-runtime.service';
import * as quizshowScoring from './quizshow-scoring';
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
const GAME_ID = 'game-1';
const OTHER_GAME_ID = 'game-2';
const GAME_SESSION_ID = 'session-game-1';
const OTHER_GAME_SESSION_ID = 'session-game-2';
const OWNER_USER_ID = 'owner-user';
const HOST_USER_ID = 'host-user';
const READ_PHASE_MS = 4000;
const OPEN_PHASE_WITH_GRACE_MS = 20_500;
const ADDED_SECONDS = 10;
const ROLE_ROOMS: readonly QuizshowRoleRoom[] = ['screen', 'players', 'hosts'];
const OPEN_STATUSES = new Set(['lobby', 'running', 'paused']);

type NamespaceRecord =
  | { kind: 'emit'; room: string; event: string; payload: unknown }
  | { kind: 'leave'; room: string; rooms: string[] }
  | { kind: 'socket_emit'; socketId: string; event: string; payload: unknown }
  | { kind: 'socket_leave'; socketId: string; room: string };

/** The sockets the fake namespace knows: room membership as socket.io's adapter keeps it, and each socket by id. */
interface FakeSockets {
  rooms: Map<string, Set<string>>;
  byId: Map<string, Socket>;
}

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
  findOpenSessionIdsForGames: jest.Mock<Promise<string[]>, [string[]]>;
  findGameIdsOfOwner: jest.Mock<Promise<string[]>, [string]>;
}

interface Harness {
  runtime: QuizshowRuntimeService;
  persistence: FakePersistence;
  records: NamespaceRecord[];
  sockets: FakeSockets;
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
    mediaAlt: { en: '', pt: '' },
    mediaReveal: 'instant',
    revealNote: { en: '', pt: '' },
    numberUnit: { en: '', pt: '' },
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
    mediaAlt: { en: '', pt: '' },
    mediaReveal: 'instant',
    revealNote: { en: '', pt: '' },
    numberUnit: { en: '', pt: '' },
    timeLimitSeconds: null,
    points: 1000,
    options: [],
    answer: null,
    acceptedAnswers: [],
    shownOptions: null,
  };
}

function typeAnswerQuestion(questionId: string): QuizshowSnapshotQuestion {
  return {
    id: questionId,
    type: 'type_answer',
    prompt: { en: 'Is it true?', pt: 'É verdade?' },
    mediaRef: null,
    mediaUrl: null,
    mediaAlt: { en: '', pt: '' },
    mediaReveal: 'instant',
    revealNote: { en: '', pt: '' },
    numberUnit: { en: '', pt: '' },
    timeLimitSeconds: null,
    points: 1000,
    options: [],
    answer: { text: { en: 'Stonewall', pt: 'Stonewall' } },
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
      ...QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
      isWarmUp: false,
      talkSeconds: 0,
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
    sourceUpdatedAt: '2026-10-19T18:00:00.000Z',
  };
  return createLobbyState({
    sessionId,
    eventId: EVENT_ID,
    eventSlug: 'pride-night',
    eventTitle: 'Pride night',
    kind: 'event',
    gameId: null,
    isAdultsOnly: false,
    hostUserId: HOST_USER_ID,
    openedByUserId: HOST_USER_ID,
    joinCode: 'ABC234',
    playMode: 'solo',
    maxTeamSize: null,
    isReviewOn: false,
    snapshot,
    attachedOrganiserUserIds: new Set<string>(),
    nextEvent: null,
    isPractice: false,
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
    findOpenSessionIdsForGames: jest.fn<Promise<string[]>, [string[]]>(() =>
      Promise.resolve([]),
    ),
    findGameIdsOfOwner: jest.fn<Promise<string[]>, [string]>(() =>
      Promise.resolve([]),
    ),
  };
}

function emptySockets(): FakeSockets {
  return { rooms: new Map(), byId: new Map() };
}

function fakeNamespace(
  records: NamespaceRecord[],
  sockets: FakeSockets = emptySockets(),
): Namespace {
  const namespace = {
    adapter: { rooms: sockets.rooms },
    sockets: sockets.byId,
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
  const sockets = emptySockets();
  runtime.bindNamespace(fakeNamespace(records, sockets));
  return { runtime, persistence, records, sockets, state, random };
}

/** A socket in the listed rooms that records what it receives and the rooms it leaves. */
function addSocket(
  harness: Harness,
  socketId: string,
  rooms: readonly string[],
  playerId: string | null = null,
): Socket {
  const socket = {
    id: socketId,
    data: { sessionId: SESSION_ID, playerId },
    emit: (event: string, payload: unknown) => {
      harness.records.push({ kind: 'socket_emit', socketId, event, payload });
      return true;
    },
    leave: (room: string) => {
      harness.sockets.rooms.get(room)?.delete(socketId);
      harness.records.push({ kind: 'socket_leave', socketId, room });
    },
  } as unknown as Socket;
  harness.sockets.byId.set(socketId, socket);
  for (const room of rooms) {
    const members = harness.sockets.rooms.get(room) ?? new Set<string>();
    members.add(socketId);
    harness.sockets.rooms.set(room, members);
  }
  return socket;
}

function socketStatesOf(
  records: readonly NamespaceRecord[],
  socketId: string,
): QuizshowSessionState[] {
  return records.flatMap((record) =>
    record.kind === 'socket_emit' &&
    record.socketId === socketId &&
    record.event === 'session:state'
      ? [record.payload as QuizshowSessionState]
      : [],
  );
}

/** Applies effects the engine would emit, without a command behind them. */
async function applyEffects(
  harness: Harness,
  effects: QuizshowEngineEffect[],
): Promise<void> {
  const outcome = await harness.runtime.execute(SESSION_ID, () =>
    succeed<Record<string, never>>({}, effects),
  );
  if (outcome === null) throw new Error('Session not live');
}

function livePlayer(
  playerId: string,
  overrides: Partial<QuizshowLivePlayer> = {},
): QuizshowLivePlayer {
  return {
    playerId,
    userId: `user-${playerId}`,
    screenName: playerId,
    teamId: null,
    isCohostPlayer: false,
    isAvatarShown: false,
    avatarUrl: null,
    hasExtraTime: false,
    score: 0,
    streak: 0,
    hasUsedJoker: false,
    jokerRoundIndex: null,
    joinedAt: START,
    removedAt: null,
    connectedSocketCount: 0,
    disconnectedAt: null,
    leftAt: null,
    ...overrides,
  };
}

function gameLobbyState(
  rounds: QuizshowSnapshotRound[],
  sessionId: string,
  gameId: string,
): QuizshowLiveState {
  return {
    ...lobbyState(rounds, sessionId),
    kind: 'game',
    gameId,
    eventId: null,
    eventSlug: null,
    eventTitle: null,
  };
}

function createGameHarness(gameSessions: ReadonlyArray<[string, string]>): {
  runtime: QuizshowRuntimeService;
  persistence: FakePersistence;
  states: QuizshowLiveState[];
  random: QuizshowRandom;
} {
  const rounds = [quizRound('round-1', ['question-1'])];
  const states = gameSessions.map(([sessionId, gameId]) =>
    gameLobbyState(rounds, sessionId, gameId),
  );
  const persistence = fakePersistence(
    new Map(states.map((state) => [state.sessionId, state])),
  );
  const random = deterministicRandom();
  const runtime = new QuizshowRuntimeService(
    persistence as unknown as QuizshowPersistenceService,
    random,
  );
  runtime.bindNamespace(fakeNamespace([]));
  return { runtime, persistence, states, random };
}

function gameStateAt(
  states: readonly QuizshowLiveState[],
  index: number,
): QuizshowLiveState {
  const state = states[index];
  if (!state) throw new Error(`No game state at index ${index}`);
  return state;
}

async function loadGameSession(
  runtime: QuizshowRuntimeService,
  random: QuizshowRandom,
  sessionId: string,
): Promise<void> {
  const outcome = await runtime.execute(sessionId, (state, now) =>
    joinLobby(
      state,
      {
        userId: 'user-alex',
        isCohostPlayer: false,
        avatarUrl: null,
        screenName: 'Alex',
        isAvatarShown: false,
        hasExtraTime: false,
        team: null,
      },
      now,
      random,
    ),
  );
  if (outcome === null || !outcome.ok) throw new Error('Join refused');
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
          latencyAllowanceMs: 0,
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

/** Join one player, start a wheel night and spin once through the runtime. */
async function spinFirstWheel(harness: Harness): Promise<void> {
  await joinPlayer(harness, 'user-alex', 'Alex');
  await startGame(harness);
  expect(harness.state.cursor.phase).toBe('wheel');
  clearRecords(harness);
  const batchCountAfterStart =
    harness.persistence.enqueueBatch.mock.calls.length;
  const outcome = await harness.runtime.execute(SESSION_ID, (state, now) =>
    hostSpin(state, state.cursor.phaseId, now, harness.random),
  );
  if (outcome === null || !outcome.ok || outcome.success.isNoop) {
    throw new Error('host:spin did not spin');
  }
  expect(
    harness.persistence.enqueueBatch.mock.calls.length - batchCountAfterStart,
  ).toBe(1);
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

  it('sends every role the same spin on phase:change', async () => {
    const harness = createHarness([
      snapshotRound('wheel-1', 'wheel', []),
      quizRound('round-1', ['question-1']),
      quizRound('round-2', ['question-2']),
    ]);
    const batchCountBefore = harness.persistence.enqueueBatch.mock.calls.length;

    await spinFirstWheel(harness);

    const wheelsByRole = ROLE_ROOMS.map((role) => {
      const phaseChanges = emitsOf(
        harness.records,
        'phase:change',
        roleRoom(role),
      );
      const lastPhaseChange = phaseChanges[phaseChanges.length - 1];
      if (lastPhaseChange === undefined) {
        throw new Error(`No phase:change to ${role}`);
      }
      return (lastPhaseChange.payload as QuizshowPhaseChangeFrame).wheel;
    });
    const [screenWheel, playersWheel, hostsWheel] = wheelsByRole;
    expect(screenWheel).not.toBeNull();
    expect(screenWheel?.spin?.landedSliceIndex).toBe(0);
    expect(playersWheel).toEqual(screenWheel);
    expect(hostsWheel).toEqual(screenWheel);
    const batches =
      harness.persistence.enqueueBatch.mock.calls.slice(batchCountBefore);
    const spinBatch = batches[batches.length - 1];
    const spinOperationTypes = (spinBatch?.[1] ?? []).map(
      (operation) => operation.type,
    );
    expect(
      spinOperationTypes.filter((type) => type === 'checkpoint'),
    ).toHaveLength(1);
  });

  it('rebuilds the landed spin for a late screen', async () => {
    const harness = createHarness([
      snapshotRound('wheel-1', 'wheel', []),
      quizRound('round-1', ['question-1']),
      quizRound('round-2', ['question-2']),
    ]);

    await spinFirstWheel(harness);
    await jest.advanceTimersByTimeAsync(QUIZSHOW_LIMITS.wheelSpinMs);

    const phaseChanges = emitsOf(
      harness.records,
      'phase:change',
      roleRoom('screen'),
    );
    const lastPhaseChange = phaseChanges[phaseChanges.length - 1];
    if (lastPhaseChange === undefined) throw new Error('No phase:change');
    const frameSpin = (lastPhaseChange.payload as QuizshowPhaseChangeFrame)
      .wheel?.spin;
    expect(frameSpin).toBeDefined();
    expect(frameSpin).not.toBeNull();
    const lateScreenState = buildSessionState(harness.state, {
      role: 'screen',
    });
    expect(lateScreenState.wheel?.spin).toEqual(frameSpin);
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
    const playerLobby = onlyPayload<QuizshowPlayerLobby>(
      harness.records,
      'lobby:update',
      roleRoom('players'),
    );
    expect(playerLobby).toEqual({ teams: [], playerCount: 1 });
    expect(playerLobby).not.toHaveProperty('players');
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
    const playerLobby = onlyPayload<QuizshowPlayerLobby>(
      harness.records,
      'lobby:update',
      roleRoom('players'),
    );
    expect(playerLobby.playerCount).toBe(4);
    expect(playerLobby).not.toHaveProperty('players');
    expect(
      onlyPayload<QuizshowLobby>(
        harness.records,
        'lobby:update',
        roleRoom('screen'),
      ).players,
    ).toHaveLength(4);

    await openFirstQuestion(harness);
    clearRecords(harness);
    await answerTrue(harness, alexId);
    await answerTrue(harness, beaId);

    await jest.advanceTimersByTimeAsync(249);
    expect(emitsOf(harness.records, 'answer:count')).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    const counts = emitsOf(harness.records, 'answer:count');
    expect(counts.map((record) => record.room)).toEqual(
      ROLE_ROOMS.map(roleRoom),
    );
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
      payload: { sessionId: SESSION_ID, canRejoin: false },
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
    expect(alex?.disconnectedAt).toBeNull();
    await jest.advanceTimersByTimeAsync(500);
    expect(
      onlyPayload<QuizshowHostLobby>(
        harness.records,
        'lobby:update',
        roleRoom('hosts'),
      ).players[0]?.isConnected,
    ).toBe(true);
    harness.runtime.noteSocketDetached(SESSION_ID, alexId);
    expect(alex?.disconnectedAt).toBeNull();
    harness.runtime.noteSocketDetached(SESSION_ID, alexId);
    const lastDetachAt = Date.now();
    harness.runtime.noteSocketDetached(SESSION_ID, alexId);
    expect(alex?.connectedSocketCount).toBe(0);
    expect(alex?.disconnectedAt).toBe(lastDetachAt);

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

  it('leaves a game session open when an event is cancelled', async () => {
    const game = createGameHarness([[GAME_SESSION_ID, GAME_ID]]);
    await loadGameSession(game.runtime, game.random, GAME_SESSION_ID);

    await game.runtime.abandonSessionsOfEvents([EVENT_ID], START + 5000);

    expect(gameStateAt(game.states, 0).eventId).toBeNull();
    expect(gameStateAt(game.states, 0).status).toBe('lobby');
    expect(game.persistence.markAbandoned).not.toHaveBeenCalled();
  });

  it('abandons the stored and the loaded open sessions of a game once each', async () => {
    const game = createGameHarness([
      [GAME_SESSION_ID, GAME_ID],
      [OTHER_GAME_SESSION_ID, OTHER_GAME_ID],
    ]);
    await loadGameSession(game.runtime, game.random, GAME_SESSION_ID);
    await loadGameSession(game.runtime, game.random, OTHER_GAME_SESSION_ID);
    game.persistence.findOpenSessionIdsForGames.mockResolvedValue([
      GAME_SESSION_ID,
      UNLOADED_SESSION_ID,
    ]);
    const deletedAt = START + 5000;

    await game.runtime.abandonSessionsOfGames([GAME_ID], deletedAt);

    expect(game.persistence.findOpenSessionIdsForGames).toHaveBeenCalledWith([
      GAME_ID,
    ]);
    expect(gameStateAt(game.states, 0).status).toBe('abandoned');
    expect(gameStateAt(game.states, 1).status).toBe('lobby');
    expect(game.persistence.markAbandoned).toHaveBeenCalledTimes(1);
    expect(game.persistence.markAbandoned).toHaveBeenCalledWith(
      UNLOADED_SESSION_ID,
      new Date(deletedAt),
    );
  });

  it('abandons every open game session of an owner', async () => {
    const game = createGameHarness([
      [GAME_SESSION_ID, GAME_ID],
      [OTHER_GAME_SESSION_ID, OTHER_GAME_ID],
    ]);
    await loadGameSession(game.runtime, game.random, GAME_SESSION_ID);
    await loadGameSession(game.runtime, game.random, OTHER_GAME_SESSION_ID);
    game.persistence.findGameIdsOfOwner.mockResolvedValue([
      GAME_ID,
      OTHER_GAME_ID,
    ]);

    await game.runtime.abandonSessionsOfOwner(OWNER_USER_ID, START + 5000);

    expect(game.persistence.findGameIdsOfOwner).toHaveBeenCalledWith(
      OWNER_USER_ID,
    );
    expect(game.persistence.findOpenSessionIdsForGames).toHaveBeenCalledWith([
      GAME_ID,
      OTHER_GAME_ID,
    ]);
    expect(gameStateAt(game.states, 0).status).toBe('abandoned');
    expect(gameStateAt(game.states, 1).status).toBe('abandoned');
  });

  it('logs a failed abandon with its code and keeps going', async () => {
    const game = createGameHarness([[GAME_SESSION_ID, GAME_ID]]);
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    game.persistence.findOpenSessionIdsForGames.mockResolvedValue([
      UNLOADED_SESSION_ID,
      GAME_SESSION_ID,
    ]);
    game.persistence.isOpenSessionIdle.mockResolvedValue(false);
    game.persistence.markAbandoned.mockRejectedValueOnce(
      Object.assign(new Error('write failed'), { code: '40001' }),
    );

    await game.runtime.abandonSessionsOfGames([GAME_ID], START + 5000);

    expect(errorSpy).toHaveBeenCalledWith(
      `Pulse Live session ${UNLOADED_SESSION_ID} could not be abandoned: 40001`,
    );
    expect(game.persistence.markAbandoned).toHaveBeenCalledTimes(2);
    expect(game.persistence.markAbandoned).toHaveBeenLastCalledWith(
      GAME_SESSION_ID,
      new Date(START + 5000),
    );
  });

  it('withholds unrevealed podium places from screen and phones and shows hosts every place', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    const alexId = await joinPlayer(harness, 'user-alex', 'Alex');
    const beaId = await joinPlayer(harness, 'user-bea', 'Bea');
    const crisId = await joinPlayer(harness, 'user-cris', 'Cris');
    const { state } = harness;
    const placings: Array<[string, 1 | 2 | 3, number]> = [
      [alexId, 1, 300],
      [beaId, 2, 200],
      [crisId, 3, 100],
    ];
    state.podium = placings.map(
      ([playerId, place, score]): QuizshowPodiumEntry => {
        const player = state.players.get(playerId);
        if (player !== undefined) player.score = score;
        return {
          place,
          kind: 'player',
          entrantId: playerId,
          name: player?.screenName ?? '',
          colorKey: null,
          score,
        };
      },
    );
    state.status = 'running';
    state.cursor = {
      ...state.cursor,
      status: 'running',
      phase: 'podium',
      phaseId: '9',
      podiumRevealedCount: 1,
    };
    clearRecords(harness);

    await applyEffects(harness, [{ kind: 'podium_shown' }]);

    for (const role of ['screen', 'players'] as const) {
      const publicPodium = onlyPayload<QuizshowPodiumFrame>(
        harness.records,
        'podium',
        roleRoom(role),
      );
      expect(publicPodium.entries.map((entry) => entry.place)).toEqual([3]);
      expect(publicPodium.revealedCount).toBe(1);
    }
    const hostPodium = onlyPayload<QuizshowPodiumFrame>(
      harness.records,
      'podium',
      roleRoom('hosts'),
    );
    expect(
      hostPodium.entries
        .map((entry) => entry.place)
        .sort((first, second) => first - second),
    ).toEqual([1, 2, 3]);
  });

  it('ranks once per scores emit with 200 players', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    await joinPlayer(harness, 'user-alex', 'Alex');
    const { state } = harness;
    for (let playerNumber = 1; playerNumber <= 200; playerNumber += 1) {
      const playerId = `player-${playerNumber}`;
      state.players.set(
        playerId,
        livePlayer(playerId, {
          score: playerNumber * 10,
          joinedAt: START + playerNumber,
        }),
      );
    }
    state.status = 'running';
    state.cursor = {
      ...state.cursor,
      status: 'running',
      phase: 'leaderboard',
      phaseId: '9',
    };
    clearRecords(harness);
    const competitionRanksSpy = jest.spyOn(quizshowScoring, 'competitionRanks');

    await applyEffects(harness, [{ kind: 'scores_shown', scope: 'round' }]);

    expect(competitionRanksSpy).toHaveBeenCalledTimes(1);
    for (const role of ROLE_ROOMS) {
      expect(emitsOf(harness.records, 'scores', roleRoom(role))).toHaveLength(
        1,
      );
    }
    expect(emitsOf(harness.records, 'scores:mine')).toHaveLength(201);
  });

  it('sends reveal:mine to every eligible player after a rescore and to the favourite author alone', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    const alexId = await joinPlayer(harness, 'user-alex', 'Alex');
    const beaId = await joinPlayer(harness, 'user-bea', 'Bea');
    await openFirstQuestion(harness);
    await answerTrue(harness, alexId);
    await answerTrue(harness, beaId);
    expect(harness.state.cursor.phase).toBe('reveal');
    clearRecords(harness);

    await applyEffects(harness, [
      { kind: 'reveal_updated', scope: 'everyone' },
    ]);

    for (const role of ROLE_ROOMS) {
      expect(emitsOf(harness.records, 'reveal', roleRoom(role))).toHaveLength(
        1,
      );
    }
    for (const playerId of [alexId, beaId]) {
      expect(
        emitsOf(harness.records, 'reveal:mine', playerRoom(playerId)),
      ).toHaveLength(1);
    }

    clearRecords(harness);
    await applyEffects(harness, [
      { kind: 'reveal_updated', scope: 'favourite', playerId: alexId },
    ]);

    expect(
      emitsOf(harness.records, 'reveal:mine', playerRoom(alexId)),
    ).toHaveLength(1);
    expect(
      emitsOf(harness.records, 'reveal:mine', playerRoom(beaId)),
    ).toHaveLength(0);
  });

  it('sends typed answers to hosts alone when a type_answer question is revealed', async () => {
    const harness = createHarness([
      snapshotRound('round-1', 'quiz', [typeAnswerQuestion('question-1')]),
    ]);
    const alexId = await joinPlayer(harness, 'user-alex', 'Alex');
    await openFirstQuestion(harness);
    clearRecords(harness);

    await submit(harness, alexId, {
      type: 'type_answer',
      text: 'Stonewall Inn',
    });

    expect(harness.state.cursor.phase).toBe('reveal');
    expect(
      emitsOf(harness.records, 'typed:answers').map((record) => record.room),
    ).toEqual([roleRoom('hosts')]);

    clearRecords(harness);
    await applyEffects(harness, [{ kind: 'typed_answers_changed' }]);

    expect(
      emitsOf(harness.records, 'typed:answers').map((record) => record.room),
    ).toEqual([roleRoom('hosts')]);
  });

  it('coalesces reactions into one anonymous frame for screen and hosts', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    await joinPlayer(harness, 'user-alex', 'Alex');
    await jest.advanceTimersByTimeAsync(QUIZSHOW_LOBBY_THROTTLE_MS);
    clearRecords(harness);
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);

    await applyEffects(harness, [{ kind: 'reaction', reactionId: 'heart' }]);
    await applyEffects(harness, [{ kind: 'reaction', reactionId: 'heart' }]);
    await applyEffects(harness, [{ kind: 'reaction', reactionId: 'clap' }]);

    expect(emitsOf(harness.records, 'reactions')).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(QUIZSHOW_LIMITS.reactionsFrameMs);
    const frames = emitsOf(harness.records, 'reactions');
    expect(frames.map((record) => record.room)).toEqual([
      roleRoom('screen'),
      roleRoom('hosts'),
    ]);
    const expectedFrame: QuizshowReactionsFrame = {
      counts: { heart: 2, clap: 1 },
    };
    expect(frames[0]?.payload).toEqual(expectedFrame);
    expect(
      emitsOf(harness.records, 'reactions', roleRoom('players')),
    ).toHaveLength(0);
    expect(logSpy).not.toHaveBeenCalled();

    clearRecords(harness);
    await jest.advanceTimersByTimeAsync(QUIZSHOW_LIMITS.reactionsFrameMs);
    expect(emitsOf(harness.records, 'reactions')).toHaveLength(0);
  });

  it('sends a fresh session:state to every socket of the session for its role', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    const alexId = await joinPlayer(harness, 'user-alex', 'Alex');
    addSocket(harness, 'screen-socket', [roleRoom('screen')]);
    addSocket(
      harness,
      'alex-socket',
      [roleRoom('players'), playerRoom(alexId)],
      alexId,
    );
    addSocket(harness, 'visitor-socket', [roleRoom('players')]);
    addSocket(harness, 'host-socket', [roleRoom('hosts')]);
    clearRecords(harness);

    await applyEffects(harness, [{ kind: 'state_reset', scope: 'everyone' }]);

    expect(
      socketStatesOf(harness.records, 'screen-socket').map(
        (sessionState) => sessionState.role,
      ),
    ).toEqual(['screen']);
    expect(
      socketStatesOf(harness.records, 'host-socket').map(
        (sessionState) => sessionState.role,
      ),
    ).toEqual(['host']);
    const [alexState] = socketStatesOf(
      harness.records,
      'alex-socket',
    ) as QuizshowPlayerState[];
    expect(alexState?.me?.playerId).toBe(alexId);
    expect(alexState?.suggestedScreenName).toBe('Alex');
    const [visitorState] = socketStatesOf(
      harness.records,
      'visitor-socket',
    ) as QuizshowPlayerState[];
    expect(visitorState?.role).toBe('player');
    expect(visitorState?.me).toBeNull();
    expect(visitorState?.suggestedScreenName).toBe('');

    clearRecords(harness);
    await applyEffects(harness, [{ kind: 'state_reset', scope: 'hosts' }]);

    expect(
      harness.records.flatMap((record) =>
        record.kind === 'socket_emit' ? [record.socketId] : [],
      ),
    ).toEqual(['host-socket']);
  });

  it('unbinds every socket of a player who left', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    const alexId = await joinPlayer(harness, 'user-alex', 'Alex');
    const socketIds = ['alex-phone', 'alex-laptop'];
    const sockets = socketIds.map((socketId) =>
      addSocket(
        harness,
        socketId,
        [roleRoom('players'), playerRoom(alexId)],
        alexId,
      ),
    );
    harness.runtime.noteSocketAttached(SESSION_ID, alexId);
    harness.runtime.noteSocketAttached(SESSION_ID, alexId);
    clearRecords(harness);

    await applyEffects(harness, [{ kind: 'player_left', playerId: alexId }]);

    socketIds.forEach((socketId, index) => {
      expect(harness.records).toContainEqual({
        kind: 'socket_leave',
        socketId,
        room: playerRoom(alexId),
      });
      const socketData = sockets[index]?.data as
        { playerId: string | null } | undefined;
      expect(socketData?.playerId).toBeNull();
      const states = socketStatesOf(
        harness.records,
        socketId,
      ) as QuizshowPlayerState[];
      expect(states).toHaveLength(1);
      expect(states[0]?.me).toBeNull();
    });
    expect(harness.sockets.rooms.get(playerRoom(alexId))?.size).toBe(0);
    expect(harness.sockets.rooms.get(roleRoom('players'))?.size).toBe(2);
    const alex = harness.state.players.get(alexId);
    expect(alex?.connectedSocketCount).toBe(0);
    expect(alex?.disconnectedAt).toBe(Date.now());
  });

  it('unbinds a socket of the leaving player whose bind is still joining the private room', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    const alexId = await joinPlayer(harness, 'user-alex', 'Alex');
    const joiningSocket = addSocket(
      harness,
      'alex-joining',
      [roleRoom('players')],
      alexId,
    );
    harness.runtime.noteSocketAttached(SESSION_ID, alexId);
    clearRecords(harness);

    await applyEffects(harness, [{ kind: 'player_left', playerId: alexId }]);

    const socketData = joiningSocket.data as { playerId: string | null };
    expect(socketData.playerId).toBeNull();
    expect(harness.state.players.get(alexId)?.connectedSocketCount).toBe(0);
    const states = socketStatesOf(
      harness.records,
      'alex-joining',
    ) as QuizshowPlayerState[];
    expect(states).toHaveLength(1);
    expect(states[0]?.me).toBeNull();
  });

  it('unbinds a player removed with a rejoin like a leave and keeps them in the players room', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    const alexId = await joinPlayer(harness, 'user-alex', 'Alex');
    const socket = addSocket(
      harness,
      'alex-phone',
      [roleRoom('players'), playerRoom(alexId)],
      alexId,
    );
    harness.runtime.noteSocketAttached(SESSION_ID, alexId);
    clearRecords(harness);

    await applyEffects(harness, [
      { kind: 'player_removed', playerId: alexId, canRejoin: true },
    ]);

    expect(
      onlyPayload<{ sessionId: string; canRejoin: boolean }>(
        harness.records,
        'player:removed',
        playerRoom(alexId),
      ),
    ).toEqual({ sessionId: SESSION_ID, canRejoin: true });
    const removedIndex = indexOfEmit(
      harness.records,
      'player:removed',
      playerRoom(alexId),
    );
    const unbindIndex = harness.records.findIndex(
      (record) => record.kind === 'socket_leave',
    );
    expect(unbindIndex).toBeGreaterThan(removedIndex);
    expect(harness.records).toContainEqual({
      kind: 'socket_leave',
      socketId: 'alex-phone',
      room: playerRoom(alexId),
    });
    expect(
      harness.records.some(
        (record) =>
          record.kind === 'leave' ||
          (record.kind === 'socket_leave' &&
            record.room === roleRoom('players')),
      ),
    ).toBe(false);
    expect(
      harness.sockets.rooms.get(roleRoom('players'))?.has('alex-phone'),
    ).toBe(true);
    expect((socket.data as { playerId: string | null }).playerId).toBeNull();
    expect(harness.state.players.get(alexId)?.connectedSocketCount).toBe(0);
    const states = socketStatesOf(
      harness.records,
      'alex-phone',
    ) as QuizshowPlayerState[];
    expect(states).toHaveLength(1);
    expect(states[0]?.me).toBeNull();
  });

  it('evicts a player removed without a rejoin from every room of the session', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    const alexId = await joinPlayer(harness, 'user-alex', 'Alex');
    const socket = addSocket(
      harness,
      'alex-phone',
      [roleRoom('players'), playerRoom(alexId)],
      alexId,
    );
    clearRecords(harness);

    await applyEffects(harness, [
      { kind: 'player_removed', playerId: alexId, canRejoin: false },
    ]);

    expect(
      onlyPayload<{ sessionId: string; canRejoin: boolean }>(
        harness.records,
        'player:removed',
        playerRoom(alexId),
      ),
    ).toEqual({ sessionId: SESSION_ID, canRejoin: false });
    expect(harness.records).toContainEqual({
      kind: 'leave',
      room: playerRoom(alexId),
      rooms: [...ROLE_ROOMS.map(roleRoom), playerRoom(alexId)],
    });
    expect(
      harness.records.some((record) => record.kind === 'socket_leave'),
    ).toBe(false);
    expect((socket.data as { playerId: string | null }).playerId).toBe(alexId);
    expect(socketStatesOf(harness.records, 'alex-phone')).toHaveLength(0);
  });

  it('evicts a player who left and is then removed for good from the public rooms by member', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    const alexId = await joinPlayer(harness, 'user-alex', 'Alex');
    const phone = addSocket(
      harness,
      'alex-phone',
      [roleRoom('players'), playerRoom(alexId)],
      alexId,
    );
    Object.assign(phone.data as object, {
      userId: 'user-alex',
      role: 'player',
    });
    // Another member's phone and a host socket of the same member stay put.
    const otherPhone = addSocket(harness, 'bea-phone', [roleRoom('players')]);
    Object.assign(otherPhone.data as object, {
      userId: 'user-bea',
      role: 'player',
    });
    const hostRemote = addSocket(harness, 'alex-remote', [roleRoom('hosts')]);
    Object.assign(hostRemote.data as object, {
      userId: 'user-alex',
      role: 'host',
    });
    harness.runtime.noteSocketAttached(SESSION_ID, alexId);
    await applyEffects(harness, [{ kind: 'player_left', playerId: alexId }]);
    expect(
      harness.sockets.rooms.get(playerRoom(alexId))?.has('alex-phone'),
    ).toBe(false);
    clearRecords(harness);

    await applyEffects(harness, [
      { kind: 'player_removed', playerId: alexId, canRejoin: false },
    ]);

    expect(harness.records).toContainEqual({
      kind: 'socket_emit',
      socketId: 'alex-phone',
      event: 'player:removed',
      payload: { sessionId: SESSION_ID, canRejoin: false },
    });
    for (const role of ROLE_ROOMS) {
      expect(harness.records).toContainEqual({
        kind: 'socket_leave',
        socketId: 'alex-phone',
        room: roleRoom(role),
      });
    }
    expect(
      harness.sockets.rooms.get(roleRoom('players'))?.has('alex-phone'),
    ).toBe(false);
    expect(
      harness.sockets.rooms.get(roleRoom('players'))?.has('bea-phone'),
    ).toBe(true);
    expect(
      harness.sockets.rooms.get(roleRoom('hosts'))?.has('alex-remote'),
    ).toBe(true);
    expect(
      harness.records.some(
        (record) =>
          record.kind === 'socket_emit' &&
          record.socketId !== 'alex-phone' &&
          record.event === 'player:removed',
      ),
    ).toBe(false);
  });

  it('sends session flags to every role room', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    await joinPlayer(harness, 'user-alex', 'Alex');
    harness.state.isJoinLocked = true;
    clearRecords(harness);

    await applyEffects(harness, [{ kind: 'flags_changed' }]);

    for (const role of ROLE_ROOMS) {
      expect(
        onlyPayload<{ isJoinLocked: boolean; isAutoAdvanceOn: boolean }>(
          harness.records,
          'session:flags',
          roleRoom(role),
        ),
      ).toEqual({ isJoinLocked: true, isAutoAdvanceOn: false });
    }
  });

  it('counts paired device sockets and tells hosts', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    await joinPlayer(harness, 'user-alex', 'Alex');
    harness.state.pairedDevices.push({
      pairingId: 'pairing-1',
      kind: 'screen',
      helperUserId: null,
      helperName: null,
      pairedAt: START,
      revokedAt: null,
      connectedSocketCount: 0,
    });
    const device = harness.state.pairedDevices[0];
    clearRecords(harness);

    harness.runtime.noteDeviceSocketAttached(SESSION_ID, 'pairing-1');

    expect(device?.connectedSocketCount).toBe(1);
    expect(
      emitsOf(harness.records, 'devices:update').map((record) => record.room),
    ).toEqual([roleRoom('hosts')]);
    expect(
      onlyPayload<{ devices: QuizshowPairedDevice[] }>(
        harness.records,
        'devices:update',
        roleRoom('hosts'),
      ).devices,
    ).toEqual([
      expect.objectContaining({ pairingId: 'pairing-1', isConnected: true }),
    ]);

    clearRecords(harness);
    harness.runtime.noteDeviceSocketDetached(SESSION_ID, 'pairing-1');
    harness.runtime.noteDeviceSocketDetached(SESSION_ID, 'pairing-1');
    expect(device?.connectedSocketCount).toBe(0);
    // The second detach changed nothing, so hosts hear about the first only.
    expect(emitsOf(harness.records, 'devices:update')).toHaveLength(1);

    clearRecords(harness);
    harness.runtime.noteDeviceSocketAttached(SESSION_ID, 'pairing-unknown');
    harness.runtime.noteDeviceSocketAttached(UNLOADED_SESSION_ID, 'pairing-1');
    if (device !== undefined) device.revokedAt = START;
    harness.runtime.noteDeviceSocketAttached(SESSION_ID, 'pairing-1');
    expect(device?.connectedSocketCount).toBe(0);
    expect(emitsOf(harness.records, 'devices:update')).toHaveLength(0);

    await applyEffects(harness, [{ kind: 'devices_changed' }]);
    expect(
      emitsOf(harness.records, 'devices:update').map((record) => record.room),
    ).toEqual([roleRoom('hosts')]);
  });

  it('sends the rematch to the old session role rooms', () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    const rematch: QuizshowRematch = {
      fromSessionId: SESSION_ID,
      sessionId: 'session-rematch',
      joinCode: 'XYZ234',
      playMode: 'solo',
    };

    harness.runtime.emitRematch(SESSION_ID, rematch);

    for (const role of ROLE_ROOMS) {
      expect(
        onlyPayload<QuizshowRematch>(
          harness.records,
          'session:rematch',
          roleRoom(role),
        ),
      ).toEqual(rematch);
    }
  });

  it('re-arms the auto-advance timer of an untimed phase on load', async () => {
    const harness = createHarness([quizRound('round-1', ['question-1'])]);
    harness.state.status = 'running';
    harness.state.cursor = {
      ...harness.state.cursor,
      status: 'running',
      phase: 'round_intro',
      phaseId: '1',
      deadline: null,
      autoAdvanceAt: START + 8000,
    };

    await harness.runtime.getOrLoad(SESSION_ID);

    expect(jest.getTimerCount()).toBe(1);
  });
});
