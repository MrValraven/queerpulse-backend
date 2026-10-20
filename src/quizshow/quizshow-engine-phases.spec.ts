import type {
  QuizshowAckFailure,
  QuizshowAnswerPayload,
  QuizshowPlayMode,
  QuizshowRoundKind,
  QuizshowText,
} from './quizshow.contract';
import {
  abandonIfIdle,
  closeIfEveryoneDone,
  hostAddTime,
  hostEnd,
  hostHideAnswer,
  hostNext,
  hostPause,
  hostPickFavourite,
  hostRemovePlayer,
  hostResume,
  hostReveal,
  hostSetScreenMuted,
  hostShowAnswers,
  hostSkip,
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
    },
    questions,
  };
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
}): QuizshowLiveState {
  const snapshot: QuizshowSessionSnapshot = {
    title: 'Pride night quiz',
    languages: 'both',
    screenLanguage: 'en',
    rounds: options.rounds,
  };
  return createLobbyState({
    sessionId: 'session-1',
    eventId: 'event-1',
    eventSlug: 'pride-night',
    eventTitle: 'Pride night',
    hostUserId: HOST_USER_ID,
    openedByUserId: HOST_USER_ID,
    joinCode: 'ABC234',
    playMode: options.playMode ?? 'solo',
    maxTeamSize: null,
    isReviewOn: options.isReviewOn ?? true,
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
  it("starts at round 0's intro and drops empty teams", () => {
    const state = stateWithQuiz({
      playMode: 'teams',
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addTeam(state, 'team-a');
    addTeam(state, 'team-b', { colorKey: 'triangle' });
    addTeam(state, 'team-c', { colorKey: 'square' });
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
    expect(findPersist(outcome.effects, 'delete_teams')).toEqual({
      type: 'delete_teams',
      teamIds: ['team-b', 'team-c'],
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

  it("shows a quiz question for four seconds, then opens it with the round's limit", () => {
    const state = stateWithQuiz({
      rounds: [quizRound('round-one', ['question-1'])],
    });
    addPlayer(state, 'player-1');
    startGame(state, NOW);

    const read = nextPhase(state, NOW + 1000);
    const readPhaseId = state.cursor.phaseId;

    expect(state.cursor.phase).toBe('read');
    expect(state.cursor.deadline).toBe(NOW + 5000);
    expect(state.cursor.extraTimeDeadline).toBeNull();
    expect(findEffect(read.effects, 'timer')).toEqual({
      kind: 'timer',
      phaseId: readPhaseId,
      fireAt: NOW + 5000,
    });
    expect(currentPlay(state).eligiblePlayerIds).toEqual(new Set(['player-1']));

    expect(timerElapsed(state, readPhaseId, NOW + 4999)).toEqual([
      { kind: 'timer', phaseId: readPhaseId, fireAt: NOW + 5000 },
    ]);
    expect(state.cursor.phase).toBe('read');

    const opened = timerElapsed(state, readPhaseId, NOW + 5000);

    expect(state.cursor.phase).toBe('open');
    expect(state.cursor.phaseStartedAt).toBe(NOW + 5000);
    expect(state.cursor.deadline).toBe(NOW + 25_000);
    expect(state.cursor.extraTimeDeadline).toBe(NOW + 35_000);
    expect(findEffect(opened, 'timer')).toEqual({
      kind: 'timer',
      phaseId: state.cursor.phaseId,
      fireAt: NOW + 25_500,
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
      favouriteAuthorPlayerId: 'player-1',
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
    expect(refusal.code).toBe('quizshow_command_not_allowed');

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
      'quizshow_command_not_allowed',
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

    const finished = nextPhase(teamsState, NOW + 2000);

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
    expect(state.cursor.deadline).toBe(resumeAt + 4000);
    expect(state.questionLog).toHaveLength(1);
    expect(state.questionLog[0]?.openedAt).toBe(resumeAt);
    expect(currentPlay(state).answers.size).toBe(0);
    expect(currentPlay(state).eligiblePlayerIds).toEqual(
      new Set(['player-1', 'player-2', 'player-3']),
    );
    expect(findEffect(resumed.effects, 'timer')).toEqual({
      kind: 'timer',
      phaseId: state.cursor.phaseId,
      fireAt: resumeAt + 4000,
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
      'quizshow_command_not_allowed',
    );
    expect(state.isScreenMuted).toBe(true);
  });
});
