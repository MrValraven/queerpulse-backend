import type {
  QuizshowCursor,
  QuizshowPhase,
  QuizshowRoundKind,
  QuizshowRoundSettings,
  QuizshowWheelSpin,
} from './quizshow.contract';
import {
  canSpinForNextRound,
  createWheelState,
  displayRoundNumber,
  displayWheelNumber,
  drawnWheelSliceRoundIndexes,
  drawWheelSpin,
  emptyWheelProgress,
  isInWheelRange,
  isQuizRoundKind,
  isWheelExhausted,
  isWheelRoundKind,
  isWheelSlicePlayed,
  isWheelSpinLanded,
  nextQuizshowStep,
  normaliseWheelRounds,
  playableRoundCount,
  progressCursorFields,
  quizshowRoundNumber,
  quizshowRoundTotal,
  toWheelView,
  unplannedWheelSliceRoundIndexes,
  wheelAngleModulo,
  wheelBonusViewForCursor,
  wheelRoundIndexOfRange,
  wheelSliceRoundIndexes,
  wheelSpinEndAngle,
  wheelSpinLandsAt,
  wheelViewForCursor,
  withWheelSettingsDefaults,
  type QuizshowWheelProgress,
  type QuizshowWheelRoundRow,
} from './quizshow-wheel';

type WheelSettings = Partial<
  Pick<QuizshowRoundSettings, 'wheelBonus' | 'wheelPick' | 'sliceCount'>
>;

function row(
  kind: QuizshowRoundKind,
  questionCount: number,
  settings: WheelSettings = {},
  titleEn = `${kind} round`,
): QuizshowWheelRoundRow {
  return {
    kind,
    title: { en: titleEn, pt: titleEn },
    contentLabel: 'none',
    settings,
    questions: Array.from(
      { length: questionCount },
      (_unused, questionIndex) => ({
        questionIndex,
      }),
    ),
  };
}

/** Contract 3.2: [R0, W1 Auto pick round, R2, R3, R4, W5 count 2 pick question, R6, R7, R8]. */
const EXAMPLE_ROWS = [
  row('quiz', 2),
  row('wheel', 0),
  row('quiz', 2, { wheelBonus: 500 }, 'Music'),
  row('lie_detector', 1),
  row('quiz', 3),
  row('wheel', 0, { wheelPick: 'question', sliceCount: 2 }),
  row('quiz', 3),
  row('caption_this', 2, { wheelBonus: 250 }),
  row('quiz', 1),
];
/** [R0, R1, R2, W3 count 2, R4, R5, R6, R7]: R6 and R7 sit outside every range. */
const SPLIT_ROWS = [
  row('quiz', 1),
  row('quiz', 1),
  row('quiz', 1),
  row('wheel', 0, { sliceCount: 2 }),
  row('quiz', 1),
  row('quiz', 1),
  row('quiz', 1),
  row('quiz', 1),
];
const FLAT_ROWS = Array.from({ length: 10 }, () => row('quiz', 1));

function progressWith(
  overrides: Partial<QuizshowWheelProgress> = {},
): QuizshowWheelProgress {
  return { ...emptyWheelProgress(), ...overrides };
}

function scriptedRandom(values: number[]) {
  const limits: number[] = [];
  return {
    limits,
    integerBelow(limit: number) {
      limits.push(limit);
      return values.shift() ?? 0;
    },
  };
}

function cursorAt(
  phase: QuizshowPhase,
  roundIndex: number | null,
  phaseId = '7',
): QuizshowCursor {
  return {
    phaseId,
    status: 'running',
    phase,
    roundIndex,
    questionIndex: null,
    roundCount: 6,
    phaseStartedAt: 1000,
    deadline: null,
    extraTimeDeadline: null,
    pausedRemainingMs: null,
    pausedExtraTimeRemainingMs: null,
    isRestartRecovery: false,
    roundNumber: 1,
    upNext: null,
    canSpinForNextRound: false,
  };
}

const LANDED_SPIN: QuizshowWheelSpin = {
  landedSliceIndex: 0,
  startedAt: 1000,
  durationMs: 5500,
  turns: 5,
  jitterSeed: 500,
  startAngle: 0,
};

function spinWith(
  overrides: Partial<QuizshowWheelSpin> = {},
): QuizshowWheelSpin {
  return {
    landedSliceIndex: 1,
    startedAt: 1000,
    durationMs: 5500,
    turns: 5,
    jitterSeed: 500,
    startAngle: 0,
    ...overrides,
  };
}

describe('quizshow-wheel', () => {
  it('guards the wheel and quiz kinds', () => {
    expect(isWheelRoundKind('wheel')).toBe(true);
    expect(isWheelRoundKind('quiz')).toBe(false);
    expect(isQuizRoundKind('quiz')).toBe(true);
    expect(isQuizRoundKind('lie_detector')).toBe(false);
    expect(isQuizRoundKind('wheel')).toBe(false);
  });

  it('wraps angles to a positive remainder', () => {
    expect(wheelAngleModulo(400, 360)).toBe(40);
    expect(wheelAngleModulo(-30, 360)).toBe(330);
    expect(wheelAngleModulo(-30 - 360, 360)).toBe(330);
    expect(wheelAngleModulo(0, 360)).toBe(0);
    expect(wheelAngleModulo(360, 360)).toBe(0);
  });

  it('finds the slices of each wheel as contract 3.2 does', () => {
    expect(wheelSliceRoundIndexes(EXAMPLE_ROWS, 1)).toEqual([2, 3, 4]);
    expect(wheelSliceRoundIndexes(EXAMPLE_ROWS, 5)).toEqual([6, 7]);
    expect(wheelSliceRoundIndexes(EXAMPLE_ROWS, 0)).toEqual([]);
    expect(wheelSliceRoundIndexes(EXAMPLE_ROWS, 99)).toEqual([]);
    expect(
      wheelSliceRoundIndexes([row('quiz', 1), row('wheel', 0)], 1),
    ).toEqual([]);
    expect(
      wheelSliceRoundIndexes(
        [row('wheel', 0), row('wheel', 0), row('quiz', 1)],
        0,
      ),
    ).toEqual([]);
  });

  it('caps an Auto wheel at 8 slices', () => {
    expect(wheelSliceRoundIndexes([row('wheel', 0), ...FLAT_ROWS], 0)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it('never draws more than 8 slices from a stored count above the limit', () => {
    expect(
      wheelSliceRoundIndexes(
        [row('wheel', 0, { sliceCount: 12 }), ...FLAT_ROWS],
        0,
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('cuts a fixed count short at the next wheel', () => {
    expect(
      wheelSliceRoundIndexes(
        [
          row('wheel', 0, { sliceCount: 3 }),
          row('quiz', 1),
          row('wheel', 0),
          row('quiz', 1),
        ],
        0,
      ),
    ).toEqual([1]);
  });

  it('names the wheel whose range holds a row', () => {
    expect(wheelRoundIndexOfRange(EXAMPLE_ROWS, 3)).toBe(1);
    expect(wheelRoundIndexOfRange(EXAMPLE_ROWS, 7)).toBe(5);
    expect(wheelRoundIndexOfRange(EXAMPLE_ROWS, 0)).toBeNull();
    expect(wheelRoundIndexOfRange(EXAMPLE_ROWS, 1)).toBeNull();
    expect(wheelRoundIndexOfRange(EXAMPLE_ROWS, 8)).toBeNull();
    expect(isInWheelRange(EXAMPLE_ROWS, 6)).toBe(true);
    expect(isInWheelRange(EXAMPLE_ROWS, 8)).toBe(false);
  });

  it('counts and numbers rounds without the wheels', () => {
    expect(playableRoundCount(EXAMPLE_ROWS)).toBe(7);
    expect(displayRoundNumber(EXAMPLE_ROWS, 2)).toBe(2);
    expect(displayRoundNumber(EXAMPLE_ROWS, 8)).toBe(7);
    expect(displayWheelNumber(EXAMPLE_ROWS, 1)).toBe(1);
    expect(displayWheelNumber(EXAMPLE_ROWS, 5)).toBe(2);
  });

  it('defaults stored rows that lack the wheel settings', () => {
    const stored = { timeLimitSeconds: 20 };
    expect(withWheelSettingsDefaults(stored)).toEqual({
      timeLimitSeconds: 20,
      wheelBonus: 0,
      wheelPick: 'round',
      sliceCount: null,
    });
    expect(stored).toEqual({ timeLimitSeconds: 20 });
    expect(
      withWheelSettingsDefaults({
        wheelBonus: 500,
        wheelPick: 'question',
        sliceCount: 3,
      }),
    ).toEqual({ wheelBonus: 500, wheelPick: 'question', sliceCount: 3 });
  });

  it('fills the section 2.2 defaults before normalising', () => {
    const normalised = normaliseWheelRounds([
      row('quiz', 1),
      row('wheel', 0),
      row('quiz', 1),
      row('quiz', 1),
    ]);
    expect(normalised).toHaveLength(4);
    normalised.forEach((normalisedRow) => {
      expect(Object.keys(normalisedRow.settings)).toEqual(
        expect.arrayContaining(['wheelBonus', 'wheelPick', 'sliceCount']),
      );
      expect(normalisedRow.settings).toEqual({
        wheelBonus: 0,
        wheelPick: 'round',
        sliceCount: null,
      });
    });
  });

  it('normalises wheel rows on save from the ranges of the input', () => {
    const input: QuizshowWheelRoundRow[] = [
      row('quiz', 1, { wheelBonus: 500 }),
      {
        ...row('wheel', 0, {
          wheelBonus: 500,
          wheelPick: 'question',
          sliceCount: 2,
        }),
        contentLabel: 'adults',
      },
      row('quiz', 1, { wheelBonus: 250, wheelPick: 'question', sliceCount: 3 }),
      row('quiz', 1, { wheelBonus: 1000 }),
      row('quiz', 1, { wheelBonus: 500 }),
      row('quiz', 1, {}),
    ];
    const snapshotBefore = structuredClone(input);
    const normalised = normaliseWheelRounds(input);
    expect(input).toEqual(snapshotBefore);
    expect(normalised.map((normalisedRow) => normalisedRow.settings)).toEqual([
      { wheelBonus: 0, wheelPick: 'round', sliceCount: null },
      { wheelBonus: 0, wheelPick: 'question', sliceCount: 2 },
      { wheelBonus: 250, wheelPick: 'round', sliceCount: null },
      { wheelBonus: 1000, wheelPick: 'round', sliceCount: null },
      { wheelBonus: 0, wheelPick: 'round', sliceCount: null },
      { wheelBonus: 0, wheelPick: 'round', sliceCount: null },
    ]);
    expect(normalised[1]?.contentLabel).toBe('none');
  });

  it('walks the running order to the next step', () => {
    expect(nextQuizshowStep(EXAMPLE_ROWS, emptyWheelProgress())).toEqual({
      kind: 'round',
      roundIndex: 0,
    });
    expect(
      nextQuizshowStep(EXAMPLE_ROWS, progressWith({ playedRoundIndexes: [0] })),
    ).toEqual({ kind: 'wheel', wheelRoundIndex: 1 });
    expect(
      nextQuizshowStep(
        EXAMPLE_ROWS,
        progressWith({
          playedRoundIndexes: [0, 2],
          openedWheelRoundIndexes: [1],
        }),
      ),
    ).toEqual({ kind: 'wheel', wheelRoundIndex: 1 });
    expect(
      nextQuizshowStep(
        EXAMPLE_ROWS,
        progressWith({
          playedRoundIndexes: [0, 2],
          openedWheelRoundIndexes: [1],
          closedWheelRoundIndexes: [1],
        }),
      ),
    ).toEqual({ kind: 'wheel', wheelRoundIndex: 5 });
    expect(
      nextQuizshowStep(
        EXAMPLE_ROWS,
        progressWith({
          playedRoundIndexes: [0, 2],
          closedWheelRoundIndexes: [1, 5],
        }),
      ),
    ).toEqual({ kind: 'round', roundIndex: 8 });
    expect(
      nextQuizshowStep(
        EXAMPLE_ROWS,
        progressWith({
          playedRoundIndexes: [0, 2, 8],
          closedWheelRoundIndexes: [1, 5],
        }),
      ),
    ).toEqual({ kind: 'podium' });
  });

  it('fills the cursor fields in the lobby', () => {
    expect(
      progressCursorFields(EXAMPLE_ROWS, emptyWheelProgress(), 'lobby'),
    ).toEqual({
      roundNumber: 0,
      roundCount: 6,
      upNext: { kind: 'round', roundIndex: 0 },
      canSpinForNextRound: false,
    });
  });

  it('names what comes next only in the lobby and on a leaderboard', () => {
    const afterFirstRound = progressWith({ playedRoundIndexes: [0] });
    expect(
      progressCursorFields(EXAMPLE_ROWS, afterFirstRound, 'leaderboard'),
    ).toMatchObject({
      roundNumber: 1,
      upNext: { kind: 'wheel', wheelRoundIndex: 1 },
    });
    expect(
      progressCursorFields(EXAMPLE_ROWS, afterFirstRound, 'open').upNext,
    ).toBeNull();
  });

  it('offers the unplanned spin on a leaderboard in the cursor fields', () => {
    expect(
      progressCursorFields(
        SPLIT_ROWS,
        progressWith({ playedRoundIndexes: [0] }),
        'leaderboard',
      ).canSpinForNextRound,
    ).toBe(true);
  });

  it('resumes the running order after an unplanned spin', () => {
    expect(
      nextQuizshowStep(
        SPLIT_ROWS,
        progressWith({ playedRoundIndexes: [0, 6] }),
      ),
    ).toEqual({ kind: 'round', roundIndex: 1 });
  });

  it('lists the unplanned candidates outside every range, first 8', () => {
    expect(
      unplannedWheelSliceRoundIndexes(
        SPLIT_ROWS,
        progressWith({ playedRoundIndexes: [0] }),
      ),
    ).toEqual([1, 2, 6, 7]);
    expect(
      unplannedWheelSliceRoundIndexes(
        FLAT_ROWS,
        progressWith({ playedRoundIndexes: [0] }),
      ),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('offers the unplanned spin only on a leaderboard with a round next and 2 candidates', () => {
    const afterFirstRound = progressWith({ playedRoundIndexes: [0] });
    expect(
      canSpinForNextRound(SPLIT_ROWS, afterFirstRound, 'leaderboard'),
    ).toBe(true);
    expect(canSpinForNextRound(SPLIT_ROWS, afterFirstRound, 'scores')).toBe(
      false,
    );
    expect(
      canSpinForNextRound(
        SPLIT_ROWS,
        progressWith({ playedRoundIndexes: [0, 1, 2] }),
        'leaderboard',
      ),
    ).toBe(false);
    expect(
      canSpinForNextRound(
        SPLIT_ROWS,
        progressWith({
          playedRoundIndexes: [0, 1, 2, 6],
          closedWheelRoundIndexes: [3],
        }),
        'leaderboard',
      ),
    ).toBe(false);
    expect(
      canSpinForNextRound(
        SPLIT_ROWS,
        progressWith({
          playedRoundIndexes: [0],
          wheel: createWheelState(SPLIT_ROWS, null, [1, 2]),
        }),
        'leaderboard',
      ),
    ).toBe(false);
  });

  it('totals rounds per contract 3.5', () => {
    expect(quizshowRoundTotal(EXAMPLE_ROWS, emptyWheelProgress())).toBe(6);
    expect(
      quizshowRoundTotal(
        EXAMPLE_ROWS,
        progressWith({
          playedRoundIndexes: [0, 3],
          openedWheelRoundIndexes: [1],
          closedWheelRoundIndexes: [1],
        }),
      ),
    ).toBe(4);
    expect(
      quizshowRoundNumber(
        EXAMPLE_ROWS,
        progressWith({
          playedRoundIndexes: [0, 3],
          openedWheelRoundIndexes: [1, 5],
        }),
      ),
    ).toBe(3);
  });

  it('creates a wheel state with its spin total', () => {
    expect(createWheelState(EXAMPLE_ROWS, 1, [2, 3, 4])).toEqual({
      wheelRoundIndex: 1,
      pick: 'round',
      sliceRoundIndexes: [2, 3, 4],
      askedCounts: [0, 0, 0],
      pickedCount: 0,
      spinTotal: 3,
      spin: null,
      restAngle: 0,
      playingRoundIndex: null,
      baselineByEntrant: null,
    });
    expect(createWheelState(EXAMPLE_ROWS, 5, [6, 7])).toMatchObject({
      pick: 'question',
      spinTotal: 5,
    });
    expect(createWheelState(FLAT_ROWS, null, [1, 2])).toMatchObject({
      pick: 'round',
      spinTotal: 2,
    });
  });

  it('draws the slices still on the wheel', () => {
    const wheelOne = createWheelState(EXAMPLE_ROWS, 1, [2, 3, 4]);
    const afterTwoRounds = progressWith({ playedRoundIndexes: [0, 2] });
    expect(
      drawnWheelSliceRoundIndexes(EXAMPLE_ROWS, wheelOne, afterTwoRounds),
    ).toEqual([3, 4]);

    const wheelFive = createWheelState(EXAMPLE_ROWS, 5, [6, 7]);
    const partlyAsked = { ...wheelFive, askedCounts: [3, 0] };
    expect(
      drawnWheelSliceRoundIndexes(
        EXAMPLE_ROWS,
        partlyAsked,
        emptyWheelProgress(),
      ),
    ).toEqual([7]);
    expect(
      isWheelSlicePlayed(EXAMPLE_ROWS, partlyAsked, emptyWheelProgress(), 6),
    ).toBe(true);

    const allAsked = { ...wheelFive, askedCounts: [3, 2] };
    expect(
      drawnWheelSliceRoundIndexes(EXAMPLE_ROWS, allAsked, emptyWheelProgress()),
    ).toEqual([]);
    expect(isWheelExhausted(EXAMPLE_ROWS, allAsked, emptyWheelProgress())).toBe(
      true,
    );
  });

  it('draws a spin in the fixed order of contract 7.1', () => {
    const random = scriptedRandom([2, 1, 500]);
    expect(
      drawWheelSpin({ drawnCount: 4, startAngle: 90, now: 1000, random }),
    ).toEqual({
      landedSliceIndex: 2,
      startedAt: 1000,
      durationMs: 5500,
      turns: 6,
      jitterSeed: 500,
      startAngle: 90,
    });
    expect(random.limits).toEqual([4, 2, 1001]);
  });

  it('refuses to draw a spin with no slices', () => {
    expect(() =>
      drawWheelSpin({
        drawnCount: 0,
        startAngle: 0,
        now: 0,
        random: scriptedRandom([]),
      }),
    ).toThrow('Pulse Live cannot spin a wheel with no slices.');
  });

  it("lands the middle of the slice under the pointer at 9 o'clock", () => {
    expect(wheelSpinEndAngle(LANDED_SPIN, 4)).toBeCloseTo(2025, 9);
    expect(
      wheelSpinEndAngle({ ...LANDED_SPIN, jitterSeed: 1000 }, 4),
    ).toBeCloseTo(2056.5, 9);
    expect(wheelSpinEndAngle({ ...LANDED_SPIN, jitterSeed: 0 }, 4)).toBeCloseTo(
      1993.5,
      9,
    );
    expect(
      wheelSpinEndAngle({ ...LANDED_SPIN, startAngle: 400 }, 4),
    ).toBeCloseTo(2385, 9);
    expect(
      wheelSpinEndAngle({ ...LANDED_SPIN, landedSliceIndex: 3 }, 4),
    ).toBeCloseTo(2115, 9);
  });

  it('computes the end angle with the pointer at nine o clock', () => {
    expect(wheelSpinEndAngle(spinWith(), 4)).toBeCloseTo(1935, 9);
    expect(wheelSpinEndAngle(spinWith({ startAngle: 135 }), 4)).toBeCloseTo(
      1935,
      9,
    );
    expect(wheelSpinEndAngle(spinWith({ startAngle: 400 }), 4)).toBeCloseTo(
      2295,
      9,
    );
    expect(wheelSpinEndAngle(spinWith({ jitterSeed: 1000 }), 4)).toBeCloseTo(
      1966.5,
      9,
    );
    expect(wheelSpinEndAngle(spinWith({ jitterSeed: 0 }), 4)).toBeCloseTo(
      1903.5,
      9,
    );
    expect(wheelSpinEndAngle(spinWith({ landedSliceIndex: 2 }), 3)).toBeCloseTo(
      2130,
      9,
    );
  });

  it('starts a negative angle from the turn below zero', () => {
    expect(
      wheelSpinEndAngle(spinWith({ landedSliceIndex: 0, startAngle: -30 }), 4),
    ).toBeCloseTo(1665, 9);
    expect(
      wheelSpinEndAngle(spinWith({ landedSliceIndex: 1, startAngle: -30 }), 4),
    ).toBeCloseTo(1575, 9);
  });

  it('times the landing with the server tolerance', () => {
    expect(wheelSpinLandsAt(LANDED_SPIN)).toBe(6500);
    expect(isWheelSpinLanded(LANDED_SPIN, 6499)).toBe(false);
    expect(isWheelSpinLanded(LANDED_SPIN, 6500)).toBe(true);
    expect(isWheelSpinLanded(LANDED_SPIN, 6250, 250)).toBe(true);
    expect(isWheelSpinLanded(LANDED_SPIN, 6249, 250)).toBe(false);
  });

  it('builds the wheel view from the rows and the state', () => {
    const wheelOne = {
      ...createWheelState(EXAMPLE_ROWS, 1, [2, 3, 4]),
      pickedCount: 1,
    };
    const view = toWheelView(
      EXAMPLE_ROWS,
      wheelOne,
      progressWith({ playedRoundIndexes: [0, 2], wheel: wheelOne }),
      'wheel',
    );
    expect(view.slices).toEqual([
      {
        roundIndex: 2,
        title: { en: 'Music', pt: 'Music' },
        kind: 'quiz',
        contentLabel: 'none',
        wheelBonus: 500,
        questionCount: 2,
        isPlayed: true,
      },
      {
        roundIndex: 3,
        title: { en: 'lie_detector round', pt: 'lie_detector round' },
        kind: 'lie_detector',
        contentLabel: 'none',
        wheelBonus: 0,
        questionCount: 1,
        isPlayed: false,
      },
      {
        roundIndex: 4,
        title: { en: 'quiz round', pt: 'quiz round' },
        kind: 'quiz',
        contentLabel: 'none',
        wheelBonus: 0,
        questionCount: 3,
        isPlayed: false,
      },
    ]);
    expect(view).toMatchObject({
      wheelRoundIndex: 1,
      pick: 'round',
      spinNumber: 2,
      spinTotal: 3,
      spin: null,
      playingRoundIndex: null,
    });

    const wheelFive = {
      ...createWheelState(EXAMPLE_ROWS, 5, [6, 7]),
      askedCounts: [1, 0],
    };
    const questionView = toWheelView(
      EXAMPLE_ROWS,
      wheelFive,
      progressWith({ wheel: wheelFive }),
      'wheel',
    );
    expect(questionView.slices[0]).toMatchObject({
      roundIndex: 6,
      questionCount: 2,
    });
    expect(questionView.slices[1]).toMatchObject({
      roundIndex: 7,
      questionCount: 2,
      wheelBonus: 250,
    });

    const unplanned = createWheelState(EXAMPLE_ROWS, null, [2, 8]);
    const unplannedView = toWheelView(
      EXAMPLE_ROWS,
      unplanned,
      progressWith({ wheel: unplanned }),
      'wheel',
    );
    expect(unplannedView.wheelRoundIndex).toBeNull();
    expect(unplannedView.slices.map((slice) => slice.wheelBonus)).toEqual([
      0, 0,
    ]);
  });

  it('shows the wheel view only in wheel and on a pick a question wheel question', () => {
    const wheelFive = {
      ...createWheelState(EXAMPLE_ROWS, 5, [6, 7]),
      playingRoundIndex: 6,
    };
    const questionProgress = progressWith({ wheel: wheelFive });
    expect(
      wheelViewForCursor(EXAMPLE_ROWS, questionProgress, cursorAt('wheel', 5)),
    ).not.toBeNull();
    expect(
      wheelViewForCursor(EXAMPLE_ROWS, questionProgress, cursorAt('wheel', 5))
        ?.playingRoundIndex,
    ).toBeNull();
    expect(
      wheelViewForCursor(EXAMPLE_ROWS, questionProgress, cursorAt('open', 6))
        ?.playingRoundIndex,
    ).toBe(6);

    const wheelOne = {
      ...createWheelState(EXAMPLE_ROWS, 1, [2, 3, 4]),
      playingRoundIndex: 2,
    };
    const roundProgress = progressWith({ wheel: wheelOne });
    expect(
      wheelViewForCursor(EXAMPLE_ROWS, roundProgress, cursorAt('open', 2)),
    ).toBeNull();
    expect(
      wheelViewForCursor(
        EXAMPLE_ROWS,
        questionProgress,
        cursorAt('leaderboard', 5),
      ),
    ).toBeNull();
    expect(
      wheelViewForCursor(
        EXAMPLE_ROWS,
        emptyWheelProgress(),
        cursorAt('wheel', 5),
      ),
    ).toBeNull();
  });

  it('shows the bonus only while its phase is on show', () => {
    const progress = progressWith({
      wheelBonusAward: {
        phaseId: '7',
        points: 500,
        pick: 'round',
        sliceRoundIndex: 2,
        sliceTitle: { en: 'Music', pt: 'Music' },
        winners: [
          {
            entrantId: 'player-1',
            kind: 'player',
            name: 'Ana',
            colorKey: null,
          },
        ],
      },
    });
    expect(
      wheelBonusViewForCursor(progress, cursorAt('leaderboard', 2, '7')),
    ).toEqual({
      points: 500,
      pick: 'round',
      sliceRoundIndex: 2,
      sliceTitle: { en: 'Music', pt: 'Music' },
      winners: [
        { entrantId: 'player-1', kind: 'player', name: 'Ana', colorKey: null },
      ],
    });
    expect(
      wheelBonusViewForCursor(progress, cursorAt('leaderboard', 2, '8')),
    ).toBeNull();
    expect(
      wheelBonusViewForCursor(emptyWheelProgress(), cursorAt('leaderboard', 2)),
    ).toBeNull();
  });
});
