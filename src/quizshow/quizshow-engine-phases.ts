/**
 * Pulse Live (`quizshow`) engine phases: the phase machine of one live
 * session. Host commands, timers, early closes, scoring at reveal, scores,
 * leaderboard and podium, the wheel (spins, picks, slice bonuses and the
 * early finish), the end of the night and abandonment. Pure: every time comes
 * in as a `now` argument and randomness through `QuizshowRandom`.
 */
import type { QuizshowStoredPodiumEntry } from './entities/quizshow-result.entity';
import {
  QUIZSHOW_LIMITS,
  QUIZSHOW_TIMED_PHASES,
  type QuizshowPhase,
  type QuizshowPodiumEntry,
  type QuizshowScoresScope,
  type QuizshowSessionStatus,
  type QuizshowUpNext,
  type QuizshowWheelBonusView,
} from './quizshow.contract';
import {
  activePlayers,
  advanceCursor,
  buildRankIndex,
  eligiblePlayersNow,
  entrantTotals,
  isActivePlayer,
  isAwayAt,
  isJokerActiveFor,
  ownDeadline,
  persist,
  podiumSteps,
  refuse,
  setSessionStatus,
  statusRefusalCode,
  succeed,
} from './quizshow-engine-state';
import {
  dropEmptyLobbyTeams,
  foldNameKey,
  textRefusal,
} from './quizshow-engine-players';
import {
  applyWheelBonus,
  type QuizshowWheelBonusResult,
} from './quizshow-engine-wheel';
import type {
  QuizshowCommandOutcome,
  QuizshowEngineEffect,
  QuizshowLiveAnswer,
  QuizshowLivePlayer,
  QuizshowLiveQuestionPlay,
  QuizshowLiveState,
  QuizshowLiveVoteOption,
  QuizshowPersistOperation,
  QuizshowQuestionLogEntry,
} from './quizshow-engine-types';
import {
  closestNumberOutcomes,
  scoreLieDetectorVotes,
  scorePartyVotes,
  scoreQuizAnswer,
  teamQuestionPoints,
} from './quizshow-scoring';
import {
  CRYPTO_RANDOM,
  effectiveAnswerKey,
  extraTimeMs,
  isLastQuestionOfRound,
  openLimitMs,
  readPhaseMsFor,
  shuffleAvoidingOrder,
  snapshotQuestionAt,
  voteLimitMs,
  writeLimitMs,
  type QuizshowRandom,
  type QuizshowSnapshotQuestion,
  type QuizshowSnapshotRound,
} from './quizshow-snapshot';
import {
  createWheelState,
  drawnWheelSliceRoundIndexes,
  drawWheelSpin,
  isInWheelRange,
  isQuizRoundKind,
  isWheelExhausted,
  isWheelRoundKind,
  isWheelSpinLanded,
  nextQuizshowStep,
  unplannedWheelSliceRoundIndexes,
  wheelAngleModulo,
  wheelRoundIndexOfRange,
  wheelSliceRoundIndexes,
  wheelSpinEndAngle,
  withWheelSettingsDefaults,
  type QuizshowWheelState,
} from './quizshow-wheel';

/** Host commands that move the cursor and share the no-op rule. */
export const QUIZSHOW_MOVING_COMMANDS = [
  'start',
  'next',
  'reveal',
  'skip',
  'show_answers',
  'end',
  'spin',
  'finish_wheel',
] as const;

export type QuizshowHostOutcome = QuizshowCommandOutcome<{ isNoop: boolean }>;

/** Phases that belong to one question before its reveal; a restart replays them. */
const QUESTION_PHASES: readonly QuizshowPhase[] = [
  'read',
  'open',
  'write',
  'review',
  'vote',
];

/** Phases that take answers or votes and close early once everyone is done. */
const SUBMISSION_PHASES: readonly QuizshowPhase[] = ['open', 'write', 'vote'];

const OPEN_STATUSES: readonly QuizshowSessionStatus[] = [
  'lobby',
  'running',
  'paused',
];

function isTimedPhase(phase: QuizshowPhase): boolean {
  return (QUIZSHOW_TIMED_PHASES as readonly QuizshowPhase[]).includes(phase);
}

function isOpenStatus(status: QuizshowSessionStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export function checkpoint(): QuizshowEngineEffect {
  return persist({ type: 'checkpoint' });
}

function isCheckpointEffect(effect: QuizshowEngineEffect): boolean {
  return effect.kind === 'persist' && effect.operation.type === 'checkpoint';
}

/** Keeps one checkpoint, at the end, when the effects hold any. */
function withSingleCheckpoint(
  effects: QuizshowEngineEffect[],
): QuizshowEngineEffect[] {
  if (!effects.some(isCheckpointEffect)) return effects;
  return [
    ...effects.filter((effect) => !isCheckpointEffect(effect)),
    checkpoint(),
  ];
}

/** Every host command attempt, refused or not, resets the abandonment clock: it measures host presence. */
export function noteHostCommand(state: QuizshowLiveState, now: number): void {
  state.lastHostCommandAt = now;
}

/** A host command that acted or was a no-op: ends on one checkpoint. */
export function hostActed(
  state: QuizshowLiveState,
  now: number,
  effects: QuizshowEngineEffect[],
  isNoop: boolean,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  return succeed({ isNoop }, [
    ...effects.filter((effect) => !isCheckpointEffect(effect)),
    checkpoint(),
  ]);
}

/** The no-op and stale rule shared by every moving command. */
function checkMovingCommand(
  state: QuizshowLiveState,
  phaseId: string,
): 'act' | 'noop' | 'stale' {
  if (phaseId === state.cursor.phaseId) return 'act';
  if (state.lastTransition?.fromPhaseId === phaseId) return 'noop';
  return 'stale';
}

export interface QuizshowPlayContext {
  play: QuizshowLiveQuestionPlay;
  round: QuizshowSnapshotRound;
  question: QuizshowSnapshotQuestion;
}

/** The question in play with its round; a missing one breaks an engine invariant. */
export function currentPlayContext(
  state: QuizshowLiveState,
): QuizshowPlayContext {
  const play = state.current;
  if (play === null) {
    throw new Error(
      `Pulse Live session ${state.sessionId} has no question in play.`,
    );
  }
  const round = state.snapshot.rounds[play.roundIndex];
  const question = round?.questions[play.questionIndex];
  if (round === undefined || question === undefined) {
    throw new Error(
      `Pulse Live session ${state.sessionId} names a question outside its snapshot.`,
    );
  }
  return { play, round, question };
}

export function isQuizRoundInPlay(state: QuizshowLiveState): boolean {
  const roundIndex = state.cursor.roundIndex ?? state.current?.roundIndex;
  if (roundIndex === undefined) return false;
  const round = state.snapshot.rounds[roundIndex];
  return round !== undefined && isQuizRoundKind(round.kind);
}

function findLogEntry(
  state: QuizshowLiveState,
  questionId: string,
): QuizshowQuestionLogEntry | undefined {
  for (let index = state.questionLog.length - 1; index >= 0; index -= 1) {
    const entry = state.questionLog[index];
    if (entry !== undefined && entry.questionId === questionId) return entry;
  }
  return undefined;
}

/** One map read: `answersById` is kept in step with `answers` (contract 7.1). */
function findAnswer(
  play: QuizshowLiveQuestionPlay,
  answerId: string,
): QuizshowLiveAnswer | undefined {
  return play.answersById.get(answerId);
}

function isOptionVisible(
  play: QuizshowLiveQuestionPlay,
  option: QuizshowLiveVoteOption,
): boolean {
  if (option.answerId === null) return true;
  return findAnswer(play, option.answerId)?.hiddenAt === null;
}

/** The timer of the current timed phase: `read` fires at its deadline, the others after the answer grace. */
function phaseTimer(state: QuizshowLiveState): QuizshowEngineEffect[] {
  const { deadline, phase, phaseId } = state.cursor;
  if (deadline === null) return [];
  const fireAt =
    phase === 'read' ? deadline : deadline + QUIZSHOW_LIMITS.answerGraceMs;
  return [{ kind: 'timer', phaseId, fireAt }];
}

/** Eligible, still active, and without an answer (`open`, `write`) or a vote (`vote`) for the current question. */
function isStillToSubmit(state: QuizshowLiveState, playerId: string): boolean {
  const play = state.current;
  if (play === null || !play.eligiblePlayerIds.has(playerId)) return false;
  const player = state.players.get(playerId);
  if (player === undefined || !isActivePlayer(player)) return false;
  return state.cursor.phase === 'vote'
    ? !play.votes.has(playerId)
    : !play.answers.has(playerId);
}

/** Still to submit and still allowed to: their own deadline plus the grace has not passed (the players engine refuses them after it). */
function isAwaitedSubmitter(
  state: QuizshowLiveState,
  playerId: string,
  now: number,
): boolean {
  if (!isStillToSubmit(state, playerId)) return false;
  const deadline = ownDeadline(state, playerId);
  return deadline === null || now <= deadline + QUIZSHOW_LIMITS.answerGraceMs;
}

/**
 * Opens a question at its first phase and freezes who may play it: every
 * active player who is not away (contract 6.2). A quiz round reads for a
 * length scaled to the text (contract 6.12); in teams play a talk beat follows
 * the read inside the same phase (contract 6.20).
 */
function openQuestion(
  state: QuizshowLiveState,
  roundIndex: number,
  questionIndex: number,
  now: number,
): QuizshowEngineEffect[] {
  const round = state.snapshot.rounds[roundIndex];
  const question = round?.questions[questionIndex];
  if (round === undefined || question === undefined) {
    throw new Error(
      `Pulse Live session ${state.sessionId} has no question ${roundIndex}.${questionIndex}.`,
    );
  }
  const activePlayersAtOpen = activePlayers(state);
  const eligiblePlayers: QuizshowLivePlayer[] = [];
  const awayPlayerIds = new Set<string>();
  for (const player of activePlayersAtOpen) {
    if (isAwayAt(player, now)) awayPlayerIds.add(player.playerId);
    else eligiblePlayers.push(player);
  }
  state.current = {
    questionId: question.id,
    roundIndex,
    questionIndex,
    openedAt: now,
    eligiblePlayerIds: new Set(
      eligiblePlayers.map((player) => player.playerId),
    ),
    extraTimePlayerIds: new Set(
      eligiblePlayers
        .filter((player) => player.hasExtraTime)
        .map((player) => player.playerId),
    ),
    answers: new Map(),
    votes: new Map(),
    voteOptions: null,
    favouriteOptionId: null,
    isScored: false,
    wasSkipped: false,
    pointsByPlayer: new Map(),
    teamPoints: new Map(),
    answersById: new Map(),
    awayPlayerIds,
    streakBeforeByPlayer: new Map(),
    keyOverride: null,
    acceptedTexts: new Set(),
    wasCorrected: false,
  };
  state.questionLog.push({
    questionId: question.id,
    roundIndex,
    questionIndex,
    roundKind: round.kind,
    type: question.type,
    openedAt: now,
    revealedAt: null,
    eligibleCount: eligiblePlayers.length,
    wasSkipped: false,
  });
  const isQuiz = isQuizRoundKind(round.kind);
  const readMs = isQuiz
    ? readPhaseMsFor(question, state.snapshot.languages)
    : 0;
  const talkMs =
    isQuiz && state.playMode === 'teams'
      ? round.settings.talkSeconds * 1000
      : 0;
  const limitMs = isQuiz ? readMs + talkMs : writeLimitMs(round);
  advanceCursor(state, {
    phase: isQuiz ? 'read' : 'write',
    roundIndex,
    questionIndex,
    now,
    durationMs: limitMs,
    extraTimeMs: isQuiz ? null : extraTimeMs(limitMs),
  });
  // advanceCursor clears the talk beat on every transition, so it is set right after.
  if (talkMs > 0 && state.cursor.phaseStartedAt !== null) {
    state.cursor.talkStartsAt = state.cursor.phaseStartedAt + readMs;
  }
  return [
    { kind: 'phase_changed' },
    { kind: 'answer_count_changed' },
    ...phaseTimer(state),
    checkpoint(),
  ];
}

/** `read` to `open` with the question's limit and its extra time. */
function openAnswers(
  state: QuizshowLiveState,
  now: number,
): QuizshowEngineEffect[] {
  const { play, round, question } = currentPlayContext(state);
  const limitMs = openLimitMs(round, question);
  advanceCursor(state, {
    phase: 'open',
    roundIndex: play.roundIndex,
    questionIndex: play.questionIndex,
    now,
    durationMs: limitMs,
    extraTimeMs: extraTimeMs(limitMs),
  });
  return [{ kind: 'phase_changed' }, ...phaseTimer(state), checkpoint()];
}

/**
 * How long the current phase waits before it moves on by itself (contract
 * 6.16): the round intro, a quiz or Lie Detector reveal and a question's
 * scores. Caption This and Drag Name reveals wait for the host to pick a
 * favourite and every other phase waits for the host, so they answer null.
 */
function autoAdvanceWaitMsOf(state: QuizshowLiveState): number | null {
  const { phase, roundIndex } = state.cursor;
  if (phase === 'round_intro') return QUIZSHOW_LIMITS.autoAdvanceRoundIntroMs;
  if (phase === 'scores') return QUIZSHOW_LIMITS.autoAdvanceScoresMs;
  if (phase !== 'reveal' || roundIndex === null) return null;
  const roundKind = state.snapshot.rounds[roundIndex]?.kind;
  return roundKind === 'quiz' || roundKind === 'lie_detector'
    ? QUIZSHOW_LIMITS.autoAdvanceRevealMs
    : null;
}

/**
 * Sets `autoAdvanceAt` to `startsAt` plus the phase's wait and asks for its
 * timer, when auto-advance is on, the session runs and the phase qualifies.
 * Anything else leaves the cursor alone and returns no effect.
 */
function armAutoAdvanceFrom(
  state: QuizshowLiveState,
  startsAt: number | null,
): QuizshowEngineEffect[] {
  const waitMs = autoAdvanceWaitMsOf(state);
  if (
    !state.isAutoAdvanceOn ||
    state.status !== 'running' ||
    waitMs === null ||
    startsAt === null
  ) {
    return [];
  }
  const { cursor } = state;
  cursor.autoAdvanceAt = startsAt + waitMs;
  return [
    { kind: 'timer', phaseId: cursor.phaseId, fireAt: cursor.autoAdvanceAt },
  ];
}

/** On entering a phase the wait counts from its start; call right after `advanceCursor`, which clears the field. */
function armAutoAdvance(state: QuizshowLiveState): QuizshowEngineEffect[] {
  return armAutoAdvanceFrom(state, state.cursor.phaseStartedAt);
}

function openRoundIntro(
  state: QuizshowLiveState,
  roundIndex: number,
  now: number,
): QuizshowEngineEffect[] {
  advanceCursor(state, {
    phase: 'round_intro',
    roundIndex,
    questionIndex: null,
    now,
    durationMs: null,
    extraTimeMs: null,
  });
  return [{ kind: 'phase_changed' }, ...armAutoAdvance(state), checkpoint()];
}

export function totalsByEntrant(state: QuizshowLiveState): Map<string, number> {
  return new Map(
    entrantTotals(state).map((entrant) => [entrant.entrantId, entrant.score]),
  );
}

/** Remembers the frame's previous scores, then the totals it shows. */
function recordScoresFrame(
  state: QuizshowLiveState,
  scope: QuizshowScoresScope,
): void {
  state.lastScoresFrame = {
    phaseId: state.cursor.phaseId,
    scope,
    previousByEntrant: new Map(state.scoresAtLastFrame),
  };
  state.scoresAtLastFrame = totalsByEntrant(state);
}

/**
 * `scores` keeps the question's indices; `leaderboard` names the round that
 * ended, which a closing wheel passes in as its own row.
 */
export function showScores(
  state: QuizshowLiveState,
  phase: 'scores' | 'leaderboard',
  scope: QuizshowScoresScope,
  now: number,
  roundIndex: number | null = state.cursor.roundIndex,
): QuizshowEngineEffect[] {
  const { questionIndex } = state.cursor;
  advanceCursor(state, {
    phase,
    roundIndex,
    questionIndex: phase === 'scores' ? questionIndex : null,
    now,
    durationMs: null,
    extraTimeMs: null,
  });
  recordScoresFrame(state, scope);
  return [
    { kind: 'phase_changed' },
    { kind: 'scores_shown', scope },
    ...armAutoAdvance(state),
    checkpoint(),
  ];
}

function podiumPlaceOf(rank: number): 1 | 2 | 3 | null {
  return rank === 1 || rank === 2 || rank === 3 ? rank : null;
}

/** Every entrant ranked 3 or better, ties sharing a place; ranks come from one rank index (contract 7.1). */
function buildPodium(state: QuizshowLiveState): QuizshowPodiumEntry[] {
  return buildRankIndex(state).ranked.flatMap(
    (entry): QuizshowPodiumEntry[] => {
      const place = podiumPlaceOf(entry.rank);
      if (place === null) return [];
      return [
        {
          place,
          kind: entry.kind,
          entrantId: entry.entrantId,
          name: entry.name,
          colorKey: entry.colorKey,
          score: entry.score,
        },
      ];
    },
  );
}

/** Every active player's place: their own in solo play, their team's in teams play; ranks come from one rank index (contract 7.1). */
function buildPlacings(state: QuizshowLiveState): Record<string, number> {
  const { rankByEntrantId } = buildRankIndex(state);
  const placings: Record<string, number> = {};
  for (const player of activePlayers(state)) {
    const entrantId =
      state.playMode === 'solo' ? player.playerId : player.teamId;
    const rank =
      entrantId === null ? undefined : rankByEntrantId.get(entrantId);
    if (rank !== undefined) placings[player.playerId] = rank;
  }
  return placings;
}

function showPodium(
  state: QuizshowLiveState,
  now: number,
): QuizshowEngineEffect[] {
  state.status = 'running';
  state.pausedAt = null;
  advanceCursor(state, {
    phase: 'podium',
    roundIndex: null,
    questionIndex: null,
    now,
    durationMs: null,
    extraTimeMs: null,
  });
  recordScoresFrame(state, 'final');
  state.podium = buildPodium(state);
  // The host reveals the places one by one from step 0 (contract 6.7).
  state.cursor.podiumRevealedCount = 0;
  return [
    { kind: 'phase_changed' },
    // host:end can arrive from a timed phase; the podium has no deadline.
    { kind: 'timer_cleared' },
    { kind: 'scores_shown', scope: 'final' },
    { kind: 'podium_shown' },
    checkpoint(),
  ];
}

/**
 * `host:next` on the podium shows the next place, 3rd first (contract 6.7).
 * Each step is a new podium phase, so the moving command rule and double taps
 * work as on any other phase. Null once every step is shown: the night ends.
 */
function revealNextPodiumStep(
  state: QuizshowLiveState,
  now: number,
): QuizshowEngineEffect[] | null {
  const stepCount = podiumSteps(state).length;
  // A podium loaded with no count shows every place, as it did before the paced reveal.
  const revealedCount = state.cursor.podiumRevealedCount ?? stepCount;
  if (revealedCount >= stepCount) return null;
  const finalScoresFrame = state.lastScoresFrame;
  advanceCursor(state, {
    phase: 'podium',
    roundIndex: null,
    questionIndex: null,
    now,
    durationMs: null,
    extraTimeMs: null,
  });
  state.cursor.podiumRevealedCount = revealedCount + 1;
  // The final scores still count up from the totals before the podium, so the frame moves to the new phase id.
  if (finalScoresFrame !== null && finalScoresFrame.scope === 'final') {
    finalScoresFrame.phaseId = state.cursor.phaseId;
  }
  return [
    { kind: 'phase_changed' },
    { kind: 'podium_shown' },
    { kind: 'scores_shown', scope: 'final' },
    checkpoint(),
  ];
}

/**
 * On the podium a removal or a withdrawal reorders it; anywhere else nothing
 * to do. The reveal keeps only the leading steps of the new podium whose
 * places were already shown, so a place the host has not revealed yet never
 * shows (contract 6.7).
 */
export function refreshPodiumIfShown(
  state: QuizshowLiveState,
): QuizshowEngineEffect[] {
  if (state.cursor.phase !== 'podium') return [];
  const { cursor } = state;
  // A null count is a legacy podium that withholds nothing, so it stays null.
  if (cursor.podiumRevealedCount === null) {
    state.podium = buildPodium(state);
    return [{ kind: 'podium_shown' }];
  }
  const previousSteps = podiumSteps(state);
  const previousCount = cursor.podiumRevealedCount;
  const shownPlaces = new Set<number>(previousSteps.slice(0, previousCount));
  state.podium = buildPodium(state);
  const nextSteps = podiumSteps(state);
  let nextCount = 0;
  while (
    nextCount < nextSteps.length &&
    shownPlaces.has(nextSteps[nextCount] ?? 0)
  ) {
    nextCount += 1;
  }
  if (nextCount === previousCount) return [{ kind: 'podium_shown' }];
  cursor.podiumRevealedCount = nextCount;
  // The count lives on the cursor, so remotes get it with a fresh phase frame.
  return [{ kind: 'phase_changed' }, { kind: 'podium_shown' }];
}

/** The open wheel; the `wheel` phase with none open breaks an engine invariant. */
function openedWheelOf(state: QuizshowLiveState): QuizshowWheelState {
  const wheel = state.wheelProgress.wheel;
  if (wheel === null) {
    throw new Error(
      `Pulse Live session ${state.sessionId} is in the wheel phase with no wheel open.`,
    );
  }
  return wheel;
}

/** What `host:next` opens from the lobby or a leaderboard. */
function openStep(
  state: QuizshowLiveState,
  step: QuizshowUpNext,
  now: number,
): QuizshowEngineEffect[] {
  switch (step.kind) {
    case 'round':
      state.wheelProgress.playedRoundIndexes.push(step.roundIndex);
      return openRoundIntro(state, step.roundIndex, now);
    case 'wheel':
      return openWheel(state, step.wheelRoundIndex, now);
    case 'podium':
      return showPodium(state, now);
  }
}

/** Opens a planned wheel, or returns to it after a slice with its played slice off it. */
function openWheel(
  state: QuizshowLiveState,
  wheelRoundIndex: number,
  now: number,
): QuizshowEngineEffect[] {
  const rounds = state.snapshot.rounds;
  const progress = state.wheelProgress;
  const openWheelState = progress.wheel;
  if (
    openWheelState !== null &&
    openWheelState.wheelRoundIndex === wheelRoundIndex
  ) {
    // Back from a pick, the wheel starts again from rest.
    openWheelState.spin = null;
    openWheelState.restAngle = 0;
  } else {
    progress.wheel = createWheelState(
      rounds,
      wheelRoundIndex,
      wheelSliceRoundIndexes(rounds, wheelRoundIndex),
    );
    if (!progress.openedWheelRoundIndexes.includes(wheelRoundIndex)) {
      progress.openedWheelRoundIndexes.push(wheelRoundIndex);
    }
  }
  advanceCursor(state, {
    phase: 'wheel',
    roundIndex: wheelRoundIndex,
    questionIndex: null,
    now,
    durationMs: null,
    extraTimeMs: null,
  });
  return [{ kind: 'phase_changed' }, checkpoint()];
}

/** One spin decided here: every surface animates to the same stop. Each spin is a new `wheel` phase. */
function spinWheel(
  state: QuizshowLiveState,
  wheel: QuizshowWheelState,
  now: number,
  random: QuizshowRandom,
): QuizshowEngineEffect[] {
  const drawnCount = drawnWheelSliceRoundIndexes(
    state.snapshot.rounds,
    wheel,
    state.wheelProgress,
  ).length;
  wheel.spin = drawWheelSpin({
    drawnCount,
    startAngle: wheel.restAngle,
    now,
    random,
  });
  wheel.restAngle = wheelAngleModulo(
    wheelSpinEndAngle(wheel.spin, drawnCount),
    360,
  );
  advanceCursor(state, {
    phase: 'wheel',
    roundIndex: wheel.wheelRoundIndex,
    questionIndex: null,
    now,
    durationMs: null,
    extraTimeMs: null,
  });
  return [{ kind: 'phase_changed' }, checkpoint()];
}

/** `host:next` on a landed spin: starts the landed round, or opens the next question of the landed category. */
function startWheelPick(
  state: QuizshowLiveState,
  now: number,
): QuizshowEngineEffect[] {
  const wheel = openedWheelOf(state);
  const spin = wheel.spin;
  const landedRoundIndex =
    spin === null
      ? undefined
      : drawnWheelSliceRoundIndexes(
          state.snapshot.rounds,
          wheel,
          state.wheelProgress,
        )[spin.landedSliceIndex];
  if (landedRoundIndex === undefined) {
    throw new Error(
      `Pulse Live session ${state.sessionId} started a wheel pick with no landed slice.`,
    );
  }
  if (wheel.pick === 'round') {
    if (wheel.wheelRoundIndex === null) {
      // An unplanned wheel picks once and is gone.
      state.wheelProgress.wheel = null;
    } else {
      wheel.pickedCount += 1;
      wheel.playingRoundIndex = landedRoundIndex;
      wheel.baselineByEntrant = Object.fromEntries(
        entrantTotals(state).map((entrant) => [
          entrant.entrantId,
          entrant.score,
        ]),
      );
      wheel.spin = null;
      wheel.restAngle = 0;
    }
    return openStep(
      state,
      { kind: 'round', roundIndex: landedRoundIndex },
      now,
    );
  }
  const slicePosition = wheel.sliceRoundIndexes.indexOf(landedRoundIndex);
  const questionIndex = wheel.askedCounts[slicePosition] ?? 0;
  wheel.askedCounts[slicePosition] = questionIndex + 1;
  wheel.pickedCount += 1;
  wheel.playingRoundIndex = landedRoundIndex;
  wheel.spin = null;
  wheel.restAngle = 0;
  return openQuestion(state, landedRoundIndex, questionIndex, now);
}

/** A planned wheel's row joins the closed rows, so its unplayed slices are skipped for good. */
function closeOpenWheel(state: QuizshowLiveState): void {
  const progress = state.wheelProgress;
  const wheelRoundIndex = progress.wheel?.wheelRoundIndex ?? null;
  if (
    wheelRoundIndex !== null &&
    !progress.closedWheelRoundIndexes.includes(wheelRoundIndex)
  ) {
    progress.closedWheelRoundIndexes.push(wheelRoundIndex);
  }
  progress.wheel = null;
}

/**
 * The row a closing leaderboard names: the wheel row when the cursor already
 * sits on one, or after a pick-a-question wheel question; else the round
 * that ended, a pick-a-round slice included.
 */
function leaderboardRoundIndexOf(state: QuizshowLiveState): number | null {
  const { roundIndex } = state.cursor;
  if (roundIndex === null) return null;
  const rounds = state.snapshot.rounds;
  const row = rounds[roundIndex];
  if (row !== undefined && isWheelRoundKind(row.kind)) return roundIndex;
  const wheelRoundIndex = wheelRoundIndexOfRange(rounds, roundIndex);
  const wheelRow =
    wheelRoundIndex === null ? undefined : rounds[wheelRoundIndex];
  if (
    wheelRoundIndex !== null &&
    wheelRow !== undefined &&
    withWheelSettingsDefaults(wheelRow.settings).wheelPick === 'question'
  ) {
    return wheelRoundIndex;
  }
  return roundIndex;
}

/** A warm-up question or a poll scores nobody, so `host:next` from its reveal moves on with no scores frame (contract 6.19, 6.22). */
function shouldSkipScores(state: QuizshowLiveState): boolean {
  const play = state.current;
  if (play === null) return false;
  const round = state.snapshot.rounds[play.roundIndex];
  const question = round?.questions[play.questionIndex];
  if (round === undefined || question === undefined) return false;
  return round.settings.isWarmUp || question.type === 'poll';
}

/**
 * The warm-up round scored nobody, so its end opens the next step with no
 * leaderboard (contract 6.19). A warm-up flag on a wheel slice (a quiz saved
 * before validation refused it) keeps the leaderboard, so the wheel flow runs
 * as it does for every slice.
 */
function shouldSkipLeaderboard(state: QuizshowLiveState): boolean {
  const { roundIndex } = state.cursor;
  const round =
    roundIndex === null ? undefined : state.snapshot.rounds[roundIndex];
  return (
    roundIndex !== null &&
    round !== undefined &&
    isQuizRoundKind(round.kind) &&
    round.settings.isWarmUp &&
    !isInWheelRange(state.snapshot.rounds, roundIndex)
  );
}

/**
 * A round, or a pick-a-question wheel, ended: its leaderboard, or the podium
 * when nothing remains and no bonus waits to be announced. A warm-up round
 * with no bonus to announce opens the next step straight away.
 */
function afterRoundEnds(
  state: QuizshowLiveState,
  award: QuizshowWheelBonusView | null,
  now: number,
): QuizshowEngineEffect[] {
  const nextStep = nextQuizshowStep(state.snapshot.rounds, state.wheelProgress);
  if (nextStep.kind === 'podium' && award === null) {
    return showPodium(state, now);
  }
  if (award === null && shouldSkipLeaderboard(state)) {
    return openStep(state, nextStep, now);
  }
  return showScores(
    state,
    'leaderboard',
    'round',
    now,
    leaderboardRoundIndexOf(state),
  );
}

/** Stamps the award with the phase that announces it; call after the transition moved the cursor. */
function attachWheelBonusAward(
  state: QuizshowLiveState,
  result: QuizshowWheelBonusResult | null,
): void {
  if (result === null) return;
  state.wheelProgress.wheelBonusAward = {
    ...result.view,
    phaseId: state.cursor.phaseId,
  };
}

/**
 * After a question's last phase: back to the wheel after a pick-a-question
 * wheel question, the round's next question, or the end of the round (a
 * pick-a-round slice pays its bonus first).
 */
function afterQuestion(
  state: QuizshowLiveState,
  now: number,
): QuizshowEngineEffect[] {
  const roundIndex = state.cursor.roundIndex ?? state.current?.roundIndex;
  const questionIndex =
    state.cursor.questionIndex ?? state.current?.questionIndex;
  if (roundIndex === undefined || questionIndex === undefined) {
    throw new Error(
      `Pulse Live session ${state.sessionId} moved on with no question in play.`,
    );
  }
  const rounds = state.snapshot.rounds;
  const wheel = state.wheelProgress.wheel;

  // Rule 1: a pick-a-question wheel question returns to the wheel.
  if (wheel?.pick === 'question' && wheel.playingRoundIndex === roundIndex) {
    const wheelRoundIndex = wheel.wheelRoundIndex;
    if (wheelRoundIndex === null) {
      throw new Error(
        `Pulse Live session ${state.sessionId} plays a wheel question from an unplanned wheel.`,
      );
    }
    // The bonus reads the question in play, so it runs before anything moves.
    const bonus = applyWheelBonus(state, roundIndex);
    wheel.playingRoundIndex = null;
    const effects: QuizshowEngineEffect[] = [...(bonus?.effects ?? [])];
    if (isWheelExhausted(rounds, wheel, state.wheelProgress)) {
      closeOpenWheel(state);
      effects.push(...afterRoundEnds(state, bonus?.view ?? null, now));
    } else {
      if (bonus !== null) {
        // The wheel shows no scores frame, so the next question's scores would count the bonus as its own points.
        state.scoresAtLastFrame = totalsByEntrant(state);
      }
      effects.push(...openWheel(state, wheelRoundIndex, now));
    }
    attachWheelBonusAward(state, bonus);
    return effects;
  }

  // Rule 2: the round's next question.
  if (!isLastQuestionOfRound(state.snapshot, roundIndex, questionIndex)) {
    return openQuestion(state, roundIndex, questionIndex + 1, now);
  }

  // Rule 3: the round's last question; a pick-a-round slice pays its bonus first.
  let bonus: QuizshowWheelBonusResult | null = null;
  if (wheel?.pick === 'round' && wheel.playingRoundIndex === roundIndex) {
    bonus = applyWheelBonus(state, roundIndex);
    wheel.playingRoundIndex = null;
    wheel.baselineByEntrant = null;
    if (isWheelExhausted(rounds, wheel, state.wheelProgress)) {
      closeOpenWheel(state);
    }
  }
  const effects: QuizshowEngineEffect[] = [
    ...(bonus?.effects ?? []),
    ...afterRoundEnds(state, bonus?.view ?? null, now),
  ];
  attachWheelBonusAward(state, bonus);
  return effects;
}

/** Ends the night on its podium. A practice session keeps no placings, so persistence writes no results row (contract 6.9). */
function finishSession(
  state: QuizshowLiveState,
  now: number,
): QuizshowEngineEffect[] {
  const podium = buildPodium(state);
  const placings = state.isPractice ? {} : buildPlacings(state);
  state.podium = podium;
  state.pausedAt = null;
  state.status = 'finished';
  advanceCursor(state, {
    phase: 'ended',
    roundIndex: null,
    questionIndex: null,
    now,
    durationMs: null,
    extraTimeMs: null,
  });
  const storedPodium = podium.map((entry): QuizshowStoredPodiumEntry => ({
    place: entry.place,
    kind: entry.kind,
    entrantId: entry.entrantId,
    score: entry.score,
  }));
  return [
    { kind: 'phase_changed' },
    checkpoint(),
    persist({ type: 'finish', podium: storedPodium, placings }),
    { kind: 'timer_cleared' },
    { kind: 'session_ended', status: 'finished' },
  ];
}

/** Ends the session with no results, whatever its phase and scores. */
function abandonSession(
  state: QuizshowLiveState,
  now: number,
): QuizshowEngineEffect[] {
  state.pausedAt = null;
  state.status = 'abandoned';
  advanceCursor(state, {
    phase: 'ended',
    roundIndex: null,
    questionIndex: null,
    now,
    durationMs: null,
    extraTimeMs: null,
  });
  return [
    { kind: 'phase_changed' },
    checkpoint(),
    persist({ type: 'abandon' }),
    { kind: 'timer_cleared' },
    { kind: 'session_ended', status: 'abandoned' },
  ];
}

/** Team points over the members present when the question opened (one removed since counts 0), each team's total moved by the difference. */
export function applyTeamPoints(
  state: QuizshowLiveState,
  play: QuizshowLiveQuestionPlay,
): void {
  if (state.playMode === 'solo') return;
  const openingMembers = [...play.eligiblePlayerIds].flatMap((playerId) => {
    const teamId = state.players.get(playerId)?.teamId ?? null;
    return teamId === null ? [] : [{ playerId, teamId }];
  });
  const nextTeamPoints = teamQuestionPoints(
    openingMembers,
    play.pointsByPlayer,
  );
  const teamIds = new Set([
    ...play.teamPoints.keys(),
    ...nextTeamPoints.keys(),
  ]);
  for (const teamId of teamIds) {
    const team = state.teams.get(teamId);
    if (team === undefined) continue;
    team.score +=
      (nextTeamPoints.get(teamId) ?? 0) - (play.teamPoints.get(teamId) ?? 0);
  }
  play.teamPoints = nextTeamPoints;
}

/**
 * Judges every eligible answer against the effective key (a host correction
 * when one was made) and the texts a host accepted. A prompt or a poll scores
 * nobody; a warm-up round judges but awards 0 and keeps streaks. The first
 * scoring records each eligible player's streak so a rescore can restore it.
 * `scoredPlayers` defaults to the eligible players still active, the set the
 * first scoring judges. A correction passes exactly that set again: a player
 * who left after the reveal is rescored, and one who left before it stays out.
 */
export function scoreQuizQuestion(
  state: QuizshowLiveState,
  { play, round, question }: QuizshowPlayContext,
  scoredPlayers: readonly QuizshowLivePlayer[] = eligiblePlayersNow(state),
): void {
  const answerKey = effectiveAnswerKey(round, question, play.keyOverride);
  if (play.streakBeforeByPlayer.size === 0) {
    for (const player of scoredPlayers) {
      play.streakBeforeByPlayer.set(player.playerId, player.streak);
    }
  }
  const limitMs = openLimitMs(round, question);
  const closestOutcomes =
    answerKey?.type === 'closest_number'
      ? closestNumberOutcomes(
          answerKey.value,
          answerKey.tolerance,
          scoredPlayers.flatMap((player) => {
            const payload = play.answers.get(player.playerId)?.payload;
            return payload?.type === 'closest_number'
              ? [{ playerId: player.playerId, value: payload.value }]
              : [];
          }),
        )
      : null;
  for (const player of scoredPlayers) {
    if (
      answerKey === null ||
      question.type === 'prompt' ||
      question.type === 'poll'
    ) {
      play.pointsByPlayer.set(player.playerId, 0);
      continue;
    }
    const answer = play.answers.get(player.playerId) ?? null;
    const score = scoreQuizAnswer({
      type: question.type,
      base: question.points,
      answerKey,
      payload: answer?.payload ?? null,
      elapsedMs: answer?.elapsedMs ?? 0,
      ownLimitMs: play.extraTimePlayerIds.has(player.playerId)
        ? extraTimeMs(limitMs)
        : limitMs,
      isSpeedBonusOn: round.settings.isSpeedBonusOn,
      streakBefore: player.streak,
      isJokerActive: isJokerActiveFor(state, player.playerId, play.roundIndex),
      closestOutcome: closestOutcomes?.get(player.playerId) ?? null,
      acceptedTexts: play.acceptedTexts,
      isWarmUp: round.settings.isWarmUp,
    });
    if (answer !== null) {
      answer.isCorrect = score.isCorrect;
      answer.correctPositions = score.correctPositions;
      answer.pointsAwarded = score.pointsAwarded;
      answer.streakBonus = score.streakBonus;
    }
    player.score += score.pointsAwarded;
    player.streak = score.streakAfter;
    play.pointsByPlayer.set(player.playerId, score.pointsAwarded);
  }
}

/** Votes for visible options only; each author's share lands on their answer, every total on the player. */
function scorePartyQuestion(
  state: QuizshowLiveState,
  { play, round }: QuizshowPlayContext,
): void {
  const visibleOptions = new Map(
    (play.voteOptions ?? [])
      .filter((option) => isOptionVisible(play, option))
      .map((option) => [option.optionId, option]),
  );
  const countedVotes = [...play.votes.values()].flatMap((vote) => {
    const option = visibleOptions.get(vote.optionId);
    const voter = state.players.get(vote.voterPlayerId);
    // A removed or departed voter's vote stops counting.
    const isVoterGone = voter !== undefined && !isActivePlayer(voter);
    return option === undefined || isVoterGone
      ? []
      : [
          {
            voterPlayerId: vote.voterPlayerId,
            authorPlayerId: option.authorPlayerId,
          },
        ];
  });
  const authoredVotes = countedVotes.flatMap((vote) =>
    vote.authorPlayerId === null
      ? []
      : [
          {
            voterPlayerId: vote.voterPlayerId,
            authorPlayerId: vote.authorPlayerId,
          },
        ],
  );
  const isJokerActive = (playerId: string): boolean =>
    isJokerActiveFor(state, playerId, play.roundIndex);
  const isLieDetector = round.kind === 'lie_detector';
  const totals = isLieDetector
    ? scoreLieDetectorVotes({
        votes: countedVotes,
        isJokerActiveFor: isJokerActive,
      })
    : scorePartyVotes({
        votes: authoredVotes,
        favouriteAuthorPlayerId: null,
        isJokerActiveFor: isJokerActive,
      });
  const authorShares = isLieDetector
    ? scoreLieDetectorVotes({
        votes: authoredVotes,
        isJokerActiveFor: isJokerActive,
      })
    : totals;
  for (const answer of play.answers.values()) {
    answer.pointsAwarded =
      answer.hiddenAt === null ? (authorShares.get(answer.playerId) ?? 0) : 0;
  }
  for (const player of eligiblePlayersNow(state)) {
    const points = totals.get(player.playerId) ?? 0;
    player.score += points;
    play.pointsByPlayer.set(player.playerId, points);
  }
}

export function saveScoringOperation(
  state: QuizshowLiveState,
  play: QuizshowLiveQuestionPlay,
): QuizshowPersistOperation {
  return {
    type: 'save_scoring',
    questionId: play.questionId,
    answers: [...play.answers.values()].map((answer) => ({
      answerId: answer.answerId,
      isCorrect: answer.isCorrect,
      pointsAwarded: answer.pointsAwarded,
    })),
    players: [...play.pointsByPlayer.keys()].flatMap((playerId) => {
      const player = state.players.get(playerId);
      return player === undefined
        ? []
        : [{ playerId, score: player.score, streak: player.streak }];
    }),
    teams: [...state.teams.values()].map((team) => ({
      teamId: team.teamId,
      score: team.score,
    })),
  };
}

/** Scores the question once, then shows its reveal. */
function revealQuestion(
  state: QuizshowLiveState,
  now: number,
): QuizshowEngineEffect[] {
  const context = currentPlayContext(state);
  const { play, round } = context;
  if (!play.isScored) {
    if (isQuizRoundKind(round.kind)) scoreQuizQuestion(state, context);
    else scorePartyQuestion(state, context);
    applyTeamPoints(state, play);
    play.isScored = true;
  }
  const logEntry = findLogEntry(state, play.questionId);
  if (logEntry !== undefined) logEntry.revealedAt = now;
  // A warm-up question or a poll scores nobody, so ending after only those skips a podium of zeros.
  if (!shouldSkipScores(state)) state.hasScoredQuestion = true;
  advanceCursor(state, {
    phase: 'reveal',
    roundIndex: play.roundIndex,
    questionIndex: play.questionIndex,
    now,
    durationMs: null,
    extraTimeMs: null,
  });
  return [
    { kind: 'phase_changed' },
    { kind: 'revealed' },
    persist(saveScoringOperation(state, play)),
    ...armAutoAdvance(state),
    checkpoint(),
  ];
}

function visibleAnswers(play: QuizshowLiveQuestionPlay): QuizshowLiveAnswer[] {
  return [...play.answers.values()]
    .filter((answer) => answer.hiddenAt === null)
    .sort((first, second) => first.receivedAt - second.receivedAt);
}

/**
 * The Lie Detector truth in the screen language, the other language when that
 * one is blank. A vote option holds one text, so a screen showing both
 * languages leads with English, as the TV does (contract 6.26).
 */
function truthText(
  state: QuizshowLiveState,
  question: QuizshowSnapshotQuestion,
): string | null {
  if (question.type !== 'prompt' || question.answer === null) return null;
  const { truth } = question.answer;
  const leadLanguage = state.snapshot.screenLanguage === 'pt' ? 'pt' : 'en';
  const screenText = truth[leadLanguage].trim();
  if (screenText !== '') return screenText;
  const otherText = (leadLanguage === 'en' ? truth.pt : truth.en).trim();
  return otherText === '' ? null : otherText;
}

/** Vote options from the visible answers (the truth too on Lie Detector), each with a fresh id, shuffled. */
function startVote(
  state: QuizshowLiveState,
  now: number,
  random: QuizshowRandom,
): QuizshowEngineEffect[] {
  const context = currentPlayContext(state);
  const { play, round, question } = context;
  const answerOptions = visibleAnswers(play).map(
    (answer): QuizshowLiveVoteOption & { answerId: string } => {
      const optionId = random.uuid();
      answer.voteOptionId = optionId;
      return {
        optionId,
        answerId: answer.answerId,
        authorPlayerId: answer.playerId,
        text: answer.payload.type === 'prompt' ? answer.payload.text : '',
        isTruth: false,
      };
    },
  );
  const options: QuizshowLiveVoteOption[] = [...answerOptions];
  const truth =
    round.kind === 'lie_detector' ? truthText(state, question) : null;
  if (truth !== null) {
    options.push({
      optionId: random.uuid(),
      answerId: null,
      authorPlayerId: null,
      text: truth,
      isTruth: true,
    });
  }
  // An empty correct order makes this a plain Fisher-Yates shuffle.
  play.voteOptions = shuffleAvoidingOrder(options, [], random);
  const effects: QuizshowEngineEffect[] = [
    persist({
      type: 'set_answer_vote_options',
      options: answerOptions.map((option) => ({
        answerId: option.answerId,
        voteOptionId: option.optionId,
      })),
    }),
  ];
  if (play.voteOptions.length < 2) {
    return [...effects, ...revealQuestion(state, now)];
  }
  const limitMs = voteLimitMs(round);
  advanceCursor(state, {
    phase: 'vote',
    roundIndex: play.roundIndex,
    questionIndex: play.questionIndex,
    now,
    durationMs: limitMs,
    extraTimeMs: extraTimeMs(limitMs),
  });
  return [
    ...effects,
    { kind: 'phase_changed' },
    { kind: 'vote_options_shown' },
    { kind: 'answer_count_changed' },
    ...phaseTimer(state),
    checkpoint(),
  ];
}

/** `review` when it is on and something is visible to check, else straight to the vote. */
function afterWrite(
  state: QuizshowLiveState,
  now: number,
  random: QuizshowRandom,
): QuizshowEngineEffect[] {
  const { play } = currentPlayContext(state);
  if (state.isReviewOn && visibleAnswers(play).length >= 1) {
    advanceCursor(state, {
      phase: 'review',
      roundIndex: play.roundIndex,
      questionIndex: play.questionIndex,
      now,
      durationMs: null,
      extraTimeMs: null,
    });
    return [
      { kind: 'phase_changed' },
      { kind: 'review_list_changed' },
      { kind: 'answer_count_changed' },
      checkpoint(),
    ];
  }
  return startVote(state, now, random);
}

/** A timed phase reached its deadline plus grace: wait for extra-time players, or move on. */
function closeTimedPhase(
  state: QuizshowLiveState,
  now: number,
  shouldWaitForExtraTime: boolean,
  random: QuizshowRandom,
): QuizshowEngineEffect[] {
  const { extraTimeDeadline, phaseId } = state.cursor;
  const extraTimePlayerIds =
    state.current?.extraTimePlayerIds ?? new Set<string>();
  if (
    shouldWaitForExtraTime &&
    extraTimeDeadline !== null &&
    now < extraTimeDeadline + QUIZSHOW_LIMITS.answerGraceMs &&
    [...extraTimePlayerIds].some((playerId) =>
      isAwaitedSubmitter(state, playerId, now),
    )
  ) {
    return [
      {
        kind: 'timer',
        phaseId,
        fireAt: extraTimeDeadline + QUIZSHOW_LIMITS.answerGraceMs,
      },
    ];
  }
  if (state.cursor.phase === 'write') return afterWrite(state, now, random);
  return revealQuestion(state, now);
}

/** Hides one answer of the question in play and withdraws what it earned once scored. */
function hideAnswerInPlay(
  state: QuizshowLiveState,
  play: QuizshowLiveQuestionPlay,
  answer: QuizshowLiveAnswer,
  now: number,
): QuizshowEngineEffect[] {
  answer.hiddenAt = now;
  if (state.cursor.phase === 'review') return [{ kind: 'review_list_changed' }];
  if (play.voteOptions === null) return [];
  const option = play.voteOptions.find(
    (voteOption) => voteOption.answerId === answer.answerId,
  );
  if (option !== undefined && play.favouriteOptionId === option.optionId) {
    play.favouriteOptionId = null;
  }
  const effects: QuizshowEngineEffect[] = [
    {
      kind: 'answer_hidden',
      questionId: play.questionId,
      answerId: answer.answerId,
      optionId: option?.optionId ?? null,
    },
  ];
  if (!play.isScored) return effects;
  const withdrawnPoints = answer.pointsAwarded;
  const author = state.players.get(answer.playerId);
  if (author !== undefined) author.score -= withdrawnPoints;
  if (play.pointsByPlayer.has(answer.playerId)) {
    play.pointsByPlayer.set(
      answer.playerId,
      (play.pointsByPlayer.get(answer.playerId) ?? 0) - withdrawnPoints,
    );
  }
  answer.pointsAwarded = 0;
  applyTeamPoints(state, play);
  // The favourite path with no author: the reveal frame again, and no player's own reveal changes.
  effects.push(persist(saveScoringOperation(state, play)), {
    kind: 'reveal_updated',
    scope: 'favourite',
    playerId: null,
  });
  const shownScoresScope = scoresScopeShownIn(state.cursor.phase);
  if (shownScoresScope !== null) {
    // The scores on show already counted the withdrawn points: send them again with the new totals.
    state.scoresAtLastFrame = totalsByEntrant(state);
    effects.push({ kind: 'scores_shown', scope: shownScoresScope });
  }
  return effects;
}

/** The scores scope a phase shows, or null for a phase with no scores on show. */
export function scoresScopeShownIn(
  phase: QuizshowPhase,
): QuizshowScoresScope | null {
  if (phase === 'scores') return 'question';
  if (phase === 'leaderboard') return 'round';
  if (phase === 'podium') return 'final';
  return null;
}

function isPromptQuestionInPlay(
  state: QuizshowLiveState,
  play: QuizshowLiveQuestionPlay,
): boolean {
  const question = snapshotQuestionAt(
    state.snapshot,
    play.roundIndex,
    play.questionIndex,
  );
  return question !== null && question.type === 'prompt';
}

export function hostStart(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const movingCheck = checkMovingCommand(state, phaseId);
  if (movingCheck === 'stale')
    return refuse('quizshow_stale_phase', state, true);
  if (movingCheck === 'noop') return hostActed(state, now, [], true);
  if (state.status !== 'lobby') {
    return refuse(statusRefusalCode(state.status, 'lobby'), state, true);
  }
  const players = activePlayers(state);
  if (players.length === 0) return refuse('quizshow_no_players', state, false);
  const effects: QuizshowEngineEffect[] = [];
  // Host-made teams wait empty in the lobby, but the game starts with only the teams someone plays in (contract 6.11).
  const emptyTeamIds = [...state.teams.keys()].filter(
    (teamId) => !players.some((player) => player.teamId === teamId),
  );
  if (emptyTeamIds.length > 0) {
    for (const teamId of emptyTeamIds) state.teams.delete(teamId);
    effects.push(persist({ type: 'delete_teams', teamIds: emptyTeamIds }), {
      kind: 'lobby_changed',
    });
  }
  state.status = 'running';
  effects.push(
    ...openStep(
      state,
      nextQuizshowStep(state.snapshot.rounds, state.wheelProgress),
      now,
    ),
  );
  return hostActed(state, now, effects, false);
}

/** What `host:next` does in the current phase; null where it is not allowed. */
function nextEffects(
  state: QuizshowLiveState,
  now: number,
  random: QuizshowRandom,
): QuizshowEngineEffect[] | null {
  const { phase, roundIndex } = state.cursor;
  switch (phase) {
    case 'round_intro':
      return roundIndex === null
        ? null
        : openQuestion(state, roundIndex, 0, now);
    case 'read':
      return openAnswers(state, now);
    case 'open':
    case 'write':
    case 'vote':
      return closeTimedPhase(state, now, false, random);
    case 'review':
      return startVote(state, now, random);
    case 'reveal':
      return isQuizRoundInPlay(state) && !shouldSkipScores(state)
        ? showScores(state, 'scores', 'question', now)
        : afterQuestion(state, now);
    case 'scores':
      return afterQuestion(state, now);
    case 'leaderboard':
      return openStep(
        state,
        nextQuizshowStep(state.snapshot.rounds, state.wheelProgress),
        now,
      );
    case 'wheel':
      return startWheelPick(state, now);
    case 'podium':
      return revealNextPodiumStep(state, now) ?? finishSession(state, now);
    default:
      return null;
  }
}

export function hostNext(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
  random: QuizshowRandom = CRYPTO_RANDOM,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const movingCheck = checkMovingCommand(state, phaseId);
  if (movingCheck === 'stale')
    return refuse('quizshow_stale_phase', state, true);
  if (movingCheck === 'noop') return hostActed(state, now, [], true);
  if (state.status !== 'running') {
    return refuse(statusRefusalCode(state.status, 'running'), state, true);
  }
  if (state.cursor.phase === 'wheel') {
    const spin = openedWheelOf(state).spin;
    if (spin === null) return refuse('quizshow_wheel_not_spun', state, false);
    if (
      !isWheelSpinLanded(spin, now, QUIZSHOW_LIMITS.wheelLandingToleranceMs)
    ) {
      return refuse('quizshow_wheel_spinning', state, false);
    }
  }
  const effects = nextEffects(state, now, random);
  if (effects === null) {
    const code =
      state.cursor.phase === 'lobby'
        ? 'quizshow_session_not_started'
        : 'quizshow_session_ended';
    return refuse(code, state, true);
  }
  return hostActed(state, now, effects, false);
}

/**
 * Spins the open wheel (the first spin and a spin again alike), or from a
 * leaderboard opens an unplanned wheel over the next unplayed rounds and spins
 * it in the same command.
 */
export function hostSpin(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
  random: QuizshowRandom = CRYPTO_RANDOM,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const movingCheck = checkMovingCommand(state, phaseId);
  if (movingCheck === 'stale')
    return refuse('quizshow_stale_phase', state, true);
  if (movingCheck === 'noop') return hostActed(state, now, [], true);
  if (state.status !== 'running') {
    return refuse(statusRefusalCode(state.status, 'running'), state, true);
  }
  const { phase } = state.cursor;
  if (phase === 'wheel') {
    const wheel = openedWheelOf(state);
    if (
      wheel.spin !== null &&
      !isWheelSpinLanded(
        wheel.spin,
        now,
        QUIZSHOW_LIMITS.wheelLandingToleranceMs,
      )
    ) {
      return refuse('quizshow_wheel_spinning', state, false);
    }
    return hostActed(state, now, spinWheel(state, wheel, now, random), false);
  }
  if (phase === 'leaderboard') {
    const rounds = state.snapshot.rounds;
    const progress = state.wheelProgress;
    const nextStep = nextQuizshowStep(rounds, progress);
    if (nextStep.kind === 'wheel' || progress.wheel !== null) {
      return refuse('quizshow_wheel_already_next', state, false);
    }
    const candidateRoundIndexes = unplannedWheelSliceRoundIndexes(
      rounds,
      progress,
    );
    if (
      nextStep.kind === 'podium' ||
      candidateRoundIndexes.length < QUIZSHOW_LIMITS.wheelSlicesMin
    ) {
      return refuse('quizshow_wheel_spin_too_few_rounds', state, false);
    }
    const wheel = createWheelState(rounds, null, candidateRoundIndexes);
    progress.wheel = wheel;
    return hostActed(state, now, spinWheel(state, wheel, now, random), false);
  }
  return refuse('quizshow_spin_not_available', state, true);
}

/**
 * Ends the open wheel early, even with a spin in the air: its unplayed slices
 * are skipped for good. A pick-a-question wheel that played a question ends
 * like a round; every other wheel moves straight to the next step.
 */
export function hostFinishWheel(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const movingCheck = checkMovingCommand(state, phaseId);
  if (movingCheck === 'stale')
    return refuse('quizshow_stale_phase', state, true);
  if (movingCheck === 'noop') return hostActed(state, now, [], true);
  if (state.status !== 'running') {
    return refuse(statusRefusalCode(state.status, 'running'), state, true);
  }
  if (state.cursor.phase !== 'wheel') {
    return refuse('quizshow_no_wheel_open', state, true);
  }
  const wheel = openedWheelOf(state);
  const isQuestionWheelWithPick =
    wheel.pick === 'question' && wheel.pickedCount >= 1;
  closeOpenWheel(state);
  // The cursor still sits on the wheel row, so its leaderboard names that row.
  const effects = isQuestionWheelWithPick
    ? afterRoundEnds(state, null, now)
    : openStep(
        state,
        nextQuizshowStep(state.snapshot.rounds, state.wheelProgress),
        now,
      );
  return hostActed(state, now, effects, false);
}

export function hostPause(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  if (phaseId !== state.cursor.phaseId) {
    return refuse('quizshow_stale_phase', state, true);
  }
  if (state.status === 'paused') return hostActed(state, now, [], true);
  const { cursor } = state;
  if (
    state.status !== 'running' ||
    cursor.phase === 'lobby' ||
    cursor.phase === 'ended'
  ) {
    return refuse(statusRefusalCode(state.status, 'running'), state, true);
  }
  const effects: QuizshowEngineEffect[] = [{ kind: 'phase_changed' }];
  state.pausedAt = now;
  if (isTimedPhase(cursor.phase) && cursor.deadline !== null) {
    // Signed: a pause past the deadline keeps the overrun, so no fresh grace after resume.
    cursor.pausedRemainingMs = cursor.deadline - now;
    cursor.pausedExtraTimeRemainingMs =
      cursor.extraTimeDeadline === null ? null : cursor.extraTimeDeadline - now;
    cursor.deadline = null;
    cursor.extraTimeDeadline = null;
    effects.push({ kind: 'timer_cleared' });
  } else if (cursor.autoAdvanceAt !== null) {
    // Resume arms the full wait again, so nothing of it is kept.
    cursor.autoAdvanceAt = null;
    effects.push({ kind: 'timer_cleared' });
  }
  setSessionStatus(state, 'paused');
  return hostActed(state, now, effects, false);
}

export function hostResume(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  if (phaseId !== state.cursor.phaseId) {
    return refuse('quizshow_stale_phase', state, true);
  }
  if (state.status === 'running') return hostActed(state, now, [], true);
  if (state.status !== 'paused') {
    return refuse(statusRefusalCode(state.status, 'running'), state, true);
  }
  const { cursor } = state;
  const replayQuestion =
    cursor.isRestartRecovery &&
    QUESTION_PHASES.includes(cursor.phase) &&
    cursor.roundIndex !== null &&
    cursor.questionIndex !== null
      ? snapshotQuestionAt(
          state.snapshot,
          cursor.roundIndex,
          cursor.questionIndex,
        )
      : null;
  if (
    replayQuestion !== null &&
    cursor.roundIndex !== null &&
    cursor.questionIndex !== null
  ) {
    const effects: QuizshowEngineEffect[] = [
      persist({ type: 'delete_question_plays', questionId: replayQuestion.id }),
    ];
    state.questionLog = state.questionLog.filter(
      (entry) => entry.questionId !== replayQuestion.id,
    );
    state.current = null;
    state.pausedAt = null;
    state.status = 'running';
    effects.push(
      ...openQuestion(state, cursor.roundIndex, cursor.questionIndex, now),
    );
    return hostActed(state, now, effects, false);
  }
  const pausedAt = state.pausedAt ?? now;
  const pausedForMs = now - pausedAt;
  if (cursor.phaseStartedAt !== null) cursor.phaseStartedAt += pausedForMs;
  // The talk beat sits a fixed time after the phase start, so it moves with it.
  if (cursor.talkStartsAt !== null) cursor.talkStartsAt += pausedForMs;
  if (cursor.pausedRemainingMs !== null) {
    cursor.deadline = now + cursor.pausedRemainingMs;
    cursor.extraTimeDeadline =
      cursor.pausedExtraTimeRemainingMs === null
        ? null
        : now + cursor.pausedExtraTimeRemainingMs;
  }
  cursor.pausedRemainingMs = null;
  cursor.pausedExtraTimeRemainingMs = null;
  cursor.isRestartRecovery = false;
  state.pausedAt = null;
  setSessionStatus(state, 'running');
  return hostActed(
    state,
    now,
    [
      { kind: 'phase_changed' },
      ...phaseTimer(state),
      // Auto-advance waits its full length again from the resume (contract 6.16).
      ...armAutoAdvanceFrom(state, now),
    ],
    false,
  );
}

export function hostAddTime(
  state: QuizshowLiveState,
  input: { phaseId: string; seconds: number; expectedDeadline: number },
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const { cursor } = state;
  if (input.phaseId !== cursor.phaseId) {
    return refuse('quizshow_stale_phase', state, true);
  }
  if (state.status !== 'running') {
    return refuse(statusRefusalCode(state.status, 'running'), state, true);
  }
  if (!isTimedPhase(cursor.phase)) {
    return refuse('quizshow_no_timer_running', state, true);
  }
  if (cursor.deadline === null || input.expectedDeadline !== cursor.deadline) {
    return hostActed(state, now, [], true);
  }
  const addedMs = input.seconds * 1000;
  cursor.deadline += addedMs;
  if (cursor.extraTimeDeadline !== null) cursor.extraTimeDeadline += addedMs;
  return hostActed(
    state,
    now,
    [{ kind: 'phase_changed' }, ...phaseTimer(state)],
    false,
  );
}

export function hostReveal(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
  random: QuizshowRandom = CRYPTO_RANDOM,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const movingCheck = checkMovingCommand(state, phaseId);
  if (movingCheck === 'stale')
    return refuse('quizshow_stale_phase', state, true);
  if (movingCheck === 'noop') return hostActed(state, now, [], true);
  if (state.status !== 'running') {
    return refuse(statusRefusalCode(state.status, 'running'), state, true);
  }
  const { phase } = state.cursor;
  if (phase === 'reveal' || phase === 'scores') {
    return refuse('quizshow_already_revealed', state, true);
  }
  if (phase !== 'open' && phase !== 'vote') {
    return refuse('quizshow_nothing_to_reveal', state, true);
  }
  return hostActed(
    state,
    now,
    closeTimedPhase(state, now, false, random),
    false,
  );
}

export function hostSkip(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const movingCheck = checkMovingCommand(state, phaseId);
  if (movingCheck === 'stale')
    return refuse('quizshow_stale_phase', state, true);
  if (movingCheck === 'noop') return hostActed(state, now, [], true);
  if (state.status !== 'running') {
    return refuse(statusRefusalCode(state.status, 'running'), state, true);
  }
  const { phase } = state.cursor;
  const play = state.current;
  if (QUESTION_PHASES.includes(phase) && play !== null) {
    play.wasSkipped = true;
    const logEntry = findLogEntry(state, play.questionId);
    if (logEntry !== undefined) logEntry.wasSkipped = true;
    return hostActed(state, now, afterQuestion(state, now), false);
  }
  if (phase === 'reveal' && isQuizRoundInPlay(state)) {
    return hostActed(state, now, afterQuestion(state, now), false);
  }
  return refuse('quizshow_nothing_to_skip', state, true);
}

export function hostShowAnswers(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
  random: QuizshowRandom = CRYPTO_RANDOM,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const movingCheck = checkMovingCommand(state, phaseId);
  if (movingCheck === 'stale')
    return refuse('quizshow_stale_phase', state, true);
  if (movingCheck === 'noop') return hostActed(state, now, [], true);
  if (state.status !== 'running') {
    return refuse(statusRefusalCode(state.status, 'running'), state, true);
  }
  if (state.cursor.phase !== 'review') {
    return refuse('quizshow_review_not_open', state, true);
  }
  return hostActed(state, now, startVote(state, now, random), false);
}

export function hostHideAnswer(
  state: QuizshowLiveState,
  input: { answerId: string; isHidden: boolean },
  actorUserId: string,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  if (!isOpenStatus(state.status)) {
    return refuse('quizshow_session_ended', state, true);
  }
  const play = state.current;
  const answer = play === null ? undefined : findAnswer(play, input.answerId);
  if (
    play === null ||
    answer === undefined ||
    !isPromptQuestionInPlay(state, play)
  ) {
    return refuse('quizshow_answer_not_found', state, false);
  }
  if (!input.isHidden && state.cursor.phase !== 'review') {
    return refuse('quizshow_unhide_review_only', state, true);
  }
  const author = state.players.get(answer.playerId);
  // A removed or departed author's answers stay hidden: un-hiding would bring back a voice that left.
  if (!input.isHidden && author !== undefined && !isActivePlayer(author)) {
    return refuse('quizshow_author_removed', state, true);
  }
  if ((answer.hiddenAt !== null) === input.isHidden) {
    return hostActed(state, now, [], true);
  }
  const effects: QuizshowEngineEffect[] = [];
  if (input.isHidden) {
    effects.push(...hideAnswerInPlay(state, play, answer, now));
    effects.push(...refreshPodiumIfShown(state));
  } else {
    answer.hiddenAt = null;
    effects.push({ kind: 'review_list_changed' });
  }
  effects.push(
    persist({
      type: 'set_answer_hidden',
      answerId: answer.answerId,
      hiddenAt: answer.hiddenAt,
      hiddenByUserId: input.isHidden ? actorUserId : null,
    }),
  );
  return hostActed(state, now, effects, false);
}

export function hostPickFavourite(
  state: QuizshowLiveState,
  input: { phaseId: string; questionId: string; optionId: string },
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  if (input.phaseId !== state.cursor.phaseId) {
    return refuse('quizshow_stale_phase', state, true);
  }
  const play = state.current;
  const round =
    play === null ? undefined : state.snapshot.rounds[play.roundIndex];
  if (state.status !== 'running') {
    return refuse(statusRefusalCode(state.status, 'running'), state, true);
  }
  if (
    state.cursor.phase !== 'reveal' ||
    play === null ||
    round === undefined ||
    (round.kind !== 'caption_this' && round.kind !== 'drag_name')
  ) {
    return refuse('quizshow_favourite_not_available', state, true);
  }
  if (input.questionId !== play.questionId) {
    return refuse('quizshow_wrong_question', state, false);
  }
  if (play.favouriteOptionId !== null) return hostActed(state, now, [], true);
  const option = play.voteOptions?.find(
    (voteOption) => voteOption.optionId === input.optionId,
  );
  const optionAnswerId = option?.answerId ?? null;
  const answer =
    optionAnswerId === null ? undefined : findAnswer(play, optionAnswerId);
  if (
    option === undefined ||
    option.isTruth ||
    answer === undefined ||
    answer.hiddenAt !== null
  ) {
    return refuse('quizshow_vote_option_not_found', state, false);
  }
  play.favouriteOptionId = option.optionId;
  const bonus =
    scorePartyVotes({
      votes: [],
      favouriteAuthorPlayerId: answer.playerId,
      isJokerActiveFor: (playerId) =>
        isJokerActiveFor(state, playerId, play.roundIndex),
    }).get(answer.playerId) ?? 0;
  answer.pointsAwarded += bonus;
  const author = state.players.get(answer.playerId);
  if (author !== undefined) author.score += bonus;
  play.pointsByPlayer.set(
    answer.playerId,
    (play.pointsByPlayer.get(answer.playerId) ?? 0) + bonus,
  );
  applyTeamPoints(state, play);
  return hostActed(
    state,
    now,
    [
      {
        kind: 'reveal_updated',
        scope: 'favourite',
        playerId: answer.playerId,
      },
      persist(saveScoringOperation(state, play)),
    ],
    false,
  );
}

/**
 * The leave shared by `lobby:leave` and `host:removePlayer` with a rejoin
 * (contract 6.14): the row gets `leftAt`, its answers stay visible, and in the
 * lobby a player-made team left empty goes. The player stays in the
 * question's eligible ids and its log count: a rejoin admits only players who
 * are not eligible yet, so the counts stay consistent.
 */
function leaveEffects(
  state: QuizshowLiveState,
  player: QuizshowLivePlayer,
  now: number,
  random: QuizshowRandom,
  departure: Extract<
    QuizshowEngineEffect,
    { kind: 'player_left' } | { kind: 'player_removed' }
  >,
): QuizshowEngineEffect[] {
  player.leftAt = now;
  return [
    persist({
      type: 'update_player',
      playerId: player.playerId,
      fields: { leftAt: now },
    }),
    ...dropEmptyLobbyTeams(state, [player.teamId]),
    { kind: 'lobby_changed' },
    departure,
    ...refreshPodiumIfShown(state),
    ...closeIfEveryoneDone(state, now, random),
  ];
}

/** `lobby:leave` in any open status (contract 6.14); the runtime unbinds the leaver's sockets on `player_left`. */
export function leaveLobby(
  state: QuizshowLiveState,
  playerId: string,
  now: number,
  random: QuizshowRandom = CRYPTO_RANDOM,
): QuizshowCommandOutcome {
  if (!isOpenStatus(state.status)) {
    return refuse('quizshow_session_ended', state, true);
  }
  const player = state.players.get(playerId);
  if (player === undefined) return refuse('quizshow_not_joined', state, false);
  if (player.removedAt !== null) {
    return refuse('quizshow_player_removed', state, false);
  }
  if (player.leftAt !== null)
    return refuse('quizshow_not_joined', state, false);
  const effects = leaveEffects(state, player, now, random, {
    kind: 'player_left',
    playerId,
  });
  return succeed<Record<string, never>>(
    {},
    withSingleCheckpoint([...effects, checkpoint()]),
  );
}

/**
 * Removes a player. With `canRejoin` the host does the player's leave and the
 * runtime evicts their sockets; their answers stay visible and they may join
 * again. Without it the row is removed for good and its answers hidden, a
 * player who already left included, so they cannot come back. A removed row
 * is a no-op, and so is a rejoin removal of a player who already left.
 */
export function hostRemovePlayer(
  state: QuizshowLiveState,
  playerId: string,
  actorUserId: string,
  now: number,
  random: QuizshowRandom = CRYPTO_RANDOM,
  canRejoin = false,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const player = state.players.get(playerId);
  if (player === undefined) {
    return refuse('quizshow_player_not_found', state, false);
  }
  if (!isOpenStatus(state.status)) {
    return refuse('quizshow_session_ended', state, true);
  }
  if (player.removedAt !== null || (canRejoin && player.leftAt !== null)) {
    return hostActed(state, now, [], true);
  }
  if (canRejoin) {
    const effects = leaveEffects(state, player, now, random, {
      kind: 'player_removed',
      playerId,
      canRejoin: true,
    });
    return hostActed(state, now, effects, false);
  }
  player.removedAt = now;
  const effects: QuizshowEngineEffect[] = [];
  const play = state.current;
  const answer = play?.answers.get(playerId);
  if (
    play !== null &&
    answer !== undefined &&
    answer.hiddenAt === null &&
    isPromptQuestionInPlay(state, play)
  ) {
    effects.push(...hideAnswerInPlay(state, play, answer, now));
  }
  effects.push(
    persist({ type: 'update_player', playerId, fields: { removedAt: now } }),
    ...dropEmptyLobbyTeams(state, [player.teamId]),
    persist({
      type: 'hide_player_answers',
      playerId,
      hiddenAt: now,
      hiddenByUserId: actorUserId,
    }),
    { kind: 'player_removed', playerId, canRejoin: false },
    { kind: 'lobby_changed' },
    ...refreshPodiumIfShown(state),
    ...closeIfEveryoneDone(state, now, random),
  );
  return hostActed(state, now, effects, false);
}

export function hostRenameTeam(
  state: QuizshowLiveState,
  input: { teamId: string; name: string },
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const team = state.teams.get(input.teamId);
  if (team === undefined)
    return refuse('quizshow_team_not_found', state, false);
  if (!isOpenStatus(state.status)) {
    return refuse('quizshow_session_ended', state, true);
  }
  const name = input.name.trim();
  const nameRefusal = textRefusal(name);
  if (nameRefusal !== null) return refuse(nameRefusal, state, false);
  // Team names clash by the same fold as host:createTeams (contract 6.13): accents, case and repeated spaces.
  const nameKey = foldNameKey(name);
  const isNameTaken = [...state.teams.values()].some(
    (otherTeam) =>
      otherTeam.teamId !== team.teamId &&
      foldNameKey(otherTeam.name) === nameKey,
  );
  if (isNameTaken) return refuse('quizshow_team_name_taken', state, false);
  if (name === team.name) return hostActed(state, now, [], true);
  team.name = name;
  const memberIds = activePlayers(state)
    .filter((player) => player.teamId === team.teamId)
    .map((player) => player.playerId);
  return hostActed(
    state,
    now,
    [
      { kind: 'lobby_changed' },
      { kind: 'me_changed', playerIds: memberIds },
      persist({ type: 'update_team', teamId: team.teamId, fields: { name } }),
    ],
    false,
  );
}

export function hostEnd(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  const movingCheck = checkMovingCommand(state, phaseId);
  if (movingCheck === 'stale')
    return refuse('quizshow_stale_phase', state, true);
  if (movingCheck === 'noop') return hostActed(state, now, [], true);
  if (!isOpenStatus(state.status)) {
    return refuse('quizshow_session_ended', state, true);
  }
  if (state.cursor.phase === 'podium') {
    return hostActed(state, now, finishSession(state, now), false);
  }
  if (state.status === 'lobby' || !state.hasScoredQuestion) {
    return hostActed(state, now, abandonSession(state, now), false);
  }
  return hostActed(state, now, showPodium(state, now), false);
}

/** Any status but `finished` and `abandoned`; the gateway emits `screen:muted` on a change. */
export function hostSetScreenMuted(
  state: QuizshowLiveState,
  isMuted: boolean,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  if (!isOpenStatus(state.status)) {
    return refuse('quizshow_session_ended', state, true);
  }
  if (state.isScreenMuted === isMuted) return hostActed(state, now, [], true);
  state.isScreenMuted = isMuted;
  return hostActed(state, now, [], false);
}

/**
 * `host:setAutoAdvance` in any open status (contract 6.16). Turning it on in a
 * qualifying phase of a running session arms the wait from `now`; turning it
 * off drops the armed wait and its timer. The cursor changes without a phase
 * change, so a `phase_changed` carries the new `autoAdvanceAt` to the remotes.
 */
export function hostSetAutoAdvance(
  state: QuizshowLiveState,
  isOn: boolean,
  now: number,
): QuizshowHostOutcome {
  noteHostCommand(state, now);
  if (!isOpenStatus(state.status)) {
    return refuse('quizshow_session_ended', state, true);
  }
  if (state.isAutoAdvanceOn === isOn) return hostActed(state, now, [], true);
  state.isAutoAdvanceOn = isOn;
  const { cursor } = state;
  const previousAutoAdvanceAt = cursor.autoAdvanceAt;
  const effects: QuizshowEngineEffect[] = [
    persist({ type: 'set_session_flags' }),
    { kind: 'flags_changed' },
  ];
  if (isOn) {
    effects.push(...armAutoAdvanceFrom(state, now));
  } else if (previousAutoAdvanceAt !== null) {
    cursor.autoAdvanceAt = null;
    effects.push({ kind: 'timer_cleared' });
  }
  if (cursor.autoAdvanceAt !== previousAutoAdvanceAt) {
    effects.push({ kind: 'phase_changed' });
  }
  return hostActed(state, now, effects, false);
}

/** A phase timer fired; stale phase ids and a paused session do nothing. */
export function timerElapsed(
  state: QuizshowLiveState,
  phaseId: string,
  now: number,
  random: QuizshowRandom = CRYPTO_RANDOM,
): QuizshowEngineEffect[] {
  const { cursor } = state;
  if (phaseId !== cursor.phaseId || state.status !== 'running') return [];
  if (cursor.phase === 'read') {
    if (cursor.deadline !== null && now < cursor.deadline) {
      return phaseTimer(state);
    }
    return openAnswers(state, now);
  }
  if (SUBMISSION_PHASES.includes(cursor.phase)) {
    if (
      cursor.deadline !== null &&
      now < cursor.deadline + QUIZSHOW_LIMITS.answerGraceMs
    ) {
      return phaseTimer(state);
    }
    return withSingleCheckpoint(closeTimedPhase(state, now, true, random));
  }
  // An untimed phase armed for auto-advance moves on as host:next would (contract 6.16).
  if (
    state.isAutoAdvanceOn &&
    cursor.autoAdvanceAt !== null &&
    autoAdvanceWaitMsOf(state) !== null
  ) {
    if (now < cursor.autoAdvanceAt) {
      return [{ kind: 'timer', phaseId, fireAt: cursor.autoAdvanceAt }];
    }
    return withSingleCheckpoint(nextEffects(state, now, random) ?? []);
  }
  return [];
}

/** The runtime calls this after every accepted answer, vote and removal. */
export function closeIfEveryoneDone(
  state: QuizshowLiveState,
  now: number,
  random: QuizshowRandom = CRYPTO_RANDOM,
): QuizshowEngineEffect[] {
  const play = state.current;
  if (
    state.status !== 'running' ||
    play === null ||
    !SUBMISSION_PHASES.includes(state.cursor.phase)
  ) {
    return [];
  }
  const isSomeoneStillToSubmit = [...play.eligiblePlayerIds].some((playerId) =>
    isAwaitedSubmitter(state, playerId, now),
  );
  if (isSomeoneStillToSubmit) return [];
  return withSingleCheckpoint(closeTimedPhase(state, now, false, random));
}

/** A lobby, running or paused session with no host command for `abandonAfterMs` ends with no results. */
export function abandonIfIdle(
  state: QuizshowLiveState,
  now: number,
): QuizshowEngineEffect[] {
  if (!isOpenStatus(state.status)) return [];
  if (now - state.lastHostCommandAt < QUIZSHOW_LIMITS.abandonAfterMs) return [];
  return abandonSession(state, now);
}

/** The event was cancelled or deleted: any open session ends with no results. */
export function abandonNow(
  state: QuizshowLiveState,
  now: number,
): QuizshowEngineEffect[] {
  if (!isOpenStatus(state.status)) return [];
  return abandonSession(state, now);
}
