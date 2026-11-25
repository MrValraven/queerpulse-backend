import {
  QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
  type QuizshowAckFailure,
  type QuizshowAnswerPayload,
  type QuizshowErrorCode,
  type QuizshowOption,
  type QuizshowPlayMode,
  type QuizshowText,
} from './quizshow.contract';
import {
  currentPlayContext,
  hostNext,
  hostReveal,
  hostStart,
  timerElapsed,
  type QuizshowHostOutcome,
} from './quizshow-engine-phases';
import {
  hostAcceptAnswer,
  hostAdjustPoints,
  hostChangeCorrectAnswer,
  rescoreQuestion,
} from './quizshow-engine-rescore';
import { createLobbyState } from './quizshow-engine-state';
import type {
  QuizshowEngineEffect,
  QuizshowLastTransition,
  QuizshowLiveAnswer,
  QuizshowLivePlayer,
  QuizshowLiveQuestionPlay,
  QuizshowLiveState,
  QuizshowLiveTeam,
  QuizshowPersistOperation,
} from './quizshow-engine-types';
import type {
  QuizshowRandom,
  QuizshowSessionSnapshot,
  QuizshowSnapshotQuestion,
  QuizshowSnapshotRound,
} from './quizshow-snapshot';

const STARTED_AT = 1_000_000;
const NOW = 2_000_000;
const HOST_USER_ID = 'host-user';
const TYPED_QUESTION_ID = '11111111-1111-4111-8111-111111111111';
const CHOICE_QUESTION_ID = '22222222-2222-4222-8222-222222222222';
const TRUE_FALSE_QUESTION_ID = '33333333-3333-4333-8333-333333333333';
const NO_TEXT: QuizshowText = { en: '', pt: '' };

// Speed bonus off in every round: a right answer pays the base 1000 plus the streak bonus (100 per streak step).
const BASE_POINTS = 1000;
const STREAK_STEP = 100;

// Fixture builder, in the shape of the phases spec so the two specs stay independent.

function baseQuestion(
  questionId: string,
): Omit<
  QuizshowSnapshotQuestion,
  'type' | 'answer' | 'options' | 'shownOptions'
> {
  return {
    id: questionId,
    prompt: { en: 'Which one?', pt: 'Qual?' },
    mediaRef: null,
    mediaUrl: null,
    mediaAlt: NO_TEXT,
    mediaReveal: 'instant',
    revealNote: NO_TEXT,
    numberUnit: NO_TEXT,
    timeLimitSeconds: null,
    points: BASE_POINTS,
    acceptedAnswers: [],
  };
}

function typedQuestion(): QuizshowSnapshotQuestion {
  return {
    ...baseQuestion(TYPED_QUESTION_ID),
    type: 'type_answer',
    options: [],
    answer: { text: { en: 'Lisbon', pt: 'Lisboa' } },
    shownOptions: null,
  };
}

function choiceQuestion(correctIndexes: number[]): QuizshowSnapshotQuestion {
  const options: QuizshowOption[] = [
    { id: 'option-red', text: { en: 'Red', pt: 'Vermelho' } },
    { id: 'option-green', text: { en: 'Green', pt: 'Verde' } },
    { id: 'option-blue', text: { en: 'Blue', pt: 'Azul' } },
  ];
  return {
    ...baseQuestion(CHOICE_QUESTION_ID),
    type: 'multiple_choice',
    options,
    answer: { correctIndexes },
    shownOptions: options,
  } as QuizshowSnapshotQuestion;
}

function trueFalseQuestion(): QuizshowSnapshotQuestion {
  return {
    ...baseQuestion(TRUE_FALSE_QUESTION_ID),
    type: 'true_false',
    options: [],
    answer: { isTrue: true },
    shownOptions: null,
  } as QuizshowSnapshotQuestion;
}

function quizRound(question: QuizshowSnapshotQuestion): QuizshowSnapshotRound {
  return {
    id: 'round-1',
    kind: 'quiz',
    title: { en: 'Round', pt: 'Ronda' },
    contentLabel: 'none',
    settings: {
      timeLimitSeconds: 20,
      isSpeedBonusOn: false,
      isJokerAllowed: true,
      writeSeconds: 60,
      voteSeconds: 30,
      ...QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
      isWarmUp: false,
      talkSeconds: 0,
    },
    // A second question keeps `scores` away from the round's leaderboard.
    questions: [question, { ...trueFalseQuestion(), id: 'question-after' }],
  };
}

function stateWithQuestion(
  question: QuizshowSnapshotQuestion,
  playMode: QuizshowPlayMode = 'solo',
): QuizshowLiveState {
  const snapshot: QuizshowSessionSnapshot = {
    title: 'Pride night quiz',
    languages: 'both',
    screenLanguage: 'en',
    rounds: [quizRound(question)],
    sourceUpdatedAt: '',
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
    playMode,
    maxTeamSize: null,
    isReviewOn: true,
    isPractice: false,
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
    disconnectedAt: null,
    leftAt: null,
    ...overrides,
  };
  state.players.set(playerId, player);
  return player;
}

function addTeam(state: QuizshowLiveState, teamId: string): QuizshowLiveTeam {
  const team: QuizshowLiveTeam = {
    teamId,
    name: `${teamId} name`,
    colorKey: 'circle',
    score: 0,
    hasUsedJoker: false,
    jokerRoundIndex: null,
    createdAt: STARTED_AT,
    isHostMade: false,
  };
  state.teams.set(teamId, team);
  return team;
}

function seededRandom(): QuizshowRandom {
  let uuidCount = 0;
  return {
    uuid: () => {
      uuidCount += 1;
      return `00000000-0000-4000-8000-${String(uuidCount).padStart(12, '0')}`;
    },
    integerBelow: () => 0,
  };
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

function expectRefusal(
  outcome: QuizshowHostOutcome,
  code: QuizshowErrorCode,
): QuizshowAckFailure {
  const failure = expectFailure(outcome);
  expect(failure.code).toBe(code);
  return failure;
}

function requireNumber(value: number | null): number {
  if (value === null) throw new Error('Expected a number');
  return value;
}

function requireTransition(state: QuizshowLiveState): QuizshowLastTransition {
  if (state.lastTransition === null) throw new Error('Expected a transition');
  return state.lastTransition;
}

function effectKinds(effects: QuizshowEngineEffect[]): string[] {
  return effects.map((effect) =>
    effect.kind === 'persist'
      ? `persist:${effect.operation.type}`
      : effect.kind === 'reveal_updated'
        ? `reveal_updated:${effect.scope}`
        : effect.kind,
  );
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

const CHECKPOINT_ONLY: QuizshowEngineEffect[] = [
  { kind: 'persist', operation: { type: 'checkpoint' } },
];

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

function teamOf(state: QuizshowLiveState, teamId: string): QuizshowLiveTeam {
  const team = state.teams.get(teamId);
  if (team === undefined) throw new Error(`Unknown team ${teamId}`);
  return team;
}

/** Lobby to the first question's `open`, every answer stored the way the players engine stores one, then the host reveals. */
function playToReveal(
  state: QuizshowLiveState,
  payloadByPlayer: Record<string, QuizshowAnswerPayload>,
  playerIdsLeavingBeforeReveal: readonly string[] = [],
): void {
  const random = seededRandom();
  expectSuccess(hostStart(state, state.cursor.phaseId, NOW));
  expectSuccess(hostNext(state, state.cursor.phaseId, NOW, random));
  const openAt = requireNumber(state.cursor.deadline);
  timerElapsed(state, state.cursor.phaseId, openAt, random);
  expect(state.cursor.phase).toBe('open');
  const play = currentPlay(state);
  let receivedAt = openAt + 1000;
  for (const [playerId, payload] of Object.entries(payloadByPlayer)) {
    const answer: QuizshowLiveAnswer = {
      answerId: `answer-${playerId}`,
      playerId,
      questionId: play.questionId,
      phaseId: state.cursor.phaseId,
      payload,
      receivedAt,
      elapsedMs: receivedAt - requireNumber(state.cursor.phaseStartedAt),
      isCorrect: null,
      correctPositions: null,
      pointsAwarded: 0,
      streakBonus: 0,
      voteOptionId: null,
      hiddenAt: null,
    };
    play.answers.set(playerId, answer);
    play.answersById.set(answer.answerId, answer);
    receivedAt += 10;
  }
  for (const playerId of playerIdsLeavingBeforeReveal) {
    playerOf(state, playerId).leftAt = receivedAt;
  }
  expectSuccess(hostReveal(state, state.cursor.phaseId, openAt + 5000, random));
  expect(state.cursor.phase).toBe('reveal');
}

function typed(text: string): QuizshowAnswerPayload {
  return { type: 'type_answer', text };
}

function picked(optionIndex: number): QuizshowAnswerPayload {
  return { type: 'multiple_choice', optionIndex };
}

function accept(
  state: QuizshowLiveState,
  normalisedText: string,
): QuizshowHostOutcome {
  return hostAcceptAnswer(
    state,
    {
      phaseId: state.cursor.phaseId,
      questionId: currentPlay(state).questionId,
      normalisedText,
    },
    NOW + 60_000,
  );
}

function changeChoiceKey(
  state: QuizshowLiveState,
  correctIndexes: number[],
): QuizshowHostOutcome {
  return hostChangeCorrectAnswer(
    state,
    {
      phaseId: state.cursor.phaseId,
      questionId: currentPlay(state).questionId,
      answer: { type: 'multiple_choice', correctIndexes },
    },
    NOW + 60_000,
  );
}

function adjust(
  state: QuizshowLiveState,
  entrantId: string,
  delta: number,
  requestId: string,
): QuizshowHostOutcome {
  return hostAdjustPoints(state, { entrantId, delta, requestId }, NOW + 60_000);
}

/** Ana answered Lisbon (right), Bea and Cai wrote Porto in two spellings, Dee wrote Faro. */
function typedStateAtReveal(): QuizshowLiveState {
  const state = stateWithQuestion(typedQuestion());
  addPlayer(state, 'ana');
  addPlayer(state, 'bea', { streak: 2 });
  addPlayer(state, 'cai');
  addPlayer(state, 'dee');
  playToReveal(state, {
    ana: typed('Lisbon'),
    bea: typed('Porto'),
    cai: typed('porto!'),
    dee: typed('Faro'),
  });
  return state;
}

/** Key [1]: Ana picked 1 (right, streak 2 before), Bea picked 2 (wrong, streak 1 before). */
function choiceStateAtReveal(): QuizshowLiveState {
  const state = stateWithQuestion(choiceQuestion([1]));
  addPlayer(state, 'ana', { streak: 2 });
  addPlayer(state, 'bea', { streak: 1 });
  playToReveal(state, { ana: picked(1), bea: picked(2) });
  return state;
}

describe('Pulse Live engine rescore: host:acceptAnswer', () => {
  it('pays the accepted text with the streak the player had before the question', () => {
    const state = typedStateAtReveal();
    expect(playerOf(state, 'bea').score).toBe(0);
    expect(playerOf(state, 'bea').streak).toBe(0);

    const { isNoop, effects } = expectSuccess(accept(state, 'porto'));

    expect(isNoop).toBe(false);
    expect(playerOf(state, 'bea').streak).toBe(3);
    expect(playerOf(state, 'bea').score).toBe(BASE_POINTS + 3 * STREAK_STEP);
    expect(playerOf(state, 'cai').streak).toBe(1);
    expect(playerOf(state, 'cai').score).toBe(BASE_POINTS + STREAK_STEP);
    expect(playerOf(state, 'ana').score).toBe(BASE_POINTS + STREAK_STEP);
    expect(playerOf(state, 'ana').streak).toBe(1);
    expect(playerOf(state, 'dee').score).toBe(0);
    const play = currentPlay(state);
    expect(play.wasCorrected).toBe(true);
    expect(play.acceptedTexts).toEqual(new Set(['porto']));
    expect(state.correctedQuestionIds.has(TYPED_QUESTION_ID)).toBe(true);
    expect(effectKinds(effects)).toEqual([
      'persist:save_scoring',
      'persist:set_answer_key_override',
      'reveal_updated:everyone',
      'typed_answers_changed',
      'lobby_changed',
      'me_changed',
      'persist:checkpoint',
    ]);
    expect(findPersist(effects, 'set_answer_key_override')).toEqual({
      type: 'set_answer_key_override',
      questionId: TYPED_QUESTION_ID,
      keyOverride: null,
      acceptedTexts: ['porto'],
    });
    const scoring = findPersist(effects, 'save_scoring');
    expect(scoring?.players).toContainEqual({
      playerId: 'bea',
      score: BASE_POINTS + 3 * STREAK_STEP,
      streak: 3,
    });
  });

  it('accepts a second text without paying the first one twice', () => {
    const state = typedStateAtReveal();
    expectSuccess(accept(state, 'porto'));
    const { effects } = expectSuccess(accept(state, 'faro'));

    expect(playerOf(state, 'dee').score).toBe(BASE_POINTS + STREAK_STEP);
    expect(playerOf(state, 'bea').score).toBe(BASE_POINTS + 3 * STREAK_STEP);
    expect(playerOf(state, 'bea').streak).toBe(3);
    expect(playerOf(state, 'cai').score).toBe(BASE_POINTS + STREAK_STEP);
    expect(playerOf(state, 'ana').score).toBe(BASE_POINTS + STREAK_STEP);
    expect(
      findPersist(effects, 'set_answer_key_override')?.acceptedTexts,
    ).toEqual(['porto', 'faro']);
  });

  it('refuses a text nobody wrote and a text already judged right', () => {
    const state = typedStateAtReveal();
    expectRefusal(accept(state, 'braga'), 'quizshow_answer_text_not_found');
    expectRefusal(accept(state, 'lisbon'), 'quizshow_answer_already_correct');
  });

  it('acks a repeated accept of the same text as a no-op', () => {
    const state = typedStateAtReveal();
    expectSuccess(accept(state, 'porto'));
    const beaScore = playerOf(state, 'bea').score;

    const { isNoop, effects } = expectSuccess(accept(state, 'porto'));

    expect(isNoop).toBe(true);
    expect(effectKinds(effects)).toEqual(['persist:checkpoint']);
    expect(playerOf(state, 'bea').score).toBe(beaScore);
    expect(currentPlay(state).acceptedTexts).toEqual(new Set(['porto']));
  });

  it('refuses a question with no typed answer', () => {
    const state = choiceStateAtReveal();
    expectRefusal(accept(state, 'red'), 'quizshow_accept_needs_typed_answer');
  });
});

describe('Pulse Live engine rescore: host:changeCorrectAnswer', () => {
  it('moves points and streaks to the new key, restoring the old streaks first', () => {
    const state = choiceStateAtReveal();
    expect(playerOf(state, 'ana').score).toBe(BASE_POINTS + 3 * STREAK_STEP);
    expect(playerOf(state, 'ana').streak).toBe(3);
    expect(playerOf(state, 'bea').streak).toBe(0);

    const { effects } = expectSuccess(changeChoiceKey(state, [2]));

    expect(playerOf(state, 'ana').score).toBe(0);
    expect(playerOf(state, 'ana').streak).toBe(0);
    expect(playerOf(state, 'bea').score).toBe(BASE_POINTS + 2 * STREAK_STEP);
    expect(playerOf(state, 'bea').streak).toBe(2);
    expect(currentPlay(state).keyOverride).toEqual({
      type: 'multiple_choice',
      correctIndexes: [2],
    });
    expect(effectKinds(effects)).toEqual([
      'persist:save_scoring',
      'persist:set_answer_key_override',
      'reveal_updated:everyone',
      'lobby_changed',
      'me_changed',
      'persist:checkpoint',
    ]);
    expect(effects).toContainEqual({
      kind: 'me_changed',
      playerIds: ['ana', 'bea'],
    });
  });

  it('keeps the frozen snapshot key untouched and sorts the new indexes', () => {
    const state = choiceStateAtReveal();
    const { question } = currentPlayContext(state);
    expectSuccess(changeChoiceKey(state, [2, 0, 2]));
    expect(currentPlay(state).keyOverride).toEqual({
      type: 'multiple_choice',
      correctIndexes: [0, 2],
    });
    expect(question.answer).toEqual({ correctIndexes: [1] });
  });

  it('treats the key already in force as a no-op', () => {
    const state = choiceStateAtReveal();
    const scoreBefore = playerOf(state, 'ana').score;
    const outcome = expectSuccess(changeChoiceKey(state, [1, 1]));
    expect(outcome).toEqual({ isNoop: true, effects: CHECKPOINT_ONLY });
    expect(playerOf(state, 'ana').score).toBe(scoreBefore);
    expect(currentPlay(state).wasCorrected).toBe(false);
  });

  it('rescores again from the same ground after a second change', () => {
    const state = choiceStateAtReveal();
    expectSuccess(changeChoiceKey(state, [2]));
    expectSuccess(changeChoiceKey(state, [1]));
    expect(playerOf(state, 'ana').score).toBe(BASE_POINTS + 3 * STREAK_STEP);
    expect(playerOf(state, 'ana').streak).toBe(3);
    expect(playerOf(state, 'bea').score).toBe(0);
    expect(playerOf(state, 'bea').streak).toBe(0);
  });

  it('doubles the corrected points under a joker', () => {
    const state = stateWithQuestion(choiceQuestion([1]));
    addPlayer(state, 'ana', { hasUsedJoker: true, jokerRoundIndex: 0 });
    playToReveal(state, { ana: picked(2) });
    expect(playerOf(state, 'ana').score).toBe(0);

    expectSuccess(changeChoiceKey(state, [2]));

    expect(playerOf(state, 'ana').score).toBe((BASE_POINTS + STREAK_STEP) * 2);
  });

  it('refuses indexes outside the options, every option, and a mismatched type', () => {
    const state = choiceStateAtReveal();
    expectRefusal(
      changeChoiceKey(state, [3]),
      'quizshow_correct_option_not_found',
    );
    expectRefusal(
      changeChoiceKey(state, [0, 1, 2]),
      'quizshow_every_option_correct',
    );
    expectRefusal(
      hostChangeCorrectAnswer(
        state,
        {
          phaseId: state.cursor.phaseId,
          questionId: CHOICE_QUESTION_ID,
          answer: { type: 'true_false', isTrue: false },
        },
        NOW + 60_000,
      ),
      'quizshow_change_needs_choice_question',
    );
  });

  it('refuses a typed answer question', () => {
    const state = typedStateAtReveal();
    expectRefusal(
      changeChoiceKey(state, [0]),
      'quizshow_change_needs_choice_question',
    );
  });

  it('flips a true or false key and treats the same value as a no-op', () => {
    const state = stateWithQuestion(trueFalseQuestion());
    addPlayer(state, 'ana');
    playToReveal(state, { ana: { type: 'true_false', isTrue: false } });
    const change = (isTrue: boolean): QuizshowHostOutcome =>
      hostChangeCorrectAnswer(
        state,
        {
          phaseId: state.cursor.phaseId,
          questionId: TRUE_FALSE_QUESTION_ID,
          answer: { type: 'true_false', isTrue },
        },
        NOW + 60_000,
      );
    expect(expectSuccess(change(true)).isNoop).toBe(true);
    expectSuccess(change(false));
    expect(playerOf(state, 'ana').score).toBe(BASE_POINTS + STREAK_STEP);
  });
});

describe('Pulse Live engine rescore: the shared gate', () => {
  it('refuses a stale phase id with the cursor', () => {
    const state = choiceStateAtReveal();
    const failure = expectRefusal(
      hostChangeCorrectAnswer(
        state,
        {
          phaseId: 'phase-old',
          questionId: CHOICE_QUESTION_ID,
          answer: { type: 'multiple_choice', correctIndexes: [2] },
        },
        NOW + 60_000,
      ),
      'quizshow_stale_phase',
    );
    expect(failure.cursor).toEqual(state.cursor);
  });

  it('refuses another question', () => {
    const state = choiceStateAtReveal();
    expectRefusal(
      hostChangeCorrectAnswer(
        state,
        {
          phaseId: state.cursor.phaseId,
          questionId: TYPED_QUESTION_ID,
          answer: { type: 'multiple_choice', correctIndexes: [2] },
        },
        NOW + 60_000,
      ),
      'quizshow_wrong_question',
    );
  });

  it('refuses before the reveal', () => {
    const state = stateWithQuestion(choiceQuestion([1]));
    addPlayer(state, 'ana');
    const random = seededRandom();
    expectSuccess(hostStart(state, state.cursor.phaseId, NOW));
    expectSuccess(hostNext(state, state.cursor.phaseId, NOW, random));
    timerElapsed(
      state,
      state.cursor.phaseId,
      requireNumber(state.cursor.deadline),
      random,
    );
    expect(state.cursor.phase).toBe('open');
    expectRefusal(changeChoiceKey(state, [2]), 'quizshow_rescore_not_now');
  });

  it('in scores, accepts the reveal phase id that typed:answers carries', () => {
    const state = typedStateAtReveal();
    const revealPhaseId = state.cursor.phaseId;
    expectSuccess(hostNext(state, revealPhaseId, NOW + 30_000));
    expect(state.cursor.phase).toBe('scores');
    expect(state.cursor.phaseId).not.toBe(revealPhaseId);

    const { isNoop } = expectSuccess(
      hostAcceptAnswer(
        state,
        {
          phaseId: revealPhaseId,
          questionId: TYPED_QUESTION_ID,
          normalisedText: 'porto',
        },
        NOW + 60_000,
      ),
    );

    expect(isNoop).toBe(false);
    expect(playerOf(state, 'bea').score).toBe(BASE_POINTS + 3 * STREAK_STEP);
  });

  it('in scores, still refuses a phase id older than the reveal', () => {
    const state = choiceStateAtReveal();
    const answeringPhaseId = requireTransition(state).fromPhaseId;
    expectSuccess(hostNext(state, state.cursor.phaseId, NOW + 30_000));
    expect(state.cursor.phase).toBe('scores');
    expectRefusal(
      hostChangeCorrectAnswer(
        state,
        {
          phaseId: answeringPhaseId,
          questionId: CHOICE_QUESTION_ID,
          answer: { type: 'multiple_choice', correctIndexes: [2] },
        },
        NOW + 60_000,
      ),
      'quizshow_stale_phase',
    );
  });

  it('in reveal, refuses the phase id of the answering phase before it', () => {
    const state = choiceStateAtReveal();
    const answeringPhaseId = requireTransition(state).fromPhaseId;
    expectRefusal(
      hostChangeCorrectAnswer(
        state,
        {
          phaseId: answeringPhaseId,
          questionId: CHOICE_QUESTION_ID,
          answer: { type: 'multiple_choice', correctIndexes: [2] },
        },
        NOW + 60_000,
      ),
      'quizshow_stale_phase',
    );
  });

  it('refuses a play scored before a restart (no recorded streaks)', () => {
    const state = choiceStateAtReveal();
    currentPlay(state).streakBeforeByPlayer.clear();
    expectRefusal(changeChoiceKey(state, [2]), 'quizshow_rescore_not_now');
  });
});

describe('Pulse Live engine rescore: scores memory', () => {
  it('in scores, refreshes the totals and keeps the previous frame', () => {
    const state = choiceStateAtReveal();
    expectSuccess(hostNext(state, state.cursor.phaseId, NOW + 30_000));
    expect(state.cursor.phase).toBe('scores');
    const lastScoresFrame = state.lastScoresFrame;

    const { effects } = expectSuccess(changeChoiceKey(state, [2]));

    expect(state.lastScoresFrame).toBe(lastScoresFrame);
    expect(state.scoresAtLastFrame).toEqual(
      new Map([
        ['ana', 0],
        ['bea', BASE_POINTS + 2 * STREAK_STEP],
      ]),
    );
    expect(effects).toContainEqual({ kind: 'scores_shown', scope: 'question' });
  });

  it('in reveal, leaves the totals before the question alone', () => {
    const state = choiceStateAtReveal();
    const scoresAtLastFrame = state.scoresAtLastFrame;
    const { effects } = expectSuccess(changeChoiceKey(state, [2]));
    expect(state.scoresAtLastFrame).toBe(scoresAtLastFrame);
    expect(effectKinds(effects)).not.toContain('scores_shown');
  });

  it('rescoreQuestion with typed answers off leaves out typed_answers_changed', () => {
    const state = typedStateAtReveal();
    const effects = rescoreQuestion(state, currentPlayContext(state), false);
    expect(effectKinds(effects)).not.toContain('typed_answers_changed');
  });
});

describe('Pulse Live engine rescore: players who left and players a host removed', () => {
  it('pays a player who left after answering the corrected points and streak', () => {
    const state = choiceStateAtReveal();
    playerOf(state, 'bea').leftAt = NOW + 10_000;

    const { effects } = expectSuccess(changeChoiceKey(state, [2]));

    expect(playerOf(state, 'bea').score).toBe(BASE_POINTS + 2 * STREAK_STEP);
    expect(playerOf(state, 'bea').streak).toBe(2);
    expect(playerOf(state, 'bea').leftAt).toBe(NOW + 10_000);
    expect(findPersist(effects, 'save_scoring')?.players).toEqual([
      { playerId: 'ana', score: 0, streak: 0 },
      {
        playerId: 'bea',
        score: BASE_POINTS + 2 * STREAK_STEP,
        streak: 2,
      },
    ]);
    expect(effects).toContainEqual({ kind: 'me_changed', playerIds: ['ana'] });
  });

  it('leaves a player who left between open and reveal unpaid after a correction', () => {
    const state = stateWithQuestion(choiceQuestion([1]));
    addPlayer(state, 'ana');
    addPlayer(state, 'bea');
    playToReveal(state, { ana: picked(1), bea: picked(2) }, ['bea']);
    expect(currentPlay(state).streakBeforeByPlayer.has('bea')).toBe(false);

    const { effects } = expectSuccess(changeChoiceKey(state, [2]));

    expect(playerOf(state, 'bea').score).toBe(0);
    expect(playerOf(state, 'bea').streak).toBe(0);
    expect(
      findPersist(effects, 'save_scoring')?.players.map(
        (player) => player.playerId,
      ),
    ).toEqual(['ana']);
  });

  it('accepts a typed text written by a player who left since', () => {
    const state = typedStateAtReveal();
    playerOf(state, 'bea').leftAt = NOW + 10_000;
    expectSuccess(accept(state, 'porto'));
    expect(playerOf(state, 'bea').score).toBe(BASE_POINTS + 3 * STREAK_STEP);
    expect(playerOf(state, 'bea').streak).toBe(3);
  });

  it('leaves a host-removed player as they were', () => {
    const state = choiceStateAtReveal();
    const ana = playerOf(state, 'ana');
    ana.removedAt = NOW + 10_000;
    const scoreBefore = ana.score;
    const streakBefore = ana.streak;

    const { effects } = expectSuccess(changeChoiceKey(state, [2]));

    expect(ana.score).toBe(scoreBefore);
    expect(ana.streak).toBe(streakBefore);
    expect(currentPlay(state).pointsByPlayer.get('ana')).toBe(scoreBefore);
    expect(playerOf(state, 'bea').score).toBe(BASE_POINTS + 2 * STREAK_STEP);
    expect(
      findPersist(effects, 'save_scoring')?.players.map(
        (player) => player.playerId,
      ),
    ).toEqual(['bea']);
  });
});

describe('Pulse Live engine rescore: teams', () => {
  it('moves the team by the change in its average and keeps an earlier adjustment', () => {
    const state = stateWithQuestion(choiceQuestion([1]), 'teams');
    addTeam(state, 'team-1');
    addPlayer(state, 'ana', { teamId: 'team-1' });
    addPlayer(state, 'bea', { teamId: 'team-1' });
    addPlayer(state, 'cai', { teamId: 'team-1' });
    playToReveal(state, { ana: picked(1), bea: picked(2), cai: picked(2) });
    const firstAverage = Math.round((BASE_POINTS + STREAK_STEP) / 3);
    expect(teamOf(state, 'team-1').score).toBe(firstAverage);

    expectSuccess(adjust(state, 'team-1', 500, 'request-team'));
    expect(teamOf(state, 'team-1').score).toBe(firstAverage + 500);

    expectSuccess(changeChoiceKey(state, [2]));

    const correctedAverage = Math.round((2 * (BASE_POINTS + STREAK_STEP)) / 3);
    expect(teamOf(state, 'team-1').score).toBe(correctedAverage + 500);
  });
});

describe('Pulse Live engine rescore: host:adjustPoints', () => {
  it('moves a player and sends their own frame', () => {
    const state = choiceStateAtReveal();
    const scoreBefore = playerOf(state, 'bea').score;
    const { isNoop, effects } = expectSuccess(
      adjust(state, 'bea', 300, 'request-1'),
    );
    expect(isNoop).toBe(false);
    expect(playerOf(state, 'bea').score).toBe(scoreBefore + 300);
    expect(effects).toEqual([
      {
        kind: 'persist',
        operation: {
          type: 'adjust_score',
          kind: 'player',
          entrantId: 'bea',
          score: scoreBefore + 300,
        },
      },
      { kind: 'lobby_changed' },
      { kind: 'me_changed', playerIds: ['bea'] },
      { kind: 'persist', operation: { type: 'checkpoint' } },
    ]);
  });

  it('stops a player at 0 when a correction takes back points a host already removed', () => {
    const state = choiceStateAtReveal();
    const ana = playerOf(state, 'ana');
    expectSuccess(adjust(state, 'ana', -ana.score, 'request-down'));
    expect(ana.score).toBe(0);

    const { effects } = expectSuccess(changeChoiceKey(state, [2]));

    expect(ana.score).toBe(0);
    expect(findPersist(effects, 'save_scoring')?.players).toContainEqual({
      playerId: 'ana',
      score: 0,
      streak: 0,
    });
  });

  it('stops a team at 0 when a correction takes back points a host already removed', () => {
    const state = stateWithQuestion(choiceQuestion([1]), 'teams');
    addTeam(state, 'team-1');
    addPlayer(state, 'ana', { teamId: 'team-1' });
    addPlayer(state, 'bea', { teamId: 'team-1' });
    playToReveal(state, { ana: picked(1), bea: picked(2) });
    const team = teamOf(state, 'team-1');
    expect(team.score).toBeGreaterThan(0);
    expectSuccess(adjust(state, 'team-1', -team.score, 'request-down'));

    expectSuccess(changeChoiceKey(state, [0]));

    expect(team.score).toBe(0);
  });

  it('treats a repeated request id as a no-op', () => {
    const state = choiceStateAtReveal();
    expectSuccess(adjust(state, 'bea', 300, 'request-1'));
    const outcome = expectSuccess(adjust(state, 'bea', 300, 'request-1'));
    expect(outcome).toEqual({ isNoop: true, effects: CHECKPOINT_ONLY });
    expect(playerOf(state, 'bea').score).toBe(300);
  });

  it('treats a retry as a no-op after the phase moved on to the podium', () => {
    const state = choiceStateAtReveal();
    expectSuccess(adjust(state, 'bea', 300, 'request-1'));
    state.cursor.phase = 'podium';
    const outcome = expectSuccess(adjust(state, 'bea', 300, 'request-1'));
    expect(outcome).toEqual({ isNoop: true, effects: CHECKPOINT_ONLY });
    expect(playerOf(state, 'bea').score).toBe(300);
  });

  it('remembers the last 50 request ids only', () => {
    const state = choiceStateAtReveal();
    for (let requestNumber = 0; requestNumber < 51; requestNumber += 1) {
      expectSuccess(adjust(state, 'bea', 1, `request-${requestNumber}`));
    }
    expect(state.adjustRequestIds).toHaveLength(50);
    expect(state.adjustRequestIds).not.toContain('request-0');
    expect(state.adjustRequestIds.at(-1)).toBe('request-50');
  });

  it('refuses a total below 0, an unknown entrant and the podium', () => {
    const state = choiceStateAtReveal();
    expectRefusal(
      adjust(state, 'bea', -1, 'request-below'),
      'quizshow_adjust_below_zero',
    );
    expectRefusal(
      adjust(state, 'nobody', 100, 'request-unknown'),
      'quizshow_entrant_not_found',
    );
    playerOf(state, 'bea').leftAt = NOW;
    expectRefusal(
      adjust(state, 'bea', 100, 'request-left'),
      'quizshow_entrant_not_found',
    );
    state.cursor.phase = 'podium';
    expectRefusal(
      adjust(state, 'ana', 100, 'request-podium'),
      'quizshow_adjust_not_now',
    );
  });

  it('refuses in the lobby', () => {
    const state = stateWithQuestion(choiceQuestion([1]));
    addPlayer(state, 'ana');
    expectRefusal(
      adjust(state, 'ana', 100, 'request-lobby'),
      'quizshow_adjust_not_now',
    );
  });

  it('in scores, refreshes the totals and shows the scores again', () => {
    const state = choiceStateAtReveal();
    expectSuccess(hostNext(state, state.cursor.phaseId, NOW + 30_000));
    const lastScoresFrame = state.lastScoresFrame;
    const { effects } = expectSuccess(adjust(state, 'bea', 250, 'request-1'));
    expect(state.lastScoresFrame).toBe(lastScoresFrame);
    expect(state.scoresAtLastFrame.get('bea')).toBe(250);
    expect(effects).toContainEqual({ kind: 'scores_shown', scope: 'question' });
  });

  it('keeps an adjustment through a later rescore', () => {
    const state = typedStateAtReveal();
    expectSuccess(adjust(state, 'cai', 300, 'request-1'));
    expectSuccess(accept(state, 'porto'));
    expect(playerOf(state, 'cai').score).toBe(300 + BASE_POINTS + STREAK_STEP);
  });
});
