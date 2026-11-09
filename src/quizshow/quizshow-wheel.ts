import {
  QUIZSHOW_LIMITS,
  QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
  type QuizshowContentLabel,
  type QuizshowCursor,
  type QuizshowPhase,
  type QuizshowPlayableRoundKind,
  type QuizshowRoundKind,
  type QuizshowRoundSettings,
  type QuizshowText,
  type QuizshowUpNext,
  type QuizshowWheelBonusView,
  type QuizshowWheelPick,
  type QuizshowWheelSlice,
  type QuizshowWheelSpin,
  type QuizshowWheelView,
} from './quizshow.contract';

/**
 * Pure wheel helpers shared by the engine, the frames and the quiz mapping.
 * The module imports only the contract file, so every layer can use it
 * without a dependency cycle. The frontend mirrors it by hand.
 */

type WheelSettingsFields = Pick<
  QuizshowRoundSettings,
  'wheelBonus' | 'wheelPick' | 'sliceCount'
>;

/** What the helpers read off a round row; stored rows may lack the wheel settings. */
export interface QuizshowWheelRoundLike {
  kind: QuizshowRoundKind;
  settings: Partial<WheelSettingsFields>;
  questions: ReadonlyArray<unknown>;
}

export type QuizshowWheelRoundRow = QuizshowWheelRoundLike & {
  title: QuizshowText;
  contentLabel: QuizshowContentLabel;
};

export interface QuizshowWheelState {
  wheelRoundIndex: number | null; // null: unplanned spin
  pick: QuizshowWheelPick;
  /** Fixed when the wheel opens; running order. */
  sliceRoundIndexes: number[];
  /** Pick a question: questions opened from each slice, aligned with `sliceRoundIndexes`. All 0 on pick a round. */
  askedCounts: number[];
  /** Items started from this wheel: rounds (pick a round) or questions (pick a question). */
  pickedCount: number;
  spinTotal: number;
  spin: QuizshowWheelSpin | null;
  /** Rotation the wheel rests at, degrees in [0, 360); the next spin starts here. */
  restAngle: number;
  /** The slice whose round or question plays now; null in `wheel` and after the bonus check. */
  playingRoundIndex: number | null;
  /** Pick a round: entrant totals when `playingRoundIndex`'s round_intro opened. */
  baselineByEntrant: Record<string, number> | null;
}

export interface QuizshowWheelBonusAward extends QuizshowWheelBonusView {
  /** The phase that announces it; shown only while `cursor.phaseId` equals it. */
  phaseId: string;
}

export interface QuizshowWheelProgress {
  /** Non-wheel rows whose `round_intro` has opened, in play order. */
  playedRoundIndexes: number[];
  /** Wheel rows whose wheel has opened at least once. */
  openedWheelRoundIndexes: number[];
  /** Wheel rows whose wheel is done: exhausted, or finished early. */
  closedWheelRoundIndexes: number[];
  /** The open wheel (planned or unplanned), or null. */
  wheel: QuizshowWheelState | null;
  wheelBonusAward: QuizshowWheelBonusAward | null;
}

/** Phases that show the wheel view for a pick-a-question wheel question. */
const WHEEL_QUESTION_PHASES: ReadonlyArray<QuizshowPhase> = [
  'read',
  'open',
  'write',
  'review',
  'vote',
  'reveal',
  'scores',
];

const FULL_TURN_DEGREES = 360;

export function isWheelRoundKind(kind: QuizshowRoundKind): kind is 'wheel' {
  return kind === 'wheel';
}

export function isQuizRoundKind(kind: QuizshowRoundKind): kind is 'quiz' {
  return kind === 'quiz';
}

/** Fills the three wheel settings a row stored before the wheel may lack. Returns a new object. */
export function withWheelSettingsDefaults<Settings extends object>(
  settings: Settings,
): Settings & WheelSettingsFields {
  const stored: Partial<WheelSettingsFields> = settings;
  return {
    ...settings,
    wheelBonus:
      stored.wheelBonus ?? QUIZSHOW_WHEEL_SETTINGS_DEFAULTS.wheelBonus,
    wheelPick: stored.wheelPick ?? QUIZSHOW_WHEEL_SETTINGS_DEFAULTS.wheelPick,
    sliceCount:
      stored.sliceCount ?? QUIZSHOW_WHEEL_SETTINGS_DEFAULTS.sliceCount,
  };
}

/** Rows whose kind is not `wheel`: every "N rounds" count. */
export function playableRoundCount(
  rounds: ReadonlyArray<{ kind: QuizshowRoundKind }>,
): number {
  return rounds.filter((round) => !isWheelRoundKind(round.kind)).length;
}

/** 1 + rows before `roundIndex` whose kind is not `wheel`: "Round 3" in the studio. */
export function displayRoundNumber(
  rounds: ReadonlyArray<{ kind: QuizshowRoundKind }>,
  roundIndex: number,
): number {
  return 1 + playableRoundCount(rounds.slice(0, roundIndex));
}

/** 1 + wheel rows before `roundIndex`: "Wheel 2". */
export function displayWheelNumber(
  rounds: ReadonlyArray<{ kind: QuizshowRoundKind }>,
  roundIndex: number,
): number {
  const wheelRowsBefore = rounds
    .slice(0, roundIndex)
    .filter((round) => isWheelRoundKind(round.kind)).length;
  return 1 + wheelRowsBefore;
}

/**
 * The rows right after a wheel row, up to its slice count (Auto means 8),
 * stopping at the next wheel. A range never crosses another wheel.
 */
export function wheelSliceRoundIndexes(
  rounds: ReadonlyArray<QuizshowWheelRoundLike>,
  wheelRoundIndex: number,
): number[] {
  const wheelRow = rounds[wheelRoundIndex];
  if (!wheelRow || !isWheelRoundKind(wheelRow.kind)) return [];
  // A stored count above the limit can never draw more than 8 slices.
  const sliceCap = Math.min(
    withWheelSettingsDefaults(wheelRow.settings).sliceCount ??
      QUIZSHOW_LIMITS.wheelSlicesMax,
    QUIZSHOW_LIMITS.wheelSlicesMax,
  );
  const sliceRoundIndexes: number[] = [];
  for (
    let rowIndex = wheelRoundIndex + 1;
    rowIndex < rounds.length && sliceRoundIndexes.length < sliceCap;
    rowIndex += 1
  ) {
    const row = rounds[rowIndex];
    if (!row || isWheelRoundKind(row.kind)) break;
    sliceRoundIndexes.push(rowIndex);
  }
  return sliceRoundIndexes;
}

/** The wheel row whose range holds `roundIndex`, or null. */
export function wheelRoundIndexOfRange(
  rounds: ReadonlyArray<QuizshowWheelRoundLike>,
  roundIndex: number,
): number | null {
  const row = rounds[roundIndex];
  if (!row || isWheelRoundKind(row.kind)) return null;
  // Ranges never cross a wheel, so only the nearest wheel above can own the row.
  for (let rowIndex = roundIndex - 1; rowIndex >= 0; rowIndex -= 1) {
    const candidate = rounds[rowIndex];
    if (candidate && isWheelRoundKind(candidate.kind)) {
      return wheelSliceRoundIndexes(rounds, rowIndex).includes(roundIndex)
        ? rowIndex
        : null;
    }
  }
  return null;
}

export function isInWheelRange(
  rounds: ReadonlyArray<QuizshowWheelRoundLike>,
  roundIndex: number,
): boolean {
  return wheelRoundIndexOfRange(rounds, roundIndex) !== null;
}

/**
 * Returns a copy of the rows ready to store. Defaults come first so every
 * output row carries the three wheel settings; ranges are computed from the
 * input rows before any change. The input is never mutated.
 */
export function normaliseWheelRounds<
  Round extends QuizshowWheelRoundLike & { contentLabel: QuizshowContentLabel },
>(rounds: readonly Round[]): Round[] {
  const defaultedRounds = rounds.map((round) => ({
    ...round,
    settings: withWheelSettingsDefaults(round.settings),
  }));
  const isInRangeByIndex = defaultedRounds.map((_round, roundIndex) =>
    isInWheelRange(defaultedRounds, roundIndex),
  );
  return defaultedRounds.map((round, roundIndex) => {
    const isWheelRow = isWheelRoundKind(round.kind);
    const isInRange = isInRangeByIndex[roundIndex] === true;
    return {
      ...round,
      contentLabel: isWheelRow ? 'none' : round.contentLabel,
      settings: {
        ...round.settings,
        wheelBonus: !isWheelRow && isInRange ? round.settings.wheelBonus : 0,
        wheelPick: isWheelRow ? round.settings.wheelPick : 'round',
        sliceCount: isWheelRow ? round.settings.sliceCount : null,
      },
    };
  });
}

export function emptyWheelProgress(): QuizshowWheelProgress {
  return {
    playedRoundIndexes: [],
    openedWheelRoundIndexes: [],
    closedWheelRoundIndexes: [],
    wheel: null,
    wheelBonusAward: null,
  };
}

/** What `host:next` opens from the lobby or a leaderboard. */
export function nextQuizshowStep(
  rounds: ReadonlyArray<QuizshowWheelRoundLike>,
  progress: QuizshowWheelProgress,
): QuizshowUpNext {
  let rowIndex = 0;
  while (rowIndex < rounds.length) {
    const row = rounds[rowIndex];
    if (!row) break;
    if (isWheelRoundKind(row.kind)) {
      if (!progress.closedWheelRoundIndexes.includes(rowIndex)) {
        return { kind: 'wheel', wheelRoundIndex: rowIndex };
      }
      // A closed wheel's unplayed slices are skipped for good.
      const lastSliceRoundIndex =
        wheelSliceRoundIndexes(rounds, rowIndex).at(-1) ?? rowIndex;
      rowIndex = lastSliceRoundIndex + 1;
      continue;
    }
    if (!progress.playedRoundIndexes.includes(rowIndex)) {
      return { kind: 'round', roundIndex: rowIndex };
    }
    rowIndex += 1;
  }
  return { kind: 'podium' };
}

/** Unplayed rows outside every range, in running order, at most 8: the unplanned wheel. */
export function unplannedWheelSliceRoundIndexes(
  rounds: ReadonlyArray<QuizshowWheelRoundLike>,
  progress: QuizshowWheelProgress,
): number[] {
  const candidateRoundIndexes: number[] = [];
  for (
    let rowIndex = 0;
    rowIndex < rounds.length &&
    candidateRoundIndexes.length < QUIZSHOW_LIMITS.wheelSlicesMax;
    rowIndex += 1
  ) {
    const row = rounds[rowIndex];
    if (!row || isWheelRoundKind(row.kind)) continue;
    if (isInWheelRange(rounds, rowIndex)) continue;
    if (progress.playedRoundIndexes.includes(rowIndex)) continue;
    candidateRoundIndexes.push(rowIndex);
  }
  return candidateRoundIndexes;
}

export function canSpinForNextRound(
  rounds: ReadonlyArray<QuizshowWheelRoundLike>,
  progress: QuizshowWheelProgress,
  phase: QuizshowPhase,
): boolean {
  return (
    phase === 'leaderboard' &&
    nextQuizshowStep(rounds, progress).kind === 'round' &&
    progress.wheel === null &&
    unplannedWheelSliceRoundIndexes(rounds, progress).length >=
      QUIZSHOW_LIMITS.wheelSlicesMin
  );
}

/** M of "Round N of M". */
export function quizshowRoundTotal(
  rounds: ReadonlyArray<QuizshowWheelRoundLike>,
  progress: QuizshowWheelProgress,
): number {
  let total = 0;
  rounds.forEach((row, rowIndex) => {
    if (isWheelRoundKind(row.kind)) {
      if (withWheelSettingsDefaults(row.settings).wheelPick === 'question') {
        total += 1;
        return;
      }
      const sliceRoundIndexes = wheelSliceRoundIndexes(rounds, rowIndex);
      if (progress.closedWheelRoundIndexes.includes(rowIndex)) {
        total += sliceRoundIndexes.filter((sliceRoundIndex) =>
          progress.playedRoundIndexes.includes(sliceRoundIndex),
        ).length;
      } else {
        total += sliceRoundIndexes.length;
      }
      return;
    }
    // A slice row adds 0: its wheel counted it.
    if (!isInWheelRange(rounds, rowIndex)) total += 1;
  });
  return total;
}

/** N of "Round N of M": rounds started, plus opened pick-a-question wheels. */
export function quizshowRoundNumber(
  rounds: ReadonlyArray<QuizshowWheelRoundLike>,
  progress: QuizshowWheelProgress,
): number {
  const openedQuestionWheelCount = progress.openedWheelRoundIndexes.filter(
    (wheelRoundIndex) => {
      const wheelRow = rounds[wheelRoundIndex];
      return (
        wheelRow !== undefined &&
        withWheelSettingsDefaults(wheelRow.settings).wheelPick === 'question'
      );
    },
  ).length;
  return progress.playedRoundIndexes.length + openedQuestionWheelCount;
}

/** The four cursor fields that follow the wheel progress; recomputed on every phase change. */
export function progressCursorFields(
  rounds: ReadonlyArray<QuizshowWheelRoundLike>,
  progress: QuizshowWheelProgress,
  phase: QuizshowPhase,
): Pick<
  QuizshowCursor,
  'roundNumber' | 'roundCount' | 'upNext' | 'canSpinForNextRound'
> {
  const isUpNextPhase = phase === 'lobby' || phase === 'leaderboard';
  return {
    roundNumber: quizshowRoundNumber(rounds, progress),
    roundCount: quizshowRoundTotal(rounds, progress),
    upNext: isUpNextPhase ? nextQuizshowStep(rounds, progress) : null,
    canSpinForNextRound: canSpinForNextRound(rounds, progress, phase),
  };
}

export function createWheelState(
  rounds: ReadonlyArray<QuizshowWheelRoundLike>,
  wheelRoundIndex: number | null,
  sliceRoundIndexes: readonly number[],
): QuizshowWheelState {
  const wheelRow =
    wheelRoundIndex === null ? undefined : rounds[wheelRoundIndex];
  const pick: QuizshowWheelPick = wheelRow
    ? withWheelSettingsDefaults(wheelRow.settings).wheelPick
    : 'round';
  const spinTotal =
    pick === 'round'
      ? sliceRoundIndexes.length
      : sliceRoundIndexes.reduce(
          (questionTotal, sliceRoundIndex) =>
            questionTotal + (rounds[sliceRoundIndex]?.questions.length ?? 0),
          0,
        );
  return {
    wheelRoundIndex,
    pick,
    sliceRoundIndexes: [...sliceRoundIndexes],
    askedCounts: sliceRoundIndexes.map(() => 0),
    pickedCount: 0,
    spinTotal,
    spin: null,
    restAngle: 0,
    playingRoundIndex: null,
    baselineByEntrant: null,
  };
}

/** Pick a round: the round has started. Pick a question: the pile is empty. */
export function isWheelSlicePlayed(
  rounds: ReadonlyArray<QuizshowWheelRoundLike>,
  wheel: QuizshowWheelState,
  progress: QuizshowWheelProgress,
  sliceRoundIndex: number,
): boolean {
  if (wheel.pick === 'round') {
    return progress.playedRoundIndexes.includes(sliceRoundIndex);
  }
  const slicePosition = wheel.sliceRoundIndexes.indexOf(sliceRoundIndex);
  const askedCount = wheel.askedCounts[slicePosition] ?? 0;
  return askedCount >= (rounds[sliceRoundIndex]?.questions.length ?? 0);
}

/** The slices still on the wheel, running order: what is drawn and spun. */
export function drawnWheelSliceRoundIndexes(
  rounds: ReadonlyArray<QuizshowWheelRoundLike>,
  wheel: QuizshowWheelState,
  progress: QuizshowWheelProgress,
): number[] {
  return wheel.sliceRoundIndexes.filter(
    (sliceRoundIndex) =>
      !isWheelSlicePlayed(rounds, wheel, progress, sliceRoundIndex),
  );
}

export function isWheelExhausted(
  rounds: ReadonlyArray<QuizshowWheelRoundLike>,
  wheel: QuizshowWheelState,
  progress: QuizshowWheelProgress,
): boolean {
  return drawnWheelSliceRoundIndexes(rounds, wheel, progress).length === 0;
}

/** The always-positive remainder of contract 7.2; the engine stores `restAngle` with it. */
export function wheelAngleModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

/** Draws in the fixed order of contract 7.1: slice, turns, jitter. */
export function drawWheelSpin(input: {
  drawnCount: number;
  startAngle: number;
  now: number;
  random: { integerBelow(limit: number): number };
}): QuizshowWheelSpin {
  if (input.drawnCount < 1) {
    throw new Error('Pulse Live cannot spin a wheel with no slices.');
  }
  const landedSliceIndex = input.random.integerBelow(input.drawnCount);
  const turns =
    QUIZSHOW_LIMITS.wheelTurnsMin +
    input.random.integerBelow(
      QUIZSHOW_LIMITS.wheelTurnsMax - QUIZSHOW_LIMITS.wheelTurnsMin + 1,
    );
  const jitterSeed = input.random.integerBelow(
    QUIZSHOW_LIMITS.wheelJitterSeedMax + 1,
  );
  return {
    landedSliceIndex,
    startedAt: input.now,
    durationMs: QUIZSHOW_LIMITS.wheelSpinMs,
    turns,
    jitterSeed,
    startAngle: input.startAngle,
  };
}

/** The rotation that puts the middle of the landed slice, nudged by the jitter, under the pointer. */
export function wheelSpinEndAngle(
  spin: QuizshowWheelSpin,
  drawnCount: number,
): number {
  const sweep = FULL_TURN_DEGREES / drawnCount;
  const middle = spin.landedSliceIndex * sweep + sweep / 2;
  const jitter =
    (spin.jitterSeed / QUIZSHOW_LIMITS.wheelJitterSeedMax - 0.5) *
    QUIZSHOW_LIMITS.wheelJitterSpread *
    sweep;
  const landing = wheelAngleModulo(
    QUIZSHOW_LIMITS.wheelPointerAngle - middle + jitter,
    FULL_TURN_DEGREES,
  );
  const base =
    spin.startAngle - wheelAngleModulo(spin.startAngle, FULL_TURN_DEGREES);
  return base + FULL_TURN_DEGREES * spin.turns + landing;
}

export function wheelSpinLandsAt(spin: QuizshowWheelSpin): number {
  return spin.startedAt + spin.durationMs;
}

export function isWheelSpinLanded(
  spin: QuizshowWheelSpin,
  now: number,
  toleranceMs = 0,
): boolean {
  return now >= wheelSpinLandsAt(spin) - toleranceMs;
}

export function toWheelView(
  rounds: ReadonlyArray<QuizshowWheelRoundRow>,
  wheel: QuizshowWheelState,
  progress: QuizshowWheelProgress,
  phase: QuizshowPhase,
): QuizshowWheelView {
  const slices: QuizshowWheelSlice[] = [];
  wheel.sliceRoundIndexes.forEach((sliceRoundIndex, slicePosition) => {
    const row = rounds[sliceRoundIndex];
    // A range never holds a wheel row; skip one defensively.
    if (!row || isWheelRoundKind(row.kind)) return;
    const slicePlayableKind: QuizshowPlayableRoundKind = row.kind;
    const isPlayed = isWheelSlicePlayed(
      rounds,
      wheel,
      progress,
      sliceRoundIndex,
    );
    const askedCount = wheel.askedCounts[slicePosition] ?? 0;
    slices.push({
      roundIndex: sliceRoundIndex,
      title: row.title,
      kind: slicePlayableKind,
      contentLabel: row.contentLabel,
      wheelBonus:
        wheel.wheelRoundIndex === null
          ? 0
          : withWheelSettingsDefaults(row.settings).wheelBonus,
      questionCount:
        wheel.pick === 'round'
          ? row.questions.length
          : Math.max(0, row.questions.length - askedCount),
      isPlayed,
    });
  });
  const isWheelPhase = phase === 'wheel';
  return {
    wheelRoundIndex: wheel.wheelRoundIndex,
    pick: wheel.pick,
    slices,
    spinNumber: wheel.pickedCount + (isWheelPhase ? 1 : 0),
    spinTotal: wheel.spinTotal,
    spin: wheel.spin,
    playingRoundIndex: isWheelPhase ? null : wheel.playingRoundIndex,
  };
}

/** Contract 8.1: the wheel view while the phase shows a wheel; null otherwise. */
export function wheelViewForCursor(
  rounds: ReadonlyArray<QuizshowWheelRoundRow>,
  progress: QuizshowWheelProgress,
  cursor: QuizshowCursor,
): QuizshowWheelView | null {
  const wheel = progress.wheel;
  if (!wheel) return null;
  if (cursor.phase === 'wheel') {
    return toWheelView(rounds, wheel, progress, cursor.phase);
  }
  const isWheelQuestion =
    WHEEL_QUESTION_PHASES.includes(cursor.phase) &&
    wheel.pick === 'question' &&
    wheel.playingRoundIndex !== null &&
    wheel.playingRoundIndex === cursor.roundIndex;
  return isWheelQuestion
    ? toWheelView(rounds, wheel, progress, cursor.phase)
    : null;
}

/** Contract 8.2: the award while its phase is on show, without `phaseId`. */
export function wheelBonusViewForCursor(
  progress: QuizshowWheelProgress,
  cursor: QuizshowCursor,
): QuizshowWheelBonusView | null {
  const award = progress.wheelBonusAward;
  if (!award || award.phaseId !== cursor.phaseId) return null;
  return {
    points: award.points,
    pick: award.pick,
    sliceRoundIndex: award.sliceRoundIndex,
    sliceTitle: award.sliceTitle,
    winners: [...award.winners],
  };
}
