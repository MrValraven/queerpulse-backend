import {
  QUIZSHOW_LIMITS,
  QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
  type QuizshowAckFailure,
  type QuizshowAnswerPayload,
  type QuizshowRoundKind,
  type QuizshowRoundSettings,
  type QuizshowWheelSpin,
} from './quizshow.contract';
import {
  hostAddTime,
  hostEnd,
  hostFinishWheel,
  hostNext,
  hostPause,
  hostRemovePlayer,
  hostResume,
  hostReveal,
  hostSkip,
  hostSpin,
  hostStart,
  timerElapsed,
  type QuizshowHostOutcome,
} from './quizshow-engine-phases';
import { createLobbyState, setSessionStatus } from './quizshow-engine-state';
import type {
  QuizshowEngineEffect,
  QuizshowLiveAnswer,
  QuizshowLivePlayer,
  QuizshowLiveQuestionPlay,
  QuizshowLiveState,
  QuizshowPersistOperation,
} from './quizshow-engine-types';
import type {
  QuizshowRandom,
  QuizshowSessionSnapshot,
  QuizshowSnapshotQuestion,
  QuizshowSnapshotRound,
} from './quizshow-snapshot';
import {
  drawnWheelSliceRoundIndexes,
  wheelBonusViewForCursor,
  wheelSpinEndAngle,
  type QuizshowWheelState,
} from './quizshow-wheel';

const STARTED_AT = 1_000_000;
const NOW = 2_000_000;
const HOST_USER_ID = 'host-user';
const SPIN_AT = NOW + 100_000;
const LANDS_AT = SPIN_AT + 5500;
const PLAYER_IDS = ['player-1', 'player-2'];

// Fixture builders and helpers, copied from the phases spec so the specs stay independent.

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
    prompt: { en: 'Write something', pt: 'Escreve algo' },
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

interface RoundOptions {
  title?: string;
  settings?: Partial<QuizshowRoundSettings>;
}

function snapshotRound(
  roundId: string,
  kind: QuizshowRoundKind,
  questions: QuizshowSnapshotQuestion[],
  options: RoundOptions = {},
): QuizshowSnapshotRound {
  const title = options.title ?? 'Round';
  return {
    id: roundId,
    kind,
    title: { en: title, pt: title },
    contentLabel: 'none',
    settings: {
      timeLimitSeconds: 20,
      isSpeedBonusOn: true,
      isJokerAllowed: true,
      writeSeconds: 60,
      voteSeconds: 30,
      ...QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
      ...options.settings,
    },
    questions,
  };
}

function quizRound(
  roundId: string,
  questionCount: number,
  options: RoundOptions = {},
): QuizshowSnapshotRound {
  const questions = Array.from({ length: questionCount }, (_unused, index) =>
    trueFalseQuestion(`${roundId}-question-${index}`),
  );
  return snapshotRound(roundId, 'quiz', questions, options);
}

function captionRound(
  roundId: string,
  options: RoundOptions = {},
): QuizshowSnapshotRound {
  return snapshotRound(
    roundId,
    'caption_this',
    [promptQuestion(`${roundId}-question-0`)],
    options,
  );
}

/** A wheel row: no questions, the five base settings plus the wheel settings. */
function wheelRound(
  roundId: string,
  settings: Partial<QuizshowRoundSettings>,
): QuizshowSnapshotRound {
  return snapshotRound(roundId, 'wheel', [], { title: 'Wheel', settings });
}

/** `integerBelow` hands out the scripted values in order (0 once they run out); uuids count up. */
function scriptedRandom(values: number[] = []): QuizshowRandom {
  const remainingValues = [...values];
  let uuidCount = 0;
  return {
    uuid: () => {
      uuidCount += 1;
      return `00000000-0000-4000-8000-${String(uuidCount).padStart(12, '0')}`;
    },
    integerBelow: () => remainingValues.shift() ?? 0,
  };
}

/** Night A: a pick a round wheel with a 500 bonus on Music. */
function nightA(): QuizshowSnapshotRound[] {
  return [
    quizRound('opener', 1, { title: 'Opener' }),
    wheelRound('wheel', { wheelPick: 'round', sliceCount: null }),
    quizRound('music', 1, { title: 'Music', settings: { wheelBonus: 500 } }),
    quizRound('film', 1, { title: 'Film', settings: { wheelBonus: 0 } }),
  ];
}

/**
 * Night B: a pick a question wheel with a 250 bonus on Music. With a finale
 * the wheel takes two slices, so a round remains after its range.
 */
function nightB(hasFinale = false): QuizshowSnapshotRound[] {
  return [
    quizRound('opener', 1, { title: 'Opener' }),
    wheelRound('wheel', {
      wheelPick: 'question',
      sliceCount: hasFinale ? 2 : null,
    }),
    quizRound('music', 2, { title: 'Music', settings: { wheelBonus: 250 } }),
    captionRound('captions', { title: 'Captions' }),
    ...(hasFinale ? [quizRound('finale', 1, { title: 'Finale' })] : []),
  ];
}

/** Night C: three quiz rounds and no wheel. */
function nightC(): QuizshowSnapshotRound[] {
  return [
    quizRound('first', 1, { title: 'First' }),
    quizRound('second', 1, { title: 'Second' }),
    quizRound('third', 1, { title: 'Third' }),
  ];
}

function stateWithQuiz(rounds: QuizshowSnapshotRound[]): QuizshowLiveState {
  const snapshot: QuizshowSessionSnapshot = {
    title: 'Pride night quiz',
    languages: 'both',
    screenLanguage: 'en',
    rounds,
  };
  return createLobbyState({
    sessionId: 'session-1',
    eventId: 'event-1',
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
    startedAt: STARTED_AT,
  });
}

function addPlayer(
  state: QuizshowLiveState,
  playerId: string,
  overrides: Partial<QuizshowLivePlayer> = {},
): QuizshowLivePlayer {
  const player: QuizshowLivePlayer = {
    playerId,
    userId: `${playerId}-user`,
    screenName: `${playerId} name`,
    teamId: null,
    isCohostPlayer: false,
    isAvatarShown: false,
    avatarUrl: null,
    hasExtraTime: false,
    score: 0,
    streak: 0,
    hasUsedJoker: false,
    jokerRoundIndex: null,
    joinedAt: STARTED_AT,
    removedAt: null,
    connectedSocketCount: 1,
    ...overrides,
  };
  state.players.set(playerId, player);
  return player;
}

function expectSuccess(outcome: QuizshowHostOutcome): {
  isNoop: boolean;
  effects: QuizshowEngineEffect[];
} {
  if (!outcome.ok) {
    throw new Error(`Expected success, got ${outcome.failure.code}`);
  }
  return { isNoop: outcome.success.isNoop, effects: outcome.effects };
}

function expectFailure(outcome: QuizshowHostOutcome): QuizshowAckFailure {
  if (outcome.ok) throw new Error('Expected a refusal');
  expect(outcome.effects).toEqual([]);
  return outcome.failure;
}

function requireNumber(value: number | null): number {
  if (value === null) throw new Error('Expected a number');
  return value;
}

function effectKinds(effects: QuizshowEngineEffect[]): string[] {
  return effects.map((effect) => effect.kind);
}

function findPersist<Type extends QuizshowPersistOperation['type']>(
  effects: QuizshowEngineEffect[],
  type: Type,
): Extract<QuizshowPersistOperation, { type: Type }> | undefined {
  for (const effect of effects) {
    if (effect.kind === 'persist' && effect.operation.type === type) {
      return effect.operation as Extract<
        QuizshowPersistOperation,
        { type: Type }
      >;
    }
  }
  return undefined;
}

function checkpointCount(effects: QuizshowEngineEffect[]): number {
  return effects.filter(
    (effect) =>
      effect.kind === 'persist' && effect.operation.type === 'checkpoint',
  ).length;
}

function currentPlay(state: QuizshowLiveState): QuizshowLiveQuestionPlay {
  if (state.current === null) throw new Error('Expected a question in play');
  return state.current;
}

function playerOf(
  state: QuizshowLiveState,
  playerId: string,
): QuizshowLivePlayer {
  const player = state.players.get(playerId);
  if (player === undefined) throw new Error(`Unknown player ${playerId}`);
  return player;
}

function openedWheel(state: QuizshowLiveState): QuizshowWheelState {
  const wheel = state.wheelProgress.wheel;
  if (wheel === null) throw new Error('Expected an open wheel');
  return wheel;
}

function requireSpin(wheel: QuizshowWheelState): QuizshowWheelSpin {
  if (wheel.spin === null) throw new Error('Expected a spin');
  return wheel.spin;
}

/** Stores an answer the way the players engine accepts one. */
function submit(
  state: QuizshowLiveState,
  playerId: string,
  payload: QuizshowAnswerPayload,
  now: number,
): QuizshowLiveAnswer {
  const play = currentPlay(state);
  const answer: QuizshowLiveAnswer = {
    answerId: `answer-${playerId}-${play.questionId}`,
    playerId,
    questionId: play.questionId,
    phaseId: state.cursor.phaseId,
    payload,
    receivedAt: now,
    elapsedMs:
      payload.type === 'prompt'
        ? null
        : now - requireNumber(state.cursor.phaseStartedAt),
    isCorrect: null,
    correctPositions: null,
    pointsAwarded: 0,
    streakBonus: 0,
    voteOptionId: null,
    hiddenAt: null,
  };
  play.answers.set(playerId, answer);
  return answer;
}

interface Clock {
  now: number;
}

function tick(clock: Clock, milliseconds = 1000): number {
  clock.now += milliseconds;
  return clock.now;
}

function nextPhase(
  state: QuizshowLiveState,
  now: number,
  random: QuizshowRandom = scriptedRandom(),
): { isNoop: boolean; effects: QuizshowEngineEffect[] } {
  return expectSuccess(hostNext(state, state.cursor.phaseId, now, random));
}

/** A lobby with two players, started at the clock's time. */
function startedNight(
  rounds: QuizshowSnapshotRound[],
  clock: Clock,
): QuizshowLiveState {
  const state = stateWithQuiz(rounds);
  for (const playerId of PLAYER_IDS) addPlayer(state, playerId);
  expectSuccess(hostStart(state, '0', clock.now));
  return state;
}

/** From `read`: opens, every player answers (true for the correct ones), the host reveals. */
function playQuestionFromRead(
  state: QuizshowLiveState,
  clock: Clock,
  correctPlayerIds: string[],
): void {
  expect(state.cursor.phase).toBe('read');
  clock.now = Math.max(clock.now, requireNumber(state.cursor.deadline));
  timerElapsed(state, state.cursor.phaseId, clock.now);
  expect(state.cursor.phase).toBe('open');
  for (const playerId of PLAYER_IDS) {
    submit(
      state,
      playerId,
      { type: 'true_false', isTrue: correctPlayerIds.includes(playerId) },
      tick(clock),
    );
  }
  expectSuccess(hostReveal(state, state.cursor.phaseId, tick(clock)));
  expect(state.cursor.phase).toBe('reveal');
}

/** From `round_intro` or `read` of a quiz question to its `scores`. */
function playQuizQuestionToScores(
  state: QuizshowLiveState,
  clock: Clock,
  correctPlayerIds: string[],
): void {
  if (state.cursor.phase === 'round_intro') nextPhase(state, tick(clock));
  playQuestionFromRead(state, clock, correctPlayerIds);
  nextPhase(state, tick(clock));
  expect(state.cursor.phase).toBe('scores');
}

/** Plays the current one-question quiz round and moves on from its scores. */
function playToLeaderboard(
  state: QuizshowLiveState,
  clock: Clock,
  correctPlayerIds: string[] = ['player-1'],
): QuizshowEngineEffect[] {
  playQuizQuestionToScores(state, clock, correctPlayerIds);
  return nextPhase(state, tick(clock)).effects;
}

/** Spins the open wheel onto a drawn slice, waits for the stop and starts the pick. */
function spinAndPick(
  state: QuizshowLiveState,
  clock: Clock,
  landedSliceIndex: number,
): QuizshowEngineEffect[] {
  const spinAt = tick(clock);
  expectSuccess(
    hostSpin(
      state,
      state.cursor.phaseId,
      spinAt,
      scriptedRandom([landedSliceIndex, 0, 500]),
    ),
  );
  clock.now = spinAt + QUIZSHOW_LIMITS.wheelSpinMs;
  return nextPhase(state, clock.now).effects;
}

/** Night A or B from the lobby to its wheel. */
function openFirstWheel(
  rounds: QuizshowSnapshotRound[],
  clock: Clock,
): QuizshowLiveState {
  const state = startedNight(rounds, clock);
  playToLeaderboard(state, clock);
  nextPhase(state, tick(clock));
  expect(state.cursor.phase).toBe('wheel');
  return state;
}

/** Night A to the leaderboard of Music, won by player-1. */
function playMusicSlice(clock: Clock): QuizshowLiveState {
  const state = openFirstWheel(nightA(), clock);
  spinAndPick(state, clock, 0);
  playToLeaderboard(state, clock);
  return state;
}

describe('Pulse Live engine phases: the wheel', () => {
  it('starts at the first step and counts it as round 1', () => {
    const state = startedNight(nightA(), { now: NOW });

    expect(state.cursor.phase).toBe('round_intro');
    expect(state.cursor.roundIndex).toBe(0);
    expect(state.wheelProgress.playedRoundIndexes).toEqual([0]);
    expect(state.cursor.roundNumber).toBe(1);
    expect(state.cursor.roundCount).toBe(3);
  });

  it('opens the wheel from the leaderboard before it', () => {
    const clock = { now: NOW };
    const state = startedNight(nightA(), clock);
    playToLeaderboard(state, clock);

    expect(state.cursor.phase).toBe('leaderboard');
    expect(state.cursor.upNext).toEqual({ kind: 'wheel', wheelRoundIndex: 1 });
    expect(state.cursor.canSpinForNextRound).toBe(false);

    nextPhase(state, tick(clock));

    expect(state.cursor.phase).toBe('wheel');
    expect(state.cursor.roundIndex).toBe(1);
    expect(state.cursor.questionIndex).toBeNull();
    expect(state.cursor.deadline).toBeNull();
    expect(openedWheel(state).sliceRoundIndexes).toEqual([2, 3]);
    expect(state.wheelProgress.openedWheelRoundIndexes).toEqual([1]);
  });

  it('opens a quiz that starts on a wheel', () => {
    const state = startedNight(
      [
        wheelRound('wheel', { wheelPick: 'round' }),
        quizRound('first', 1),
        quizRound('second', 1),
      ],
      { now: NOW },
    );

    expect(state.cursor.phase).toBe('wheel');
    expect(state.cursor.roundIndex).toBe(0);
    expect(state.wheelProgress.openedWheelRoundIndexes).toEqual([0]);
  });

  it('refuses next before a spin with the reason', () => {
    const clock = { now: NOW };
    const state = openFirstWheel(nightA(), clock);
    const phaseIdBefore = state.cursor.phaseId;

    const failure = expectFailure(
      hostNext(state, phaseIdBefore, tick(clock), scriptedRandom()),
    );

    expect(failure.code).toBe('quizshow_wheel_not_spun');
    expect(failure).not.toHaveProperty('cursor');
    expect(state.cursor.phaseId).toBe(phaseIdBefore);
  });

  it('spins as a new wheel phase decided by the server', () => {
    const state = openFirstWheel(nightA(), { now: NOW });
    const phaseIdBefore = state.cursor.phaseId;

    const outcome = expectSuccess(
      hostSpin(state, phaseIdBefore, SPIN_AT, scriptedRandom([1, 0, 500])),
    );

    const wheel = openedWheel(state);
    expect(outcome.isNoop).toBe(false);
    expect(state.cursor.phaseId).not.toBe(phaseIdBefore);
    expect(state.cursor.phase).toBe('wheel');
    expect(state.cursor.roundIndex).toBe(1);
    expect(state.cursor.phaseStartedAt).toBe(SPIN_AT);
    expect(wheel.spin).toEqual({
      landedSliceIndex: 1,
      startedAt: SPIN_AT,
      durationMs: 5500,
      turns: 5,
      jitterSeed: 500,
      startAngle: 0,
    });
    expect(wheel.restAngle).toBe(
      wheelSpinEndAngle(requireSpin(wheel), 2) % 360,
    );
    expect(effectKinds(outcome.effects)).toEqual(['phase_changed', 'persist']);
    expect(checkpointCount(outcome.effects)).toBe(1);
  });

  it('refuses spin and next while the wheel spins, and accepts next 250 ms before the stop', () => {
    const state = openFirstWheel(nightA(), { now: NOW });
    expectSuccess(
      hostSpin(state, state.cursor.phaseId, SPIN_AT, scriptedRandom([0, 0, 0])),
    );
    const spinBefore = { ...requireSpin(openedWheel(state)) };

    const spinning = expectFailure(
      hostSpin(
        state,
        state.cursor.phaseId,
        SPIN_AT + 1000,
        scriptedRandom([1, 1, 1]),
      ),
    );
    const early = expectFailure(
      hostNext(state, state.cursor.phaseId, LANDS_AT - 251, scriptedRandom()),
    );

    expect(spinning.code).toBe('quizshow_wheel_spinning');
    expect(spinning).not.toHaveProperty('cursor');
    expect(early.code).toBe('quizshow_wheel_spinning');
    expect(early).not.toHaveProperty('cursor');
    expect(openedWheel(state).spin).toEqual(spinBefore);

    expectSuccess(
      hostNext(state, state.cursor.phaseId, LANDS_AT - 250, scriptedRandom()),
    );
    expect(state.cursor.phase).toBe('round_intro');
  });

  it('spins once for a double tap', () => {
    const state = openFirstWheel(nightA(), { now: NOW });
    const phaseIdBeforeSpin = state.cursor.phaseId;
    expectSuccess(
      hostSpin(state, phaseIdBeforeSpin, SPIN_AT, scriptedRandom([1, 0, 500])),
    );
    const spinAfterFirst = { ...requireSpin(openedWheel(state)) };
    const phaseIdAfterFirst = state.cursor.phaseId;

    const second = expectSuccess(
      hostSpin(
        state,
        phaseIdBeforeSpin,
        SPIN_AT + 200,
        scriptedRandom([0, 1, 10]),
      ),
    );

    expect(second.isNoop).toBe(true);
    expect(openedWheel(state).spin).toEqual(spinAfterFirst);
    expect(state.cursor.phaseId).toBe(phaseIdAfterFirst);
  });

  it('spins again from where the wheel rests and keeps the spin number', () => {
    const state = openFirstWheel(nightA(), { now: NOW });
    expectSuccess(
      hostSpin(
        state,
        state.cursor.phaseId,
        SPIN_AT,
        scriptedRandom([1, 0, 500]),
      ),
    );
    const restAfterFirst = openedWheel(state).restAngle;

    expectSuccess(
      hostSpin(
        state,
        state.cursor.phaseId,
        LANDS_AT,
        scriptedRandom([0, 1, 250]),
      ),
    );

    const wheel = openedWheel(state);
    expect(requireSpin(wheel).startAngle).toBe(restAfterFirst);
    expect(requireSpin(wheel).startedAt).toBe(LANDS_AT);
    expect(
      drawnWheelSliceRoundIndexes(
        state.snapshot.rounds,
        wheel,
        state.wheelProgress,
      ),
    ).toEqual([2, 3]);
    expect(wheel.pickedCount).toBe(0);
  });

  it('starts the landed round with a baseline', () => {
    const state = openFirstWheel(nightA(), { now: NOW });
    expectSuccess(
      hostSpin(state, state.cursor.phaseId, SPIN_AT, scriptedRandom([0, 0, 0])),
    );
    const totalsBefore = {
      'player-1': playerOf(state, 'player-1').score,
      'player-2': playerOf(state, 'player-2').score,
    };
    expect(totalsBefore['player-1']).toBeGreaterThan(0);

    expectSuccess(
      hostNext(state, state.cursor.phaseId, LANDS_AT, scriptedRandom()),
    );

    const wheel = openedWheel(state);
    expect(state.cursor.phase).toBe('round_intro');
    expect(state.cursor.roundIndex).toBe(2);
    expect(state.wheelProgress.playedRoundIndexes).toEqual([0, 2]);
    expect(wheel.pickedCount).toBe(1);
    expect(wheel.playingRoundIndex).toBe(2);
    expect(wheel.baselineByEntrant).toEqual(totalsBefore);
    expect(wheel.spin).toBeNull();
    expect(wheel.restAngle).toBe(0);
    expect(state.cursor.roundNumber).toBe(2);
  });

  it("pays the slice bonus before the round's leaderboard and announces it there", () => {
    const clock = { now: NOW };
    const state = openFirstWheel(nightA(), clock);
    spinAndPick(state, clock, 0);
    playQuizQuestionToScores(state, clock, ['player-1']);
    const winnerScoreBefore = playerOf(state, 'player-1').score;
    const otherScoreBefore = playerOf(state, 'player-2').score;

    const leaderboard = nextPhase(state, tick(clock));

    expect(state.cursor.phase).toBe('leaderboard');
    expect(playerOf(state, 'player-1').score).toBe(winnerScoreBefore + 500);
    expect(playerOf(state, 'player-2').score).toBe(otherScoreBefore);
    expect(findPersist(leaderboard.effects, 'save_wheel_bonus')).toEqual({
      type: 'save_wheel_bonus',
      players: [{ playerId: 'player-1', score: winnerScoreBefore + 500 }],
      teams: [],
    });
    expect(effectKinds(leaderboard.effects)).toEqual(
      expect.arrayContaining(['lobby_changed', 'me_changed', 'scores_shown']),
    );
    expect(checkpointCount(leaderboard.effects)).toBe(1);
    expect(leaderboard.effects.at(-1)).toEqual({
      kind: 'persist',
      operation: { type: 'checkpoint' },
    });
    expect(state.wheelProgress.wheelBonusAward).toEqual({
      points: 500,
      pick: 'round',
      sliceRoundIndex: 2,
      sliceTitle: { en: 'Music', pt: 'Music' },
      winners: [
        {
          entrantId: 'player-1',
          kind: 'player',
          name: 'player-1 name',
          colorKey: null,
        },
      ],
      phaseId: state.cursor.phaseId,
    });
    expect(
      wheelBonusViewForCursor(state.wheelProgress, state.cursor),
    ).not.toBeNull();
    expect(openedWheel(state).playingRoundIndex).toBeNull();
    expect(openedWheel(state).baselineByEntrant).toBeNull();
  });

  it('keeps a pick a round slice leaderboard on the slice row', () => {
    const state = playMusicSlice({ now: NOW });

    expect(state.cursor.phase).toBe('leaderboard');
    expect(state.cursor.roundIndex).toBe(2);
  });

  it('returns to the same wheel with the played slice off it', () => {
    const clock = { now: NOW };
    const state = playMusicSlice(clock);
    const awardPhaseId = state.cursor.phaseId;
    expect(state.cursor.upNext).toEqual({ kind: 'wheel', wheelRoundIndex: 1 });

    nextPhase(state, tick(clock));

    const wheel = openedWheel(state);
    expect(state.cursor.phase).toBe('wheel');
    expect(state.cursor.roundIndex).toBe(1);
    expect(wheel.sliceRoundIndexes).toEqual([2, 3]);
    expect(wheel.spin).toBeNull();
    expect(wheel.restAngle).toBe(0);
    expect(
      drawnWheelSliceRoundIndexes(
        state.snapshot.rounds,
        wheel,
        state.wheelProgress,
      ),
    ).toEqual([3]);
    expect(state.cursor.phaseId).not.toBe(awardPhaseId);
    expect(
      wheelBonusViewForCursor(state.wheelProgress, state.cursor),
    ).toBeNull();
  });

  it('closes an exhausted wheel and shows a bonus leaderboard before the podium', () => {
    const bonusNight = (): QuizshowSnapshotRound[] => [
      quizRound('opener', 1),
      wheelRound('wheel', { wheelPick: 'round' }),
      quizRound('music', 1, { settings: { wheelBonus: 500 } }),
      quizRound('film', 1, { settings: { wheelBonus: 500 } }),
    ];
    const playBothSlices = (
      clock: Clock,
      lastCorrectPlayerIds: string[],
    ): QuizshowLiveState => {
      const state = openFirstWheel(bonusNight(), clock);
      spinAndPick(state, clock, 0);
      playToLeaderboard(state, clock);
      nextPhase(state, tick(clock));
      expect(state.cursor.phase).toBe('wheel');
      spinAndPick(state, clock, 0);
      expect(state.cursor.roundIndex).toBe(3);
      playToLeaderboard(state, clock, lastCorrectPlayerIds);
      return state;
    };

    const clock = { now: NOW };
    const wonState = playBothSlices(clock, ['player-1']);

    expect(wonState.cursor.phase).toBe('leaderboard');
    expect(wonState.wheelProgress.closedWheelRoundIndexes).toEqual([1]);
    expect(wonState.wheelProgress.wheel).toBeNull();
    expect(wonState.cursor.upNext).toEqual({ kind: 'podium' });

    nextPhase(wonState, tick(clock));
    expect(wonState.cursor.phase).toBe('podium');

    const unwonState = playBothSlices({ now: NOW }, []);

    expect(unwonState.cursor.phase).toBe('podium');
    expect(unwonState.wheelProgress.closedWheelRoundIndexes).toEqual([1]);
  });

  it('plays one question per spin on a pick a question wheel', () => {
    const clock = { now: NOW };
    const state = openFirstWheel(nightB(), clock);

    spinAndPick(state, clock, 0);

    expect(state.cursor.phase).toBe('read');
    expect(state.cursor.roundIndex).toBe(2);
    expect(state.cursor.questionIndex).toBe(0);
    expect(openedWheel(state).askedCounts).toEqual([1, 0]);
    expect(openedWheel(state).playingRoundIndex).toBe(2);

    playQuizQuestionToScores(state, clock, []);
    nextPhase(state, tick(clock));

    expect(state.cursor.phase).toBe('wheel');
    expect(state.cursor.roundIndex).toBe(1);
    expect(openedWheel(state).playingRoundIndex).toBeNull();

    spinAndPick(state, clock, 0);

    expect(state.cursor.phase).toBe('read');
    expect(state.cursor.roundIndex).toBe(2);
    expect(state.cursor.questionIndex).toBe(1);
    expect(openedWheel(state).askedCounts).toEqual([2, 0]);
  });

  it('pays the category bonus before returning to the wheel', () => {
    const clock = { now: NOW };
    const state = openFirstWheel(nightB(), clock);
    spinAndPick(state, clock, 0);
    playQuizQuestionToScores(state, clock, ['player-1']);
    const winnerScoreBefore = playerOf(state, 'player-1').score;

    const backToWheel = nextPhase(state, tick(clock));

    expect(state.cursor.phase).toBe('wheel');
    expect(playerOf(state, 'player-1').score).toBe(winnerScoreBefore + 250);
    expect(findPersist(backToWheel.effects, 'save_wheel_bonus')).toEqual({
      type: 'save_wheel_bonus',
      players: [{ playerId: 'player-1', score: winnerScoreBefore + 250 }],
      teams: [],
    });
    expect(checkpointCount(backToWheel.effects)).toBe(1);
    expect(state.wheelProgress.wheelBonusAward?.phaseId).toBe(
      state.cursor.phaseId,
    );
    expect(state.wheelProgress.wheelBonusAward?.pick).toBe('question');
    expect(
      wheelBonusViewForCursor(state.wheelProgress, state.cursor)?.points,
    ).toBe(250);
  });

  it('ends an exhausted pick a question wheel with a leaderboard on the wheel row', () => {
    const clock = { now: NOW };
    const state = openFirstWheel(nightB(true), clock);

    spinAndPick(state, clock, 0);
    playQuizQuestionToScores(state, clock, []);
    nextPhase(state, tick(clock));
    expect(state.cursor.phase).toBe('wheel');

    spinAndPick(state, clock, 1);
    expect(state.cursor.phase).toBe('write');
    expect(state.cursor.roundIndex).toBe(3);
    nextPhase(state, tick(clock));
    expect(state.cursor.phase).toBe('reveal');
    nextPhase(state, tick(clock));
    expect(state.cursor.phase).toBe('wheel');

    spinAndPick(state, clock, 0);
    expect(state.cursor.questionIndex).toBe(1);
    playQuizQuestionToScores(state, clock, []);
    nextPhase(state, tick(clock));

    expect(state.cursor.phase).toBe('leaderboard');
    expect(state.cursor.roundIndex).toBe(1);
    expect(state.wheelProgress.closedWheelRoundIndexes).toEqual([1]);
    expect(state.wheelProgress.wheel).toBeNull();
    expect(state.cursor.upNext).toEqual({ kind: 'round', roundIndex: 4 });
    expect(state.cursor.roundNumber).toBe(2);
    expect(state.cursor.roundCount).toBe(3);
  });

  it("counts the category bonus in the next question's previous scores", () => {
    const clock = { now: NOW };
    const state = openFirstWheel(nightB(), clock);
    spinAndPick(state, clock, 0);
    playQuizQuestionToScores(state, clock, ['player-1']);
    nextPhase(state, tick(clock));
    expect(state.cursor.phase).toBe('wheel');
    const winnerScoreWithBonus = playerOf(state, 'player-1').score;
    const otherScore = playerOf(state, 'player-2').score;

    spinAndPick(state, clock, 0);
    expect(state.cursor.questionIndex).toBe(1);
    playQuizQuestionToScores(state, clock, []);

    const previousByEntrant = state.lastScoresFrame?.previousByEntrant;
    expect(previousByEntrant?.get('player-1')).toBe(winnerScoreWithBonus);
    expect(previousByEntrant?.get('player-2')).toBe(otherScore);
    expect(playerOf(state, 'player-1').score).toBe(winnerScoreWithBonus);
  });

  it('ends an exhausted pick a question wheel with an award on a leaderboard, then the podium', () => {
    const clock = { now: NOW };
    const state = openFirstWheel(nightB(), clock);

    spinAndPick(state, clock, 0);
    playQuizQuestionToScores(state, clock, []);
    nextPhase(state, tick(clock));
    spinAndPick(state, clock, 1);
    expect(state.cursor.phase).toBe('write');
    nextPhase(state, tick(clock));
    nextPhase(state, tick(clock));
    expect(state.cursor.phase).toBe('wheel');

    spinAndPick(state, clock, 0);
    expect(state.cursor.questionIndex).toBe(1);
    playQuizQuestionToScores(state, clock, ['player-1']);
    const leaderboard = nextPhase(state, tick(clock));

    expect(state.cursor.phase).toBe('leaderboard');
    expect(state.cursor.roundIndex).toBe(1);
    expect(state.wheelProgress.closedWheelRoundIndexes).toEqual([1]);
    expect(state.wheelProgress.wheel).toBeNull();
    expect(state.cursor.upNext).toEqual({ kind: 'podium' });
    expect(findPersist(leaderboard.effects, 'save_wheel_bonus')).toBeDefined();
    expect(state.wheelProgress.wheelBonusAward?.phaseId).toBe(
      state.cursor.phaseId,
    );

    nextPhase(state, tick(clock));

    expect(state.cursor.phase).toBe('podium');
  });

  it('pays no bonus for a skipped wheel question', () => {
    const clock = { now: NOW };
    const state = openFirstWheel(nightB(), clock);
    spinAndPick(state, clock, 0);
    expect(state.cursor.phase).toBe('read');

    const skipped = expectSuccess(
      hostSkip(state, state.cursor.phaseId, tick(clock)),
    );

    expect(state.cursor.phase).toBe('wheel');
    expect(findPersist(skipped.effects, 'save_wheel_bonus')).toBeUndefined();
    expect(state.wheelProgress.wheelBonusAward).toBeNull();
  });

  it('finishes a pick a round wheel and moves straight on', () => {
    const clock = { now: NOW };
    const state = openFirstWheel(nightA(), clock);

    const finished = expectSuccess(
      hostFinishWheel(state, state.cursor.phaseId, tick(clock)),
    );

    expect(finished.isNoop).toBe(false);
    expect(state.wheelProgress.closedWheelRoundIndexes).toEqual([1]);
    expect(state.wheelProgress.wheel).toBeNull();
    expect(state.cursor.phase).toBe('podium');

    const finaleClock = { now: NOW };
    const finaleState = openFirstWheel(
      [
        quizRound('opener', 1),
        wheelRound('wheel', { wheelPick: 'round', sliceCount: 2 }),
        quizRound('music', 1),
        quizRound('film', 1),
        quizRound('finale', 1, { title: 'Finale' }),
      ],
      finaleClock,
    );

    const movedOn = expectSuccess(
      hostFinishWheel(
        finaleState,
        finaleState.cursor.phaseId,
        tick(finaleClock),
      ),
    );

    expect(finaleState.cursor.phase).toBe('round_intro');
    expect(finaleState.cursor.roundIndex).toBe(4);
    expect(effectKinds(movedOn.effects)).not.toContain('scores_shown');
    expect(finaleState.wheelProgress.playedRoundIndexes).toEqual([0, 4]);
  });

  it("finishes an unplanned wheel and opens upNext's round", () => {
    const clock = { now: NOW };
    const state = startedNight(nightC(), clock);
    playToLeaderboard(state, clock);
    expect(state.cursor.upNext).toEqual({ kind: 'round', roundIndex: 1 });
    expectSuccess(
      hostSpin(state, state.cursor.phaseId, SPIN_AT, scriptedRandom([1, 0, 0])),
    );

    expectSuccess(hostFinishWheel(state, state.cursor.phaseId, LANDS_AT));

    expect(state.cursor.phase).toBe('round_intro');
    expect(state.cursor.roundIndex).toBe(1);
    expect(state.wheelProgress.wheel).toBeNull();
    expect(state.wheelProgress.closedWheelRoundIndexes).toEqual([]);
    expect(state.wheelProgress.playedRoundIndexes).toEqual([0, 1]);
  });

  it('finishes the wheel while the spin is in the air', () => {
    const state = openFirstWheel(nightA(), { now: NOW });
    expectSuccess(
      hostSpin(state, state.cursor.phaseId, SPIN_AT, scriptedRandom([0, 0, 0])),
    );

    expectSuccess(hostFinishWheel(state, state.cursor.phaseId, SPIN_AT + 1000));

    expect(state.wheelProgress.wheel).toBeNull();
    expect(state.wheelProgress.closedWheelRoundIndexes).toEqual([1]);
  });

  it('finishes a pick a question wheel that played a question with a leaderboard', () => {
    const clock = { now: NOW };
    const state = openFirstWheel(nightB(true), clock);
    spinAndPick(state, clock, 0);
    playQuizQuestionToScores(state, clock, []);
    nextPhase(state, tick(clock));
    expect(state.cursor.phase).toBe('wheel');

    expectSuccess(hostFinishWheel(state, state.cursor.phaseId, tick(clock)));

    expect(state.cursor.phase).toBe('leaderboard');
    expect(state.cursor.roundIndex).toBe(1);
    expect(state.wheelProgress.closedWheelRoundIndexes).toEqual([1]);
    expect(state.cursor.upNext).toEqual({ kind: 'round', roundIndex: 4 });
  });

  it('refuses finish outside the wheel and while paused', () => {
    const clock = { now: NOW };
    const introState = startedNight(nightA(), clock);
    expect(introState.cursor.phase).toBe('round_intro');

    const outsideWheel = expectFailure(
      hostFinishWheel(introState, introState.cursor.phaseId, tick(clock)),
    );

    expect(outsideWheel.code).toBe('quizshow_command_not_allowed');
    expect(outsideWheel.cursor).toEqual(introState.cursor);

    const state = openFirstWheel(nightA(), clock);
    expectSuccess(hostPause(state, state.cursor.phaseId, tick(clock)));
    const phaseId = state.cursor.phaseId;

    const pausedRefusals = [
      expectFailure(hostSpin(state, phaseId, tick(clock), scriptedRandom())),
      expectFailure(hostNext(state, phaseId, tick(clock), scriptedRandom())),
      expectFailure(hostFinishWheel(state, phaseId, tick(clock))),
    ];

    for (const failure of pausedRefusals) {
      expect(failure.code).toBe('quizshow_command_not_allowed');
      expect(failure.cursor).toEqual(state.cursor);
    }
    expect(state.cursor.phase).toBe('wheel');
    expect(state.status).toBe('paused');
  });

  it('spins for the next round from a leaderboard in one tap', () => {
    const clock = { now: NOW };
    const state = startedNight(nightC(), clock);
    playToLeaderboard(state, clock);
    expect(state.cursor.canSpinForNextRound).toBe(true);
    const phaseCounterBefore = state.phaseCounter;

    expectSuccess(
      hostSpin(
        state,
        state.cursor.phaseId,
        SPIN_AT,
        scriptedRandom([1, 0, 500]),
      ),
    );

    const wheel = openedWheel(state);
    expect(state.cursor.phase).toBe('wheel');
    expect(state.cursor.roundIndex).toBeNull();
    expect(wheel.wheelRoundIndex).toBeNull();
    expect(wheel.sliceRoundIndexes).toEqual([1, 2]);
    expect(wheel.spin).not.toBeNull();
    expect(state.phaseCounter).toBe(phaseCounterBefore + 1);

    clock.now = LANDS_AT;
    nextPhase(state, clock.now);

    expect(state.cursor.phase).toBe('round_intro');
    expect(state.cursor.roundIndex).toBe(2);
    expect(state.wheelProgress.wheel).toBeNull();

    playToLeaderboard(state, clock);

    expect(state.cursor.phase).toBe('leaderboard');
    expect(state.cursor.upNext).toEqual({ kind: 'round', roundIndex: 1 });
  });

  it('refuses the unplanned spin with the specific reason', () => {
    const clock = { now: NOW };
    const beforeWheel = startedNight(nightA(), clock);
    playToLeaderboard(beforeWheel, clock);

    const wheelNext = expectFailure(
      hostSpin(
        beforeWheel,
        beforeWheel.cursor.phaseId,
        tick(clock),
        scriptedRandom(),
      ),
    );

    expect(wheelNext.code).toBe('quizshow_wheel_already_next');
    expect(wheelNext).not.toHaveProperty('cursor');

    const sliceLeaderboard = playMusicSlice({ now: NOW });
    expect(sliceLeaderboard.cursor.phase).toBe('leaderboard');

    const wheelOpen = expectFailure(
      hostSpin(
        sliceLeaderboard,
        sliceLeaderboard.cursor.phaseId,
        tick(clock),
        scriptedRandom(),
      ),
    );

    expect(wheelOpen.code).toBe('quizshow_wheel_already_next');
    expect(wheelOpen).not.toHaveProperty('cursor');

    const oneCandidate = startedNight(nightC(), clock);
    playToLeaderboard(oneCandidate, clock);
    nextPhase(oneCandidate, tick(clock));
    playToLeaderboard(oneCandidate, clock);
    expect(oneCandidate.cursor.phase).toBe('leaderboard');
    expect(oneCandidate.cursor.canSpinForNextRound).toBe(false);

    const tooFew = expectFailure(
      hostSpin(
        oneCandidate,
        oneCandidate.cursor.phaseId,
        tick(clock),
        scriptedRandom(),
      ),
    );

    expect(tooFew.code).toBe('quizshow_wheel_spin_too_few_rounds');
    expect(tooFew).not.toHaveProperty('cursor');
  });

  it('refuses a spin in other phases', () => {
    const clock = { now: NOW };
    const state = startedNight(nightA(), clock);

    const failure = expectFailure(
      hostSpin(state, state.cursor.phaseId, tick(clock), scriptedRandom()),
    );

    expect(failure.code).toBe('quizshow_command_not_allowed');
    expect(failure.cursor).toEqual(state.cursor);
  });

  it('pauses in the wheel without a timer and resumes without shifting the spin', () => {
    const state = openFirstWheel(nightA(), { now: NOW });
    expectSuccess(
      hostSpin(state, state.cursor.phaseId, SPIN_AT, scriptedRandom([0, 0, 0])),
    );

    const paused = expectSuccess(
      hostPause(state, state.cursor.phaseId, SPIN_AT + 1000),
    );

    expect(effectKinds(paused.effects)).not.toContain('timer_cleared');
    expect(state.status).toBe('paused');

    const resumeAt = SPIN_AT + 20_000;
    const resumed = expectSuccess(
      hostResume(state, state.cursor.phaseId, resumeAt),
    );

    expect(effectKinds(resumed.effects)).not.toContain('timer');
    expect(state.cursor.phaseStartedAt).toBe(SPIN_AT + 19_000);
    expect(requireSpin(openedWheel(state)).startedAt).toBe(SPIN_AT);

    expectSuccess(
      hostNext(state, state.cursor.phaseId, resumeAt, scriptedRandom()),
    );
    expect(state.cursor.phase).toBe('round_intro');
  });

  it('refuses skip and add time in the wheel', () => {
    const clock = { now: NOW };
    const state = openFirstWheel(nightA(), clock);

    const skip = expectFailure(
      hostSkip(state, state.cursor.phaseId, tick(clock)),
    );
    const addTime = expectFailure(
      hostAddTime(
        state,
        { phaseId: state.cursor.phaseId, seconds: 10, expectedDeadline: 0 },
        tick(clock),
      ),
    );

    expect(skip.code).toBe('quizshow_command_not_allowed');
    expect(addTime.code).toBe('quizshow_command_not_allowed');
  });

  it('ends to the podium from the wheel after a scored question', () => {
    const clock = { now: NOW };
    const state = openFirstWheel(nightA(), clock);

    expectSuccess(hostEnd(state, state.cursor.phaseId, tick(clock)));

    expect(state.cursor.phase).toBe('podium');
  });

  it('replays a wheel question after a restart without drawing it again', () => {
    const clock = { now: NOW };
    const state = openFirstWheel(nightB(), clock);
    spinAndPick(state, clock, 0);
    clock.now = requireNumber(state.cursor.deadline);
    timerElapsed(state, state.cursor.phaseId, clock.now);
    expect(state.cursor.phase).toBe('open');
    // What a reload after a restart leaves: paused, flagged for a replay.
    setSessionStatus(state, 'paused');
    state.pausedAt = clock.now;
    state.cursor.isRestartRecovery = true;

    expectSuccess(hostResume(state, state.cursor.phaseId, tick(clock)));

    expect(state.cursor.phase).toBe('read');
    expect(state.cursor.roundIndex).toBe(2);
    expect(state.cursor.questionIndex).toBe(0);
    expect(openedWheel(state).askedCounts).toEqual([1, 0]);

    playQuizQuestionToScores(state, clock, []);
    nextPhase(state, tick(clock));

    expect(state.cursor.phase).toBe('wheel');
    expect(state.cursor.roundIndex).toBe(1);
  });

  it('keeps the award when the winner is removed on the leaderboard', () => {
    const clock = { now: NOW };
    const state = playMusicSlice(clock);
    const awardBefore = structuredClone(state.wheelProgress.wheelBonusAward);
    expect(awardBefore).not.toBeNull();
    const winnerScore = playerOf(state, 'player-1').score;
    const otherScore = playerOf(state, 'player-2').score;

    expectSuccess(
      hostRemovePlayer(state, 'player-1', HOST_USER_ID, tick(clock)),
    );

    expect(state.wheelProgress.wheelBonusAward).toEqual(awardBefore);
    expect(playerOf(state, 'player-1').score).toBe(winnerScore);
    expect(playerOf(state, 'player-2').score).toBe(otherScore);
  });
});
