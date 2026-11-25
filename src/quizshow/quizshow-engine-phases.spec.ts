import { BLOCKED_TERMS } from '../common/blocked-terms';
import {
  QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
  type QuizshowAckFailure,
  type QuizshowAnswerPayload,
  type QuizshowClosestTolerance,
  type QuizshowErrorCode,
  type QuizshowOption,
  type QuizshowPlayMode,
  type QuizshowRoundKind,
  type QuizshowText,
} from './quizshow.contract';
import {
  abandonIfIdle,
  closeIfEveryoneDone,
  currentPlayContext,
  hostAddTime,
  hostEnd,
  hostFinishWheel,
  hostHideAnswer,
  hostNext,
  hostPause,
  hostPickFavourite,
  hostRemovePlayer,
  hostRenameTeam,
  hostResume,
  hostReveal,
  hostSetAutoAdvance,
  hostSetScreenMuted,
  hostShowAnswers,
  hostSkip,
  hostSpin,
  hostStart,
  leaveLobby,
  scoreQuizQuestion,
  timerElapsed,
  type QuizshowHostOutcome,
} from './quizshow-engine-phases';
import { createLobbyState, setSessionStatus } from './quizshow-engine-state';
import type {
  QuizshowCommandOutcome,
  QuizshowEngineEffect,
  QuizshowLiveAnswer,
  QuizshowLivePlayer,
  QuizshowLiveQuestionPlay,
  QuizshowLiveState,
  QuizshowLiveTeam,
  QuizshowLiveVoteOption,
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
const TWO_HOURS_MS = 7_200_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Fixture builder, copied from the players spec so the two specs stay independent.

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

function promptQuestion(
  questionId: string,
  truth: QuizshowText | null,
): QuizshowSnapshotQuestion {
  return {
    id: questionId,
    type: 'prompt',
    prompt: { en: 'Write something', pt: 'Escreve algo' },
    mediaRef: null,
    mediaUrl: null,
    mediaAlt: { en: '', pt: '' },
    mediaReveal: 'instant',
    revealNote: { en: '', pt: '' },
    numberUnit: { en: '', pt: '' },
    timeLimitSeconds: null,
    points: 1000,
    options: [],
    answer: truth === null ? null : { truth },
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

const NO_TEXT: QuizshowText = { en: '', pt: '' };

function multipleChoiceQuestion(
  questionId: string,
  correctIndexes: number[],
): QuizshowSnapshotQuestion {
  const options: QuizshowOption[] = [
    { id: `${questionId}-red`, text: { en: 'Red', pt: 'Vermelho' } },
    { id: `${questionId}-green`, text: { en: 'Green', pt: 'Verde' } },
    { id: `${questionId}-blue`, text: { en: 'Blue', pt: 'Azul' } },
  ];
  return {
    id: questionId,
    type: 'multiple_choice',
    prompt: { en: 'Which colours?', pt: 'Que cores?' },
    mediaRef: null,
    mediaUrl: null,
    mediaAlt: NO_TEXT,
    mediaReveal: 'instant',
    revealNote: NO_TEXT,
    numberUnit: NO_TEXT,
    timeLimitSeconds: null,
    points: 1000,
    options,
    answer: { correctIndexes },
    acceptedAnswers: [],
    shownOptions: options,
  };
}

function closestQuestion(
  questionId: string,
  value: number,
  tolerance: QuizshowClosestTolerance,
): QuizshowSnapshotQuestion {
  return {
    id: questionId,
    type: 'closest_number',
    prompt: { en: 'What year?', pt: 'Que ano?' },
    mediaRef: null,
    mediaUrl: null,
    mediaAlt: NO_TEXT,
    mediaReveal: 'instant',
    revealNote: NO_TEXT,
    numberUnit: { en: 'years', pt: 'anos' },
    timeLimitSeconds: null,
    points: 1000,
    options: [],
    answer: { value, tolerance },
    acceptedAnswers: [],
    shownOptions: null,
  };
}

function pollQuestion(questionId: string): QuizshowSnapshotQuestion {
  const options: QuizshowOption[] = [
    { id: `${questionId}-pop`, text: { en: 'Pop', pt: 'Pop' } },
    { id: `${questionId}-disco`, text: { en: 'Disco', pt: 'Disco' } },
  ];
  return {
    id: questionId,
    type: 'poll',
    prompt: { en: 'Which one tonight?', pt: 'Qual hoje?' },
    mediaRef: null,
    mediaUrl: null,
    mediaAlt: NO_TEXT,
    mediaReveal: 'instant',
    revealNote: NO_TEXT,
    numberUnit: NO_TEXT,
    timeLimitSeconds: null,
    points: 1000,
    options,
    answer: null,
    acceptedAnswers: [],
    shownOptions: options,
  };
}

function withRoundSettings(
  round: QuizshowSnapshotRound,
  settings: Partial<QuizshowSnapshotRound['settings']>,
): QuizshowSnapshotRound {
  return { ...round, settings: { ...round.settings, ...settings } };
}

function quizRound(
  roundId: string,
  questionIds: string[],
): QuizshowSnapshotRound {
  return snapshotRound(roundId, 'quiz', questionIds.map(trueFalseQuestion));
}

function captionRound(roundId: string): QuizshowSnapshotRound {
  return snapshotRound(roundId, 'caption_this', [
    promptQuestion(`${roundId}-question`, null),
  ]);
}

function lieDetectorRound(roundId: string): QuizshowSnapshotRound {
  return snapshotRound(roundId, 'lie_detector', [
    promptQuestion(`${roundId}-question`, { en: 'Lisbon', pt: 'Lisboa' }),
  ]);
}

function stateWithQuiz(options: {
  playMode?: QuizshowPlayMode;
  rounds: QuizshowSnapshotRound[];
  isReviewOn?: boolean;
  isPractice?: boolean;
}): QuizshowLiveState {
  const snapshot: QuizshowSessionSnapshot = {
    title: 'Pride night quiz',
    languages: 'both',
    screenLanguage: 'en',
    rounds: options.rounds,
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
    playMode: options.playMode ?? 'solo',
    maxTeamSize: null,
    isReviewOn: options.isReviewOn ?? true,
    isPractice: options.isPractice ?? false,
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

function addTeam(
  state: QuizshowLiveState,
  teamId: string,
  overrides: Partial<QuizshowLiveTeam> = {},
): QuizshowLiveTeam {
  const team: QuizshowLiveTeam = {
    teamId,
    name: `${teamId} name`,
    colorKey: 'circle',
    score: 0,
    hasUsedJoker: false,
    jokerRoundIndex: null,
    createdAt: STARTED_AT,
    isHostMade: false,
    ...overrides,
  };
  state.teams.set(teamId, team);
  return team;
}

/** Sequential uuids and a shuffle that always swaps with the first slot. */
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

function requireNumber(value: number | null): number {
  if (value === null) throw new Error('Expected a number');
  return value;
}

function effectKinds(effects: QuizshowEngineEffect[]): string[] {
  return effects.map((effect) => effect.kind);
}

function findEffect<Kind extends QuizshowEngineEffect['kind']>(
  effects: QuizshowEngineEffect[],
  kind: Kind,
): Extract<QuizshowEngineEffect, { kind: Kind }> | undefined {
  return effects.find(
    (effect): effect is Extract<QuizshowEngineEffect, { kind: Kind }> =>
      effect.kind === kind,
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

function checkpointCount(effects: QuizshowEngineEffect[]): number {
  return effects.filter(
    (effect) =>
      effect.kind === 'persist' && effect.operation.type === 'checkpoint',
  ).length;
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

function answerOf(
  state: QuizshowLiveState,
  playerId: string,
): QuizshowLiveAnswer {
  const answer = currentPlay(state).answers.get(playerId);
  if (answer === undefined) throw new Error(`No answer from ${playerId}`);
  return answer;
}

/** The option a player wrote, or the truth for `null`. */
function optionOf(
  state: QuizshowLiveState,
  authorPlayerId: string | null,
): QuizshowLiveVoteOption {
  const option = currentPlay(state).voteOptions?.find(
    (voteOption) => voteOption.authorPlayerId === authorPlayerId,
  );
  if (option === undefined) throw new Error('No such vote option');
  return option;
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
  play.answersById.set(answer.answerId, answer);
  return answer;
}

/** Stores a vote the way the players engine accepts one. */
function castVote(
  state: QuizshowLiveState,
  voterPlayerId: string,
  option: QuizshowLiveVoteOption,
  now: number,
): void {
  const play = currentPlay(state);
  play.votes.set(voterPlayerId, {
    voterPlayerId,
    questionId: play.questionId,
    optionId: option.optionId,
    answerId: option.answerId,
    createdAt: now,
  });
}

function startGame(state: QuizshowLiveState, now: number): void {
  expectSuccess(hostStart(state, state.cursor.phaseId, now));
}

function nextPhase(
  state: QuizshowLiveState,
  now: number,
  random: QuizshowRandom = seededRandom(),
): { isNoop: boolean; effects: QuizshowEngineEffect[] } {
  return expectSuccess(hostNext(state, state.cursor.phaseId, now, random));
}

/** Lobby to the first quiz question's `open`; returns when `open` started. */
function openFirstQuizQuestion(state: QuizshowLiveState, now: number): number {
  startGame(state, now);
  nextPhase(state, now);
  const openAt = requireNumber(state.cursor.deadline);
  timerElapsed(state, state.cursor.phaseId, openAt);
  expect(state.cursor.phase).toBe('open');
  return openAt;
}

/** From `read`: opens, takes every given answer, then the host reveals. Returns the reveal time. */
function playQuizQuestionFromRead(
  state: QuizshowLiveState,
  playerIds: string[],
): number {
  const openAt = requireNumber(state.cursor.deadline);
  timerElapsed(state, state.cursor.phaseId, openAt);
  for (const playerId of playerIds) {
    submit(
      state,
      playerId,
      { type: 'true_false', isTrue: true },
      openAt + 1000,
    );
  }
  expectSuccess(hostReveal(state, state.cursor.phaseId, openAt + 2000));
  expect(state.cursor.phase).toBe('reveal');
  return openAt + 2000;
}

/** Party question from `write` with review off: every player writes, the vote opens. */
function writeEveryCaption(
  state: QuizshowLiveState,
  playerIds: string[],
  now: number,
  random: QuizshowRandom,
): void {
  for (const playerId of playerIds) {
    submit(
      state,
      playerId,
      { type: 'prompt', text: `${playerId} caption` },
      now,
    );
  }
  closeIfEveryoneDone(state, now, random);
  expect(state.cursor.phase).toBe('vote');
}

describe('Pulse Live engine phases', () => {
  it("starts at round 0's intro and drops empty teams, host-made ones included", () => {
    const state = stateWithQuiz({
      playMode: 'teams',
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addTeam(state, 'team-a');
    addTeam(state, 'team-b', { colorKey: 'triangle' });
    addTeam(state, 'team-c', { colorKey: 'square' });
    addTeam(state, 'team-d', { colorKey: 'diamond', isHostMade: true });
    addPlayer(state, 'player-1', { teamId: 'team-a' });
    addPlayer(state, 'player-2', {
      teamId: 'team-c',
      removedAt: STARTED_AT + 10,
    });

    const outcome = expectSuccess(hostStart(state, '0', NOW));

    expect(outcome.isNoop).toBe(false);
    expect(state.status).toBe('running');
    expect(state.cursor.status).toBe('running');
    expect(state.cursor.phase).toBe('round_intro');
    expect(state.cursor.roundIndex).toBe(0);
    expect(state.cursor.questionIndex).toBeNull();
    expect([...state.teams.keys()]).toEqual(['team-a']);
    // A host-made team still empty at the start goes too (contract 6.11).
    expect(findPersist(outcome.effects, 'delete_teams')).toEqual({
      type: 'delete_teams',
      teamIds: ['team-b', 'team-c', 'team-d'],
    });
    expect(effectKinds(outcome.effects)).toEqual(
      expect.arrayContaining(['lobby_changed', 'phase_changed']),
    );
    expect(state.lastHostCommandAt).toBe(NOW);
    expect(outcome.effects.at(-1)).toEqual(CHECKPOINT_ONLY[0]);
    expect(checkpointCount(outcome.effects)).toBe(1);
  });

  it('refuses to start with no players', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(state, 'player-1', { removedAt: STARTED_AT + 10 });

    const failure = expectFailure(hostStart(state, '0', NOW));

    expect(failure.code).toBe('quizshow_no_players');
    expect(state.status).toBe('lobby');
    expect(state.cursor.phase).toBe('lobby');
    expect(state.lastHostCommandAt).toBe(NOW);
  });

  it("shows a short quiz question for the 3 s read floor, then opens it with the round's limit", () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(state, 'player-1');
    startGame(state, NOW);

    const read = nextPhase(state, NOW + 1000);
    const readPhaseId = state.cursor.phaseId;

    expect(state.cursor.phase).toBe('read');
    expect(state.cursor.deadline).toBe(NOW + 4000);
    expect(state.cursor.extraTimeDeadline).toBeNull();
    expect(state.cursor.talkStartsAt).toBeNull();
    expect(findEffect(read.effects, 'timer')).toEqual({
      kind: 'timer',
      phaseId: readPhaseId,
      fireAt: NOW + 4000,
    });
    expect(currentPlay(state).eligiblePlayerIds).toEqual(new Set(['player-1']));

    expect(timerElapsed(state, readPhaseId, NOW + 3999)).toEqual([
      { kind: 'timer', phaseId: readPhaseId, fireAt: NOW + 4000 },
    ]);
    expect(state.cursor.phase).toBe('read');

    const opened = timerElapsed(state, readPhaseId, NOW + 4000);

    expect(state.cursor.phase).toBe('open');
    expect(state.cursor.phaseStartedAt).toBe(NOW + 4000);
    expect(state.cursor.deadline).toBe(NOW + 24_000);
    expect(state.cursor.extraTimeDeadline).toBe(NOW + 34_000);
    expect(findEffect(opened, 'timer')).toEqual({
      kind: 'timer',
      phaseId: state.cursor.phaseId,
      fireAt: NOW + 24_500,
    });
    expect(timerElapsed(state, readPhaseId, NOW + 6000)).toEqual([]);
  });

  it('closes open early once every eligible player answered', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(state, 'player-1');
    addPlayer(state, 'player-2');
    const openAt = openFirstQuizQuestion(state, NOW);
    addPlayer(state, 'player-3', { joinedAt: openAt + 10 });

    submit(
      state,
      'player-1',
      { type: 'true_false', isTrue: true },
      openAt + 1000,
    );
    expect(closeIfEveryoneDone(state, openAt + 1000)).toEqual([]);
    expect(state.cursor.phase).toBe('open');

    submit(
      state,
      'player-2',
      { type: 'true_false', isTrue: false },
      openAt + 2000,
    );
    const effects = closeIfEveryoneDone(state, openAt + 2000);

    expect(state.cursor.phase).toBe('reveal');
    expect(effectKinds(effects)).toEqual(
      expect.arrayContaining(['phase_changed', 'revealed']),
    );
    expect(checkpointCount(effects)).toBe(1);
  });

  it('waits for an extra-time player who has not answered before closing open', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(state, 'player-1');
    addPlayer(state, 'player-2', { hasExtraTime: true });
    const openAt = openFirstQuizQuestion(state, NOW);
    const openPhaseId = state.cursor.phaseId;

    submit(
      state,
      'player-1',
      { type: 'true_false', isTrue: true },
      openAt + 1000,
    );
    expect(closeIfEveryoneDone(state, openAt + 1000)).toEqual([]);

    const waiting = timerElapsed(state, openPhaseId, openAt + 20_500);

    expect(waiting).toEqual([
      { kind: 'timer', phaseId: openPhaseId, fireAt: openAt + 30_500 },
    ]);
    expect(state.cursor.phase).toBe('open');

    submit(
      state,
      'player-2',
      { type: 'true_false', isTrue: true },
      openAt + 25_000,
    );
    closeIfEveryoneDone(state, openAt + 25_000);

    expect(state.cursor.phase).toBe('reveal');
  });

  it('closes at once when the extra-time player answers during finishing up and a standard player never answered', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(state, 'player-1');
    addPlayer(state, 'player-2', { hasExtraTime: true });
    const openAt = openFirstQuizQuestion(state, NOW);
    const openPhaseId = state.cursor.phaseId;

    expect(timerElapsed(state, openPhaseId, openAt + 20_500)).toEqual([
      { kind: 'timer', phaseId: openPhaseId, fireAt: openAt + 30_500 },
    ]);

    submit(
      state,
      'player-2',
      { type: 'true_false', isTrue: true },
      openAt + 24_000,
    );
    const effects = closeIfEveryoneDone(state, openAt + 24_000);

    expect(state.cursor.phase).toBe('reveal');
    expect(effectKinds(effects)).toContain('revealed');
    expect(currentPlay(state).answers.has('player-1')).toBe(false);
  });

  it('freezes the remaining time on pause and restores it on resume', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(state, 'player-1');
    const openAt = openFirstQuizQuestion(state, NOW);
    const openPhaseId = state.cursor.phaseId;

    const paused = expectSuccess(hostPause(state, openPhaseId, openAt + 5000));

    expect(paused.isNoop).toBe(false);
    expect(state.status).toBe('paused');
    expect(state.cursor.status).toBe('paused');
    expect(state.cursor.phaseId).toBe(openPhaseId);
    expect(state.cursor.pausedRemainingMs).toBe(15_000);
    expect(state.cursor.pausedExtraTimeRemainingMs).toBe(25_000);
    expect(state.cursor.deadline).toBeNull();
    expect(state.cursor.extraTimeDeadline).toBeNull();
    expect(effectKinds(paused.effects)).toEqual(
      expect.arrayContaining(['phase_changed', 'timer_cleared']),
    );
    expect(timerElapsed(state, openPhaseId, openAt + 20_500)).toEqual([]);
    expect(
      expectSuccess(hostPause(state, openPhaseId, openAt + 6000)).isNoop,
    ).toBe(true);

    const resumeAt = openAt + 65_000;
    const resumed = expectSuccess(hostResume(state, openPhaseId, resumeAt));

    expect(resumed.isNoop).toBe(false);
    expect(state.status).toBe('running');
    expect(state.cursor.status).toBe('running');
    expect(state.cursor.phaseId).toBe(openPhaseId);
    expect(state.cursor.deadline).toBe(resumeAt + 15_000);
    expect(state.cursor.extraTimeDeadline).toBe(resumeAt + 25_000);
    expect(state.cursor.phaseStartedAt).toBe(openAt + 60_000);
    expect(state.cursor.pausedRemainingMs).toBeNull();
    expect(state.pausedAt).toBeNull();
    expect(findEffect(resumed.effects, 'timer')).toEqual({
      kind: 'timer',
      phaseId: openPhaseId,
      fireAt: resumeAt + 15_500,
    });

    const answer = submit(
      state,
      'player-1',
      { type: 'true_false', isTrue: true },
      resumeAt + 1000,
    );
    closeIfEveryoneDone(state, resumeAt + 1000);

    expect(answer.elapsedMs).toBe(6000);
    // 1000 * (1 - 6000 / 20000 / 2) = 850, plus the first streak step of 100.
    expect(answer.pointsAwarded).toBe(950);
    expect(playerOf(state, 'player-1').score).toBe(950);

    const lateState = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(lateState, 'player-1');
    addPlayer(lateState, 'player-2', { hasExtraTime: true });
    const lateOpenAt = openFirstQuizQuestion(lateState, NOW);
    const latePhaseId = lateState.cursor.phaseId;
    // Paused during finishing up, 2000 ms past the standard deadline.
    expectSuccess(hostPause(lateState, latePhaseId, lateOpenAt + 22_000));

    expect(lateState.cursor.pausedRemainingMs).toBe(-2000);
    expect(lateState.cursor.pausedExtraTimeRemainingMs).toBe(8000);

    const lateResumeAt = lateOpenAt + 100_000;
    const lateResumed = expectSuccess(
      hostResume(lateState, latePhaseId, lateResumeAt),
    );

    expect(lateState.cursor.deadline).toBe(lateResumeAt - 2000);
    expect(lateState.cursor.extraTimeDeadline).toBe(lateResumeAt + 8000);
    expect(findEffect(lateResumed.effects, 'timer')).toEqual({
      kind: 'timer',
      phaseId: latePhaseId,
      fireAt: lateResumeAt - 1500,
    });
    expect(closeIfEveryoneDone(lateState, lateResumeAt)).toEqual([]);
    expect(timerElapsed(lateState, latePhaseId, lateResumeAt)).toEqual([
      { kind: 'timer', phaseId: latePhaseId, fireAt: lateResumeAt + 8500 },
    ]);
  });

  it('adds time once when two remotes send the same expected deadline', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(state, 'player-1');
    const openAt = openFirstQuizQuestion(state, NOW);
    const { phaseId } = state.cursor;
    const deadline = requireNumber(state.cursor.deadline);
    const extraTimeDeadline = requireNumber(state.cursor.extraTimeDeadline);

    const first = expectSuccess(
      hostAddTime(
        state,
        { phaseId, seconds: 10, expectedDeadline: deadline },
        openAt + 3000,
      ),
    );
    const second = expectSuccess(
      hostAddTime(
        state,
        { phaseId, seconds: 10, expectedDeadline: deadline },
        openAt + 3010,
      ),
    );

    expect(first.isNoop).toBe(false);
    expect(findEffect(first.effects, 'timer')).toEqual({
      kind: 'timer',
      phaseId,
      fireAt: deadline + 10_500,
    });
    expect(second.isNoop).toBe(true);
    expect(second.effects).toEqual(CHECKPOINT_ONLY);
    expect(state.cursor.deadline).toBe(deadline + 10_000);
    expect(state.cursor.extraTimeDeadline).toBe(extraTimeDeadline + 10_000);
    expect(state.cursor.phaseId).toBe(phaseId);
    expect(state.lastHostCommandAt).toBe(openAt + 3010);
  });

  it('advances once when two host:next frames carry the same phase id and acks the second as a noop', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(state, 'player-1');
    startGame(state, NOW);
    const introPhaseId = state.cursor.phaseId;

    const first = expectSuccess(hostNext(state, introPhaseId, NOW + 100));
    const readPhaseId = state.cursor.phaseId;
    const second = expectSuccess(hostNext(state, introPhaseId, NOW + 105));

    expect(first.isNoop).toBe(false);
    expect(second.isNoop).toBe(true);
    expect(second.effects).toEqual(CHECKPOINT_ONLY);
    expect(state.cursor.phase).toBe('read');
    expect(state.cursor.phaseId).toBe(readPhaseId);
    expect(state.questionLog).toHaveLength(1);
  });

  it('treats host:next after a timer moved the phase as a noop', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(state, 'player-1');
    startGame(state, NOW);
    nextPhase(state, NOW);
    const readPhaseId = state.cursor.phaseId;
    timerElapsed(state, readPhaseId, NOW + 4000);
    const openPhaseId = state.cursor.phaseId;

    const outcome = expectSuccess(hostNext(state, readPhaseId, NOW + 4010));

    expect(outcome.isNoop).toBe(true);
    expect(state.cursor.phase).toBe('open');
    expect(state.cursor.phaseId).toBe(openPhaseId);
  });

  it('acks a host:next with an older phase id as stale with the cursor', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(state, 'player-1');
    startGame(state, NOW);
    const introPhaseId = state.cursor.phaseId;
    nextPhase(state, NOW);
    timerElapsed(state, state.cursor.phaseId, NOW + 4000);
    const cursorBefore = { ...state.cursor };

    const failure = expectFailure(hostNext(state, introPhaseId, NOW + 4010));

    expect(failure.code).toBe('quizshow_stale_phase');
    expect(failure.cursor).toEqual(cursorBefore);
    expect(state.cursor).toEqual(cursorBefore);
  });

  it('goes from write to review with review on, and to vote with review off', () => {
    const random = seededRandom();
    const reviewState = stateWithQuiz({
      rounds: [captionRound('round-party')],
      isReviewOn: true,
    });
    addPlayer(reviewState, 'player-1');
    addPlayer(reviewState, 'player-2');
    startGame(reviewState, NOW);
    nextPhase(reviewState, NOW);
    expect(reviewState.cursor.phase).toBe('write');
    submit(
      reviewState,
      'player-1',
      { type: 'prompt', text: 'First' },
      NOW + 1000,
    );
    submit(
      reviewState,
      'player-2',
      { type: 'prompt', text: 'Second' },
      NOW + 2000,
    );

    const toReview = closeIfEveryoneDone(reviewState, NOW + 2000, random);

    expect(reviewState.cursor.phase).toBe('review');
    expect(reviewState.cursor.deadline).toBeNull();
    expect(effectKinds(toReview)).toEqual(
      expect.arrayContaining(['review_list_changed', 'answer_count_changed']),
    );
    expect(currentPlay(reviewState).voteOptions).toBeNull();

    expectSuccess(
      hostShowAnswers(
        reviewState,
        reviewState.cursor.phaseId,
        NOW + 3000,
        random,
      ),
    );
    expect(reviewState.cursor.phase).toBe('vote');

    const voteState = stateWithQuiz({
      rounds: [captionRound('round-party')],
      isReviewOn: false,
    });
    addPlayer(voteState, 'player-1');
    addPlayer(voteState, 'player-2');
    startGame(voteState, NOW);
    nextPhase(voteState, NOW);
    submit(
      voteState,
      'player-1',
      { type: 'prompt', text: 'First' },
      NOW + 1000,
    );
    submit(
      voteState,
      'player-2',
      { type: 'prompt', text: 'Second' },
      NOW + 2000,
    );

    const toVote = closeIfEveryoneDone(voteState, NOW + 2000, seededRandom());
    const options = currentPlay(voteState).voteOptions ?? [];

    expect(voteState.cursor.phase).toBe('vote');
    expect(options).toHaveLength(2);
    for (const option of options) {
      expect(option.optionId).toMatch(UUID_PATTERN);
      expect(option.isTruth).toBe(false);
    }
    expect(answerOf(voteState, 'player-1').voteOptionId).toBe(
      optionOf(voteState, 'player-1').optionId,
    );
    expect(
      findPersist(toVote, 'set_answer_vote_options')?.options,
    ).toHaveLength(2);
    expect(effectKinds(toVote)).toEqual(
      expect.arrayContaining(['vote_options_shown', 'answer_count_changed']),
    );
    expect(voteState.cursor.deadline).toBe(NOW + 32_000);
    expect(voteState.cursor.extraTimeDeadline).toBe(NOW + 47_000);
    expect(findEffect(toVote, 'timer')).toEqual({
      kind: 'timer',
      phaseId: voteState.cursor.phaseId,
      fireAt: NOW + 32_500,
    });
  });

  it('goes straight to reveal when fewer than two vote options remain', () => {
    const state = stateWithQuiz({
      rounds: [captionRound('round-party')],
      isReviewOn: false,
    });
    addPlayer(state, 'player-1');
    addPlayer(state, 'player-2');
    startGame(state, NOW);
    nextPhase(state, NOW);
    const writeDeadline = requireNumber(state.cursor.deadline);
    submit(state, 'player-1', { type: 'prompt', text: 'Alone' }, NOW + 1000);
    expect(closeIfEveryoneDone(state, NOW + 1000)).toEqual([]);

    const effects = timerElapsed(
      state,
      state.cursor.phaseId,
      writeDeadline + 500,
      seededRandom(),
    );

    expect(state.cursor.phase).toBe('reveal');
    expect(currentPlay(state).voteOptions).toHaveLength(1);
    expect(
      findPersist(effects, 'set_answer_vote_options')?.options,
    ).toHaveLength(1);
    expect(effectKinds(effects)).toContain('revealed');
    expect(effectKinds(effects)).not.toContain('vote_options_shown');
  });

  it('scores a quiz question with speed, streak and joker, and averages teams over eligible members', () => {
    const state = stateWithQuiz({
      playMode: 'teams',
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addTeam(state, 'team-a', { hasUsedJoker: true, jokerRoundIndex: 0 });
    addTeam(state, 'team-b', { colorKey: 'triangle' });
    addPlayer(state, 'player-1', { teamId: 'team-a', streak: 2 });
    addPlayer(state, 'player-2', { teamId: 'team-a', streak: 1 });
    addPlayer(state, 'player-4', { teamId: 'team-b', streak: 3 });
    const openAt = openFirstQuizQuestion(state, NOW);
    addPlayer(state, 'player-3', { teamId: 'team-a', joinedAt: openAt + 1 });

    submit(
      state,
      'player-1',
      { type: 'true_false', isTrue: true },
      openAt + 4000,
    );
    submit(
      state,
      'player-4',
      { type: 'true_false', isTrue: false },
      openAt + 1000,
    );
    const revealed = expectSuccess(
      hostReveal(state, state.cursor.phaseId, openAt + 5000),
    );

    const fastAnswer = answerOf(state, 'player-1');
    // Speed 1000 * (1 - 4000 / 20000 / 2) = 900, streak 3 adds 300, the team joker doubles it.
    expect(fastAnswer.isCorrect).toBe(true);
    expect(fastAnswer.streakBonus).toBe(300);
    expect(fastAnswer.pointsAwarded).toBe(2400);
    expect(playerOf(state, 'player-1').score).toBe(2400);
    expect(playerOf(state, 'player-1').streak).toBe(3);
    expect(playerOf(state, 'player-2').score).toBe(0);
    expect(playerOf(state, 'player-2').streak).toBe(0);
    expect(answerOf(state, 'player-4').isCorrect).toBe(false);
    expect(playerOf(state, 'player-4').streak).toBe(0);
    expect(playerOf(state, 'player-3').score).toBe(0);
    expect(currentPlay(state).teamPoints.get('team-a')).toBe(1200);
    expect(teamOf(state, 'team-a').score).toBe(1200);
    expect(teamOf(state, 'team-b').score).toBe(0);
    expect(findPersist(revealed.effects, 'save_scoring')?.teams).toEqual(
      expect.arrayContaining([{ teamId: 'team-a', score: 1200 }]),
    );
    expect(state.questionLog[0]?.revealedAt).toBe(openAt + 5000);
    expect(state.hasScoredQuestion).toBe(true);
    expect(currentPlay(state).isScored).toBe(true);
  });

  it('scores Lie Detector votes and Caption This votes with the favourite', () => {
    const random = seededRandom();
    const lieState = stateWithQuiz({
      rounds: [lieDetectorRound('round-lies')],
      isReviewOn: false,
    });
    addPlayer(lieState, 'player-1', { streak: 2 });
    addPlayer(lieState, 'player-2');
    addPlayer(lieState, 'player-3');
    startGame(lieState, NOW);
    nextPhase(lieState, NOW);
    const writeDeadline = requireNumber(lieState.cursor.deadline);
    submit(lieState, 'player-1', { type: 'prompt', text: 'Porto' }, NOW + 1000);
    submit(lieState, 'player-2', { type: 'prompt', text: 'Faro' }, NOW + 2000);
    timerElapsed(
      lieState,
      lieState.cursor.phaseId,
      writeDeadline + 500,
      random,
    );

    expect(lieState.cursor.phase).toBe('vote');
    expect(currentPlay(lieState).voteOptions).toHaveLength(3);
    const truthOption = optionOf(lieState, null);
    expect(truthOption.isTruth).toBe(true);
    expect(truthOption.answerId).toBeNull();
    expect(truthOption.text).toBe('Lisbon');

    castVote(
      lieState,
      'player-1',
      optionOf(lieState, 'player-2'),
      NOW + 70_000,
    );
    castVote(lieState, 'player-2', truthOption, NOW + 70_000);
    castVote(lieState, 'player-3', truthOption, NOW + 70_000);
    closeIfEveryoneDone(lieState, NOW + 70_000, random);

    expect(lieState.cursor.phase).toBe('reveal');
    expect(playerOf(lieState, 'player-1').score).toBe(0);
    expect(playerOf(lieState, 'player-2').score).toBe(1500);
    expect(playerOf(lieState, 'player-3').score).toBe(1000);
    expect(answerOf(lieState, 'player-2').pointsAwarded).toBe(500);
    expect(answerOf(lieState, 'player-1').pointsAwarded).toBe(0);
    expect(currentPlay(lieState).pointsByPlayer.get('player-2')).toBe(1500);
    expect(playerOf(lieState, 'player-1').streak).toBe(2);

    const captionState = stateWithQuiz({
      rounds: [captionRound('round-captions')],
      isReviewOn: false,
    });
    for (const playerId of ['player-1', 'player-2', 'player-3']) {
      addPlayer(captionState, playerId);
    }
    startGame(captionState, NOW);
    nextPhase(captionState, NOW);
    writeEveryCaption(
      captionState,
      ['player-1', 'player-2', 'player-3'],
      NOW + 1000,
      random,
    );
    castVote(
      captionState,
      'player-1',
      optionOf(captionState, 'player-2'),
      NOW + 2000,
    );
    castVote(
      captionState,
      'player-3',
      optionOf(captionState, 'player-2'),
      NOW + 2000,
    );
    castVote(
      captionState,
      'player-2',
      optionOf(captionState, 'player-1'),
      NOW + 2000,
    );
    closeIfEveryoneDone(captionState, NOW + 2000, random);

    expect(captionState.cursor.phase).toBe('reveal');
    expect(playerOf(captionState, 'player-2').score).toBe(500);
    expect(playerOf(captionState, 'player-1').score).toBe(250);
    expect(playerOf(captionState, 'player-3').score).toBe(0);

    const favourite = expectSuccess(
      hostPickFavourite(
        captionState,
        {
          phaseId: captionState.cursor.phaseId,
          questionId: currentPlay(captionState).questionId,
          optionId: optionOf(captionState, 'player-1').optionId,
        },
        NOW + 3000,
      ),
    );

    expect(favourite.isNoop).toBe(false);
    expect(playerOf(captionState, 'player-1').score).toBe(750);
    expect(answerOf(captionState, 'player-1').pointsAwarded).toBe(750);
    expect(findEffect(favourite.effects, 'reveal_updated')).toEqual({
      kind: 'reveal_updated',
      scope: 'favourite',
      playerId: 'player-1',
    });
    expect(findPersist(favourite.effects, 'save_scoring')).toBeDefined();

    const secondPick = expectSuccess(
      hostPickFavourite(
        captionState,
        {
          phaseId: captionState.cursor.phaseId,
          questionId: currentPlay(captionState).questionId,
          optionId: optionOf(captionState, 'player-2').optionId,
        },
        NOW + 3010,
      ),
    );

    expect(secondPick.isNoop).toBe(true);
    expect(playerOf(captionState, 'player-2').score).toBe(500);
    expect(currentPlay(captionState).favouriteOptionId).toBe(
      optionOf(captionState, 'player-1').optionId,
    );

    const favouriteAnswer = answerOf(captionState, 'player-1');
    expectSuccess(
      hostHideAnswer(
        captionState,
        { answerId: favouriteAnswer.answerId, isHidden: true },
        HOST_USER_ID,
        NOW + 4000,
      ),
    );

    expect(currentPlay(captionState).favouriteOptionId).toBeNull();
    expect(favouriteAnswer.pointsAwarded).toBe(0);
    expect(playerOf(captionState, 'player-1').score).toBe(0);
  });

  it('keeps a member removed between open and reveal in the team average with 0 points', () => {
    const state = stateWithQuiz({
      playMode: 'teams',
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addTeam(state, 'team-a');
    addTeam(state, 'team-b', { colorKey: 'triangle' });
    addPlayer(state, 'player-1', { teamId: 'team-a' });
    addPlayer(state, 'player-2', { teamId: 'team-a' });
    addPlayer(state, 'player-3', { teamId: 'team-b' });
    const openAt = openFirstQuizQuestion(state, NOW);
    submit(state, 'player-1', { type: 'true_false', isTrue: true }, openAt);
    submit(state, 'player-3', { type: 'true_false', isTrue: true }, openAt);

    expectSuccess(
      hostRemovePlayer(state, 'player-2', HOST_USER_ID, openAt + 1000),
    );

    // Both answers score the full 1000 plus the first streak step of 100.
    expect(state.cursor.phase).toBe('reveal');
    expect(playerOf(state, 'player-1').score).toBe(1100);
    expect(currentPlay(state).teamPoints.get('team-a')).toBe(550);
    expect(teamOf(state, 'team-a').score).toBe(550);
    expect(teamOf(state, 'team-b').score).toBe(1100);
    expect(playerOf(state, 'player-2').score).toBe(0);
  });

  it('drops the votes of a voter removed before reveal', () => {
    const random = seededRandom();
    const state = stateWithQuiz({
      rounds: [captionRound('round-captions')],
      isReviewOn: false,
    });
    for (const playerId of ['player-1', 'player-2', 'player-3']) {
      addPlayer(state, playerId);
    }
    startGame(state, NOW);
    nextPhase(state, NOW);
    writeEveryCaption(
      state,
      ['player-1', 'player-2', 'player-3'],
      NOW + 1000,
      random,
    );
    castVote(state, 'player-3', optionOf(state, 'player-1'), NOW + 2000);
    castVote(state, 'player-2', optionOf(state, 'player-1'), NOW + 2000);
    castVote(state, 'player-1', optionOf(state, 'player-2'), NOW + 2000);

    expectSuccess(
      hostRemovePlayer(state, 'player-3', HOST_USER_ID, NOW + 3000, random),
    );

    expect(state.cursor.phase).toBe('reveal');
    expect(playerOf(state, 'player-1').score).toBe(250);
    expect(answerOf(state, 'player-1').pointsAwarded).toBe(250);
    expect(playerOf(state, 'player-2').score).toBe(250);
    expect(answerOf(state, 'player-3').hiddenAt).toBe(NOW + 3000);
  });

  it("withdraws the author's points and emits answer hidden to every room when a host hides a revealed answer", () => {
    const random = seededRandom();
    const state = stateWithQuiz({
      playMode: 'teams',
      rounds: [captionRound('round-captions')],
      isReviewOn: false,
    });
    addTeam(state, 'team-a');
    addTeam(state, 'team-b', { colorKey: 'triangle' });
    addPlayer(state, 'player-1', { teamId: 'team-a' });
    addPlayer(state, 'player-2', { teamId: 'team-a' });
    addPlayer(state, 'player-3', { teamId: 'team-b' });
    startGame(state, NOW);
    nextPhase(state, NOW);
    writeEveryCaption(
      state,
      ['player-1', 'player-2', 'player-3'],
      NOW + 1000,
      random,
    );
    castVote(state, 'player-1', optionOf(state, 'player-3'), NOW + 2000);
    castVote(state, 'player-3', optionOf(state, 'player-2'), NOW + 2000);
    castVote(state, 'player-2', optionOf(state, 'player-3'), NOW + 2000);
    closeIfEveryoneDone(state, NOW + 2000, random);

    expect(playerOf(state, 'player-2').score).toBe(250);
    expect(teamOf(state, 'team-a').score).toBe(125);
    expect(teamOf(state, 'team-b').score).toBe(500);

    const hiddenAnswer = answerOf(state, 'player-2');
    const refusal = expectFailure(
      hostHideAnswer(
        state,
        { answerId: hiddenAnswer.answerId, isHidden: false },
        HOST_USER_ID,
        NOW + 3000,
      ),
    );
    expect(refusal.code).toBe('quizshow_unhide_review_only');
    expect(refusal.cursor).toEqual(state.cursor);

    const hidden = expectSuccess(
      hostHideAnswer(
        state,
        { answerId: hiddenAnswer.answerId, isHidden: true },
        HOST_USER_ID,
        NOW + 3000,
      ),
    );

    expect(hidden.isNoop).toBe(false);
    expect(hiddenAnswer.hiddenAt).toBe(NOW + 3000);
    expect(hiddenAnswer.pointsAwarded).toBe(0);
    expect(playerOf(state, 'player-2').score).toBe(0);
    expect(currentPlay(state).pointsByPlayer.get('player-2')).toBe(0);
    expect(teamOf(state, 'team-a').score).toBe(0);
    expect(teamOf(state, 'team-b').score).toBe(500);
    expect(findEffect(hidden.effects, 'answer_hidden')).toEqual({
      kind: 'answer_hidden',
      questionId: currentPlay(state).questionId,
      answerId: hiddenAnswer.answerId,
      optionId: optionOf(state, 'player-2').optionId,
    });
    expect(findPersist(hidden.effects, 'set_answer_hidden')).toEqual({
      type: 'set_answer_hidden',
      answerId: hiddenAnswer.answerId,
      hiddenAt: NOW + 3000,
      hiddenByUserId: HOST_USER_ID,
    });
    expect(findPersist(hidden.effects, 'save_scoring')).toBeDefined();
    expect(effectKinds(hidden.effects)).toContain('reveal_updated');

    const repeat = expectSuccess(
      hostHideAnswer(
        state,
        { answerId: hiddenAnswer.answerId, isHidden: true },
        HOST_USER_ID,
        NOW + 3010,
      ),
    );
    expect(repeat.isNoop).toBe(true);
    expect(teamOf(state, 'team-a').score).toBe(0);
  });

  it('skips a question with no score and no streak change', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1', 'question-2'])],
    });
    addPlayer(state, 'player-1', { score: 300, streak: 2 });
    startGame(state, NOW);
    expect(expectFailure(hostSkip(state, state.cursor.phaseId, NOW)).code).toBe(
      'quizshow_nothing_to_skip',
    );
    nextPhase(state, NOW);
    const openAt = requireNumber(state.cursor.deadline);
    timerElapsed(state, state.cursor.phaseId, openAt);
    submit(
      state,
      'player-1',
      { type: 'true_false', isTrue: true },
      openAt + 1000,
    );
    const skippedPlay = currentPlay(state);

    const skipped = expectSuccess(
      hostSkip(state, state.cursor.phaseId, openAt + 2000),
    );

    expect(skipped.isNoop).toBe(false);
    expect(skippedPlay.wasSkipped).toBe(true);
    expect(skippedPlay.isScored).toBe(false);
    expect(state.questionLog[0]?.wasSkipped).toBe(true);
    expect(state.questionLog[0]?.revealedAt).toBeNull();
    expect(playerOf(state, 'player-1').score).toBe(300);
    expect(playerOf(state, 'player-1').streak).toBe(2);
    expect(findPersist(skipped.effects, 'save_scoring')).toBeUndefined();
    expect(state.cursor.phase).toBe('read');
    expect(currentPlay(state).questionId).toBe('question-2');
    expect(state.hasScoredQuestion).toBe(false);
  });

  it("moves from the round's last question to the leaderboard and from the quiz's last to the podium", () => {
    const state = stateWithQuiz({
      rounds: [
        quizRound('round-one', ['question-1']),
        quizRound('round-two', ['question-2']),
      ],
    });
    addPlayer(state, 'player-1');
    startGame(state, NOW);
    nextPhase(state, NOW);
    const firstRevealAt = playQuizQuestionFromRead(state, ['player-1']);
    const scoreAfterFirst = playerOf(state, 'player-1').score;

    const scores = nextPhase(state, firstRevealAt + 1000);

    expect(state.cursor.phase).toBe('scores');
    expect(state.cursor.roundIndex).toBe(0);
    expect(state.cursor.questionIndex).toBe(0);
    expect(findEffect(scores.effects, 'scores_shown')).toEqual({
      kind: 'scores_shown',
      scope: 'question',
    });
    expect(state.lastScoresFrame?.phaseId).toBe(state.cursor.phaseId);
    expect(
      state.lastScoresFrame?.previousByEntrant.get('player-1'),
    ).toBeUndefined();

    const leaderboard = nextPhase(state, firstRevealAt + 2000);

    expect(state.cursor.phase).toBe('leaderboard');
    expect(state.cursor.roundIndex).toBe(0);
    expect(state.cursor.questionIndex).toBeNull();
    expect(findEffect(leaderboard.effects, 'scores_shown')).toEqual({
      kind: 'scores_shown',
      scope: 'round',
    });
    expect(state.lastScoresFrame?.previousByEntrant.get('player-1')).toBe(
      scoreAfterFirst,
    );

    nextPhase(state, firstRevealAt + 3000);
    expect(state.cursor.phase).toBe('round_intro');
    expect(state.cursor.roundIndex).toBe(1);

    nextPhase(state, firstRevealAt + 4000);
    const secondRevealAt = playQuizQuestionFromRead(state, ['player-1']);
    nextPhase(state, secondRevealAt + 1000);
    expect(state.cursor.phase).toBe('scores');

    const podium = nextPhase(state, secondRevealAt + 2000);

    expect(state.cursor.phase).toBe('podium');
    expect(state.cursor.roundIndex).toBeNull();
    expect(state.cursor.questionIndex).toBeNull();
    expect(findEffect(podium.effects, 'scores_shown')).toEqual({
      kind: 'scores_shown',
      scope: 'final',
    });
    expect(effectKinds(podium.effects)).toContain('podium_shown');
    expect(state.podium).toEqual([
      {
        place: 1,
        kind: 'player',
        entrantId: 'player-1',
        name: 'player-1 name',
        colorKey: null,
        score: playerOf(state, 'player-1').score,
      },
    ]);
  });

  it("finishes from the podium with places for every player and their team's place in teams play", () => {
    const teamsState = stateWithQuiz({
      playMode: 'teams',
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addTeam(teamsState, 'team-a', { name: 'Foxes' });
    addTeam(teamsState, 'team-b', { name: 'Owls', colorKey: 'triangle' });
    addPlayer(teamsState, 'player-1', { teamId: 'team-a' });
    addPlayer(teamsState, 'player-2', { teamId: 'team-a' });
    addPlayer(teamsState, 'player-3', { teamId: 'team-b' });
    addPlayer(teamsState, 'player-4', {
      teamId: 'team-b',
      removedAt: STARTED_AT + 10,
    });
    startGame(teamsState, NOW);
    teamOf(teamsState, 'team-a').score = 1500;
    teamOf(teamsState, 'team-b').score = 900;
    teamsState.hasScoredQuestion = true;

    expectSuccess(hostEnd(teamsState, teamsState.cursor.phaseId, NOW + 1000));
    expect(teamsState.cursor.phase).toBe('podium');
    // Two places, so two host-paced steps before host:next finishes (contract 6.7).
    nextPhase(teamsState, NOW + 2000);
    nextPhase(teamsState, NOW + 3000);
    expect(teamsState.cursor.podiumRevealedCount).toBe(2);

    const finished = nextPhase(teamsState, NOW + 4000);

    expect(teamsState.status).toBe('finished');
    expect(teamsState.cursor.status).toBe('finished');
    expect(teamsState.cursor.phase).toBe('ended');
    expect(findPersist(finished.effects, 'finish')).toEqual({
      type: 'finish',
      podium: [
        { place: 1, kind: 'team', entrantId: 'team-a', score: 1500 },
        { place: 2, kind: 'team', entrantId: 'team-b', score: 900 },
      ],
      placings: { 'player-1': 1, 'player-2': 1, 'player-3': 2 },
    });
    expect(effectKinds(finished.effects)).toEqual(
      expect.arrayContaining(['timer_cleared', 'session_ended']),
    );
    expect(findEffect(finished.effects, 'session_ended')).toEqual({
      kind: 'session_ended',
      status: 'finished',
    });

    const soloState = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(soloState, 'player-1');
    addPlayer(soloState, 'player-2');
    addPlayer(soloState, 'player-3');
    startGame(soloState, NOW);
    playerOf(soloState, 'player-1').score = 1000;
    playerOf(soloState, 'player-2').score = 1000;
    playerOf(soloState, 'player-3').score = 200;
    soloState.hasScoredQuestion = true;
    expectSuccess(hostEnd(soloState, soloState.cursor.phaseId, NOW + 1000));
    const soloPodiumPhaseId = soloState.cursor.phaseId;

    const soloFinished = expectSuccess(
      hostEnd(soloState, soloPodiumPhaseId, NOW + 2000),
    );
    const secondEnd = expectSuccess(
      hostEnd(soloState, soloPodiumPhaseId, NOW + 2005),
    );

    expect(secondEnd.isNoop).toBe(true);
    expect(secondEnd.effects).toEqual(CHECKPOINT_ONLY);
    expect(soloState.status).toBe('finished');

    expect(findPersist(soloFinished.effects, 'finish')?.placings).toEqual({
      'player-1': 1,
      'player-2': 1,
      'player-3': 3,
    });
    expect(
      findPersist(soloFinished.effects, 'finish')?.podium.map(
        (entry) => entry.place,
      ),
    ).toEqual([1, 1, 3]);
  });

  it('ends a game with no scored question as abandoned and one with scores at the podium', () => {
    const lobbyState = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(lobbyState, 'player-1');

    const lobbyEnd = expectSuccess(hostEnd(lobbyState, '0', NOW));
    const repeatedEnd = expectSuccess(hostEnd(lobbyState, '0', NOW + 5));

    expect(repeatedEnd.isNoop).toBe(true);
    expect(findPersist(repeatedEnd.effects, 'abandon')).toBeUndefined();

    expect(lobbyState.status).toBe('abandoned');
    expect(lobbyState.cursor.status).toBe('abandoned');
    expect(lobbyState.cursor.phase).toBe('ended');
    expect(findPersist(lobbyEnd.effects, 'abandon')).toEqual({
      type: 'abandon',
    });
    expect(findPersist(lobbyEnd.effects, 'finish')).toBeUndefined();
    expect(findEffect(lobbyEnd.effects, 'session_ended')).toEqual({
      kind: 'session_ended',
      status: 'abandoned',
    });

    const unscoredState = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(unscoredState, 'player-1');
    startGame(unscoredState, NOW);
    nextPhase(unscoredState, NOW);

    expect(
      expectFailure(hostEnd(unscoredState, 'phase-from-elsewhere', NOW + 1000))
        .code,
    ).toBe('quizshow_stale_phase');
    expectSuccess(
      hostEnd(unscoredState, unscoredState.cursor.phaseId, NOW + 1000),
    );

    expect(unscoredState.status).toBe('abandoned');
    expect(unscoredState.cursor.phase).toBe('ended');

    const scoredState = stateWithQuiz({
      rounds: [
        quizRound('round-one', ['question-1']),
        quizRound('round-two', ['question-2']),
      ],
    });
    addPlayer(scoredState, 'player-1');
    startGame(scoredState, NOW);
    nextPhase(scoredState, NOW);
    const revealAt = playQuizQuestionFromRead(scoredState, ['player-1']);
    nextPhase(scoredState, revealAt + 1000);
    nextPhase(scoredState, revealAt + 2000);
    expect(scoredState.cursor.phase).toBe('leaderboard');
    expectSuccess(
      hostPause(scoredState, scoredState.cursor.phaseId, revealAt + 3000),
    );

    const scoredEnd = expectSuccess(
      hostEnd(scoredState, scoredState.cursor.phaseId, revealAt + 4000),
    );

    expect(scoredState.cursor.phase).toBe('podium');
    expect(scoredState.status).toBe('running');
    expect(scoredState.cursor.status).toBe('running');
    expect(scoredState.pausedAt).toBeNull();
    expect(effectKinds(scoredEnd.effects)).toContain('podium_shown');
    expect(scoredState.podium?.[0]?.entrantId).toBe('player-1');
  });

  it('ending from a timed phase clears the timer', () => {
    const state = stateWithQuiz({
      rounds: [
        quizRound('round-one', ['question-1']),
        quizRound('round-two', ['question-2']),
      ],
    });
    addPlayer(state, 'player-1');
    startGame(state, NOW);
    nextPhase(state, NOW);
    const revealAt = playQuizQuestionFromRead(state, ['player-1']);
    nextPhase(state, revealAt + 1000);
    nextPhase(state, revealAt + 2000);
    nextPhase(state, revealAt + 3000);
    nextPhase(state, revealAt + 4000);
    expect(state.cursor.phase).toBe('read');
    const openAt = requireNumber(state.cursor.deadline);
    timerElapsed(state, state.cursor.phaseId, openAt);
    expect(state.cursor.phase).toBe('open');
    expect(state.cursor.deadline).not.toBeNull();

    const ended = expectSuccess(
      hostEnd(state, state.cursor.phaseId, openAt + 1000),
    );

    expect(state.cursor.phase).toBe('podium');
    expect(state.cursor.deadline).toBeNull();
    expect(state.cursor.extraTimeDeadline).toBeNull();
    expect(findEffect(ended.effects, 'timer_cleared')).toEqual({
      kind: 'timer_cleared',
    });
    expect(findEffect(ended.effects, 'timer')).toBeUndefined();
    const kinds = effectKinds(ended.effects);
    expect(kinds.indexOf('timer_cleared')).toBeGreaterThan(
      kinds.indexOf('phase_changed'),
    );
    expect(kinds).toEqual(
      expect.arrayContaining(['scores_shown', 'podium_shown']),
    );
    expect(checkpointCount(ended.effects)).toBe(1);
  });

  it('hiding an answer on the leaderboard re-sends scores', () => {
    const random = seededRandom();
    const state = stateWithQuiz({
      rounds: [
        captionRound('round-captions'),
        quizRound('round-two', ['question-2']),
      ],
      isReviewOn: false,
    });
    addPlayer(state, 'player-1');
    addPlayer(state, 'player-2');
    addPlayer(state, 'player-3');
    startGame(state, NOW);
    nextPhase(state, NOW);
    writeEveryCaption(
      state,
      ['player-1', 'player-2', 'player-3'],
      NOW + 1000,
      random,
    );
    castVote(state, 'player-1', optionOf(state, 'player-3'), NOW + 2000);
    castVote(state, 'player-3', optionOf(state, 'player-2'), NOW + 2000);
    castVote(state, 'player-2', optionOf(state, 'player-3'), NOW + 2000);
    closeIfEveryoneDone(state, NOW + 2000, random);
    expect(state.cursor.phase).toBe('reveal');

    const scoredState = structuredClone(state);

    nextPhase(state, NOW + 3000);
    expect(state.cursor.phase).toBe('leaderboard');
    const hiddenAnswer = answerOf(state, 'player-2');
    const scoreBefore = playerOf(state, 'player-2').score;
    const withdrawnPoints = hiddenAnswer.pointsAwarded;
    expect(withdrawnPoints).toBeGreaterThan(0);
    const leaderboardPhaseId = state.cursor.phaseId;
    const leaderboardFrame = state.lastScoresFrame;
    expect(leaderboardFrame?.phaseId).toBe(leaderboardPhaseId);

    const hidden = expectSuccess(
      hostHideAnswer(
        state,
        { answerId: hiddenAnswer.answerId, isHidden: true },
        HOST_USER_ID,
        NOW + 4000,
      ),
    );

    expect(hidden.isNoop).toBe(false);
    expect(playerOf(state, 'player-2').score).toBe(
      scoreBefore - withdrawnPoints,
    );
    expect(findEffect(hidden.effects, 'scores_shown')).toEqual({
      kind: 'scores_shown',
      scope: 'round',
    });
    expect(findPersist(hidden.effects, 'save_scoring')).toBeDefined();
    expect(state.cursor.phaseId).toBe(leaderboardPhaseId);
    expect(state.lastScoresFrame).toBe(leaderboardFrame);
    expect(
      state.lastScoresFrame?.previousByEntrant.get('player-2'),
    ).toBeUndefined();
    expect(state.scoresAtLastFrame.get('player-2')).toBe(
      scoreBefore - withdrawnPoints,
    );

    // With the caption round as the quiz's last, the podium follows, and its final scores are sent again too.
    const podiumState = scoredState;
    podiumState.snapshot = {
      ...podiumState.snapshot,
      rounds: podiumState.snapshot.rounds.slice(0, 1),
    };
    nextPhase(podiumState, NOW + 3000);
    expect(podiumState.cursor.phase).toBe('podium');

    const hiddenOnPodium = expectSuccess(
      hostHideAnswer(
        podiumState,
        {
          answerId: answerOf(podiumState, 'player-2').answerId,
          isHidden: true,
        },
        HOST_USER_ID,
        NOW + 4000,
      ),
    );

    expect(findEffect(hiddenOnPodium.effects, 'scores_shown')).toEqual({
      kind: 'scores_shown',
      scope: 'final',
    });
    expect(effectKinds(hiddenOnPodium.effects)).toContain('podium_shown');
  });

  it('hiding an answer in reveal sends no scores frame', () => {
    const random = seededRandom();
    const state = stateWithQuiz({
      rounds: [captionRound('round-captions')],
      isReviewOn: false,
    });
    addPlayer(state, 'player-1');
    addPlayer(state, 'player-2');
    addPlayer(state, 'player-3');
    startGame(state, NOW);
    nextPhase(state, NOW);
    writeEveryCaption(
      state,
      ['player-1', 'player-2', 'player-3'],
      NOW + 1000,
      random,
    );
    castVote(state, 'player-1', optionOf(state, 'player-3'), NOW + 2000);
    castVote(state, 'player-3', optionOf(state, 'player-2'), NOW + 2000);
    castVote(state, 'player-2', optionOf(state, 'player-3'), NOW + 2000);
    closeIfEveryoneDone(state, NOW + 2000, random);
    expect(state.cursor.phase).toBe('reveal');

    const hidden = expectSuccess(
      hostHideAnswer(
        state,
        { answerId: answerOf(state, 'player-2').answerId, isHidden: true },
        HOST_USER_ID,
        NOW + 3000,
      ),
    );

    expect(effectKinds(hidden.effects)).toContain('reveal_updated');
    expect(findEffect(hidden.effects, 'scores_shown')).toBeUndefined();
  });

  it('replays the question from its first phase on resume after a restart and drops its answers', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(state, 'player-1');
    addPlayer(state, 'player-2');
    const openAt = openFirstQuizQuestion(state, NOW);
    submit(
      state,
      'player-1',
      { type: 'true_false', isTrue: true },
      openAt + 1000,
    );
    const bootAt = openAt + 5000;
    // What the boot recovery leaves: paused with restart recovery, no play loaded.
    setSessionStatus(state, 'paused');
    state.cursor.isRestartRecovery = true;
    state.pausedAt = bootAt;
    state.current = null;
    addPlayer(state, 'player-3', { joinedAt: bootAt + 100 });
    const pausedPhaseId = state.cursor.phaseId;
    const resumeAt = bootAt + 60_000;

    const resumed = expectSuccess(hostResume(state, pausedPhaseId, resumeAt));

    expect(resumed.effects[0]).toEqual({
      kind: 'persist',
      operation: { type: 'delete_question_plays', questionId: 'question-1' },
    });
    expect(state.status).toBe('running');
    expect(state.cursor.phase).toBe('read');
    expect(state.cursor.phaseId).not.toBe(pausedPhaseId);
    expect(state.cursor.isRestartRecovery).toBe(false);
    expect(state.cursor.deadline).toBe(resumeAt + 3000);
    expect(state.questionLog).toHaveLength(1);
    expect(state.questionLog[0]?.openedAt).toBe(resumeAt);
    expect(currentPlay(state).answers.size).toBe(0);
    expect(currentPlay(state).eligiblePlayerIds).toEqual(
      new Set(['player-1', 'player-2', 'player-3']),
    );
    expect(findEffect(resumed.effects, 'timer')).toEqual({
      kind: 'timer',
      phaseId: state.cursor.phaseId,
      fireAt: resumeAt + 3000,
    });
  });

  it('resumes a restart pause in reveal at the same phase', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(state, 'player-1');
    startGame(state, NOW);
    nextPhase(state, NOW);
    const revealAt = playQuizQuestionFromRead(state, ['player-1']);
    const scoreAtReveal = playerOf(state, 'player-1').score;
    const revealPhaseId = state.cursor.phaseId;
    setSessionStatus(state, 'paused');
    state.pausedAt = revealAt + 1000;

    const resumed = expectSuccess(
      hostResume(state, revealPhaseId, revealAt + 9000),
    );

    expect(state.status).toBe('running');
    expect(state.cursor.phase).toBe('reveal');
    expect(state.cursor.phaseId).toBe(revealPhaseId);
    expect(
      findPersist(resumed.effects, 'delete_question_plays'),
    ).toBeUndefined();
    expect(findEffect(resumed.effects, 'timer')).toBeUndefined();
    expect(playerOf(state, 'player-1').score).toBe(scoreAtReveal);
    expect(state.questionLog[0]?.revealedAt).toBe(revealAt);
  });

  it('abandons a lobby idle for two hours and a pause of two hours, and keeps one idle for less', () => {
    const lobbyState = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(lobbyState, 'player-1');

    expect(abandonIfIdle(lobbyState, STARTED_AT + TWO_HOURS_MS - 1)).toEqual(
      [],
    );
    expect(lobbyState.status).toBe('lobby');

    const lobbyEffects = abandonIfIdle(lobbyState, STARTED_AT + TWO_HOURS_MS);

    expect(lobbyState.status).toBe('abandoned');
    expect(lobbyState.cursor.phase).toBe('ended');
    expect(findPersist(lobbyEffects, 'abandon')).toEqual({ type: 'abandon' });
    expect(findEffect(lobbyEffects, 'session_ended')).toEqual({
      kind: 'session_ended',
      status: 'abandoned',
    });
    expect(abandonIfIdle(lobbyState, STARTED_AT + 2 * TWO_HOURS_MS)).toEqual(
      [],
    );

    const pausedState = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(pausedState, 'player-1');
    startGame(pausedState, NOW);
    nextPhase(pausedState, NOW);
    const pausedAt = NOW + 1000;
    expectSuccess(hostPause(pausedState, pausedState.cursor.phaseId, pausedAt));

    expect(abandonIfIdle(pausedState, pausedAt + TWO_HOURS_MS - 1)).toEqual([]);
    expect(pausedState.status).toBe('paused');

    const pausedEffects = abandonIfIdle(pausedState, pausedAt + TWO_HOURS_MS);

    expect(pausedState.status).toBe('abandoned');
    expect(effectKinds(pausedEffects)).toEqual(
      expect.arrayContaining(['timer_cleared', 'session_ended']),
    );
  });

  it('abandons a running session after 2 hours with no host command', () => {
    const submitAndCloseFirstQuestion = (state: QuizshowLiveState): void => {
      nextPhase(state, NOW + 1000);
      const openAt = requireNumber(state.cursor.deadline);
      timerElapsed(state, state.cursor.phaseId, openAt);
      submit(
        state,
        'player-1',
        { type: 'true_false', isTrue: true },
        openAt + 500,
      );
      closeIfEveryoneDone(state, openAt + 500);
    };
    const buildRevealedSession = (): {
      state: QuizshowLiveState;
      lastCommandAt: number;
    } => {
      const state = stateWithQuiz({
        rounds: [
          quizRound('round-one', ['question-1']),
          quizRound('round-two', ['question-2']),
        ],
      });
      addPlayer(state, 'player-1');
      startGame(state, NOW);
      submitAndCloseFirstQuestion(state);
      expect(state.cursor.phase).toBe('reveal');
      expect(state.hasScoredQuestion).toBe(true);
      return { state, lastCommandAt: state.lastHostCommandAt };
    };

    const idle = buildRevealedSession();
    expect(idle.lastCommandAt).toBe(NOW + 1000);

    const effects = abandonIfIdle(
      idle.state,
      idle.lastCommandAt + TWO_HOURS_MS,
    );

    expect(idle.state.status).toBe('abandoned');
    expect(idle.state.cursor.phase).toBe('ended');
    expect(findPersist(effects, 'finish')).toBeUndefined();
    expect(findPersist(effects, 'abandon')).toEqual({ type: 'abandon' });
    expect(findEffect(effects, 'session_ended')).toEqual({
      kind: 'session_ended',
      status: 'abandoned',
    });

    const recent = buildRevealedSession();
    const oneHourFiftyNineMs = TWO_HOURS_MS - 60_000;

    expect(
      abandonIfIdle(recent.state, recent.lastCommandAt + oneHourFiftyNineMs),
    ).toEqual([]);
    expect(recent.state.status).toBe('running');
    expect(recent.state.cursor.phase).toBe('reveal');
  });

  it('removes a player, hides their party answers and closes the phase when they were the last to answer', () => {
    const state = stateWithQuiz({
      rounds: [captionRound('round-captions')],
      isReviewOn: true,
    });
    addPlayer(state, 'player-1');
    addPlayer(state, 'player-2');
    addPlayer(state, 'player-3');
    startGame(state, NOW);
    nextPhase(state, NOW);
    submit(state, 'player-1', { type: 'prompt', text: 'Kept' }, NOW + 1000);
    const removedAnswer = submit(
      state,
      'player-2',
      { type: 'prompt', text: 'Gone' },
      NOW + 2000,
    );

    const firstRemoval = expectSuccess(
      hostRemovePlayer(state, 'player-2', HOST_USER_ID, NOW + 3000),
    );

    expect(firstRemoval.isNoop).toBe(false);
    expect(playerOf(state, 'player-2').removedAt).toBe(NOW + 3000);
    expect(removedAnswer.hiddenAt).toBe(NOW + 3000);
    expect(state.cursor.phase).toBe('write');
    expect(findPersist(firstRemoval.effects, 'update_player')).toEqual({
      type: 'update_player',
      playerId: 'player-2',
      fields: { removedAt: NOW + 3000 },
    });
    expect(findPersist(firstRemoval.effects, 'hide_player_answers')).toEqual({
      type: 'hide_player_answers',
      playerId: 'player-2',
      hiddenAt: NOW + 3000,
      hiddenByUserId: HOST_USER_ID,
    });
    expect(findEffect(firstRemoval.effects, 'player_removed')).toEqual({
      kind: 'player_removed',
      playerId: 'player-2',
      canRejoin: false,
    });
    expect(effectKinds(firstRemoval.effects)).toContain('lobby_changed');

    const lastRemoval = expectSuccess(
      hostRemovePlayer(
        state,
        'player-3',
        HOST_USER_ID,
        NOW + 4000,
        seededRandom(),
      ),
    );

    expect(state.cursor.phase).toBe('review');
    expect(effectKinds(lastRemoval.effects)).toEqual(
      expect.arrayContaining(['player_removed', 'review_list_changed']),
    );
    expect(checkpointCount(lastRemoval.effects)).toBe(1);

    expect(
      expectFailure(
        hostRemovePlayer(state, 'player-9', HOST_USER_ID, NOW + 5000),
      ).code,
    ).toBe('quizshow_player_not_found');
    expect(
      expectSuccess(
        hostRemovePlayer(state, 'player-3', HOST_USER_ID, NOW + 5000),
      ).isNoop,
    ).toBe(true);
  });

  it('deletes the team a removal leaves empty in the lobby and keeps a team with members left', () => {
    const state = stateWithQuiz({
      playMode: 'teams',
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addTeam(state, 'team-a');
    addTeam(state, 'team-b', { colorKey: 'triangle' });
    addPlayer(state, 'player-1', { teamId: 'team-a' });
    addPlayer(state, 'player-2', { teamId: 'team-a' });
    addPlayer(state, 'player-3', { teamId: 'team-b' });

    const keptRemoval = expectSuccess(
      hostRemovePlayer(state, 'player-1', HOST_USER_ID, NOW),
    );

    expect(findPersist(keptRemoval.effects, 'delete_teams')).toBeUndefined();
    expect(teamOf(state, 'team-a').teamId).toBe('team-a');

    const emptyingRemoval = expectSuccess(
      hostRemovePlayer(state, 'player-3', HOST_USER_ID, NOW + 1000),
    );

    expect(findPersist(emptyingRemoval.effects, 'delete_teams')).toEqual({
      type: 'delete_teams',
      teamIds: ['team-b'],
    });
    const persistTypes = emptyingRemoval.effects.flatMap((effect) =>
      effect.kind === 'persist' ? [effect.operation.type] : [],
    );
    expect(persistTypes.indexOf('update_player')).toBeLessThan(
      persistTypes.indexOf('delete_teams'),
    );
    expect(effectKinds(emptyingRemoval.effects)).toContain('lobby_changed');
    expect([...state.teams.keys()]).toEqual(['team-a']);
  });

  it('keeps the team of a player removed while the game runs', () => {
    const state = stateWithQuiz({
      playMode: 'teams',
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addTeam(state, 'team-a');
    addTeam(state, 'team-b', { colorKey: 'triangle' });
    addPlayer(state, 'player-1', { teamId: 'team-a' });
    addPlayer(state, 'player-2', { teamId: 'team-b' });
    startGame(state, NOW);

    const removal = expectSuccess(
      hostRemovePlayer(state, 'player-2', HOST_USER_ID, NOW + 1000),
    );

    expect(findPersist(removal.effects, 'delete_teams')).toBeUndefined();
    expect([...state.teams.keys()]).toEqual(['team-a', 'team-b']);
  });

  it('mutes the screen for every screen and host socket and acks a repeat as a noop', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(state, 'player-1');

    const first = expectSuccess(hostSetScreenMuted(state, true, NOW));

    expect(first.isNoop).toBe(false);
    expect(state.isScreenMuted).toBe(true);
    expect(first.effects).toEqual(CHECKPOINT_ONLY);
    expect(state.lastHostCommandAt).toBe(NOW);

    const repeat = expectSuccess(hostSetScreenMuted(state, true, NOW + 10));

    expect(repeat.isNoop).toBe(true);
    expect(repeat.effects).toEqual(CHECKPOINT_ONLY);
    expect(state.isScreenMuted).toBe(true);

    setSessionStatus(state, 'finished');

    expect(expectFailure(hostSetScreenMuted(state, false, NOW + 20)).code).toBe(
      'quizshow_session_ended',
    );
    expect(state.isScreenMuted).toBe(true);
  });
});

describe('Pulse Live engine phases: refusal causes (contract 3.2)', () => {
  function lobbyState(): QuizshowLiveState {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1', 'question-2'])],
    });
    addTeam(state, 'team-a');
    addPlayer(state, 'player-1');
    return state;
  }

  /** Running, on round 0's intro. */
  function introState(): QuizshowLiveState {
    const state = lobbyState();
    startGame(state, NOW);
    return state;
  }

  function readState(): QuizshowLiveState {
    const state = introState();
    nextPhase(state, NOW);
    return state;
  }

  function openState(): QuizshowLiveState {
    const state = lobbyState();
    openFirstQuizQuestion(state, NOW);
    return state;
  }

  function revealState(): QuizshowLiveState {
    const state = openState();
    expectSuccess(hostReveal(state, state.cursor.phaseId, NOW + 30_000));
    return state;
  }

  function scoresState(): QuizshowLiveState {
    const state = revealState();
    nextPhase(state, NOW + 31_000);
    expect(state.cursor.phase).toBe('scores');
    return state;
  }

  function pausedState(): QuizshowLiveState {
    const state = introState();
    expectSuccess(hostPause(state, state.cursor.phaseId, NOW + 10));
    return state;
  }

  function finishedState(): QuizshowLiveState {
    const state = lobbyState();
    setSessionStatus(state, 'finished');
    return state;
  }

  /** Running with the cursor still on a phase `host:next` cannot leave. */
  function runningOnPhase(phase: 'lobby' | 'ended'): QuizshowLiveState {
    const state = lobbyState();
    setSessionStatus(state, 'running');
    state.cursor.phase = phase;
    return state;
  }

  function reviewStateWithLeftAuthor(): {
    state: QuizshowLiveState;
    answerId: string;
  } {
    const state = stateWithQuiz({
      rounds: [captionRound('round-captions')],
      isReviewOn: true,
    });
    addPlayer(state, 'player-1');
    addPlayer(state, 'player-2');
    startGame(state, NOW);
    nextPhase(state, NOW);
    submit(state, 'player-1', { type: 'prompt', text: 'Kept' }, NOW + 1000);
    const answer = submit(
      state,
      'player-2',
      { type: 'prompt', text: 'Gone' },
      NOW + 1000,
    );
    closeIfEveryoneDone(state, NOW + 1000, seededRandom());
    expect(state.cursor.phase).toBe('review');
    expectSuccess(
      hostHideAnswer(
        state,
        { answerId: answer.answerId, isHidden: true },
        HOST_USER_ID,
        NOW + 2000,
      ),
    );
    playerOf(state, 'player-2').leftAt = NOW + 2500;
    return { state, answerId: answer.answerId };
  }

  const rows: Array<{
    label: string;
    run: () => { state: QuizshowLiveState; outcome: QuizshowHostOutcome };
    code: QuizshowErrorCode;
  }> = [
    {
      label: 'hostStart once the game runs',
      run: () => {
        const state = introState();
        return {
          state,
          outcome: hostStart(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_already_started',
    },
    {
      label: 'hostStart on a finished session',
      run: () => {
        const state = finishedState();
        return {
          state,
          outcome: hostStart(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_session_ended',
    },
    {
      label: 'hostNext in the lobby status',
      run: () => {
        const state = lobbyState();
        return {
          state,
          outcome: hostNext(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_session_not_started',
    },
    {
      label: 'hostNext while paused',
      run: () => {
        const state = pausedState();
        return {
          state,
          outcome: hostNext(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_session_paused',
    },
    {
      label: 'hostNext with the cursor on the lobby phase',
      run: () => {
        const state = runningOnPhase('lobby');
        return {
          state,
          outcome: hostNext(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_session_not_started',
    },
    {
      label: 'hostNext with the cursor on the ended phase',
      run: () => {
        const state = runningOnPhase('ended');
        return {
          state,
          outcome: hostNext(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_session_ended',
    },
    {
      label: 'hostSpin while paused',
      run: () => {
        const state = pausedState();
        return {
          state,
          outcome: hostSpin(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_session_paused',
    },
    {
      label: 'hostSpin outside a wheel or a leaderboard',
      run: () => {
        const state = introState();
        return {
          state,
          outcome: hostSpin(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_spin_not_available',
    },
    {
      label: 'hostFinishWheel in the lobby status',
      run: () => {
        const state = lobbyState();
        return {
          state,
          outcome: hostFinishWheel(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_session_not_started',
    },
    {
      label: 'hostFinishWheel running with no wheel open',
      run: () => {
        const state = introState();
        return {
          state,
          outcome: hostFinishWheel(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_no_wheel_open',
    },
    {
      label: 'hostPause in the lobby',
      run: () => {
        const state = lobbyState();
        return {
          state,
          outcome: hostPause(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_session_not_started',
    },
    {
      label: 'hostPause on a finished session',
      run: () => {
        const state = finishedState();
        return {
          state,
          outcome: hostPause(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_session_ended',
    },
    {
      label: 'hostResume in the lobby',
      run: () => {
        const state = lobbyState();
        return {
          state,
          outcome: hostResume(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_session_not_started',
    },
    {
      label: 'hostResume on a finished session',
      run: () => {
        const state = finishedState();
        return {
          state,
          outcome: hostResume(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_session_ended',
    },
    {
      label: 'hostAddTime while paused',
      run: () => {
        const state = pausedState();
        return {
          state,
          outcome: hostAddTime(
            state,
            { phaseId: state.cursor.phaseId, seconds: 10, expectedDeadline: 0 },
            NOW + 100,
          ),
        };
      },
      code: 'quizshow_session_paused',
    },
    {
      label: 'hostAddTime in an untimed phase',
      run: () => {
        const state = introState();
        return {
          state,
          outcome: hostAddTime(
            state,
            { phaseId: state.cursor.phaseId, seconds: 10, expectedDeadline: 0 },
            NOW + 100,
          ),
        };
      },
      code: 'quizshow_no_timer_running',
    },
    {
      label: 'hostReveal while paused',
      run: () => {
        const state = pausedState();
        return {
          state,
          outcome: hostReveal(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_session_paused',
    },
    {
      label: 'hostReveal in reveal',
      run: () => {
        const state = revealState();
        return {
          state,
          outcome: hostReveal(state, state.cursor.phaseId, NOW + 31_000),
        };
      },
      code: 'quizshow_already_revealed',
    },
    {
      label: 'hostReveal in scores',
      run: () => {
        const state = scoresState();
        return {
          state,
          outcome: hostReveal(state, state.cursor.phaseId, NOW + 32_000),
        };
      },
      code: 'quizshow_already_revealed',
    },
    {
      label: 'hostReveal in read',
      run: () => {
        const state = readState();
        return {
          state,
          outcome: hostReveal(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_nothing_to_reveal',
    },
    {
      label: 'hostSkip while paused',
      run: () => {
        const state = pausedState();
        return {
          state,
          outcome: hostSkip(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_session_paused',
    },
    {
      label: 'hostSkip with no question in play',
      run: () => {
        const state = introState();
        return {
          state,
          outcome: hostSkip(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_nothing_to_skip',
    },
    {
      label: 'hostShowAnswers while paused',
      run: () => {
        const state = pausedState();
        return {
          state,
          outcome: hostShowAnswers(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_session_paused',
    },
    {
      label: 'hostShowAnswers outside review',
      run: () => {
        const state = openState();
        return {
          state,
          outcome: hostShowAnswers(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_review_not_open',
    },
    {
      label: 'hostHideAnswer on a finished session',
      run: () => {
        const state = finishedState();
        return {
          state,
          outcome: hostHideAnswer(
            state,
            { answerId: 'answer-1', isHidden: true },
            HOST_USER_ID,
            NOW + 100,
          ),
        };
      },
      code: 'quizshow_session_ended',
    },
    {
      label: 'hostHideAnswer showing again an answer whose author left',
      run: () => {
        const { state, answerId } = reviewStateWithLeftAuthor();
        return {
          state,
          outcome: hostHideAnswer(
            state,
            { answerId, isHidden: false },
            HOST_USER_ID,
            NOW + 3000,
          ),
        };
      },
      code: 'quizshow_author_removed',
    },
    {
      label: 'hostPickFavourite while paused',
      run: () => {
        const state = pausedState();
        return {
          state,
          outcome: hostPickFavourite(
            state,
            {
              phaseId: state.cursor.phaseId,
              questionId: 'question-1',
              optionId: 'option-1',
            },
            NOW + 100,
          ),
        };
      },
      code: 'quizshow_session_paused',
    },
    {
      label: 'hostPickFavourite on a quiz reveal',
      run: () => {
        const state = revealState();
        return {
          state,
          outcome: hostPickFavourite(
            state,
            {
              phaseId: state.cursor.phaseId,
              questionId: 'question-1',
              optionId: 'option-1',
            },
            NOW + 31_000,
          ),
        };
      },
      code: 'quizshow_favourite_not_available',
    },
    {
      label: 'hostRemovePlayer on a finished session',
      run: () => {
        const state = finishedState();
        return {
          state,
          outcome: hostRemovePlayer(state, 'player-1', HOST_USER_ID, NOW + 100),
        };
      },
      code: 'quizshow_session_ended',
    },
    {
      label: 'hostRenameTeam on a finished session',
      run: () => {
        const state = finishedState();
        return {
          state,
          outcome: hostRenameTeam(
            state,
            { teamId: 'team-a', name: 'The Divas' },
            NOW + 100,
          ),
        };
      },
      code: 'quizshow_session_ended',
    },
    {
      label: 'hostEnd on a finished session',
      run: () => {
        const state = finishedState();
        return {
          state,
          outcome: hostEnd(state, state.cursor.phaseId, NOW + 100),
        };
      },
      code: 'quizshow_session_ended',
    },
    {
      label: 'hostSetScreenMuted on a finished session',
      run: () => {
        const state = finishedState();
        return { state, outcome: hostSetScreenMuted(state, true, NOW + 100) };
      },
      code: 'quizshow_session_ended',
    },
  ];

  it.each(rows)('$label refuses with $code and the cursor', ({ run, code }) => {
    const { state, outcome } = run();

    const failure = expectFailure(outcome);

    expect(failure.code).toBe(code);
    expect(failure.cursor).toEqual(state.cursor);
  });
});

describe('Pulse Live engine phases: v2 question flow', () => {
  it('leaves out a player away for 20 s or more when a question opens and keeps one who left 5 s ago', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(state, 'player-1');
    addPlayer(state, 'player-2', {
      connectedSocketCount: 0,
      disconnectedAt: NOW - 25_000,
    });
    addPlayer(state, 'player-3', {
      connectedSocketCount: 0,
      disconnectedAt: NOW - 5_000,
    });
    startGame(state, NOW);

    nextPhase(state, NOW);

    const play = currentPlay(state);
    expect(play.eligiblePlayerIds).toEqual(new Set(['player-1', 'player-3']));
    expect(play.awayPlayerIds).toEqual(new Set(['player-2']));
    expect(state.questionLog[0]?.eligibleCount).toBe(2);
    expect(play.answersById.size).toBe(0);
    expect(play.streakBeforeByPlayer.size).toBe(0);
    expect(play.keyOverride).toBeNull();
    expect(play.acceptedTexts.size).toBe(0);
    expect(play.wasCorrected).toBe(false);
  });

  it('reads a long question for the 8 s ceiling', () => {
    const longQuestion: QuizshowSnapshotQuestion = {
      ...trueFalseQuestion('question-1'),
      prompt: { en: 'x'.repeat(280), pt: 'y'.repeat(10) },
    };
    const state = stateWithQuiz({
      rounds: [snapshotRound('round-one', 'quiz', [longQuestion])],
    });
    addPlayer(state, 'player-1');
    startGame(state, NOW);

    nextPhase(state, NOW);

    expect(state.cursor.phase).toBe('read');
    expect(state.cursor.deadline).toBe(NOW + 8000);
  });

  it('adds the talk beat to read in teams play and moves it with a pause', () => {
    const state = stateWithQuiz({
      playMode: 'teams',
      rounds: [
        withRoundSettings(quizRound('round-one', ['question-1']), {
          talkSeconds: 20,
        }),
      ],
    });
    addTeam(state, 'team-a');
    addPlayer(state, 'player-1', { teamId: 'team-a' });
    startGame(state, NOW);

    nextPhase(state, NOW + 1000);

    expect(state.cursor.phase).toBe('read');
    expect(state.cursor.phaseStartedAt).toBe(NOW + 1000);
    expect(state.cursor.talkStartsAt).toBe(NOW + 1000 + 3000);
    expect(state.cursor.deadline).toBe(NOW + 1000 + 3000 + 20_000);

    const readPhaseId = state.cursor.phaseId;
    expectSuccess(hostPause(state, readPhaseId, NOW + 2000));
    expectSuccess(hostResume(state, readPhaseId, NOW + 12_000));

    expect(state.cursor.phaseStartedAt).toBe(NOW + 11_000);
    expect(state.cursor.talkStartsAt).toBe(NOW + 14_000);
    expect(state.cursor.deadline).toBe(NOW + 34_000);
  });

  it('ignores the talk beat in solo play', () => {
    const state = stateWithQuiz({
      rounds: [
        withRoundSettings(quizRound('round-one', ['question-1']), {
          talkSeconds: 20,
        }),
      ],
    });
    addPlayer(state, 'player-1');
    startGame(state, NOW);

    nextPhase(state, NOW + 1000);

    expect(state.cursor.deadline).toBe(NOW + 1000 + 3000);
    expect(state.cursor.talkStartsAt).toBeNull();
  });

  it('judges a warm-up question with 0 points and the streak kept, then skips its scores and the round leaderboard', () => {
    const state = stateWithQuiz({
      playMode: 'teams',
      rounds: [
        withRoundSettings(quizRound('round-warm-up', ['warm-1', 'warm-2']), {
          isWarmUp: true,
        }),
        quizRound('round-two', ['question-1']),
      ],
    });
    addTeam(state, 'team-a');
    addPlayer(state, 'player-1', { teamId: 'team-a', streak: 2 });
    startGame(state, NOW);
    nextPhase(state, NOW);

    const firstRevealAt = playQuizQuestionFromRead(state, ['player-1']);

    expect(answerOf(state, 'player-1').isCorrect).toBe(true);
    expect(answerOf(state, 'player-1').pointsAwarded).toBe(0);
    expect(answerOf(state, 'player-1').streakBonus).toBe(0);
    expect(playerOf(state, 'player-1').score).toBe(0);
    expect(playerOf(state, 'player-1').streak).toBe(2);
    expect(currentPlay(state).teamPoints.get('team-a') ?? 0).toBe(0);
    expect(teamOf(state, 'team-a').score).toBe(0);

    const fromFirstReveal = nextPhase(state, firstRevealAt + 1000);

    expect(state.cursor.phase).toBe('read');
    expect(state.cursor.questionIndex).toBe(1);
    expect(findEffect(fromFirstReveal.effects, 'scores_shown')).toBeUndefined();

    const secondRevealAt = playQuizQuestionFromRead(state, ['player-1']);
    const fromLastReveal = nextPhase(state, secondRevealAt + 1000);

    expect(state.cursor.phase).toBe('round_intro');
    expect(state.cursor.roundIndex).toBe(1);
    expect(findEffect(fromLastReveal.effects, 'scores_shown')).toBeUndefined();
  });

  it('scores nobody on a poll and skips its scores', () => {
    const state = stateWithQuiz({
      rounds: [
        snapshotRound('round-one', 'quiz', [
          pollQuestion('poll-1'),
          trueFalseQuestion('question-2'),
        ]),
      ],
    });
    addPlayer(state, 'player-1', { score: 300, streak: 2 });
    const openAt = openFirstQuizQuestion(state, NOW);
    submit(state, 'player-1', { type: 'poll', optionIndex: 0 }, openAt + 1000);
    expectSuccess(hostReveal(state, state.cursor.phaseId, openAt + 2000));

    expect(answerOf(state, 'player-1').isCorrect).toBeNull();
    expect(answerOf(state, 'player-1').pointsAwarded).toBe(0);
    expect(playerOf(state, 'player-1').score).toBe(300);
    expect(playerOf(state, 'player-1').streak).toBe(2);
    expect(currentPlay(state).pointsByPlayer.get('player-1')).toBe(0);

    const fromReveal = nextPhase(state, openAt + 3000);

    expect(state.cursor.phase).toBe('read');
    expect(state.cursor.questionIndex).toBe(1);
    expect(findEffect(fromReveal.effects, 'scores_shown')).toBeUndefined();
  });

  it('judges a multiple choice question with two correct options', () => {
    const state = stateWithQuiz({
      rounds: [
        snapshotRound('round-one', 'quiz', [
          multipleChoiceQuestion('question-1', [0, 2]),
        ]),
      ],
    });
    addPlayer(state, 'player-1');
    addPlayer(state, 'player-2');
    addPlayer(state, 'player-3');
    const openAt = openFirstQuizQuestion(state, NOW);
    submit(
      state,
      'player-1',
      { type: 'multiple_choice', optionIndex: 0 },
      openAt + 1000,
    );
    submit(
      state,
      'player-2',
      { type: 'multiple_choice', optionIndex: 2 },
      openAt + 1000,
    );
    submit(
      state,
      'player-3',
      { type: 'multiple_choice', optionIndex: 1 },
      openAt + 1000,
    );

    closeIfEveryoneDone(state, openAt + 1000);

    expect(state.cursor.phase).toBe('reveal');
    expect(answerOf(state, 'player-1').isCorrect).toBe(true);
    expect(answerOf(state, 'player-2').isCorrect).toBe(true);
    expect(answerOf(state, 'player-3').isCorrect).toBe(false);
    expect(answerOf(state, 'player-3').pointsAwarded).toBe(0);
  });

  it('scores closest number answers against an absolute tolerance', () => {
    const state = stateWithQuiz({
      rounds: [
        snapshotRound('round-one', 'quiz', [
          closestQuestion('question-1', 1969, { mode: 'absolute', amount: 5 }),
        ]),
      ],
    });
    addPlayer(state, 'player-1');
    addPlayer(state, 'player-2');
    addPlayer(state, 'player-3');
    const openAt = openFirstQuizQuestion(state, NOW);
    submit(
      state,
      'player-1',
      { type: 'closest_number', value: 1970 },
      openAt + 1000,
    );
    submit(
      state,
      'player-2',
      { type: 'closest_number', value: 1973 },
      openAt + 1000,
    );
    submit(
      state,
      'player-3',
      { type: 'closest_number', value: 1980 },
      openAt + 1000,
    );

    closeIfEveryoneDone(state, openAt + 1000);

    // Closest: the plain base plus the first streak step. Within 5: half the base.
    expect(answerOf(state, 'player-1').isCorrect).toBe(true);
    expect(answerOf(state, 'player-1').pointsAwarded).toBe(1100);
    expect(answerOf(state, 'player-2').isCorrect).toBe(false);
    expect(answerOf(state, 'player-2').pointsAwarded).toBe(500);
    expect(answerOf(state, 'player-3').pointsAwarded).toBe(0);
  });

  it('records the streaks before the first scoring once', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(state, 'player-1', { streak: 2 });
    addPlayer(state, 'player-2');
    const openAt = openFirstQuizQuestion(state, NOW);
    submit(
      state,
      'player-1',
      { type: 'true_false', isTrue: true },
      openAt + 1000,
    );
    expectSuccess(hostReveal(state, state.cursor.phaseId, openAt + 2000));

    const expectedStreaks = new Map([
      ['player-1', 2],
      ['player-2', 0],
    ]);
    expect(currentPlay(state).streakBeforeByPlayer).toEqual(expectedStreaks);
    expect(playerOf(state, 'player-1').streak).toBe(3);

    scoreQuizQuestion(state, currentPlayContext(state));

    expect(currentPlay(state).streakBeforeByPlayer).toEqual(expectedStreaks);
  });

  it('finishes a practice session with no placings and still shows the podium', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
      isPractice: true,
    });
    addPlayer(state, 'player-1');
    startGame(state, NOW);
    nextPhase(state, NOW);
    const revealAt = playQuizQuestionFromRead(state, ['player-1']);
    nextPhase(state, revealAt + 1000);
    nextPhase(state, revealAt + 2000);
    expect(state.cursor.phase).toBe('podium');
    expect(state.podium).toHaveLength(1);
    // One place, so one host-paced step before host:next finishes.
    nextPhase(state, revealAt + 2500);
    expect(state.cursor.podiumRevealedCount).toBe(1);

    const finished = nextPhase(state, revealAt + 3000);

    expect(state.status).toBe('finished');
    const finish = findPersist(finished.effects, 'finish');
    expect(finish?.placings).toEqual({});
    expect(finish?.podium).toHaveLength(1);
  });
});

describe('Pulse Live engine phases: podium steps, auto-advance, leave and remove with rejoin', () => {
  function expectCommandSuccess(
    outcome: QuizshowCommandOutcome,
  ): QuizshowEngineEffect[] {
    if (!outcome.ok) {
      throw new Error(`Expected success, got ${outcome.failure.code}`);
    }
    return outcome.effects;
  }

  function expectCommandFailure(
    outcome: QuizshowCommandOutcome,
  ): QuizshowAckFailure {
    if (outcome.ok) throw new Error('Expected a refusal');
    expect(outcome.effects).toEqual([]);
    return outcome.failure;
  }

  /** Solo players `player-1`, `player-2`, ... on the given scores, started and past a scored question. */
  function soloStateWithScores(scores: number[]): QuizshowLiveState {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    for (let position = 0; position < scores.length; position += 1) {
      addPlayer(state, `player-${position + 1}`, {
        joinedAt: STARTED_AT + position,
      });
    }
    startGame(state, NOW);
    scores.forEach((score, position) => {
      playerOf(state, `player-${position + 1}`).score = score;
    });
    state.hasScoredQuestion = true;
    return state;
  }

  /** A caption round with review off, played to its `write` phase. */
  function captionStateInWrite(isAutoAdvanceOn: boolean): QuizshowLiveState {
    const state = stateWithQuiz({
      rounds: [captionRound('round-captions')],
      isReviewOn: false,
    });
    state.isAutoAdvanceOn = isAutoAdvanceOn;
    for (const playerId of ['player-1', 'player-2', 'player-3']) {
      addPlayer(state, playerId);
    }
    startGame(state, NOW);
    nextPhase(state, NOW);
    expect(state.cursor.phase).toBe('write');
    return state;
  }

  it('reveals three places one host:next at a time, each a new phase id, and finishes on the fourth', () => {
    const state = soloStateWithScores([300, 200, 100]);

    expectSuccess(hostEnd(state, state.cursor.phaseId, NOW + 1000));

    expect(state.cursor.phase).toBe('podium');
    expect(state.cursor.podiumRevealedCount).toBe(0);
    const seenPhaseIds = new Set([state.cursor.phaseId]);

    for (const expectedCount of [1, 2, 3]) {
      const previousPhaseId = state.cursor.phaseId;
      const step = nextPhase(state, NOW + 1000 + expectedCount * 1000);

      expect(state.cursor.phase).toBe('podium');
      expect(seenPhaseIds.has(state.cursor.phaseId)).toBe(false);
      seenPhaseIds.add(state.cursor.phaseId);
      expect(state.cursor.podiumRevealedCount).toBe(expectedCount);
      expect(effectKinds(step.effects)).toEqual(
        expect.arrayContaining(['phase_changed', 'podium_shown']),
      );
      expect(findEffect(step.effects, 'scores_shown')).toEqual({
        kind: 'scores_shown',
        scope: 'final',
      });
      expect(checkpointCount(step.effects)).toBe(1);
      expect(state.lastScoresFrame?.phaseId).toBe(state.cursor.phaseId);

      // A double tap on the step just left is a no-op.
      const doubleTap = expectSuccess(
        hostNext(state, previousPhaseId, NOW + 1000 + expectedCount * 1000),
      );
      expect(doubleTap.isNoop).toBe(true);
      expect(state.cursor.podiumRevealedCount).toBe(expectedCount);
    }

    const finished = nextPhase(state, NOW + 5000);

    expect(state.status).toBe('finished');
    expect(state.cursor.phase).toBe('ended');
    expect(findPersist(finished.effects, 'finish')).toBeDefined();
  });

  it('takes two steps for places 1, 1 and 3', () => {
    const state = soloStateWithScores([500, 500, 100]);
    expectSuccess(hostEnd(state, state.cursor.phaseId, NOW + 1000));
    expect(state.podium?.map((entry) => entry.place)).toEqual([1, 1, 3]);

    nextPhase(state, NOW + 2000);
    nextPhase(state, NOW + 3000);

    expect(state.cursor.phase).toBe('podium');
    expect(state.cursor.podiumRevealedCount).toBe(2);

    nextPhase(state, NOW + 4000);

    expect(state.status).toBe('finished');
  });

  it('clamps the revealed count when a removal on the podium leaves fewer places', () => {
    const state = soloStateWithScores([300, 200, 100]);
    expectSuccess(hostEnd(state, state.cursor.phaseId, NOW + 1000));
    nextPhase(state, NOW + 2000);
    nextPhase(state, NOW + 3000);
    nextPhase(state, NOW + 4000);
    expect(state.cursor.podiumRevealedCount).toBe(3);

    const removed = expectSuccess(
      hostRemovePlayer(state, 'player-3', HOST_USER_ID, NOW + 5000),
    );

    expect(state.podium?.map((entry) => entry.place)).toEqual([1, 2]);
    expect(state.cursor.podiumRevealedCount).toBe(2);
    expect(effectKinds(removed.effects)).toEqual(
      expect.arrayContaining(['phase_changed', 'podium_shown']),
    );

    nextPhase(state, NOW + 6000);

    expect(state.status).toBe('finished');
  });

  it('keeps a legacy podium with no count showing everything when an entrant leaves', () => {
    const state = soloStateWithScores([300, 200, 100]);
    expectSuccess(hostEnd(state, state.cursor.phaseId, NOW + 1000));
    state.cursor.podiumRevealedCount = null;

    const effects = expectCommandSuccess(
      leaveLobby(state, 'player-3', NOW + 2000),
    );

    expect(state.podium?.map((entry) => entry.place)).toEqual([1, 2]);
    expect(state.cursor.podiumRevealedCount).toBeNull();
    expect(effectKinds(effects)).toContain('podium_shown');
    expect(effectKinds(effects)).not.toContain('phase_changed');
  });

  it('keeps a place the host has not revealed hidden when a podium entrant leaves', () => {
    const state = soloStateWithScores([300, 200, 100]);
    expectSuccess(hostEnd(state, state.cursor.phaseId, NOW + 1000));
    nextPhase(state, NOW + 2000);
    nextPhase(state, NOW + 3000);
    expect(state.cursor.podiumRevealedCount).toBe(2);

    const effects = expectCommandSuccess(
      leaveLobby(state, 'player-3', NOW + 4000),
    );

    // 3rd and 2nd were shown; the new 2nd stays shown and the winner waits for the host.
    expect(state.podium?.map((entry) => entry.place)).toEqual([1, 2]);
    expect(state.cursor.podiumRevealedCount).toBe(1);
    expect(effectKinds(effects)).toEqual(
      expect.arrayContaining(['phase_changed', 'podium_shown']),
    );
  });

  it('arms auto-advance on a round intro, a quiz reveal and scores, and moves on when the timer fires', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1', 'question-2'])],
    });
    state.isAutoAdvanceOn = true;
    addPlayer(state, 'player-1');

    const started = expectSuccess(hostStart(state, state.cursor.phaseId, NOW));

    expect(state.cursor.phase).toBe('round_intro');
    expect(state.cursor.autoAdvanceAt).toBe(NOW + 5000);
    const introPhaseId = state.cursor.phaseId;
    expect(findEffect(started.effects, 'timer')).toEqual({
      kind: 'timer',
      phaseId: introPhaseId,
      fireAt: NOW + 5000,
    });
    // An early fire asks for the same timer again and moves nothing.
    expect(timerElapsed(state, introPhaseId, NOW + 4000)).toEqual([
      { kind: 'timer', phaseId: introPhaseId, fireAt: NOW + 5000 },
    ]);
    expect(state.cursor.phase).toBe('round_intro');

    timerElapsed(state, introPhaseId, NOW + 5000);

    expect(state.cursor.phase).toBe('read');
    expect(state.cursor.autoAdvanceAt).toBeNull();

    const revealAt = playQuizQuestionFromRead(state, ['player-1']);

    expect(state.cursor.autoAdvanceAt).toBe(revealAt + 6000);

    const toScores = timerElapsed(state, state.cursor.phaseId, revealAt + 6000);

    expect(state.cursor.phase).toBe('scores');
    expect(state.cursor.autoAdvanceAt).toBe(revealAt + 12_000);
    expect(findEffect(toScores, 'timer')).toEqual({
      kind: 'timer',
      phaseId: state.cursor.phaseId,
      fireAt: revealAt + 12_000,
    });
    expect(checkpointCount(toScores)).toBe(1);

    timerElapsed(state, state.cursor.phaseId, revealAt + 12_000);

    expect(state.cursor.phase).toBe('read');
    expect(state.cursor.questionIndex).toBe(1);
  });

  it('leaves a Caption This reveal unarmed', () => {
    const random = seededRandom();
    const state = captionStateInWrite(true);
    writeEveryCaption(
      state,
      ['player-1', 'player-2', 'player-3'],
      NOW + 1000,
      random,
    );
    castVote(state, 'player-1', optionOf(state, 'player-2'), NOW + 2000);
    castVote(state, 'player-2', optionOf(state, 'player-1'), NOW + 2000);
    castVote(state, 'player-3', optionOf(state, 'player-1'), NOW + 2000);
    closeIfEveryoneDone(state, NOW + 2000, random);

    expect(state.cursor.phase).toBe('reveal');
    expect(state.cursor.autoAdvanceAt).toBeNull();
    expect(timerElapsed(state, state.cursor.phaseId, NOW + 60_000)).toEqual([]);
    expect(state.cursor.phase).toBe('reveal');
  });

  it('clears auto-advance on pause and arms the full wait again from the resume', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    state.isAutoAdvanceOn = true;
    addPlayer(state, 'player-1');
    startGame(state, NOW);
    const introPhaseId = state.cursor.phaseId;
    expect(state.cursor.autoAdvanceAt).toBe(NOW + 5000);

    const paused = expectSuccess(hostPause(state, introPhaseId, NOW + 1000));

    expect(state.cursor.autoAdvanceAt).toBeNull();
    expect(findEffect(paused.effects, 'timer_cleared')).toEqual({
      kind: 'timer_cleared',
    });

    const resumed = expectSuccess(
      hostResume(state, introPhaseId, NOW + 10_000),
    );

    expect(state.cursor.autoAdvanceAt).toBe(NOW + 15_000);
    expect(findEffect(resumed.effects, 'timer')).toEqual({
      kind: 'timer',
      phaseId: introPhaseId,
      fireAt: NOW + 15_000,
    });
  });

  it('arms from now when auto-advance turns on mid-reveal and clears when it turns off', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(state, 'player-1');

    const inLobby = expectSuccess(hostSetAutoAdvance(state, true, NOW - 100));
    expect(effectKinds(inLobby.effects)).not.toContain('phase_changed');
    expect(state.cursor.autoAdvanceAt).toBeNull();
    expectSuccess(hostSetAutoAdvance(state, false, NOW - 50));

    startGame(state, NOW);
    nextPhase(state, NOW);
    const revealAt = playQuizQuestionFromRead(state, ['player-1']);
    expect(state.cursor.autoAdvanceAt).toBeNull();

    const turnedOn = expectSuccess(
      hostSetAutoAdvance(state, true, revealAt + 2000),
    );

    expect(turnedOn.isNoop).toBe(false);
    expect(state.isAutoAdvanceOn).toBe(true);
    expect(state.cursor.autoAdvanceAt).toBe(revealAt + 8000);
    expect(findPersist(turnedOn.effects, 'set_session_flags')).toEqual({
      type: 'set_session_flags',
    });
    expect(effectKinds(turnedOn.effects)).toEqual(
      expect.arrayContaining(['flags_changed', 'timer', 'phase_changed']),
    );
    expect(checkpointCount(turnedOn.effects)).toBe(1);

    const repeated = expectSuccess(
      hostSetAutoAdvance(state, true, revealAt + 2500),
    );
    expect(repeated.isNoop).toBe(true);
    expect(repeated.effects).toEqual(CHECKPOINT_ONLY);

    const turnedOff = expectSuccess(
      hostSetAutoAdvance(state, false, revealAt + 3000),
    );

    expect(state.isAutoAdvanceOn).toBe(false);
    expect(state.cursor.autoAdvanceAt).toBeNull();
    expect(effectKinds(turnedOff.effects)).toEqual(
      expect.arrayContaining([
        'flags_changed',
        'timer_cleared',
        'phase_changed',
      ]),
    );

    setSessionStatus(state, 'finished');
    expect(
      expectFailure(hostSetAutoAdvance(state, true, revealAt + 4000)).code,
    ).toBe('quizshow_session_ended');
  });

  it('drops a player-made team when its last player leaves the lobby and keeps a host-made one', () => {
    const state = stateWithQuiz({
      playMode: 'teams',
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addTeam(state, 'team-a');
    addTeam(state, 'team-b', { colorKey: 'triangle', isHostMade: true });
    addPlayer(state, 'player-1', { teamId: 'team-a' });
    addPlayer(state, 'player-2', { teamId: 'team-b' });

    const firstLeave = expectCommandSuccess(leaveLobby(state, 'player-1', NOW));

    expect(playerOf(state, 'player-1').leftAt).toBe(NOW);
    expect(state.teams.has('team-a')).toBe(false);
    expect(findPersist(firstLeave, 'update_player')).toEqual({
      type: 'update_player',
      playerId: 'player-1',
      fields: { leftAt: NOW },
    });
    expect(findPersist(firstLeave, 'delete_teams')).toEqual({
      type: 'delete_teams',
      teamIds: ['team-a'],
    });
    expect(findEffect(firstLeave, 'player_left')).toEqual({
      kind: 'player_left',
      playerId: 'player-1',
    });
    expect(effectKinds(firstLeave)).toContain('lobby_changed');
    expect(checkpointCount(firstLeave)).toBe(1);

    const secondLeave = expectCommandSuccess(
      leaveLobby(state, 'player-2', NOW + 100),
    );

    expect(state.teams.has('team-b')).toBe(true);
    expect(findPersist(secondLeave, 'delete_teams')).toBeUndefined();

    expect(
      expectCommandFailure(leaveLobby(state, 'player-2', NOW + 200)).code,
    ).toBe('quizshow_not_joined');
    expect(
      expectCommandFailure(leaveLobby(state, 'player-9', NOW + 200)).code,
    ).toBe('quizshow_not_joined');
    addPlayer(state, 'player-3', { removedAt: NOW });
    expect(
      expectCommandFailure(leaveLobby(state, 'player-3', NOW + 200)).code,
    ).toBe('quizshow_player_removed');
    setSessionStatus(state, 'finished');
    addPlayer(state, 'player-4');
    expect(
      expectCommandFailure(leaveLobby(state, 'player-4', NOW + 300)).code,
    ).toBe('quizshow_session_ended');
  });

  it('closes an open question early when the last player still to answer leaves', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1', 'question-2'])],
    });
    addPlayer(state, 'player-1');
    addPlayer(state, 'player-2');
    const openAt = openFirstQuizQuestion(state, NOW);
    submit(state, 'player-1', { type: 'true_false', isTrue: true }, openAt);

    const effects = expectCommandSuccess(
      leaveLobby(state, 'player-2', openAt + 1000),
    );

    expect(state.cursor.phase).toBe('reveal');
    expect(effectKinds(effects)).toEqual(
      expect.arrayContaining(['player_left', 'revealed']),
    );
    expect(checkpointCount(effects)).toBe(1);
    // The leaver stays counted for the question, so a rejoin keeps the counts consistent.
    expect(currentPlay(state).eligiblePlayerIds.has('player-2')).toBe(true);
    expect(state.questionLog[0]?.eligibleCount).toBe(2);
  });

  it('removes a player with a rejoin: leftAt set, answers stay visible, sockets evicted', () => {
    const state = captionStateInWrite(false);
    const answer = submit(
      state,
      'player-1',
      { type: 'prompt', text: 'player-1 caption' },
      NOW + 1000,
    );

    const removed = expectSuccess(
      hostRemovePlayer(
        state,
        'player-1',
        HOST_USER_ID,
        NOW + 2000,
        seededRandom(),
        true,
      ),
    );

    const player = playerOf(state, 'player-1');
    expect(player.leftAt).toBe(NOW + 2000);
    expect(player.removedAt).toBeNull();
    expect(answer.hiddenAt).toBeNull();
    expect(findPersist(removed.effects, 'hide_player_answers')).toBeUndefined();
    expect(findEffect(removed.effects, 'answer_hidden')).toBeUndefined();
    expect(findPersist(removed.effects, 'update_player')).toEqual({
      type: 'update_player',
      playerId: 'player-1',
      fields: { leftAt: NOW + 2000 },
    });
    expect(findEffect(removed.effects, 'player_removed')).toEqual({
      kind: 'player_removed',
      playerId: 'player-1',
      canRejoin: true,
    });
    expect(findEffect(removed.effects, 'player_left')).toBeUndefined();

    // A second rejoin removal of a player who left changes nothing.
    const rejoinAgain = expectSuccess(
      hostRemovePlayer(
        state,
        'player-1',
        HOST_USER_ID,
        NOW + 2500,
        seededRandom(),
        true,
      ),
    );
    expect(rejoinAgain.isNoop).toBe(true);
    expect(playerOf(state, 'player-1').removedAt).toBeNull();

    // Removing for good a player who left blocks the rejoin and hides their answers.
    const removedAfterLeave = expectSuccess(
      hostRemovePlayer(state, 'player-1', HOST_USER_ID, NOW + 3000),
    );
    expect(removedAfterLeave.isNoop).toBe(false);
    expect(playerOf(state, 'player-1').removedAt).toBe(NOW + 3000);
    expect(answer.hiddenAt).toBe(NOW + 3000);
    expect(
      findPersist(removedAfterLeave.effects, 'hide_player_answers'),
    ).toEqual({
      type: 'hide_player_answers',
      playerId: 'player-1',
      hiddenAt: NOW + 3000,
      hiddenByUserId: HOST_USER_ID,
    });
    expect(findEffect(removedAfterLeave.effects, 'player_removed')).toEqual({
      kind: 'player_removed',
      playerId: 'player-1',
      canRejoin: false,
    });

    const removedAgain = expectSuccess(
      hostRemovePlayer(state, 'player-1', HOST_USER_ID, NOW + 3500),
    );
    expect(removedAgain.isNoop).toBe(true);

    const removedForGood = expectSuccess(
      hostRemovePlayer(state, 'player-2', HOST_USER_ID, NOW + 4000),
    );
    expect(findEffect(removedForGood.effects, 'player_removed')).toEqual({
      kind: 'player_removed',
      playerId: 'player-2',
      canRejoin: false,
    });
  });

  it('arms auto-advance on a Lie Detector reveal and leaves the podium unarmed', () => {
    const random = seededRandom();
    const state = stateWithQuiz({
      rounds: [lieDetectorRound('round-lies')],
      isReviewOn: false,
    });
    state.isAutoAdvanceOn = true;
    for (const playerId of ['player-1', 'player-2', 'player-3']) {
      addPlayer(state, playerId);
    }
    startGame(state, NOW);
    nextPhase(state, NOW);
    const writeDeadline = requireNumber(state.cursor.deadline);
    submit(state, 'player-1', { type: 'prompt', text: 'Porto' }, NOW + 1000);
    submit(state, 'player-2', { type: 'prompt', text: 'Faro' }, NOW + 2000);
    timerElapsed(state, state.cursor.phaseId, writeDeadline + 500, random);
    expect(state.cursor.phase).toBe('vote');
    const truthOption = optionOf(state, null);
    castVote(state, 'player-1', optionOf(state, 'player-2'), NOW + 70_000);
    castVote(state, 'player-2', truthOption, NOW + 70_000);
    castVote(state, 'player-3', truthOption, NOW + 70_000);
    closeIfEveryoneDone(state, NOW + 70_000, random);

    expect(state.cursor.phase).toBe('reveal');
    expect(state.cursor.autoAdvanceAt).toBe(NOW + 76_000);

    timerElapsed(state, state.cursor.phaseId, NOW + 76_000, random);

    expect(state.cursor.phase).toBe('podium');
    expect(state.cursor.autoAdvanceAt).toBeNull();
  });

  it('leaves a leaderboard unarmed and treats host:next on the phase the timer left as a no-op', () => {
    const state = stateWithQuiz({
      rounds: [
        quizRound('round-one', ['question-1']),
        quizRound('round-two', ['question-2']),
      ],
    });
    state.isAutoAdvanceOn = true;
    addPlayer(state, 'player-1');
    startGame(state, NOW);
    timerElapsed(state, state.cursor.phaseId, NOW + 5000);
    const revealAt = playQuizQuestionFromRead(state, ['player-1']);
    const revealPhaseId = state.cursor.phaseId;

    timerElapsed(state, revealPhaseId, revealAt + 6000);

    expect(state.cursor.phase).toBe('scores');
    const scoresPhaseId = state.cursor.phaseId;
    const lateTap = expectSuccess(
      hostNext(state, revealPhaseId, revealAt + 6100),
    );
    expect(lateTap.isNoop).toBe(true);
    expect(state.cursor.phaseId).toBe(scoresPhaseId);

    timerElapsed(state, scoresPhaseId, revealAt + 12_000);

    expect(state.cursor.phase).toBe('leaderboard');
    expect(state.cursor.autoAdvanceAt).toBeNull();
    expect(
      timerElapsed(state, state.cursor.phaseId, revealAt + 60_000),
    ).toEqual([]);
    expect(state.cursor.phase).toBe('leaderboard');
  });

  it('arms nothing when auto-advance turns on while paused and arms on resume', () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(state, 'player-1');
    startGame(state, NOW);
    const introPhaseId = state.cursor.phaseId;
    expectSuccess(hostPause(state, introPhaseId, NOW + 1000));

    const turnedOn = expectSuccess(hostSetAutoAdvance(state, true, NOW + 2000));

    expect(state.isAutoAdvanceOn).toBe(true);
    expect(state.cursor.autoAdvanceAt).toBeNull();
    expect(findEffect(turnedOn.effects, 'timer')).toBeUndefined();
    expect(effectKinds(turnedOn.effects)).not.toContain('phase_changed');

    const resumed = expectSuccess(hostResume(state, introPhaseId, NOW + 3000));

    expect(state.cursor.autoAdvanceAt).toBe(NOW + 8000);
    expect(findEffect(resumed.effects, 'timer')).toEqual({
      kind: 'timer',
      phaseId: introPhaseId,
      fireAt: NOW + 8000,
    });
  });
});

describe('Pulse Live engine phases: hostRenameTeam name checks', () => {
  function teamsLobby(): QuizshowLiveState {
    const state = stateWithQuiz({
      playMode: 'teams',
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addTeam(state, 'team-a', { name: 'Team A' });
    addTeam(state, 'team-b', { name: 'Les Étoiles', colorKey: 'triangle' });
    return state;
  }

  it('refuses a name that clashes with another team once accents, case and spaces fold away', () => {
    const state = teamsLobby();

    const failure = expectFailure(
      hostRenameTeam(state, { teamId: 'team-a', name: 'les   etoiles' }, NOW),
    );

    expect(failure.code).toBe('quizshow_team_name_taken');
    expect(teamOf(state, 'team-a').name).toBe('Team A');
  });

  it('refuses a blank name and a blocked name with their own codes', () => {
    const state = teamsLobby();
    const blockedWord = BLOCKED_TERMS[0];
    if (blockedWord === undefined) throw new Error('No blocked term to test');

    expect(
      expectFailure(
        hostRenameTeam(state, { teamId: 'team-a', name: '   ' }, NOW),
      ).code,
    ).toBe('quizshow_text_blank');
    expect(
      expectFailure(
        hostRenameTeam(state, { teamId: 'team-a', name: blockedWord }, NOW),
      ).code,
    ).toBe('quizshow_text_blocked');
  });

  it('lets a team fold to its own name with new accents or case', () => {
    const state = teamsLobby();

    const { isNoop } = expectSuccess(
      hostRenameTeam(state, { teamId: 'team-b', name: 'LES ETOILES' }, NOW),
    );

    expect(isNoop).toBe(false);
    expect(teamOf(state, 'team-b').name).toBe('LES ETOILES');
  });
});
